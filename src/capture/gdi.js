/**
 * capture/gdi.js — 采集 provider：GDI（Windows 唯一零依赖方案）。
 *
 * 为什么是 provider 抽象：本机没装 ffmpeg，但 ffmpeg(ddagrab) 明显更快
 * （见-now 实测 0.28 核 12fps）。等 ffmpeg 到位后可以直接换 provider，
 * engine 和算法层不动。provider 契约：
 *   { ok, name, size, grab(opts?), cursor(), foreground(), keyDown(vk), dispose() }
 */

import { createWin32 } from './win32.js';

export function createGdiSource({ logger } = {}) {
  const w = createWin32();
  if (!w.ok) {
    logger?.warn?.(`[rta] GDI 不可用: ${w.reason}${w.detail ? ` (${w.detail})` : ''}`);
    return { ok: false, name: 'gdi', reason: w.reason, detail: w.detail };
  }
  const size = w.primarySize();
  return {
    ok: true,
    name: 'gdi',
    size,
    capabilities: { cursor: true, hotkeys: true, windowInfo: true, regionGrab: true },
    grab(opts) {
      const f = w.grab(opts ?? {});
      return { bgra: f.bgra, width: f.width, height: f.height, ts: Date.now() };
    },
    cursor: () => w.cursor(),
    foreground: () => w.foreground(),
    keyDown: (vk) => w.keyDown(vk),
    dispose: () => w.dispose(),
  };
}
