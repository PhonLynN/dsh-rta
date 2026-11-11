/**
 * host/lifecycle.js — 「启用即持续注入」的装配与生命周期。
 *
 * 数据流：
 *   engine 'push' ─► live-buffer.push ─┐
 *   status 轮询   ─► live-buffer.beat/setForeground ─┤
 *   1Hz tick      ─► injector.tick ─► 文本变化？ ─► channel(systemPrompt.context)
 *   agent/pre-step ─► 每轮首步一张图（节流/预算） ─► channel(pre-step 消息)
 *
 * 三条硬规则（docs/review/03）：
 *   - 只追加，不改历史：文本通道交给宿主自己落 runtime-context 快照；
 *   - 自动流永不唤醒会话：本模块从不 followup/steer，注入只在「本来就要跑的一步」生效；
 *   - 全部硬封顶：条数/分钟、文本 token、图片张数/间隔/在飞数都在 config.inject 里。
 *
 * 绑定语义：只有 runtime 绑定的那个会话会看到注入（单会话产品约束）。
 * 子代理的 session id 不同，自然被排除；另外再按 header.parentSession 兜一层。
 */

import { createLiveBuffer } from './live-buffer.js';
import { createInjector, createImageGovernor } from './injector.js';
import { createScreenChannel } from './channel.js';
import { createSummarizer } from './summarizer.js';
import { buildScreenMessage, buildImageCaption, buildHdCaption } from './messages.js';
import { pickInformativeFrames, extractHdFrame, nativeFrameSize, makeHdDir, cleanHdDir } from './hd.js';
import { attachRgb, attachPngFile } from './service.js';
import { notifyDelivery } from './offload.js';

const TICK_MS = 1000;

