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
 * 用户 m01622 的约束：整个 RTA 会话只复用 **一个** continuable 子代理，不要每 45s
 * 新起一个；rta_stop / 插件卸载时必须把它清除。做法：
 *   - 首次触发 `startActivation({ childId })` 预留一个本地 continuable 子代理（同一 childId）。
 *   - 之后每轮用宿主内部的 symbol 通道 `Symbol.for('dsh.subagent.deliverPrompt')`
 *     → `runtime[deliverSubagentPrompt](parent, childId, content, source, signal, 'queue')`
 *     给同一个 child 投递新的 user turn；字符串 prompt 不再创建新 Agent。
 *   - rta_stop / dispose：`subagents.interrupt(childId, { kind:'ancestor', agent })` 打断当前轮，
 *     再 `subagents.drainChildren(agent, [childId])` 释放这个常驻子代理（child-first 回收）。
 *   - 子代理的 activation `result` 只在整个 activation 结束（被 drain）时 settle，
 *     所以单轮完成靠 notes/screen-log.md 的 mtime 变化判断，而不是 await result。
 *
 * 用户 m01656 的约束：触发不能只有周期驱动，还要支持
 *   ① 主 agent 主动命令（rta_summarize → requestNow({ reason:'demand' })）；
 *   ② 密集事件（engine push 的 cut/region/text/高 score 事件 → onScreenEvent() 防抖触发）。
 */

import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceOf } from './service.js';

const SUMMARY_NOTE_NAME = 'screen-log';
const MAX_SUMMARY_CHARS = 700;
const DELIVER_PROMPT = Symbol.for('dsh.subagent.deliverPrompt');
const EVENT_KINDS = new Set(['cut', 'region', 'text', 'manual']);
const SETTLEMENT_GUARD_KEY = Symbol.for('dsh-rta.settlement-guard');

/** agent → session id（宿主 agent 形状有两种：agent.session.id / agent.sessionId）。 */
function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.sessionId ?? null;
}

/**
 * 宿主缺口：continuable 子代理每轮结束后 activation 会 settle，下一次投递走
 * `coldResume()`，而 `coldResume` 调用 `materialize()` 时**没有透传 `delivery`**，
 * 于是 activation.delivery 回落到 'parent' → `notifySettlement()` 会向父会话发
 * 「Background subagent ... finished」并 `followup()` 唤醒主会话。我们第一次
 * `startActivation({ delivery:'caller' })` 只能抑制首轮。
 *
 * 为了满足「整个 RTA 会话复用同一个子代理 + 主会话零唤醒」，这里在 manager 实例上
 * 加一个只针对本插件 childId 的过滤器：该 child 的结算通知直接丢弃，其它子代理
 * 完全不受影响；宿主升级后若 notfiySettlement 不再存在，Guard 自然降级为 null
 * （此时会退回可见的结算通知，但不会崩）。
 *
 * 注意：这是宿主版本相关的兜底，不是公开 API。
 */
function acquireSettlementGuard(subagents) {
  const manager = subagents?.manager;
  if (!manager || typeof manager.notifySettlement !== 'function') return null;
  let guard = manager[SETTLEMENT_GUARD_KEY];
  if (!guard) {
    const children = new Set();
    const original = manager.notifySettlement;
    const patched = function notifySettlementFiltered(activation, terminal) {
      const id = activation?.childId ?? activation?.sessionId;
      if (id && children.has(id)) return; // 我们的摘要子代理：不通知、不唤醒父会话
      return original.call(this, activation, terminal);
    };
    guard = { manager, original, patched, children };
    manager[SETTLEMENT_GUARD_KEY] = guard;
    manager.notifySettlement = patched;
  }
  return guard;
}

function releaseSettlementGuard(guard, childId) {
  if (!guard) return;
  guard.children.delete(childId);
  if (guard.children.size > 0) return;
  try {
    if (guard.manager.notifySettlement === guard.patched) {
      guard.manager.notifySettlement = guard.original;
    }
    delete guard.manager[SETTLEMENT_GUARD_KEY];
  } catch { /* host may freeze the manager; leaving the filter installed is harmless */ }
}

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

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

