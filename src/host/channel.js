/**
 * host/channel.js — 把 RTA 接进 DSH 宿主的两条通道（能力探测 + 降级）。
 *
 * 通道一（主）：`ctx.systemPrompt.context({...})`。宿主每步 assemble 一次，
 *   **只在文本变化时**落一条 runtime-context 快照（App 里显示为「运行环境」类消息），
 *   并自动声明旧快照被取代。这正是「持续感知」该有的形状：不变就什么都不落。
 *
 * 通道二（图）：`agent/pre-step` 的 prepend 处理器。文本通道只能带字，图片必须作为
 *   一条消息进会话（否则 image/offload 也看不到它）。每轮最多一条，且由 lifecycle 节流。
 *
 * 两个都拿不到（老宿主/测试上下文）时保持 mode='pull'：工具照常可用，只是不再自动注入。
 */

import { serviceOf } from './service.js';

const CONTEXT_NAME = 'rta:screen';
/**
 * 排在宿主内置上下文（WORKING_DIRECTORY=100 … HARNESS_SOURCE=200）之后、WEB_SURFACE=210 附近。
 * RTA 不在宿主的 CONTEXT_ORDERS 表里，getContextOrder() 返回 undefined，所以用固定数字（见 04 §11）。
 */
const CONTEXT_ORDER = 205;

function safeWarn(logger, message) {
  try { logger?.warn?.(message); } catch { /* ignore */ }
}

/**
 * @param {object} input
 * @param {object} input.ctx 插件 ctx（cordis）
 * @param {object} [input.logger]
 * @param {(context: object) => string} input.text 返回当前注入文本；返回 '' 表示不注入
 * @param {(payload: object) => (object|Promise<object|null>|null)} [input.images] 返回一条带图消息或 null
 * @param {string} [input.name]
 * @param {number} [input.order]
 */
export function createScreenChannel({
  ctx,
  logger,
  text,
  images,
  name = CONTEXT_NAME,
  order = CONTEXT_ORDER,
} = {}) {
  const disposers = [];
  const modes = [];
  let disposed = false;

  const safeText = (context) => {
    try {
      const value = text?.(context);
      return typeof value === 'string' ? value : '';
    } catch (err) {
      safeWarn(logger, `[rta] prompt context text failed: ${err?.message ?? err}`);
      return '';
    }
  };

  // ── 通道一：system prompt runtime context ──────────────────────────────
  let contextRegistered = false;

  const registerContext = (sp) => {
    if (contextRegistered || disposed) return;
    if (!sp || typeof sp.context !== 'function') return;
    try {
      let orderValue = order;
      try {
        const resolved = typeof sp.getContextOrder === 'function' ? sp.getContextOrder(name) : undefined;
        if (Number.isFinite(Number(resolved))) orderValue = Number(resolved);
      } catch { /* 未知名字：用数字 order 兜底 */ }
      const off = sp.context({
        name,
        order: orderValue,
        // 必须 false：注入文本里出现 {{ }} 时模板插值会抛错。
        interpolate: false,
        text: safeText,
      });
      if (typeof off === 'function') disposers.push(off);
      contextRegistered = true;
      modes.push('context');
    } catch (err) {
      safeWarn(logger, `[rta] systemPrompt.context unavailable: ${err?.message ?? err}`);
    }
  };

  try {
    const sp = serviceOf(ctx, 'systemPrompt');
    if (sp) registerContext(sp);
    // 插件 apply 可能早于 systemPrompt 服务就绪：用它自己的 inject 延迟注册
    // （生产写法，见 dsh-sandbox-policy / 04 §1）。
    if (!contextRegistered && typeof ctx?.inject === 'function') {
      const off = ctx.inject(['systemPrompt'], (scope) => {
        try {
          registerContext(serviceOf(scope ?? ctx, 'systemPrompt'));
        } catch (err) {
          safeWarn(logger, `[rta] systemPrompt inject callback failed: ${err?.message ?? err}`);
        }
      });
      if (typeof off === 'function') disposers.push(off);
    }
  } catch (err) {
    safeWarn(logger, `[rta] systemPrompt.context unavailable: ${err?.message ?? err}`);
  }

  // ── 通道二：agent/pre-step 带图消息 ───────────────────────────────────
  let preStepRegistered = false;
  if (typeof ctx?.on === 'function' && typeof images === 'function') {
    try {
      const dispose = ctx.on('agent/pre-step', async (payload, next) => {
        // cordis waterfall：必须恰好 await next() 一次。
        const decision = await next();
        if (disposed || !decision || decision.kind === 'reject') return decision;
        try {
          if (payload?.signal?.aborted) return decision;
          const message = await images(payload);
          if (!message) return decision;
          return { ...decision, messages: [...(decision.messages ?? []), message] };
        } catch (err) {
          safeWarn(logger, `[rta] pre-step injection failed: ${err?.message ?? err}`);
          return decision;
        }
      }, { prepend: true });
      if (typeof dispose === 'function') disposers.push(dispose);
      preStepRegistered = true;
      modes.push('pre-step');
    } catch (err) {
      safeWarn(logger, `[rta] agent/pre-step unavailable: ${err?.message ?? err}`);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of disposers.reverse()) {
      try { off?.(); } catch { /* ignore */ }
    }
    disposers.length = 0;
  }

  return {
    get mode() { return modes.length ? modes.join('+') : 'pull'; },
    get modes() { return [...modes]; },
    get contextRegistered() { return contextRegistered; },
    get preStepRegistered() { return preStepRegistered; },
    dispose,
  };
}
