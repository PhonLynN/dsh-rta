/**
 * img/scale.js — 纯 JS 降采样（box / area 平均）。
 *
 * 为什么需要：抓屏拿到的是 2560×1440 的 BGRA，而真正参与算法的只有
 * 320×180（哨兵）和 512×288（存档/拼图）。缩放必须在进程内完成 ——
 * 交给 GDI 的 StretchBlt 反而更慢（实测 HALFTONE 26ms、COLORONCOLOR 17ms，
 * 而 BitBlt 全屏只要 18ms），所以 GDI 只负责"拿到原图"，缩放统一在 JS 里做。
 *
 * box 平均而不是最近邻：最近邻在 40:1、16:1 这种大比例下会直接漏掉细线和小字
 * （1 像素宽的窗口边框、表格线），而 RTA 最关心的恰恰是"文字/结构变没变"。
 */

/**
 * @param {Uint8Array|Buffer} src BGRA 源缓冲
 * @param {number} sw 源宽
 * @param {number} sh 源高
 * @param {number} dw 目标宽
 * @param {number} dh 目标高
 * @param {{bgra?: boolean, out?: Uint8Array}} [opts]
 *   bgra=true 输出 BGRA（长度 dw*dh*4），否则输出 RGB（dw*dh*3）
 * @returns {Uint8Array} 目标缓冲（长度按 bgra 决定）
 */
export function downscale(src, sw, sh, dw, dh, opts = {}) {
  const bgra = opts.bgra === true;
  const out = opts.out ?? new Uint8Array(dw * dh * (bgra ? 4 : 3));
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) throw new RangeError('downscale: bad sizes');
  const kx = sw / dw;
  const ky = sh / dh;

  // 整数倍快路径（2560/512=5、2560/320=8 都是整数，走这个分支）
  if (Number.isInteger(kx) && Number.isInteger(ky)) {
    const k = kx;
    const area = k * ky;
    for (let dy = 0; dy < dh; dy++) {
      const sy0 = dy * ky;
      for (let dx = 0; dx < dw; dx++) {
        const sx0 = dx * k;
        let r = 0; let g = 0; let b = 0;
        for (let yy = 0; yy < ky; yy++) {
          let s = ((sy0 + yy) * sw + sx0) * 4;
          for (let xx = 0; xx < k; xx++, s += 4) {
            b += src[s]; g += src[s + 1]; r += src[s + 2];
          }
        }
        const o = (dy * dw + dx) * (bgra ? 4 : 3);
        if (bgra) { out[o] = b / area; out[o + 1] = g / area; out[o + 2] = r / area; out[o + 3] = 255; }
        else { out[o] = r / area; out[o + 1] = g / area; out[o + 2] = b / area; }
      }
    }
    return out;
  }

  // 任意比例：每个目标像素覆盖一个分数区间，用 floor 边界做面积加权
  for (let dy = 0; dy < dh; dy++) {
    const y0 = (dy * sh) / dh;
    const y1 = ((dy + 1) * sh) / dh;
    for (let dx = 0; dx < dw; dx++) {
      const x0 = (dx * sw) / dw;
      const x1 = ((dx + 1) * sw) / dw;
      let r = 0; let g = 0; let b = 0; let wsum = 0;
      const iy0 = Math.floor(y0); const iy1 = Math.min(sh, Math.ceil(y1));
      const ix0 = Math.floor(x0); const ix1 = Math.min(sw, Math.ceil(x1));
      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const s = (sy * sw + sx) * 4;
          b += src[s] * w; g += src[s + 1] * w; r += src[s + 2] * w; wsum += w;
        }
      }
      const o = (dy * dw + dx) * (bgra ? 4 : 3);
      if (wsum <= 0) continue;
      if (bgra) { out[o] = b / wsum; out[o + 1] = g / wsum; out[o + 2] = r / wsum; out[o + 3] = 255; }
      else { out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; }
    }
  }
  return out;
}

/** RGB 缓冲里裁剪一块矩形（行优先，越界自动夹住）。 */
export function cropRgb(src, sw, sh, x, y, w, h, out = new Uint8Array(w * h * 3)) {
  const x0 = Math.max(0, Math.min(sw - 1, x | 0));
  const y0 = Math.max(0, Math.min(sh - 1, y | 0));
  const ww = Math.max(1, Math.min(sw - x0, w | 0));
  const hh = Math.max(1, Math.min(sh - y0, h | 0));
  for (let yy = 0; yy < hh; yy++) {
    const s = ((y0 + yy) * sw + x0) * 3;
    const d = yy * w * 3;
    out.set(src.subarray(s, s + ww * 3), d);
  }
  return { data: out, width: ww, height: hh };
}

/** 把 RGB 缓冲按最近邻缩放到目标尺寸（用于把圈画区域放大显示；快而够用）。 */
export function nearestScale(src, sw, sh, dw, dh, out = new Uint8Array(dw * dh * 3)) {
  for (let dy = 0; dy < dh; dy++) {
    const sy = Math.min(sh - 1, (dy * sh / dh) | 0);
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min(sw - 1, (dx * sw / dw) | 0);
      const s = (sy * sw + sx) * 3;
      const d = (dy * dw + dx) * 3;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2];
    }
  }
  return out;
}

/**
 * 采样式降采样：每个目标格子只读 samples×samples 个点（默认 2×2 的四分位点），
 * 而不是读完整块。用于**哨兵**（192×108 @30Hz）——差分算法吃得消少量采样误差
 * （真正的变化跨几十个像素），但吃不消每帧 370 万次像素读取：box 平均要 ~10ms，
 * 采样只要 ~0.3ms，正好把预算留给 15Hz 的全量存档帧。
 *
 * 采样点取格子内的 (i+0.5)/samples 位置，避免总落在格子左上角导致边界系统性偏差。
 *
 * @param {Uint8Array|Buffer} src BGRA 源
 * @param {number} sw 源宽
 * @param {number} sh 源高
 * @param {number} dw 目标宽
 * @param {number} dh 目标高
 * @param {Uint8Array} [out] 目标 RGB（dw*dh*3）
 * @param {number} [samples=2] 每格每维采样数
 */
export function downscaleSample(src, sw, sh, dw, dh, out = new Uint8Array(dw * dh * 3), samples = 2) {
  const kx = sw / dw;
  const ky = sh / dh;
  const n = Math.max(1, samples | 0);
  const denom = n * n;
  const offs = [];
  for (let i = 0; i < n; i++) offs.push((i + 0.5) / n);
  let d = 0;
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++, d += 3) {
      let r = 0; let g = 0; let b = 0;
      for (let iy = 0; iy < n; iy++) {
        const sy = Math.min(sh - 1, ((dy + offs[iy]) * ky) | 0);
        const row = sy * sw;
        for (let ix = 0; ix < n; ix++) {
          const sx = Math.min(sw - 1, ((dx + offs[ix]) * kx) | 0);
          const s = (row + sx) * 4;
          b += src[s]; g += src[s + 1]; r += src[s + 2];
        }
      }
      out[d] = (r / denom) | 0;
      out[d + 1] = (g / denom) | 0;
      out[d + 2] = (b / denom) | 0;
    }
  }
  return out;
}