const TRIGGER_HINT = {
  interval: '',
  event: '（刚刚出现密集屏幕变化，请尽快更新摘要）',
  demand: '（主对话刚主动要求最新摘要，请优先处理）',
  start: '（屏幕采集刚启动，请先写一版摘要）',
};

/** 摘要子代理的 prompt：只给「看什么 + 写什么」，不给它自由发挥的空间。 */
export function buildSummaryPrompt({ digest = '', prior = '', at = Date.now(), trigger = 'interval' } = {}) {
  const hint = TRIGGER_HINT[trigger] ?? '';
  const lines = [
    '你是 RTA 的屏幕摘要器（后台子代理，不属于主对话，没人会直接回复你）。',
    '任务：把下面这段「屏幕活动摘要」变成 2–4 句中文滚动摘要，写进 rta_note。',
    hint || '',
  ];
  lines.push(
    '',
    '步骤：',
    '1. 先读摘要。若只有「明显变化/持续变化」而看不出内容，可调用 rta_look（count=1）看一张当前高清画面；不要为了看而看，一次足够。',
    `2. 调用 rta_note({ name: "${SUMMARY_NOTE_NAME}", text: "…" }) 写入摘要。`,
    '3. 摘要只写：用户在做什么/看什么 + 关键变化或结论。没有新信息就写「屏幕无显著变化，仍在 <窗口标题>」。',
    '4. 不要寒暄、不要提问、不要列标题，写完结束本轮。',
    '',
    '【屏幕活动摘要（自动生成，可能含噪声）】',
    digest || '（暂无事件）',
  );
  if (prior) {
    lines.push('', '【上一版摘要（保持连续性；没有新证据不要重复它）】', prior);
  }
  lines.push('', `（时间：${new Date(at).toISOString()}${hint ? ` ${hint}` : ''}）`);
  return lines.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n');
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
    maxPer10Min: 18,
    timeoutMs: 180_000,
    eventEnabled: true,
    eventMinGapMs: 12_000,
    eventDebounceMs: 2_500,
    eventMinScore: 18,
    demandWaitMs: 25_000,
    watchMs: 2_000,  // 轮询 notes mtime 判断「这一轮摘要写完了没」的周期
    pollMs: 500,     // rta_summarize 等待新摘要的轮询周期
    ...config,
  };

  let attached = false;
  let timer = null;
  let awaiting = null; // { at, baselineMtime, trigger, timer, watcher }
  let child = null; // { id, provider, controller, settled, startedAt, prompts }
  let starting = null; // 正在 startActivation 的 promise（并发保护：一次只建一个 child）
  let delivering = false; // 正在投递 prompt（并发保护：一次 tick 只投一轮）
  const knownChildren = new Set(); // 本模块实例建过的所有 child（含竞态/孤儿），stop 时一并清
  let startSeq = 0; // stop() 时自增，用来作废「stop 前发起、stop 后才落地」的创建
  let lastPromptAt = 0;
  let lastDigest = '';
  let lastSummary = '';
  let lastSummaryAt = 0;
  let starts = 0;
  let prompts = 0;
  let errors = 0;
  let lastError = null;
  let ticks = 0;
  let lastSkip = null;
  let lastTrigger = null;
  let promptWindow = [];
  let debounceTimer = null;
  let pendingEventAt = 0;
  let lastEventAt = 0;

  const notesDir = () => rt?.engine?.store?.paths?.notes ?? null;

  function noteError(stage, err) {
    errors += 1;
    lastError = `${stage}: ${err?.message ?? err}`;
    logger?.warn?.(`[rta] summarizer ${lastError}`);
  }

  /** 读 notes/ 下最新 md（子代理写的滚动摘要）。返回 { text, mtime, name }。 */
  async function readSummaryInfo() {
    const dir = notesDir();
    if (!dir) return { text: '', mtime: 0, name: null };
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      return { text: '', mtime: 0, name: null };
    }
    const scored = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      try {
        const info = await stat(join(dir, name));
        scored.push({ name, mtime: info.mtimeMs });
      } catch { /* ignore */ }
    }
    scored.sort((a, b) => b.mtime - a.mtime);
    const newest = scored[0];
    if (!newest) return { text: '', mtime: 0, name: null };
    try {
      const text = await readFile(join(dir, newest.name), 'utf8');
      return { text, mtime: newest.mtime, name: newest.name };
    } catch {
      return { text: '', mtime: newest.mtime, name: newest.name };
    }
  }

  async function latestSummary() {
    const info = await readSummaryInfo();
    if (!info.text) return '';
    lastSummary = clip(info.text, MAX_SUMMARY_CHARS);
    lastSummaryAt = info.mtime;
    return lastSummary;
  }

  function refreshSummarySoon() {
    void latestSummary().catch(() => {});
  }

  function clearAwaiting() {
    if (!awaiting) return;
    if (awaiting.timer) clearTimeout(awaiting.timer);
    if (awaiting.watcher) clearInterval(awaiting.watcher);
    awaiting = null;
  }

  /** 一轮 prompt 发出后，盯 notes/screen-log.md 的 mtime 判断子代理是否写完。 */
  function watchAwaiting() {
    if (!awaiting) return;
    const current = awaiting;
    current.watcher = setInterval(() => {
      void (async () => {
        if (!awaiting || awaiting !== current) return;
        const info = await readSummaryInfo().catch(() => null);
        if (info && info.mtime > current.baselineMtime) {
          lastSummary = clip(info.text, MAX_SUMMARY_CHARS);
          lastSummaryAt = info.mtime;
          clearAwaiting();
        }
      })();
    }, Math.max(5, Number(cfg.watchMs) || 2_000));
    current.watcher.unref?.();
  }

  async function interruptChild(reason) {
    if (!child) return;
    const subagents = serviceOf(rt?.ctx, 'subagents');
    const agent = rt?.bound?.agent ?? null;
    const id = child.id;
    if (!subagents || !agent) { child.settled = true; return; }
    try {
      subagents.interrupt(id, { kind: 'ancestor', agent });
    } catch (err) {
      noteError(`interrupt-${reason}`, err);
    }
  }

  /** rta_stop / 插件卸载：打断并释放这个常驻子代理（用户 m01622 要求「结束 rta 后清除」）。 */
  async function stop(reason = 'stop') {
    unschedule();
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    clearAwaiting();
    const subagents = serviceOf(rt?.ctx, 'subagents');
    // 用创建该 child 时的 parent agent（可能不是当前绑定会话的 agent，例如换绑后清旧的）。
    const agent = child?.parentAgent ?? rt?.bound?.agent ?? null;
    const id = child?.id ?? null;
    if (id && subagents && agent) {
      try {
        subagents.interrupt(id, { kind: 'ancestor', agent });
      } catch { /* absent / stale agent is an accepted no-op */ }
      try {
        if (typeof subagents.drainChildren === 'function') await subagents.drainChildren(agent, [id]);
      } catch (err) {
        noteError(`drain-${reason}`, err);
      }
      logger?.info?.(`[rta] summary subagent cleared (${reason}, child=${String(id).slice(0, 8)})`);
    }
    if (child?.guard) releaseSettlementGuard(child.guard, id);
    // 兜底：清掉本实例建过、但不在 child 记录里的子代理（并发竞态/重建遗留），
    // 满足「结束 rta 后相关子代理都清掉」（用户 m01622）。
    for (const k of [...knownChildren]) {
      knownChildren.delete(k);
      if (!subagents || !k.agent || k.id === id) continue;
      try { subagents.interrupt(k.id, { kind: 'ancestor', agent: k.agent }); } catch { /* absent */ }
      try { await subagents.drainChildren?.(k.agent, [k.id]); } catch { /* absent */ }
    }
    child = null;
    // 作废可能还在 startActivation 里的创建（stop 后才落地的 child 会被释放）。
    startSeq += 1;
    starting = null;
    lastPromptAt = 0;
    // 下一段采集/新会话应该重新要一版摘要，而不是被上一段的 digest 去重挡住。
    lastDigest = '';
    return true;
  }

  /** 该 RTA 会话唯一的 continuable 子代理；不存在则用预留 childId 建一个。 */
  async function ensureChild(subagents, agent, provider, prompt) {
    // 子代理一轮跑完后 activation 会 settle，但宿主保留 childId 可在下一次
    // deliverPrompt 时冷恢复，所以这里不能因为 settle 就重建（用户 m01622 要求复用同一个）。
    if (child) return child;
    // 并发保护：rta_start 的 start tick、onBind→rebind、45s interval tick 可能同时进来，
    // 若都在 startActivation 的 await 里看到 child===null 就会各建一个 child（实测 20:15:02
    // 一次启动建了两个子会话）。共享同一个 in-flight promise，只允许建一个。
    if (starting) return starting;
    const seq = startSeq;
    starting = (async () => {
      const childId = randomUUID();
      const controller = new AbortController();
      const activation = await subagents.startActivation({
        provider,
        childId, // 预留 childId → 本地 continuable 子代理（后续投递复用同一 child）
        label: 'rta-screen-summary',
        delivery: 'caller', // 结果不回父会话 → 主会话零唤醒
        signal: controller.signal,
        request: { prompt: [{ type: 'text', text: prompt }], parent: agent },
      });
      const id = activation?.childId ?? childId;
      // stop() 在这期间跑过：这个刚落地的 child 已不属于任何 RTA 会话，直接释放。
      if (seq !== startSeq) {
        try { subagents.interrupt(id, { kind: 'ancestor', agent }); } catch { /* absent */ }
        try { await subagents.drainChildren?.(agent, [id]); } catch { /* absent */ }
        return null;
      }
      const created = {
        id,
        provider,
        parentAgent: agent,
        parentSession: sessionIdOf(agent),
        controller,
        settled: false,
        startedAt: now(),
        prompts: 0,
        guard: null,
      };
      child = created;
      // 首轮之后每次投递都会 cold-resume，宿主会丢 delivery:'caller'；装过滤器止唤。
      const guard = acquireSettlementGuard(subagents);
      if (guard) {
        guard.children.add(id);
        created.guard = guard;
      }
      starts += 1;
      knownChildren.add({ id, agent });
      logger?.info?.(`[rta] summary child created (provider=${provider}, child=${String(id).slice(0, 8)})`);
      const result = activation?.result;
      if (result && typeof result.then === 'function') {
        result.then(
          () => { if (child?.id === id) child.settled = true; },
          (err) => { if (child?.id === id) child.settled = true; noteError('child', err); },
        );
      }
      return created;
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  /**
   * 给常驻子代理投递一轮 prompt：第一次用 activation 的初始 prompt，之后走 sybmol 通道
   * `deliverSubagentPrompt(parent, childId, content, source, signal, 'queue')`。
   */
  async function deliverPrompt(subagents, agent, provider, prompt, trigger) {
    // start tick / rebind / interval 可能并发进入；只允许一个在投递（否则会重复 prompt、覆盖 awaiting）。
    if (delivering) {
      lastSkip = 'busy-delivering';
      return false;
    }
    delivering = true;
    try {
      return await deliverPromptOnce(subagents, agent, provider, prompt, trigger);
    } finally {
      delivering = false;
    }
  }

  async function deliverPromptOnce(subagents, agent, provider, prompt, trigger) {
    const baseline = await readSummaryInfo().catch(() => ({ mtime: 0 }));
    const current = await ensureChild(subagents, agent, provider, prompt);
    if (!current) {
      // stop()/rebind 在创建期间发生：这个 child 已被作废，本轮直接放弃。
      lastSkip = 'stopped-during-start';
      return false;
    }
    const firstPrompt = current.prompts === 0;
    if (!firstPrompt) {
      const deliver = subagents[DELIVER_PROMPT];
      if (typeof deliver !== 'function') {
        throw new Error('subagents deliverPrompt channel is unavailable');
      }
      const signal = new AbortController().signal;
      await deliver.call(
        subagents,
        agent,
        current.id,
        [{ type: 'text', text: prompt }],
        { kind: 'user' },
        signal,
        'queue',
      );
    }
    current.prompts += 1;
    prompts += 1;
    awaiting = {
      at: now(),
      baselineMtime: baseline.mtime,
      trigger,
      timer: null,
      watcher: null,
    };
    const currentAwaiting = awaiting;
    const timerId = setTimeout(() => {
      if (!awaiting || awaiting !== currentAwaiting) return;
      noteError('timeout');
      try { current.controller?.abort?.(); } catch { /* ignore */ }
      void interruptChild('timeout');
      clearAwaiting();
    }, cfg.timeoutMs + 1_000);
    timerId.unref?.();
    currentAwaiting.timer = timerId;
    watchAwaiting();
    return true;
  }

  /**
   * 触发一次摘要。reason: 'interval' | 'event' | 'demand' | 'start'
   * force=true 时跳过 intervalMs（但仍有 eventMinGapMs 与 10 分钟预算）。
   */
  async function tickOnce({ reason = 'interval', force = false } = {}) {
    ticks += 1;
    if (!cfg.enabled) { lastSkip = 'disabled'; return false; }
    if (awaiting) { lastSkip = 'awaiting-summary'; return false; }
    const at = now();
    const engine = rt?.engine ?? null;
    if (!engine || engine.state !== 'running') { lastSkip = 'engine-idle'; return false; }
    const agent = rt?.bound?.agent ?? null;
    const sessionId = rt?.boundSessionId?.() ?? null;
    if (!agent || !sessionId) { lastSkip = 'no-binding'; return false; }

    const gap = reason === 'interval'
      ? cfg.intervalMs
      : reason === 'demand'
        ? Math.min(2_000, cfg.eventMinGapMs)
        : cfg.eventMinGapMs;
    if (at - lastPromptAt < gap) {
      lastSkip = force ? 'burst-gap' : 'interval';
      return false;
    }

    promptWindow = promptWindow.filter((t) => at - t < 600_000);
    if (promptWindow.length >= cfg.maxPer10Min) { lastSkip = 'rate-limited'; return false; }

    const text = String(digest() ?? '');
    if (!text) { lastSkip = 'empty-digest'; return false; }
    // digest 文字没变化 = 屏幕没新信息；主 agent 主动要求时仍然问一次（确认无变化）。
    if (text === lastDigest && reason !== 'demand') { lastSkip = 'same-digest'; return false; }

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
    const prompt = buildSummaryPrompt({ digest: text, prior, at, trigger: reason });
    lastPromptAt = at;
    lastTrigger = reason;
    lastDigest = text;
    promptWindow.push(at);
    try {
      const sent = await deliverPrompt(subagents, agent, provider, prompt, reason);
      if (sent !== true) {
        // 没投出去（stop 期间被作废 / 并发 tick 抢了投递）：把这一轮的预算与去重状态回滚。
        lastPromptAt = 0;
        lastDigest = '';
        promptWindow.pop();
        return false;
      }
      return true;
    } catch (err) {
      noteError('start', err);
      // 常驻 child 失效（被外部 drain / 会话结束 / 冷恢复不可用）时丢弃，下一次重建。
      child = null;
      return false;
    }
  }

  /**
   * 密集事件触发：engine push 的 cut/region/text/manual 或高分事件 → 防抖后触发一次摘要。
   * 由 lifecycle 在 engine 'push' 时调用；只做节流/防抖，不做重活。
   */
  function onScreenEvent(ev, at = now()) {
    if (!cfg.enabled || !cfg.eventEnabled) return false;
    if (!ev || typeof ev !== 'object') return false;
    const important = EVENT_KINDS.has(ev.kind) || Number(ev.score ?? 0) >= Number(cfg.eventMinScore ?? 18);
    if (!important) return false;
    lastEventAt = at;
    pendingEventAt = at;
    if (debounceTimer) return true;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const pending = pendingEventAt;
      pendingEventAt = 0;
      if (!pending) return;
      void tickOnce({ reason: 'event', force: true });
    }, Math.max(0, cfg.eventDebounceMs));
    debounceTimer.unref?.();
    return true;
  }

  /**
   * 主 agent 主动命令：立刻请求一版最新摘要，等待子代理写完（最多 waitMs）。
   * 返回 { ok, summary, summaryAt, trigger, reason }。
   */
  async function requestNow({ reason = 'demand', waitMs = cfg.demandWaitMs } = {}) {
    if (!cfg.enabled) return { ok: false, reason: 'disabled', summary: lastSummary, summaryAt: lastSummaryAt || null };
    const before = await readSummaryInfo().catch(() => ({ text: '', mtime: 0 }));
    // reason 只是调用方的说明；触发语义固定为 demand（跳过 digest 去重与周期间隔）。
    const started = await tickOnce({ reason: 'demand', force: true });
    if (!started && !awaiting) {
      const current = lastSummary || before.text;
      return { ok: false, reason: lastSkip ?? 'not-started', summary: current ? clip(current, MAX_SUMMARY_CHARS) : '', summaryAt: lastSummaryAt || null, trigger: 'demand', callerReason: reason };
    }
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    while (Date.now() < deadline) {
      await sleep(Math.max(5, Number(cfg.pollMs) || 500));
      const info = await readSummaryInfo().catch(() => null);
      if (info && info.mtime > Math.max(before.mtime, 0)) {
        lastSummary = clip(info.text, MAX_SUMMARY_CHARS);
        lastSummaryAt = info.mtime;
        return { ok: true, summary: lastSummary, summaryAt: lastSummaryAt, trigger: 'demand', callerReason: reason };
      }
      if (!awaiting) break;
    }
    const current = lastSummary || before.text;
    return { ok: false, reason: awaiting ? 'timeout' : 'no-new-summary', summary: current ? clip(current, MAX_SUMMARY_CHARS) : '', summaryAt: lastSummaryAt || null };
  }

  /**
   * 会话重新绑定（用户 m02194）：新会话 rta_start 时，engine 可能早就在跑
   * （engine.start 幂等、不再 emit 'start'），而第一次 tick 发生时绑定还没完成
   * （rta_start 的 bind 在工具 settle 里）。旧 child 的 parent agent 属于上一个
   * 会话，投递会 UNAUTHORIZED；必须清掉并在当前会话重建，否则新会话永远没有摘要。
   */
  async function rebind(agent) {
    if (!cfg.enabled) return false;
    if (!agent) return false;
    const sid = sessionIdOf(agent);
    if (!sid) return false;
    if (child && child.parentSession && child.parentSession !== sid) {
      await stop('rebind');
    } else if (child && !child.parentSession) {
      child.parentSession = sid;
      child.parentAgent = agent;
    }
    // 新绑定：丢掉上一段会话的 digest 去重状态，强制先要一版。
    lastDigest = '';
    const started = await tickOnce({ reason: 'start', force: true });
    if (!started && !awaiting) {
      // 兜底：某些启动顺序下绑定/引擎状态要过一两百毫秒才完成。
      const retry = setTimeout(() => { void tickOnce({ reason: 'start', force: true }); }, 1_500);
      retry.unref?.();
    }
    return started;
  }

  function schedule() {
    if (timer) return;
    timer = setInterval(() => { void tickOnce({ reason: 'interval' }); }, Math.max(2_000, Math.min(10_000, Math.floor(cfg.intervalMs / 3))));
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
    void stop('dispose').catch(() => {});
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
      prompts,
      errors,
      child: child ? String(child.id).slice(0, 8) : null,
      childAlive: Boolean(child),
      childSettled: Boolean(child?.settled),
      childSession: child?.parentSession ? String(child.parentSession).slice(0, 8) : null,
      settlementGuarded: Boolean(child?.guard),
      awaiting: Boolean(awaiting),
      ticks,
      lastSkip,
      lastTrigger,
      lastStartAt: lastPromptAt || null,
      lastEventAt: lastEventAt || null,
      summaryChars: lastSummary.length,
      summaryAgeMs: lastSummaryAt ? now() - lastSummaryAt : null,
      lastError,
    };
  }

  return {
    attach,
    dispose,
    stop,
    rebind,
    tickOnce,
    onScreenEvent,
    requestNow,
    latestSummary,
    summaryText: () => lastSummary,
    status,
  };
}
