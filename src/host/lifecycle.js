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
import { buildScreenMessage, buildImageCaption } from './messages.js';
import { attachRgb } from './service.js';
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

  let channel = null;
  let attached = false;
  let disposed = false;
  let tickTimer = null;
  let engineOffs = [];
  let engineHookOff = null;
  let bindHookOff = null;
  let lastImageAt = 0;
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
        logger?.info?.(`[rta] live buffer armed: ${sessionId ?? 'unknown'}`);
      }));
      engineOffs.push(engine.on('push', (ev) => {
        if (disposed) return;
        try {
          buffer.push(ev, now());
          injector.flush();
        } catch (err) {
          noteError('push', err);
        }
      }));
      engineOffs.push(engine.on('stop', (info) => {
        if (disposed) return;
        buffer.beat({ at: now(), running: false });
        injector.stop(info?.reason ?? 'explicit');
        logger?.info?.(`[rta] live buffer stopped (${info?.reason ?? 'explicit'})`);
      }));
      engineOffs.push(engine.on('exit', () => {
        if (disposed) return;
        buffer.beat({ at: now(), running: false });
        injector.stop('exit');
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
  }

  // ── 图片通道：每轮首步最多一张 ───────────────────────────────────────
  async function imageMessageFor(payload) {
    if (disposed || !governor.enabled) return null;
    if (!isBoundAgent(payload?.agent)) return null;
    // step 从 1 起：只在「本轮第一条用户消息之后的第一步」抓，避免每步都抓。
    if (Number(payload?.step) !== 1) return null;

    const at = now();
    const token = governor.tryAcquire(at);
    if (!token) return null;

    let settled = false;
    try {
      const engine = rt?.engine ?? null;
      if (!engine || engine.state !== 'running' || typeof engine.composeRecent !== 'function') return null;

      const maxFrames = Number(imageConfig.maxFrames) > 0 ? Math.min(6, imageConfig.maxFrames) : 4;
      const maxTokens = Number(imageConfig.maxSheetTokens) > 0 ? imageConfig.maxSheetTokens : 400;
      const composed = engine.composeRecent({ count: maxFrames, maxTokens });
      if (!composed?.rgb || !composed?.width || !composed?.height) return null;

      const stamp = composed.frames?.[0]?.seq ?? at;
      const name = `rta-auto-${stamp}-${at}.png`;
      const ref = await attachRgb(rt?.ctx, {
        rgb: composed.rgb,
        width: composed.width,
        height: composed.height,
        name,
      });
      if (!ref) {
        // 宿主没有 attachments 服务（或预算拒绝）：静默退回纯文本通道，但留一条可诊断的记录。
        noteError('screenshot', 'attachRgb returned null (no attachments service?)');
        return null;
      }

      governor.commit(token, at);
      settled = true;
      lastImageAt = at;
      imagesInjected += 1;
      logger?.info?.(`[rta] auto screenshot injected (${composed.plan?.count ?? composed.frames?.length ?? '?'} frames)`);

      // 消息由宿主在 pre-step 返回后落盘；稍等再通知 offload（它自己有 30s 节流）。
      setTimeout(() => {
        try { notifyDelivery(); } catch { /* ignore */ }
      }, 1000);

      let foreground = null;
      try { foreground = buffer.snapshot().foreground; } catch { foreground = null; }
      return buildScreenMessage({
        text: buildImageCaption({ frames: composed.frames ?? [], foreground, at }),
        images: [ref],
        summary: 'RTA 自动截图（插件注入）',
      });
    } catch (err) {
      noteError('screenshot', err);
      return null;
    } finally {
      // 失败路径（含提前 return null）要归还在飞名额；成功路径已 commit。
      if (!settled) governor.abort();
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
        images: imageMessageFor,
      });
    } catch (err) {
      noteError('channel', err);
    }
    try {
      engineHookOff = rt?.onEngine?.((engine) => subscribeEngine(engine)) ?? null;
    } catch (err) {
      noteError('onEngine', err);
    }
    try {
      bindHookOff = rt?.onBind?.((agent) => {
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
    get attached() { return attached; },
  };
  return api;
}
