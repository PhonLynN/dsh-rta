/**
 * host/service.js — 可选宿主服务的运行期探测 + 出图胶水。
 *
 * 和 dsh-video-storyboard 的 tools/shared.js 同一套教训（Apache-2.0）：
 * cordis 的 ctx 是 Proxy，服务没在 inject 里声明时读属性会**直接抛**，
 * `?.` 挡不住异常 —— 所以必须走 ctx.get(name)，再退回 try 包住的属性访问。
 *
 * RTA 的 inject 只有 ['tools']（见 src/index.js），attachments 一律运行期探测：
 * 宿主没有 attachments 时工具照常注册，只是拿不到图，降级成纯文本结果。
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** 从 cordis 上下文里取一个可选服务（取不到返回 null，绝不抛）。 */
export function serviceOf(ctx, name) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet) return viaGet;
    }
  } catch { /* 没有 get()，或者服务没注册：往下退 */ }
  try {
    return ctx[name] ?? null;
  } catch {
    return null; // Proxy 抛的那个 "without inject"，在这里收住
  }
}

/**
 * 把一张 RGB 图提交成附件。返回 attachment ref；宿主没有 attachments 时返回 null。
 * 调用方拿到 null 就只返回文本（不抛）。
 */
export async function attachRgb(ctx, { rgb, width, height, name }) {
  const attachments = serviceOf(ctx, 'attachments');
  const saveImage = attachments?.saveImage;
  if (typeof saveImage !== 'function') return null;
  // 懒 import：没有 attachments 的机器不该为了编码 PNG 付启动成本
  const { encodePng } = await import('../img/png.js');
  const png = encodePng(width, height, rgb);
  // **必须 .call(attachments, ...)**：新版宿主的 saveImage 内部读 this.compression
  return saveImage.call(attachments, { data: png, mediaType: 'image/png', name });
}

/** 把磁盘上的图片提交成附件（回捞历史帧用；png/jpg 自动识别 media type）。 */
export async function attachPngFile(ctx, { file, name }) {
  const attachments = serviceOf(ctx, 'attachments');
  const saveImage = attachments?.saveImage;
  if (typeof saveImage !== 'function') return null;
  const data = await readFile(file);
  const mediaType = MEDIA_TYPES[extname(file).toLowerCase()] ?? 'image/png';
  return saveImage.call(attachments, { data, mediaType, name: name ?? basename(file) });
}