export function createLiveLifecycle({ rt, logger = rt?.logger } = {}) {
  const injectConfig = rt?.config?.inject ?? {};
  const imageConfig = injectConfig.image ?? {};

  const buffer = createLiveBuffer({ maxEvents: 64 });
  const injector = createInjector({
    config: injectConfig,
    buffer,
    logger,
    onPublish: ({ count, at }) => {
      logger?.info?.(`[rta] screen context update #${count} @ ${new Date(at).toLocaleTimeString()}`);
    },
  });
  const governor = createImageGovernor({ config: imageConfig });
  /**
   * 后台摘要子代理：主会话不打断（delivery:'caller'），只把摘要写进 rta_note；
   * 这里读回最新摘要，拼进 runtime-context 文本 → 主 agent 下一步被动可见。
   */
  const summarizer = createSummarizer({
    rt,
    logger,
    config: injectConfig.summarizer ?? {},
    digest: () => {
      try { return buffer.digest(now(), injectConfig); } catch { return ''; }
    },
  });

  let channel = null;
  let attached = false;
  let disposed = false;
  let tickTimer = null;
  let engineOffs = [];
  let engineHookOff = null;
  let bindHookOff = null;
  let lastImageAt = 0;
  let lastSummarySeenAt = 0;
  let lastSummarySeenText = '';
  let startNoticePending = false;
  let imagesInjected = 0;
  let lastError = null;

  const now = () => Date.now();

  function noteError(where, err) {
    lastError = `${where}: ${err?.message ?? err}`;
    logger?.warn?.(`[rta] ${lastError}`);
  }

  /** 只有 runtime 绑定的主会话算数；子代理按 header 再排一次。 */
  function isBoundAgent(agent) {
    try {
      const sid = rt?.boundSessionId?.() ?? null;
      if (!sid || !agent) return false;
      const header = agent.header ?? null;
      if (header && header.parentSession !== undefined) return false;
      if (header && Number(header.delegationDepth) > 0) return false;
      return agent.session?.id === sid;
    } catch {
      return false;
    }
  }

  /** 文本通道的 text 回调：宿主每步都会调，必须快、必须永不抛。 */
  function textForContext(context) {
    try {
      return isBoundAgent(context?.agent) ? injector.text() : '';
    } catch {
      return '';
    }
  }

  // ── 引擎事件 → 活缓冲 ────────────────────────────────────────────────
  function subscribeEngine(engine) {
    if (!engine || typeof engine.on !== 'function' || disposed) return;
    for (const off of engineOffs) {
      try { off?.(); } catch { /* ignore */ }
    }
    engineOffs = [];

    const sessionIdOf = (status) => status?.session?.id ?? status?.sessionId ?? engine.sessionId ?? null;

    try {
      engineOffs.push(engine.on('start', (status) => {
        const sessionId = sessionIdOf(status);
        buffer.reset({ sessionId, at: now(), running: true });
        injector.start({ sessionId });
        startNoticePending = true;
        logger?.info?.(`[rta] live buffer armed: ${sessionId ?? 'unknown'}`);
        // 启动即要一版摘要（可能还没绑定会话，tickOnce 会跳过，下一轮 1Hz tick 重试）。
        void summarizer.tickOnce({ reason: 'start', force: true }).catch(() => {});
      }));
      engineOffs.push(engine.on('push', (ev) => {
        if (disposed) return;
        try {
          buffer.push(ev, now());
          injector.flush();
        } catch (err) {
          noteError('push', err);
        }
        // 密集事件触发摘要（用户 m01656）：cut/圈选/文字变化或高分事件 → 防抖后问一次子代理。
        try {
          summarizer.onScreenEvent(ev, now());
        } catch (err) {
          noteError('push-summarizer', err);
        }
      }));
      engineOffs.push(engine.on('stop', (info) => {
        if (disposed) return;
        buffer.beat({ at: now(), running: false });
        injector.stop(info?.reason ?? 'explicit');
        // rta 结束：打断并释放这个会话唯一的摘要子代理（用户 m01622）。
        void summarizer.stop(info?.reason ?? 'explicit').catch((err) => noteError('stop-summarizer', err));
        logger?.info?.(`[rta] live buffer stopped (${info?.reason ?? 'explicit'})`);
      }));
      engineOffs.push(engine.on('exit', () => {
        if (disposed) return;
        buffer.beat({ at: now(), running: false });
        injector.stop('exit');
        void summarizer.stop('exit').catch((err) => noteError('stop-summarizer', err));
      }));
    } catch (err) {
      noteError('engine-subscribe', err);
    }

    // 插件热重载 / 后加载：引擎已经跑着，补一次「已启用」状态，让下一轮立刻有内容。
    try {
      if (engine.state === 'running') {
        const sessionId = engine.sessionId ?? null;
        buffer.reset({ sessionId, at: now(), running: true });
        injector.start({ sessionId });
      }
    } catch (err) {
      noteError('engine-attach', err);
    }
  }

  // ── 1Hz 轮询：采集新鲜度 + 前台窗口 + 文本发布 ───────────────────────
  function onTick() {
    if (disposed) return;
    let engine = null;
    try { engine = rt?.engine ?? null; } catch { engine = null; }
    const running = Boolean(engine && engine.state === 'running');
    try {
      if (running) {
        buffer.beat({ at: now(), running: true });
        const status = typeof engine.status === 'function' ? engine.status() : null;
        if (status?.foreground) buffer.setForeground(status.foreground, now());
      } else if (buffer.running) {
        buffer.beat({ at: now(), running: false });
      }
    } catch (err) {
      noteError('tick-status', err);
    }
    try {
      injector.tick();
    } catch (err) {
      noteError('tick-inject', err);
    }
    // 摘要子代理：tickOnce 自带间隔/digest/在飞去重，1Hz 调一次是安全的。
    try {
      void summarizer.tickOnce();
    } catch (err) {
      noteError('tick-summarizer', err);
    }
  }

  // ── 每轮首步的「材料」：最新摘要 + 启动告知 + 一张 HD 截图 ─────────────
  // 用户 m00963：启动 rta 要让主 agent 知晓；每次用户发消息时，主动去子代理要
  // 「刚刚产生的摘要」，让主 agent 知道刚刚发生了什么。
  async function turnMaterialsFor(payload) {
    if (disposed) return null;
    if (!isBoundAgent(payload?.agent)) return null;
    if (Number(payload?.step) !== 1) return null; // 每轮只做一次

    const at = now();
    const blocks = [];

    // 1) 后台摘要子代理的最新摘要：每轮主动读 notes/，不用缓存。
    let summary = '';
    try {
      summary = await summarizer.latestSummary();
    } catch { summary = ''; }
    const ageMs = summarizer.status().summaryAgeMs;
    const summaryAt = Number.isFinite(ageMs) ? at - ageMs : 0;
    if (summary && (summaryAt > lastSummarySeenAt || summary !== lastSummarySeenText)) {
      const mins = Math.max(0, Math.round((at - summaryAt) / 60_000));
      blocks.push(`〔RTA 屏幕摘要（后台子代理·${mins <= 0 ? '刚刚' : `约 ${mins} 分钟前`}）〕\n${summary}`);
      lastSummarySeenAt = summaryAt;
      lastSummarySeenText = summary;
    }

    // 2) 启动告知：rta_start 之后、主会话第一次进入步骤时说明一次。
    if (startNoticePending) {
      startNoticePending = false;
      const engine = rt?.engine ?? null;
      let sid = engine?.sessionId ?? null;
      try { sid = sid ?? engine?.status?.()?.session?.id ?? null; } catch { /* ignore */ }
      blocks.push(`〔RTA 已启动〕屏幕感知已开启（session ${sid ?? 'unknown'}）。之后每步的 runtime-context 会带屏幕状态与后台摘要；需要原图用 rta_look，更早历史用 rta_recall(images:true)。`);
    }

    // 3) 一张预算内的 HD 截图（没预算就只给文字）。
    let shot = null;
    try {
      shot = await screenshotFor(payload, at);
    } catch (err) {
      noteError('screenshot', err);
    }
    if (shot?.caption) blocks.push(shot.caption);
    if (!blocks.length) return null;

    return buildScreenMessage({
      text: blocks.join('\n\n'),
      images: shot?.ref ? [shot.ref] : [],
      summary: shot ? 'RTA 高清截图 + 后台摘要（插件注入）' : 'RTA 屏幕摘要（插件注入）',
    });
  }

  /** 每轮首步最多一张 HD 截图（保留节流/预算/拼图回落逻辑）。 */
  async function screenshotFor(payload, at) {
    if (disposed || !governor.enabled) return null;
    if (!isBoundAgent(payload?.agent)) return null;
    const token = governor.tryAcquire(at);
    if (!token) return null;

    let settled = false;
    try {
      const engine = rt?.engine ?? null;
      if (!engine || engine.state !== 'running') return null;

      let foreground = null;
      try { foreground = buffer.snapshot().foreground; } catch { foreground = null; }

      const hd = await hdShot(engine, at, foreground);
      let ref = hd?.ref ?? null;
      let caption = hd?.caption ?? null;

      if (!ref && typeof engine.composeRecent === 'function') {
        // 回落：录像不可用（刚启动 / 无 ffmpeg / 抽帧失败）时用 eventRing 拼图。
        const maxFrames = Number(imageConfig.maxFrames) > 0 ? Math.min(6, imageConfig.maxFrames) : 4;
        const maxTokens = Number(imageConfig.maxSheetTokens) > 0 ? imageConfig.maxSheetTokens : 400;
        const composed = engine.composeRecent({ count: maxFrames, maxTokens });
        if (!composed?.rgb || !composed?.width || !composed?.height) return null;
        const stamp = composed.frames?.[0]?.seq ?? at;
        ref = await attachRgb(rt?.ctx, {
          rgb: composed.rgb,
          width: composed.width,
          height: composed.height,
          name: `rta-auto-${stamp}-${at}.png`,
        });
        if (!ref) {
          noteError('screenshot', 'attachRgb returned null (no attachments service?)');
          return null;
        }
        caption = buildImageCaption({ frames: composed.frames ?? [], foreground, at });
        logger?.info?.(`[rta] auto screenshot injected (${composed.plan?.count ?? composed.frames?.length ?? '?'} frames, sheet fallback)`);
      }
      if (!ref) return null;

      governor.commit(token, at);
      settled = true;
      lastImageAt = at;
      imagesInjected += 1;
      if (hd?.ref) logger?.info?.(`[rta] HD screenshot injected (${hd.width}x${hd.height})`);

      // 消息由宿主在 pre-step 返回后落盘；稍等再通知 offload（它自己有 30s 节流）。
      setTimeout(() => {
        try { notifyDelivery(); } catch { /* ignore */ }
      }, 1000);

      return { ref, caption, summary: hd ? 'RTA 高清截图（插件注入）' : 'RTA 自动截图（插件注入）' };
    } finally {
      if (!settled) governor.abort();
    }
  }

  /** 从原生录像抽一张「本轮前最值得看」的 HD 帧；失败返回 null（调用方回落拼图）。 */
  async function hdShot(engine, at, foreground) {
    if (!imageConfig.hd) return null;
    if (typeof engine.frameAt !== 'function') return null;
    const events = Array.isArray(engine.eventRing) ? engine.eventRing.slice(-128) : [];
    const picked = pickInformativeFrames(events, { limit: 1, now: at, maxAgeMs: 180_000 });
    if (!picked.length) return null;
    const size = nativeFrameSize(engine);
    const dir = await makeHdDir();
    try {
      const shot = await extractHdFrame(engine, picked[0].ev, {
        dir,
        foreground,
        frameWidth: size.width,
        frameHeight: size.height,
        maxWidth: Number(imageConfig.hdMaxWidth) > 0 ? Number(imageConfig.hdMaxWidth) : 1600,
      });
      if (!shot.ok) return null;
      const ref = await attachPngFile(rt?.ctx, { file: shot.path, name: `rta-hd-${picked[0].ev?.seq ?? at}-${at}.jpg` });
      if (!ref) return null;
      return {
        ref,
        width: shot.width,
        height: shot.height,
        caption: buildHdCaption({ event: picked[0].ev, foreground, hd: shot, at }),
      };
    } finally {
      void cleanHdDir(dir);
    }
  }

  function attach() {
    if (attached || disposed) return api;
    attached = true;
    try {
      channel = createScreenChannel({
        ctx: rt?.ctx,
        logger,
        text: textForContext,
        images: turnMaterialsFor,
      });
    } catch (err) {
      noteError('channel', err);
    }
    try {
      engineHookOff = rt?.onEngine?.((engine) => subscribeEngine(engine)) ?? null;
    } catch (err) {
      noteError('onEngine', err);
    }
    // 摘要子代理自己也有定时器；1Hz tick 里也会兜底驱动 tickOnce。
    try {
      const res = summarizer.attach();
      if (res && res.ok === false) logger?.info?.(`[rta] summarizer not started (${res.reason})`);
    } catch (err) {
      noteError('summarizer-attach', err);
    }
    try {
      bindHookOff = rt?.onBind?.((agent) => {
        if (isBoundAgent(agent) && rt?.engine?.state === 'running') startNoticePending = true;
        // 新绑定：让下一轮 assemble 立刻带上屏幕状态（文本本身仍由 tick 计算）。
        if (isBoundAgent(agent)) injector.flush({ force: false });
      }) ?? null;
    } catch (err) {
      noteError('onBind', err);
    }
    tickTimer = setInterval(onTick, TICK_MS);
    // 不因为这个轮询阻止进程退出（插件卸载时正式清掉）。
    if (typeof tickTimer?.unref === 'function') tickTimer.unref();
    logger?.info?.(`[rta] live injection attached (channel=${channel?.mode ?? 'none'})`);
    return api;
  }

  function status() {
    let snapshot = null;
    try { snapshot = buffer.snapshot(); } catch { snapshot = null; }
    return {
      enabled: injectConfig.enabled !== false,
      attached,
      channel: channel?.mode ?? 'none',
      text: injector.stats(),
      image: { ...governor.stats(), injected: imagesInjected, lastAt: lastImageAt },
      buffer: snapshot,
      summarizer: summarizer.status(),
      summary: summarizer.summaryText().slice(0, 240),
      lastError,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    for (const off of engineOffs) {
      try { off?.(); } catch { /* ignore */ }
    }
    engineOffs = [];
    try { engineHookOff?.(); } catch { /* ignore */ }
    try { bindHookOff?.(); } catch { /* ignore */ }
    engineHookOff = null;
    bindHookOff = null;
    try { channel?.dispose(); } catch { /* ignore */ }
    channel = null;
    try { injector.dispose(); } catch { /* ignore */ }
    try { summarizer.dispose(); } catch { /* ignore */ }
  }

  const api = {
    attach,
    dispose,
    status,
    /** 给 rta_status / 浮窗用的即时摘要（不会触发注入）。 */
    digest: () => {
      try { return buffer.digest(now(), injectConfig); } catch { return ''; }
    },
    isBoundAgent,
    get buffer() { return buffer; },
    get injector() { return injector; },
    get channel() { return channel; },
    get summarizer() { return summarizer; },
    get attached() { return attached; },
  };
  return api;
}
