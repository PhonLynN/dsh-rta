/**
 * host/summarizer.js — 后台「屏幕摘要子代理」：主会话不被打断，摘要由子代理滚动产出。
 *
 * 用户 m00826 的设计约束：
 *   - 主会话绝对不能被打断 → 自动流永不 followup/steer；本模块只用 delivery:'caller'
 *     启动子代理（settlement 不回父会话，不产生唤醒）。
 *   - rta_start 启用采集后，自动起一个摘要子代理，让它按节流读最新屏幕事件/
 *     高清画面，并把 2–4 句滚动摘要写进 rta_note(name='screen-log')。
 *   - lifecycle 的 runtime-context 文本会把这句摘要附在 digest 后面 → 主 agent
 *     下一步就能被动看到「屏幕摘要」，零唤醒。
 *   - 主 agent 想看原图时自己调 rta_look / rta_recall(images:true)。
 *
 * 为什么用「每次新起一个一次性子代理」而不是一个常驻子代理：
 *   startActivation 的返回是「一次 activation」；宿主没有给插件一个稳定的
 *   「往同一个子代理持续投喂」的公开 API（symbol-keyed 的 deliverSubagentPrompt
 *   属于宿主内部）。一次性 activation 的语义最干净：prompt 里带上一次摘要，
 *   子代理自己保持连续性；失败/超时也不影响主会话。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceOf } from './service.js';

const SUMMARY_NOTE_NAME = 'screen-log';
const MAX_SUMMARY_CHARS = 700;

/** 选择 provider：优先配置，其次 spawn（零上下文、最便宜），再 fork，再其它已注册的。 */
function pickProvider(subagents, preferred = null) {
  const registered = typeof subagents?.list === 'function' ? subagents.list() : [];
  if (preferred && registered.includes(preferred)) return preferred;
  for (const name of ['spawn', 'fork']) {
    if (registered.includes(name)) return name;
  }
  return registered[0] ?? null;
}

