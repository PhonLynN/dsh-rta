/**
 * index.js — DSH 插件入口，只做注册。
 *
 * 工具：rta_start / rta_stop / rta_status / rta_look / rta_region / rta_recall / rta_note / rta_sessions。
 * 采集与选择算法在 src/engine/ + src/algo/，与宿主无关，可以 headless 跑（bin/rta-run.mjs）。
 *
 * 契约要点（照抄 dsh-video-storyboard，Apache-2.0）：
 *  - inject 只声明 ['tools']；attachments 运行期探测（声明成硬依赖会让插件在缺少服务的机器上卡「加载中」）。
 *  - apply 永远不抛：注册失败返回空 disposer，记日志；DSH_RTA_DEBUG=1 时重抛。
 *  - 15s 看门狗：apply 里任何 await 卡住都不该拖死宿主启动。
 *  - disposers 先声明再 push，卸载时 reverse 执行。
 */

import { rtaTools } from './tools/index.js';
import { createRuntime } from './host/runtime.js';
import { defineToolCompat } from './host/define-tool.js';
import { serviceOf } from './host/service.js';
import { setDeliveryHook, planOffloadWithTrigger, applyOffload } from './host/offload.js';
import { wireLiveBridge } from './host/live.js';

export const name = 'dsh-rta';
export const inject = ['tools'];

const APPLY_TIMEOUT_MS = 15_000;

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch { /* 宿主的包常在 app.asar 里，解析不到是常态 */ }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    try {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(override).href);
      if (mod?.defineTool) return mod.defineTool;
    } catch { /* 路径不对，继续落兜底 */ }
  }
  return defineToolCompat;
}

export async function apply(ctx) {
  try {
    return await withTimeout(registerAll(ctx), APPLY_TIMEOUT_MS, 'registerAll');
  } catch (e) {
    try {
      ctx?.logger?.error?.(`[dsh-rta] failed to load: ${e?.stack ?? e}`);
    } catch { /* 连日志都写不了就算了 */ }
    if (process.env.DSH_RTA_DEBUG) throw e;
    return () => {};
  }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();
  const rt = createRuntime({ ctx });

  const disposers = [];
  disposers.push(...rtaTools(defineTool, ctx, rt).map((tool) => ctx.tools.register(tool)));

  wireImageOffload(ctx, rt, disposers);

  // 「启用即持续注入」：文本通道 systemPrompt.context + 图片通道 agent/pre-step。
  // 必须排在 wireImageOffload 之后：自动注入的截图也要走同一条 offload 预算。
  // 宿主能力不足时 lifecycle 自己降级成 pull，不影响工具面。
  try {
    rt.attachLive();
  } catch (e) {
    try { ctx?.logger?.warn?.(`[dsh-rta] live injection failed: ${e?.message ?? e}`); } catch { /* ignore */ }
  }

  // 悬浮窗（client half）的数据面：GET /api/dsh-rta/state、POST /api/dsh-rta/say。
  // connection 服务缺失时静默降级（插件照常工作，只是没有浮窗数据）。
  try {
    wireLiveBridge(ctx, rt, disposers);
  } catch (e) {
    try { ctx?.logger?.warn?.(`[dsh-rta] live bridge failed: ${e?.message ?? e}`); } catch { /* ignore */ }
  }

  // 插件加载后就让 Ctrl+Alt 可用：引擎还没跑时，热键会先起采集再推进会话。
  try {
    rt.watchForSummon();
  } catch (e) {
    try { ctx?.logger?.warn?.(`[dsh-rta] summon watcher failed: ${e?.message ?? e}`); } catch { /* ignore */ }
  }

  try {
    ctx?.logger?.info?.(`[dsh-rta] ready (config: ${rt.configPath})`);
  } catch { /* ignore */ }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose?.(); } catch { /* ignore */ }
    }
    void rt.dispose();
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------------ 会话图片省略

/**
 * RTA 的图集中在会话尾部，所以参数比 storyboard 激进：
 * 攒到 imageTrigger 张才动一次手，一次省到只剩 imageKeep 张。
 * 每次省略都会让前缀缓存从第一条被省略的消息起失效 —— 不能每出一张图就跑。
 */
function wireImageOffload(ctx, rt, disposers) {
  let lastSessionId = null;
  try {
    if (typeof ctx.on === 'function') {
      const off = ctx.on('session/event', (session) => {
        const id = session?.header?.id ?? session?.id;
        if (id) lastSessionId = id;
      });
      if (typeof off === 'function') disposers.push(off);
    }
  } catch (e) {
    try { ctx?.logger?.warn?.(`[dsh-rta] session/event hook failed: ${e?.message ?? e}`); } catch { /* ignore */ }
  }

  const limits = () => ({
    trigger: Math.floor(Number(rt.config.imageTrigger) || 0),
    keep: Math.floor(Number(rt.config.imageKeep) || 0),
  });

  async function runOffload({ trigger, keep }) {
    const sc = serviceOf(ctx, 'sessionController');
    if (!sc?.resolveAgent) return { ok: false, reason: 'no-session-controller' };
    if (!lastSessionId) return { ok: false, reason: 'no-session' };

    let resolved;
    try {
      resolved = await sc.resolveAgent(lastSessionId);
    } catch (e) {
      resolved = { error: e };
    }
    const session = resolved?.agent?.session;
    if (!session) {
      return { ok: false, reason: String(resolved?.error?.message ?? resolved?.error ?? 'resolve-failed').slice(0, 160) };
    }

    // snapshotEvents() 在宿主里标了 deprecated，但它是唯一能同步读到当前日志的公开口子
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : null;
    if (!Array.isArray(events)) return { ok: false, reason: 'no-events' };

    // 涨到触发线才动手，一次省到只剩 keep 张
    const { triggered, plan } = planOffloadWithTrigger(events, { trigger, keep });
    if (!triggered || plan.offloading === 0) return { ok: true, plan, belowTrigger: true };

    const r = await applyOffload(session, plan.targets, serviceOf(ctx, 'sessions'));
    if (!r.ok) return { ok: false, reason: r.reason, plan };
    return { ok: true, plan };
  }

  let lastCheck = 0;
  setDeliveryHook(() => {
    const { trigger } = limits();
    if (!trigger) return;
    const now = Date.now();
    if (now - lastCheck < 30_000) return;
    lastCheck = now;
    setTimeout(() => {
      void runOffload(limits()).then((r) => {
        if (!r.ok) {
          try { ctx?.logger?.warn?.(`[dsh-rta] auto offload skipped: ${r.reason}`); } catch { /* ignore */ }
        } else if (r.plan?.offloading) {
          try { ctx?.logger?.info?.(`[dsh-rta] offloaded ${r.plan.offloading} image(s), kept ${r.plan.kept}`); } catch { /* ignore */ }
        }
      });
    }, 0);
  });
}
