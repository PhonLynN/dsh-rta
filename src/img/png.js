/**
 * img/png.js — 最小 PNG 编码器（RGB 8bit，filter 0，zlib 压缩）。
 *
 * 为什么自己写：DSH 插件不能保证宿主里有 sharp/jimp 这类原生图像库，
 * 而 `ctx.attachments.saveImage()` 要的是**真正编码后的 PNG/JPEG 字节**（它会解码校验）。
 * 所以至少要有一种零依赖的编码器：node:zlib 是内置的，PNG 容器只是
 * 签名 + IHDR + IDAT + IEND 四个块，几十行就够。
 *
 * 只做编码、不做解码；只支持 8bit RGB —— RTA 所有图（基线帧、拼图）都是这两种。
 */

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 查表（PNG 每个 chunk 都要）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.allocUnsafe(4 + data.length);
  body.write(type, 0, 'ascii');
  data.copy(body, 4);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Buffer} rgb 长度 = width*height*3，行优先
 * @param {{level?: number, filters?: boolean}} [opts]
 *   level: zlib 压缩级别（1 最快、9 最小；默认 3 —— 屏幕截图内容用 3 就够）
 *   filters: true 时对每行做 Paeth/Up 等自适应滤波（更小但更慢），默认关闭
 * @returns {Buffer} PNG 字节
 */
export function encodePng(width, height, rgb, opts = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`encodePng: bad size ${width}x${height}`);
  }
  const stride = width * 3;
  if (!rgb || rgb.length !== stride * height) {
    throw new RangeError(`encodePng: rgb length ${rgb?.length} != ${stride * height}`);
  }
  const level = Number.isFinite(opts.level) ? opts.level : 3;

  // 每行前面加一个 filter 字节。filter 0 = None：
  // 屏幕截图本来就是低熵内容，zlib 已经能压得很好，做自适应滤波的收益
  // 抵不上它把 15Hz 存档链路拖慢的代价。
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), o + 1);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = deflateSync(raw, { level });
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 把 BGRA（Windows GDI 的 GetDIBits 输出）转成 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Buffer} bgra 长度 = width*height*4
 * @param {{level?: number}} [opts]
 * @returns {Buffer}
 */
export function encodePngFromBgra(width, height, bgra, opts = {}) {
  const rgb = bgraToRgb(bgra, width * height);
  return encodePng(width, height, rgb, opts);
}

/** BGRA → RGB（原地输出到新缓冲；pixels = width*height）。 */
export function bgraToRgb(bgra, pixels) {
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 4, d += 3) {
    rgb[d] = bgra[s + 2];
    rgb[d + 1] = bgra[s + 1];
    rgb[d + 2] = bgra[s];
  }
  return rgb;
}
