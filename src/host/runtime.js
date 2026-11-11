/**
 * host/runtime.js — 插件生命周期的运行时容器：一个引擎单例 + 配置 + 日志 + 召唤推送。
 *
 * 引擎是懒创建的：插件加载时不抓屏、不占 CPU，第一次 rta_start / rta_look / Ctrl+Alt 才启动。
 * 插件卸载时（apply 返回的 disposer）把正在跑的会话正常结束掉，
 * 保证 manifest 里的 endedAt / retainUntil 是准的。
 *
 * 热键语义（用户确认）：
 *   - Ctrl+Alt：召唤一次并持续启用——只在引擎没跑时生效，由 summoner 的轻量轮询唤醒；
 *   - Shift+Ctrl+Alt：圈画（引擎内处理）；
 *   - Ctrl+Tab：退出本次 RTA（引擎在跑时由 engine 'exit' 事件收口）。
 */

import { createEngine } from '../engine/engine.js';
import { readRtaConfig, engineConfig, rtaConfigPath } from '../config.js';
import { createSummoner } from './summon.js';
import { serviceOf } from './service.js';
import { createOverlayHost } from './overlay.js';
import { createLiveLifecycle } from './lifecycle.js';

/** 只有这些工具算「RTA 实时面」——它们受单会话绑定约束。 */
const LIVE_TOOLS = new Set(['rta_start', 'rta_look', 'rta_region', 'rta_note']);

/** 会话 id 只露尾部，避免把整串 id 写进给模型看的拒绝文案里。 */
function shortSession(id) {
  const text = String(id ?? '');
  return text.length <= 10 ? text : `…${text.slice(-8)}`;
}

