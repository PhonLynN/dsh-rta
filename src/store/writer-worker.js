/**
 * store/writer-worker.js — 后台线程：图片编码 + 写盘。
 *
 * 为什么必须离开主线程：512×288 的屏幕帧 PNG 编码约 8–20ms，15Hz 就是
 * 12–30% 的一个核，而且它和采集/差分在同一条线程上会顶掉帧。放进 worker 后
 * 主线程只做一次 postMessage（结构克隆 0.44MB，<0.1ms）。
 *
 * 编码器：
 *   - 基线帧走 JPEG（GDI+，约 14KB/帧、0.6ms），保住 24h 保留的磁盘预算；
 *   - 事件帧/圈画裁切图/拼图走 PNG（数量少、文字要清晰）；
 *   - GDI+ 不可用时自动退回 PNG（postMessage 里 format 字段会如实返回）。
 *
 * 消息：
 *   主→worker { id, path, width, height, rgb: Uint8Array, level?, format: 'png'|'jpeg' }
 *   worker→主 { id, op:'wrote', path, bytes, ms, format } | { id, op:'error', path, error }
 */

import { parentPort } from 'node:worker_threads';
import { promises as fsp } from 'node:fs';
import { encodePng } from '../img/png.js';
import { encodeJpegToFile } from '../native/gdiplus.js';

parentPort.on('message', async (msg) => {
  const t0 = performance.now();
  try {
    const rgb = msg.rgb instanceof Uint8Array ? msg.rgb : new Uint8Array(msg.rgb);
    let format = 'png';
    let fallbackError = null;
    let outPath = msg.path;

    if (msg.format === 'jpeg') {
      const encoded = encodeJpegToFile(msg.path, rgb, msg.width, msg.height);
      if (encoded.ok) {
        format = 'jpeg';
      } else {
        // 极少见（GDI+ 初始化/编码失败）：改用同名 .png 落盘，不把 PNG 字节写成 .jpg
        fallbackError = encoded.error;
        outPath = msg.path.replace(/\.jpe?g$/i, '.png');
      }
    }

    if (format === 'jpeg') {
      const { size } = await fsp.stat(outPath);
      parentPort.postMessage({
        id: msg.id, op: 'wrote', path: outPath, bytes: size, ms: performance.now() - t0,
        format, fallbackError: null,
      });
      return;
    }

    const png = encodePng(msg.width, msg.height, rgb, { level: msg.level ?? 3 });
    await fsp.writeFile(outPath, png);
    parentPort.postMessage({
      id: msg.id, op: 'wrote', path: outPath, bytes: png.length, ms: performance.now() - t0,
      format: 'png', fallbackError,
    });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, op: 'error', path: msg.path, error: String(err?.stack ?? err) });
  }
});
