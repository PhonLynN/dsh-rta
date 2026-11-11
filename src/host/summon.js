/**
 * host/summon.js — Ctrl+Alt「召唤」：把一条 plugin 上下文推进当前会话。
 *
 * 设计（对应需求：会话聊到一半，按下热键后 AI 实时看见屏幕并短回答）：
 *  - 推送的是一条 user-role 的 plugin context（form: 'notice'），不是普通聊天消息；
 *    宿主 UI 会按 notice 折叠显示，不会把对话撑成流水账。
 *  - agent 空闲 → followup（开一轮，AI 立刻看屏幕并回话）；正在跑 → steer（下一步边界插入）。
 *  - 只在 RTA 未启用（引擎没跑）时生效：一次 Ctrl+Alt = 召唤并持续启用；
 *    启用期间再按 Ctrl+Alt 不会重复召唤（退出用 Ctrl+Tab，由引擎处理）。
 *  - 没拿到 agent（比如插件刚加载、还没有会话）时静默返回，不报错、不刷日志。
 */

import { randomUUID } from 'node:crypto';
import { createWin32 } from '../capture/win32.js';

const VK = { SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12 };
const NOTICE_SUMMARY = 'RTA 召唤：用户想让你看屏幕';

/**
 * @param {object} opts
 * @param {{info:Function,warn:Function,error:Function}} opts.logger
 * @param {string} opts.prompt 推进会话的文本
 * @param {number} [opts.cooldownMs=1500]
 * @param {(sessionId:string|null)=>Promise<object|null>} [opts.resolveAgent] 兜底：按会话 id 找 agent
 * @param {()=>void} [opts.onIdleSummon] 引擎没跑时按下热键的回调（由 runtime 负责先起引擎）
 */
export function createSummoner({ logger, prompt, cooldownMs = 1500, resolveAgent = null, onIdleSummon = null } = {}) {
  let agent = null;
  let lastSessionId = null;
  let lastAt = 0;
  let win32 = null;
  let timer = null;
  let latch = false;

  function rememberAgent(a) {
    if (a && typeof a === 'object') agent = a;
  }

  function rememberSession(id) {
    if (id) lastSessionId = id;
  }

  async function targetAgent() {
    if (agent) return agent;
    if (!resolveAgent) return null;
    try {
      return (await resolveAgent(lastSessionId)) ?? null;
    } catch {
      return null;
    }
  }

  function buildMessage() {
    return Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      // V4 会话格式禁止 source.kind === 'plugin'（旧 plugin wrapper 已退役）；
      // 插件消息必须用 producer-owned kind，V3→V4 迁移对第三方插件的约定是 `plugin:<id>`。
      source: { kind: 'plugin:dsh-rta', form: 'notice', summary: NOTICE_SUMMARY },
    });
  }

  /**
   * 把召唤推进当前会话。
   * @returns {Promise<{ok:boolean,reason?:string,transport?:string,id?:string}>}
   */
  async function notify({ reason = 'engine' } = {}) {
    const now = Date.now();
    if (now - lastAt < cooldownMs) return { ok: false, reason: 'cooldown' };

    const a = await targetAgent();
    if (!a) return { ok: false, reason: 'no-agent' };

    const message = buildMessage();
    const transport = a.status === 'running' ? 'steer' : 'followup';
    try {
      if (transport === 'steer') a.steer(message);
      else a.followup(message);
    } catch (err) {
      logger?.warn?.(`[rta] summon push failed: ${err?.message ?? err}`);
      return { ok: false, reason: 'push-failed' };
    }
    lastAt = now;
    logger?.info?.(`[rta] summon pushed (${transport}, ${reason})`);
    return { ok: true, transport, id: message.id };
  }

  /**
   * 悬浮窗里用户发的一句话：推进当前会话。
   * 这是**用户主动动作**，所以空闲时 followup 唤醒（不是自动注入，不受节流限制）。
   * @returns {Promise<{ok:boolean,reason?:string,transport?:string,id?:string}>}
   */
  async function say({ text } = {}) {
    const clean = String(text ?? '').replace(/\s+$/g, '');
    if (!clean.trim()) return { ok: false, reason: 'empty' };

    const a = await targetAgent();
    if (!a) return { ok: false, reason: 'no-agent' };

    const summary = `RTA 悬浮窗：${clean.replace(/\s+/g, ' ').slice(0, 80)}`;
    const message = Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: clean }],
      source: { kind: 'plugin:dsh-rta', form: 'notice', summary },
    });
    const transport = a.status === 'running' ? 'steer' : 'followup';
    try {
      if (transport === 'steer') a.steer(message);
      else a.followup(message);
    } catch (err) {
      logger?.warn?.(`[rta] floating window say failed: ${err?.message ?? err}`);
      return { ok: false, reason: 'push-failed' };
    }
    logger?.info?.(`[rta] floating window message pushed (${transport})`);
    return { ok: true, transport, id: message.id };
  }

  /** 引擎没跑时，常驻一个很轻的热键轮询（每 10ms 两次 GetAsyncKeyState，约 0.1μs）。 */
  function watch() {
    if (timer) return;
    if (!onIdleSummon) return;
    if (!win32) win32 = createWin32();
    if (!win32?.ok) {
      logger?.warn?.(`[rta] summon watcher unavailable: ${win32?.error ?? 'win32 not available'}`);
      return;
    }
    timer = setInterval(() => {
      try {
        const ctrl = win32.keyDown(VK.CONTROL);
        const alt = win32.keyDown(VK.MENU);
        const shift = win32.keyDown(VK.SHIFT);
        // 未启用时 Shift+Ctrl+Alt 不是「圈画」而是无效组合，不能顺手把它当成召唤。
        if (ctrl && alt && !shift && !latch) {
          latch = true;
          try { onIdleSummon(); } catch (err) { logger?.warn?.(`[rta] idle summon failed: ${err?.message ?? err}`); }
        }
        if (!ctrl || !alt) latch = false;
      } catch { /* 轮询失败不能拖垮宿主 */ }
    }, 10);
    timer.unref?.();
  }

  function unwatch() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    latch = false;
  }

  function dispose() {
    unwatch();
    try { win32?.dispose?.(); } catch { /* ignore */ }
    win32 = null;
    agent = null;
  }

  return {
    rememberAgent,
    rememberSession,
    notify,
    say,
    watch,
    unwatch,
    dispose,
    /** 同步取当前记住的 agent（热键路径绑定会话用；没有则 null）。 */
    peekAgent: () => agent,
    get watching() { return Boolean(timer); },
    get hasAgent() { return Boolean(agent); },
    get sessionId() { return lastSessionId; },
  };
}
