/**
 * host/injector.js — 「什么时候注入、注入什么文本」的节流器。
 *
 * 屏幕是状态，不是队列（docs/review/03 C3）：注入器不做排队，它只做三件事：
 *   1. 每秒（tick）向 live-buffer 要一份 digest；
 *   2. 文本没变就什么都不做 —— 这是「静止屏幕不刷历史」的关键；
 *   3. 文本变了也要过掉最小间隔与每分钟上限，防止抖屏刷屏。
 *
 * 图片有独立的预算（更稀缺）：每轮最多一张、两次之间至少一分钟级、十分钟内封顶，
 * 并且同一时刻只允许一个请求在飞。text 通道永远不受图片预算影响（文字必带，C4）。
 *
 * 本模块不做 I/O，也不碰宿主 API：便于单测与替换。
 */

import { renderStopped } from './live-buffer.js';

/**
 * @param {object} input
 * @param {object} input.config inject 配置（见 config.js DEFAULT_RTA_CONFIG.inject）
 * @param {ReturnType<import('./live-buffer.js').createLiveBuffer>} input.buffer
 * @param {object} [input.logger]
 * @param {() => number} [input.now]
 * @param {(text: string) => void} [input.onPublish]
 */
export function createInjector({ config = {}, buffer, logger, now = Date.now, onPublish } = {}) {
  let started = false;
  let disposed = false;
  let currentText = '';
  let lastPublishedAt = 0;
  let publishTimes = [];
  let publishCount = 0;
  let lastReason = '';
  let lastError = null;

  const minIntervalMs = Number(config.minIntervalMs) > 0 ? config.minIntervalMs : 4000;
  const maxPerMinute = Number(config.maxPerMinute) > 0 ? config.maxPerMinute : 8;

  function digestOpts() {
    return {
      eventTtlMs: Number(config.eventTtlMs) > 0 ? config.eventTtlMs : 120_000,
      maxEvents: Number(config.maxEvents) > 0 ? config.maxEvents : 4,
      maxLines: Number(config.maxLines) > 0 ? config.maxLines : 12,
      maxTextTokens: Number(config.maxTextTokens) > 0 ? config.maxTextTokens : 400,
    };
  }

  function computeText(at) {
    try {
      return buffer?.digest?.(at, digestOpts()) ?? '';
    } catch (err) {
      lastError = `digest: ${err?.message ?? err}`;
      logger?.warn?.(`[rta] live digest failed: ${lastError}`);
      return '';
    }
  }

  /** 计算并按节流规则发布一次。返回是否真的改写了 currentText。 */
  function flush({ force = false } = {}) {
    if (disposed || config.enabled === false) return false;
    if (!started) return false;
    const at = now();
    const cutoff = at - 60_000;
    publishTimes = publishTimes.filter((t) => t > cutoff);

    const next = computeText(at);
    if (!next || next === currentText) return false;

    if (!force) {
      const sinceLast = at - lastPublishedAt;
      if (publishedAtRecently() && sinceLast < minIntervalMs) return false;
      if (publishTimes.length >= maxPerMinute) {
        lastReason = 'rate-limited';
        return false;
      }
    }

    currentText = next;
    lastPublishedAt = at;
    publishTimes.push(at);
    publishCount += 1;
    lastReason = force ? 'forced' : 'changed';
    try {
      onPublish?.({ text: next, at, count: publishCount });
    } catch { /* 回调失败不能影响注入 */ }
    return true;
  }

  function publishedAtRecently() {
    return lastPublishedAt > 0;
  }

  /** 开一条新的采集会话：丢掉旧文本，第一条 digest 立刻可见（空文本 = 什么都不注入）。 */
  function start({ sessionId = null } = {}) {
    if (disposed || config.enabled === false) return;
    started = true;
    currentText = '';
    lastPublishedAt = 0;
    publishTimes = [];
    publishCount = 0;
    lastReason = 'start';
    lastError = null;
    logger?.info?.(`[rta] live inject armed${sessionId ? ` for ${String(sessionId).slice(-8)}` : ''}`);
    flush({ force: true });
  }

  /** 采集结束：让上下文里最后的状态变成「已停止」，而不是停在上一帧。 */
  function stop(reason = 'explicit') {
    if (disposed) return;
    started = false;
    try {
      currentText = renderStopped(reason);
    } catch {
      currentText = '';
    }
    lastReason = 'stopped';
    lastPublishedAt = 0;
    publishTimes = [];
  }

  /** 1Hz 心跳驱动：数据源还活着时重算 digest（文本不变则零副作用）。 */
  function tick() {
    if (!started || disposed) return false;
    return flush();
  }

  function stats() {
    let snap = null;
    try { snap = buffer?.snapshot?.() ?? null; } catch { snap = null; }
    return {
      enabled: config.enabled !== false,
      armed: started,
      publishes: publishCount,
      lastPublishAt: lastPublishedAt,
      lastReason,
      lastError,
      textLength: currentText.length,
      text: currentText,
      sample: snap
        ? {
          rev: snap.rev,
          events: Array.isArray(snap.events) ? snap.events.length : 0,
          foreground: snap.foreground?.title ?? null,
        }
        : null,
    };
  }

  function dispose() {
    disposed = true;
    started = false;
    currentText = '';
  }

  return {
    start,
    stop,
    tick,
    flush,
    stats,
    dispose,
    text: () => currentText,
    get started() { return started; },
    get publishes() { return publishCount; },
  };
}

/**
 * 图片预算器：文字必带、图片稀缺（docs/review/03 C4）。
 * 计数以「真的把图交出去了」为准，失败调用要 abort 归还在飞名额。
 */
export function createImageGovernor({ config = {}, now = Date.now } = {}) {
  let lastAt = null;
  let times = [];
  let inFlight = 0;

  const enabled = config.enabled !== false;
  const minIntervalMs = Number(config.minIntervalMs) > 0 ? config.minIntervalMs : 45_000;
  const windowMs = Number(config.windowMs) > 0 ? config.windowMs : 600_000;
  const maxPerWindow = Number(config.maxPerWindow) > 0 ? config.maxPerWindow : 6;
  const maxInFlight = Number(config.maxInFlight) > 0 ? config.maxInFlight : 1;

  function tryAcquire(at = now()) {
    if (!enabled) return null;
    if (lastAt !== null && at - lastAt < minIntervalMs) return null;
    times = times.filter((t) => at - t < windowMs);
    if (times.length >= maxPerWindow) return null;
    if (inFlight >= maxInFlight) return null;
    inFlight += 1;
    return { at };
  }

  function commit(token, at = now()) {
    inFlight = Math.max(0, inFlight - 1);
    if (!token) return;
    lastAt = at;
    times.push(at);
  }

  function abort() {
    inFlight = Math.max(0, inFlight - 1);
  }

  function stats() {
    return { enabled, lastAt, count: times.length, inFlight, minIntervalMs, maxPerWindow };
  }

  return { tryAcquire, commit, abort, stats, get enabled() { return enabled; } };
}
