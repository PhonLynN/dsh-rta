/**
 * native/gdiplus.js — 用 Windows 自带的 GDI+ 把 RGB 帧写成 JPEG。
 *
 * 为什么不用 PNG 存 15Hz 基线帧：512×288 的文字型屏幕帧 PNG 约 40KB，
 * 15Hz 跑满就是 2.2GB/小时，24h 保留要求下太重。同一帧 JPEG(q75) 约 14KB
 * （实测 _probe 里 q55=10.4KB q65=11.9KB q75=14.4KB q85=18.1KB），
 * 编码 0.6ms/帧，GDI+ 又是系统自带、零依赖。
 *
 * 事件帧/圈画裁切图仍然用 PNG：它们数量少，而且文字要清晰。
 */

import { loadKoffi } from './koffi.js';

// GDI+ 的 JPEG 编码器 CLSID：{557CF401-1A04-11D3-9A73-0000F81EF32E}
const JPEG_CLSID = Buffer.from([
  0x01, 0xf4, 0x7c, 0x55, // Data1 557CF401
  0x04, 0x1a,             // Data2 1A04
  0xd3, 0x11,             // Data3 11D3
  0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e, // Data4
]);

// PixelFormat32bppARGB
const PIXEL_FORMAT_32BPP_ARGB = 0x26200a;

let state = null;

/** 懒初始化 GDI+ 与 JPEG 编码函数；不可用时返回 {ok:false}，绝不抛。 */
export function jpegEncoder({ env = process.env } = {}) {
  if (state) return state;
  if (process.platform !== 'win32') {
    state = { ok: false, reason: 'not-windows' };
    return state;
  }
  try {
    const { koffi, source } = loadKoffi(env);
    const lib = koffi.load('gdiplus.dll');
    const input = Buffer.alloc(24); // GdiplusStartupInput：version=1，其余 0
    input.writeUInt32LE(1, 0);
    const token = Buffer.alloc(8);
    const GdiplusStartup = lib.func('GdiplusStartup', 'int', ['void *', 'void *', 'void *']);
    const GdipCreateBitmapFromScan0 = lib.func('GdipCreateBitmapFromScan0', 'int', ['int', 'int', 'int', 'int', 'void *', 'void *']);
    const GdipSaveImageToFile = lib.func('GdipSaveImageToFile', 'int', ['void *', 'str16', 'void *', 'void *']);
    const GdipDisposeImage = lib.func('GdipDisposeImage', 'int', ['void *']);

    const startup = GdiplusStartup(token, input, null);
    if (startup !== 0) throw new Error(`GdiplusStartup status ${startup}`);

    state = {
      ok: true,
      source,
      koffi,
      GdipCreateBitmapFromScan0,
      GdipSaveImageToFile,
      GdipDisposeImage,
      bgra: null,
      bgraSize: 0,
      ptrs: Buffer.alloc(8),
    };
  } catch (err) {
    state = { ok: false, reason: String(err?.message ?? err) };
  }
  return state;
}

/** 本机能不能写 JPEG（主线程与 worker 结论一致，都走同一个懒初始化）。 */
export function isJpegAvailable(env) {
  return jpegEncoder({ env }).ok === true;
}

/** RGB(3B/px) → BGRA(4B/px)，复用缓冲。 */
function rgbToBgra(enc, rgb, width, height) {
  const pixels = width * height;
  const need = pixels * 4;
  if (!enc.bgra || enc.bgraSize < need) {
    enc.bgra = Buffer.alloc(need);
    enc.bgraSize = need;
  }
  const bgra = enc.bgra;
  for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 3, d += 4) {
    bgra[d] = rgb[s + 2];
    bgra[d + 1] = rgb[s + 1];
    bgra[d + 2] = rgb[s];
    bgra[d + 3] = 255;
  }
  return bgra;
}

/**
 * 把 RGB 帧写成一个 JPEG 文件。成功返回 {ok:true}，失败返回 {ok:false,error}。
 * 默认质量是 GDI+ 的默认值（75），不额外构造 EncoderParameters。
 */
export function encodeJpegToFile(file, rgb, width, height, { env } = {}) {
  const enc = jpegEncoder({ env });
  if (!enc.ok) return { ok: false, error: enc.reason ?? 'gdiplus-unavailable' };
  try {
    const bgra = rgbToBgra(enc, rgb, width, height);
    const out = enc.ptrs;
    out.writeBigUInt64LE(0n, 0);
    const create = enc.GdipCreateBitmapFromScan0(width, height, width * 4, PIXEL_FORMAT_32BPP_ARGB, bgra, out);
    const bmp = out.readBigUInt64LE(0);
    if (create !== 0 || !bmp) return { ok: false, error: `GdipCreateBitmapFromScan0 status ${create}` };
    try {
      const save = enc.GdipSaveImageToFile(bmp, file, JPEG_CLSID, null);
      if (save !== 0) return { ok: false, error: `GdipSaveImageToFile status ${save}` };
      return { ok: true };
    } finally {
      enc.GdipDisposeImage(bmp);
    }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