export function createRuntime({ ctx, env = process.env } = {}) {
  let engine = null;
  let disposed = false;
  let overlay = null;
  /**
   * 单会话绑定：同一时间 RTA 只服务一个会话（用户明确要求）。
   * rta_start 成功时绑定调用方会话；实时面工具从别的会话调用会被拒绝。
   */
  let bound = null; // { sessionId, agent }
  /** 引擎/绑定变化的外部钩子（持续注入用；不在这里直接创建注入器，保持运行时轻量）。 */
  const engineHooks = new Set();
  const bindHooks = new Set();
  let live = null;

  const logger = {
    info: (m) => { try { ctx?.logger?.info?.(m); } catch { /* ignore */ } },
    warn: (m) => { try { ctx?.logger?.warn?.(m); } catch { /* ignore */ } },
    error: (m) => { try { ctx?.logger?.error?.(m); } catch { /* ignore */ } },
  };

  const config = readRtaConfig(env);

  async function resolveSessionAgent(sessionId) {
    if (!sessionId) return null;
    const sc = serviceOf(ctx, 'sessionController');
    if (!sc || typeof sc.resolveAgent !== 'function') return null;
    try {
      const resolved = await sc.resolveAgent(sessionId);
      return resolved?.agent ?? null;
    } catch {
      return null;
    }
  }

  const summoner = createSummoner({
    logger,
    prompt: config.summonPrompt,
    cooldownMs: config.summonCooldownMs,
    resolveAgent: resolveSessionAgent,
    onIdleSummon: () => { void idleSummon(); },
  });

  function sessionIdOf(agent) {
    try {
      const id = agent?.session?.id;
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  }

  /** 订阅「引擎创建/可订阅」事件：注册时若引擎已存在立即回调；返回取消函数。 */
  function onEngine(fn) {
    if (typeof fn !== 'function') return () => {};
    engineHooks.add(fn);
    if (engine) {
      try { fn(engine); } catch (err) { logger.warn(`[rta] engine hook failed: ${err?.message ?? err}`); }
    }
    return () => { engineHooks.delete(fn); };
  }

  /** 订阅单会话绑定变化：fn(agent|null)。 */
  function onBind(fn) {
    if (typeof fn !== 'function') return () => {};
    bindHooks.add(fn);
    return () => { bindHooks.delete(fn); };
  }

  function emitBind(agent) {
    for (const fn of [...bindHooks]) {
      try { fn(agent); } catch (err) { logger.warn(`[rta] bind hook failed: ${err?.message ?? err}`); }
    }
  }

  /** 把 RTA 绑到某个 agent 所在会话（rta_start / Ctrl+Alt 召唤时调用）。 */
  function bindAgent(agent) {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return null;
    bound = { sessionId, agent };
    try { summoner.rememberAgent(agent); } catch { /* ignore */ }
    emitBind(agent);
    return sessionId;
  }

  function releaseBinding() {
    bound = null;
    emitBind(null);
  }

  function boundSessionId() {
    return bound?.sessionId ?? null;
  }

  /**
   * 实时面工具的单会话闸门：已绑定且调用方是另一个会话 → 拒绝并说明怎么切。
   * 没绑定（还没 rta_start）时放行，由 rta_start 自己完成绑定。
   */
  function gateTool(toolName, agent) {
    if (!LIVE_TOOLS.has(toolName) || !bound) return { ok: true };
    const caller = sessionIdOf(agent);
    if (!caller || caller === bound.sessionId) return { ok: true };
    return {
      ok: false,
      text: `RTA 正在服务另一个会话（${shortSession(bound.sessionId)}）。同一时间 RTA 只作用于单一会话：`
        + '要在这个会话使用，请先在原会话里 rta_stop 停掉当前采集（或回到原会话继续）。',
    };
  }

  /** 浮窗（Electron 全局置顶窗）宿主；引擎启动时拉起、停止时关掉。 */
  function overlayHost() {
    if (!overlay) overlay = createOverlayHost({ rt: api, logger, env });
    return overlay;
  }

  /**
   * 浮窗形态：Electron 全局置顶窗（ui/overlay）——跨应用/全屏可用的产品形态。
   * 玻璃 = 渲染层实时抓桌面（getDisplayMedia）→ 设计稿 blur(20px) → 原样叠设计稿图层；
   * 不依赖系统材质（tint/圆角/半径系统定，已被用户否决），也不开内容保护（远程桌面会看不见）。
   */
  function overlayEnabled() {
    const v = env?.DSH_RTA_OVERLAY;
    return !(v === '0' || v === 'false');
  }

  async function startOverlay() {
    try {
      await overlayHost().start();
    } catch (err) {
      logger.warn(`[rta] overlay start failed: ${err?.message ?? err}`);
    }
  }

  async function stopOverlay() {
    if (!overlay) return;
    try {
      await overlay.stop();
    } catch (err) {
      logger.warn(`[rta] overlay stop failed: ${err?.message ?? err}`);
    }
  }

  try {
    ctx?.on?.('session/event', (session) => {
      summoner.rememberSession(session?.header?.id ?? session?.id);
    });
  } catch { /* 测试上下文没有事件总线 */ }

  function ensure() {
    if (disposed) throw new Error('rta runtime already disposed');
    if (!engine) {
      engine = createEngine({
        logger,
        env,
        config: engineConfig(config),
      });
      try {
        engine.on('exit', () => { void stop({ reason: 'exit' }); });
        engine.on('stop', () => { if (!disposed) summoner.watch(); });
      } catch { /* 引擎事件总线不可用时，只剩 idle 轮询路径 */ }
      // 引擎刚建好：把「持续注入」的订阅挂上去（lifecycle 在 attach 时已注册钩子）。
      for (const fn of [...engineHooks]) {
        try { fn(engine); } catch (err) { logger.warn(`[rta] engine hook failed: ${err?.message ?? err}`); }
      }
    }
    return engine;
  }

  /** 引擎没跑时被热键唤醒：先起采集，再把召唤推进会话。 */
  async function idleSummon() {
    try {
      await start();
      if (!bound) {
        const sid = bindAgent(summoner.peekAgent?.());
        if (sid) logger.info(`[rta] bound to session ${shortSession(sid)} (idle-hotkey)`);
      }
      await summoner.notify({ reason: 'idle-hotkey' });
    } catch (err) {
      logger.warn(`[rta] idle summon failed: ${err?.message ?? err}`);
    }
  }

  /** 确保引擎在跑；返回引擎。 */
  async function start() {
    const e = ensure();
    if (e.state !== 'running') {
      await e.start({ config: engineConfig(config) });
      summoner.unwatch();
      logger.info(`[rta] recording started: ${e.sessionId} → ${e.store?.paths?.dir ?? ''}`);
    }
    // 浮窗生命周期 = RTA 生命周期；产品形态是 Electron 全局置顶窗（overlayEnabled 默认开）。
    if (overlayEnabled()) await startOverlay();
    return e;
  }

  async function stop({ reason = 'explicit' } = {}) {
    // 注意：引擎自己退出（Ctrl+Tab 触发 engine 'exit'）时，走到这里 engine.state 已经不是
    // running 了。以前这里直接 return，导致 summoner.watch() 没有被重新挂上 —— 表现就是
    // 「按过一次 Ctrl+Tab 之后，Ctrl+Alt 再也唤不醒 RTA」。所以早退分支也必须清浮窗 + 重挂热键。
    if (!engine || engine.state !== 'running') {
      await stopOverlay();
      if (!disposed) summoner.watch();
      return engine?.status?.() ?? null;
    }
    const out = await engine.stop({ reason });
    await stopOverlay();
    if (!disposed) summoner.watch();
    return out;
  }

  /** 插件加载后调用一次：引擎没跑时也能被 Ctrl+Alt 唤醒。 */
  function watchForSummon() {
    if (!disposed) summoner.watch();
  }

  /**
   * 装配「启用即持续注入」：文本走 systemPrompt.context，图片走 agent/pre-step。
   * 幂等；宿主能力不足时 lifecycle 自己降级成 pull，不影响工具面。
   */
  function attachLive() {
    if (disposed) return null;
    if (!live) {
      try {
        live = createLiveLifecycle({ rt: api, logger });
        live.attach();
      } catch (err) {
        logger.warn(`[rta] live injection attach failed: ${err?.message ?? err}`);
        live = null;
      }
    }
    return live;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    try { live?.dispose(); } catch { /* ignore */ }
    live = null;
    summoner.dispose();
    await stopOverlay();
    try {
      if (engine?.state === 'running') await engine.stop({ reason: 'plugin-dispose' });
    } catch (err) {
      logger.warn(`[rta] dispose stop failed: ${err?.message ?? err}`);
    }
    engine = null;
    bound = null;
  }

  const api = {
    get ctx() { return ctx; },
    get engine() { return engine; },
    get config() { return config; },
    get summoner() { return summoner; },
    configPath: rtaConfigPath(env),
    logger,
    ensure,
    start,
    stop,
    watchForSummon,
    dispose,
    /** 持续注入的装配入口（index.js 在注册完工具后调用一次）。 */
    attachLive,
    onEngine,
    onBind,
    get lifecycle() { return live; },
    /** 工具调用时把调用方 agent 记下来（召唤/主动推送要用）。 */
    rememberAgent: (agent) => summoner.rememberAgent(agent),
    rememberSession: (id) => summoner.rememberSession(id),
    /** 手动触发一次召唤推送（测试/调试用）。 */
    summon: (opts) => summoner.notify(opts),
    /** 单会话绑定（rta_start / 召唤成功后由工具层绑定）。 */
    bindAgent,
    releaseBinding,
    boundSessionId,
    get bound() { return bound ? { sessionId: bound.sessionId } : null; },
    /** 实时面工具的单会话闸门（见 gateTool）。 */
    gateTool,
    /** 全局浮窗宿主（Electron）。 */
    get overlay() { return overlay; },
    startOverlay,
    stopOverlay,
  };
  return api;
}
