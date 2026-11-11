/**
 * algo/color.js — 帧差分的颜色数学。
 *
 * 借鉴 dsh-video-storyboard 的 scan.js（Apache-2.0）：
 *  - HSV 而不是 RGB 做差分：RGB 对"亮度整体变一点"过于敏感，HSV 里色相/饱和度
 *    对光照不敏感，能区分"换了个窗口"和"同一个窗口调了下亮度"；
 *  - 色相是环形的，差值必须走 min(dh, 255-dh)；
 *  - 低饱和像素的色相没有意义，用 min(sat)/255 做权重衰减；
 *  - 运动补偿（mc）不是逐像素比较，而是"这个格子变红，但附近 2 格内有个几乎
 *    一样的格子"就不算变化 —— 这能过滤掉整个窗口平移这种"看起来变化很大、
 *    其实信息没变"的情况（拖窗口、滚动）。
 *
 * 所有函数都是纯函数、只接受 RGB（不用 BGRA），方便单测。
 */

/** 单个像素 RGB → [h(0-255), s(0-255), v(0-255)] */
export function rgbToHsv(r, g, b, out = new Float32Array(3)) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    if (h < 0) h += 6;
  }
  out[0] = (h / 6) * 255;
  out[1] = max === 0 ? 0 : (d / max) * 255;
  out[2] = max;
  return out;
}

/**
 * RGB 缓冲 → HSV 缓冲（每像素 3 个 Float32，h/s/v 各 0-255）。
 * @param {Uint8Array|Buffer} rgb 长度 pixels*3
 * @param {Uint8Array|Float32Array} [out] 长度 pixels*3
 */
export function frameToHsv(rgb, out) {
  const pixels = (rgb.length / 3) | 0;
  const dst = out ?? new Float32Array(pixels * 3);
  const tmp = new Float32Array(3);
  for (let i = 0, s = 0, d = 0; i < pixels; i++, s += 3, d += 3) {
    rgbToHsv(rgb[s], rgb[s + 1], rgb[s + 2], tmp);
    dst[d] = tmp[0];
    dst[d + 1] = tmp[1];
    dst[d + 2] = tmp[2];
  }
  return dst;
}

/**
 * 两帧 HSV 的加权平均差（0-255 量级）。
 * 权重与 storyboard 一致：三通道等权，但色相按 min(sat)/255 衰减。
 * @returns {number} 平均每像素每通道的差（0-255）
 */
export function scorePair(a, b, pixels) {
  let sum = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 3;
    let dh = a[o] - b[o];
    if (dh < -127.5) dh += 255;
    else if (dh > 127.5) dh -= 255;
    if (dh < 0) dh = -dh;
    const sat = Math.min(a[o + 1], b[o + 1]) / 255;
    sum += dh * sat;
    let ds = a[o + 1] - b[o + 1];
    if (ds < 0) ds = -ds;
    let dv = a[o + 2] - b[o + 2];
    if (dv < 0) dv = -dv;
    sum += ds + dv;
  }
  return sum / (pixels * 3);
}

/**
 * 运动补偿后的"变化格子占比"（0-1）。
 *
 * 对每个格子（像素），如果 RGB 差超过 tau，就在半径 radius 内找一个"几乎一样"
 * 的邻格；找到就不算变化。整窗平移/滚动时占比会很低，真正的局部改动占比高。
 *
 * 优化：一旦"变化数 / 剩余格子"已经不可能影响结论就提前收工（storyboard 用同样
 * 思路把 1.0ms 压到 0.155ms）。提前收工的阈值用"任何结果都 < earlyExit 或
 * 已经 > 1-earlyExit"来保证不改变返回值。
 *
 * @param {Uint8Array|Buffer} prev RGB
 * @param {Uint8Array|Buffer} cur RGB
 * @param {number} width
 * @param {number} height
 * @param {{tau?: number, radius?: number}} [opts]
 * @returns {number} 0-1
 */
export function mcRatioScore(prev, cur, width, height, opts = {}) {
  const tau = opts.tau ?? 15;
  const radius = opts.radius ?? 2;
  const pixels = width * height;
  let changed = 0;
  const r = radius | 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3;
      const dr = prev[p] - cur[p];
      const dg = prev[p + 1] - cur[p + 1];
      const db = prev[p + 2] - cur[p + 2];
      if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) <= tau) continue;

      // 在邻域里找匹配（跳过自己，自己已经确定不匹配）
      let matched = false;
      for (let dy = -r; dy <= r && !matched; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const q = (yy * width + xx) * 3;
          const er = prev[q] - cur[p];
          const eg = prev[q + 1] - cur[p + 1];
          const eb = prev[q + 2] - cur[p + 2];
          if (Math.abs(er) + Math.abs(eg) + Math.abs(eb) <= tau) { matched = true; break; }
        }
      }
      if (!matched) changed++;
    }
  }
  return changed / pixels;
}

/** 帧平均亮度（用于 luma gain；0-255） */
export function meanLuma(rgb) {
  const pixels = (rgb.length / 3) | 0;
  let sum = 0;
  for (let i = 0, s = 0; i < pixels; i++, s += 3) {
    sum += 0.299 * rgb[s] + 0.587 * rgb[s + 1] + 0.114 * rgb[s + 2];
  }
  return pixels ? sum / pixels : 0;
}

/**
 * 亮度增益：暗画面（视频黑场、夜间模式 UI）里同样的绝对差代表更大的相对变化，
 * storyboard 用 clamp(REF_V / max(V_FLOOR, meanV), 1, GAIN_MAX)。
 */
export function lumaGain(meanV, { refV = 160, gainMax = 3, vFloor = 40 } = {}) {
  const g = refV / Math.max(vFloor, meanV);
  return g < 1 ? 1 : g > gainMax ? gainMax : g;
}