function clip(text, max) {
  const s = String(text ?? '').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 摘要子代理的 prompt：只给「看什么 + 写什么」，不给它自由发挥的空间。 */
export function buildSummaryPrompt({ digest = '', prior = '', at = Date.now() } = {}) {
  const lines = [
    '你是 RTA 的屏幕摘要器（后台子代理，不属于主对话，没人会直接回复你）。',
    '任务：把下面这段「屏幕活动摘要」变成 2–4 句中文滚动摘要，写进 rta_note。',
    '',
    '步骤：',
    '1. 先读摘要。若只有「明显变化/持续变化」而看不出内容，可调用 rta_look（count=1）看一张当前高清画面；不要为了看而看，一次足够。',
    `2. 调用 rta_note({ name: "${SUMMARY_NOTE_NAME}", text: "…" }) 写入摘要。`,
    '3. 摘要只写：用户在做什么/看什么 + 关键变化或结论。没有新信息就写「屏幕无显著变化，仍在 <窗口标题>」。',
    '4. 不要寒暄、不要提问、不要列标题，写完结束本轮。',
    '',
    '【屏幕活动摘要（自动生成，可能含噪声）】',
    digest || '（暂无事件）',
  ];
  if (prior) {
    lines.push('', '【上一版摘要（保持连续性；没有新证据不要重复它）】', prior);
  }
  lines.push('', `（时间：${new Date(at).toISOString()}）`);
  return lines.join('\n');
}

/**
 * @param {object} deps
 * @param {object} deps.rt runtime api（bound、boundSessionId、engine、ctx、logger）
 * @param {object} [deps.config] inject.summarizer
 * @param {() => string} [deps.digest] 当前屏幕 digest 文本（来自 live-buffer）
 * @param {() => number} [deps.now]
 */
export function createSummarizer({ rt, logger = rt?.logger, config = {}, digest = () => '', now = Date.now } = {}) {
  const cfg = {
    enabled: true,
    provider: null,
    intervalMs: 45_000,
    maxPer10Min: 6,
    timeoutMs: 180_000,
    ...config,
  };

  let attached = false;
  let timer = null;
  let inFlight = null;
  let lastStartAt = 0;
  let lastDigest = '';
  let lastSummary = '';
  let lastSummaryAt = 0;
  let starts = 0;
  let errors = 0;
  let lastError = null;
  let ticks = 0;
  let lastSkip = null;
  let startsWindow = [];

  const notesDir = () => rt?.engine?.store?.paths?.notes ?? null;

  function noteError(stage, err) {
    errors += 1;
    lastError = `${stage}: ${err?.message ?? err}`;
    logger?.warn?.(`[rta] summarizer ${lastError}`);
  }

  /** 读 notes/ 下最新的 screen-log（子代理写的滚动摘要）。 */
  async function latestSummary() {
    const dir = notesDir();
    if (!dir) return '';
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      return '';
    }
    const candidates = names.filter((n) => n.endsWith('.md'));
    if (!candidates.length) return '';
    const scored = [];
    for (const name of candidates) {
      try {
        const info = await stat(join(dir, name));
        scored.push({ name, mtime: info.mtimeMs });
      } catch { /* ignore */ }
    }
    scored.sort((a, b) => b.mtime - a.mtime);
    const newest = scored[0];
    if (!newest) return '';
    try {
      const text = await readFile(join(dir, newest.name), 'utf8');
      lastSummary = clip(text, MAX_SUMMARY_CHARS);
      lastSummaryAt = newest.mtime;
      return lastSummary;
    } catch {
      return '';
    }
  }

  function refreshSummarySoon() {
    void latestSummary().catch(() => {});
  }

  async function tickOnce() {
    // attach() 只负责挂定时器；tickOnce 允许被测试/外部直接驱动（幂等、自带节流）。
    ticks += 1;
    if (!cfg.enabled) { lastSkip = 'disabled'; return false; }
    if (inFlight) { lastSkip = 'in-flight'; return false; }
    const at = now();
    const engine = rt?.engine ?? null;
    if (!engine || engine.state !== 'running') { lastSkip = 'engine-idle'; return false; }
    const agent = rt?.bound?.agent ?? null;
    const sessionId = rt?.boundSessionId?.() ?? null;
    if (!agent || !sessionId) { lastSkip = 'no-binding'; return false; }
    if (at - lastStartAt < cfg.intervalMs) { lastSkip = 'interval'; return false; }
    startsWindow = startsWindow.filter((t) => at - t < 600_000);
    if (startsWindow.length >= cfg.maxPer10Min) { lastSkip = 'rate-limited'; return false; }

    const text = String(digest() ?? '');
    if (!text) { lastSkip = 'empty-digest'; return false; }
    // digest 文字没变化 = 屏幕没新信息，不必再起子代理。
    if (text === lastDigest) { lastSkip = 'same-digest'; return false; }

    const subagents = serviceOf(rt?.ctx, 'subagents');
    if (!subagents || typeof subagents.startActivation !== 'function') {
      lastSkip = 'no-subagents-service';
      noteError('no-subagents-service');
      return false;
    }
    const provider = pickProvider(subagents, cfg.provider);
    if (!provider) {
      lastSkip = 'no-provider';
      noteError('no-provider');
      return false;
    }

    const prior = lastSummary || (await latestSummary().catch(() => ''));
    const prompt = buildSummaryPrompt({ digest: text, prior, at });
    inFlight = { at, provider, childId: null, abort: new AbortController() };
    lastStartAt = at;
    starts += 1;
    startsWindow.push(at);
    lastDigest = text;

    try {
      const activation = await subagents.startActivation({
        provider,
        label: 'rta-screen-summary',
        delivery: 'caller', // 结果不回父会话 → 主会话零唤醒
        // 宿主会同步调用 signal.throwIfAborted()，必须提供 AbortSignal。
        signal: inFlight.abort.signal,
        // request.prompt 必须是 content parts 数组（宿主直接交给 createUserMessage）。
        request: { prompt: [{ type: 'text', text: prompt }], parent: agent },
      });
      const childId = activation?.childId ?? null;
      if (inFlight) inFlight.childId = childId;
      logger?.info?.(`[rta] summary child started (provider=${provider}${childId ? `, child=${String(childId).slice(0, 8)}` : ''})`);

      const result = activation?.result;
      if (result && typeof result.then === 'function') {
        result.then(
          () => {
            if (inFlight?.childId === childId) inFlight = null;
            refreshSummarySoon();
          },
          (err) => {
            if (inFlight?.childId === childId) inFlight = null;
            noteError('child', err);
          },
        );
      } else {
        inFlight = null;
        refreshSummarySoon();
      }

      const childAt = inFlight?.at;
      const timerId = setTimeout(() => {
        if (inFlight && inFlight.at === childAt && now() - inFlight.at >= cfg.timeoutMs) {
          noteError('timeout');
          try { inFlight.abort?.abort?.(); } catch { /* ignore */ }
          try {
            if (inFlight.childId && typeof subagents.interrupt === 'function') {
              subagents.interrupt(inFlight.childId, { kind: 'ancestor', agent });
            }
          } catch { /* ignore */ }
          inFlight = null;
        }
      }, cfg.timeoutMs + 1_000);
      timerId.unref?.();
      return true;
    } catch (err) {
      inFlight = null;
      noteError('start', err);
      return false;
    }
  }

  function schedule() {
    if (timer) return;
    timer = setInterval(() => { void tickOnce(); }, Math.max(2_000, Math.min(10_000, Math.floor(cfg.intervalMs / 3))));
    timer.unref?.();
  }

  function unschedule() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function attach() {
    if (attached) return { ok: true, already: true };
    attached = true;
    if (!cfg.enabled) return { ok: false, reason: 'disabled' };
    schedule();
    const engine = rt?.engine ?? null;
    if (engine?.state === 'running') refreshSummarySoon();
    return { ok: true };
  }

  function dispose() {
    attached = false;
    unschedule();
    try { inFlight?.abort?.abort?.(); } catch { /* ignore */ }
    inFlight = null;
  }

  function status() {
    const engine = rt?.engine ?? null;
    return {
      enabled: Boolean(cfg.enabled),
      attached,
      provider: cfg.provider ?? 'auto',
      subagents: typeof serviceOf(rt?.ctx, 'subagents')?.startActivation === 'function',
      running: engine?.state === 'running',
      starts,
      errors,
      inFlight: Boolean(inFlight),
      ticks,
      lastSkip,
      lastStartAt: lastStartAt || null,
      summaryChars: lastSummary.length,
      summaryAgeMs: lastSummaryAt ? now() - lastSummaryAt : null,
      lastError,
    };
  }

  return {
    attach,
    dispose,
    tickOnce,
    latestSummary,
    summaryText: () => lastSummary,
    status,
  };
}
