/**
 * tools/index.js — 把 spec 和 handler 拼成宿主可注册的工具列表。
 *
 * 这里统一做三件事：
 *  1) 每次工具调用时把 exec.agent 记进 runtime 的召唤器，这样用户按 Ctrl+Alt
 *     时插件知道该把「看屏幕」的通知推给哪个会话/agent；
 *  2) 单会话闸门：同一时间 RTA 只作用于一个会话（用户明确要求）。已绑定后，
 *     别的会话调用实时面工具（rta_start / rta_look / rta_region / rta_note）
 *     会直接拿到一段说明文本，而不是悄悄切走画面；
 *  3) RTA 真正跑起来时把调用方会话绑上；rta_stop 释放绑定。
 *
 * （工具返回值语义完全不变，只是加了一层包装。）
 */

import {
  startSpec, stopSpec, statusSpec, lookSpec, regionSpec, recallSpec, noteSpec, sessionsSpec, purgeSpec,
} from './spec.js';
import * as handlers from './handlers.js';

/** 这些调用可能把引擎拉起来；成功后需要把调用方会话绑定上去。 */
const CAN_BIND = new Set(['rta_start', 'rta_look', 'rta_region']);

/**
 * 输出是「文字 + 图片」的工具。闸门拒绝时也必须遵守 output schema
 * （images 是 required），否则宿主会判 invalid output，整个调用变成一条
 * `missing required property "value.images"` 的报错 —— 用户看到的就是工具坏了。
 */
const IMAGE_TOOLS = new Set(['rta_look', 'rta_region']);

/**
 * @param {(spec: object) => object} defineTool 宿主的 defineTool（或兜底实现）
 * @param {object} ctx 宿主上下文（出图用）
 * @param {object} rt  host/runtime.js 的 runtime
 * @returns {object[]} 已 defineTool 好的工具
 */
export function rtaTools(defineTool, ctx, rt) {
  const entries = [
    [startSpec, () => handlers.start(ctx, rt)],
    [stopSpec, (args) => handlers.stop(ctx, rt, args)],
    [statusSpec, () => handlers.status(ctx, rt)],
    [lookSpec, (args) => handlers.look(ctx, rt, args)],
    [regionSpec, (args) => handlers.region(ctx, rt, args)],
    [recallSpec, (args) => handlers.recall(ctx, rt, args)],
    [noteSpec, (args) => handlers.note(ctx, rt, args)],
    [sessionsSpec, (args) => handlers.sessions(ctx, rt, args)],
    [purgeSpec, (args) => handlers.purge(ctx, rt, args)],
  ];

  return entries.map(([spec, run]) => {
    const resolved = spec();
    const name = resolved.name;

    /** 成功返回后的收尾：绑定/解绑会话（任何异常都不能影响工具返回值）。 */
    const settle = (out, agent) => {
      try {
        const running = rt.engine?.state === 'running';
        if (running && !rt.bound && CAN_BIND.has(name)) {
          rt.bindAgent?.(agent);
        }
        if (!running && name === 'rta_start') rt.releaseBinding?.();
        if (name === 'rta_stop') rt.releaseBinding?.();
      } catch { /* ignore */ }
      return out;
    };

    return defineTool({
      ...resolved,
      execute: (args, exec) => {
        try {
          rt.rememberAgent?.(exec?.agent);
        } catch { /* 记不住 agent 不影响工具本身 */ }

        // 单会话闸门：已绑定且调用方是另一个会话 → 拒绝并给切换办法
        try {
          const gate = rt.gateTool?.(name, exec?.agent);
          if (gate && gate.ok === false) {
            return IMAGE_TOOLS.has(name)
              ? { text: gate.text, images: [] }
              : { text: gate.text };
          }
        } catch { /* 闸门本身出错不阻塞工具 */ }

        const out = run(args);
        if (out && typeof out.then === 'function') {
          return out.then((value) => settle(value, exec?.agent), (err) => { settle(null, exec?.agent); throw err; });
        }
        return settle(out, exec?.agent);
      },
    });
  });
}
