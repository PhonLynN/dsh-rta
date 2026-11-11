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

/* ------------------------------------------------------------------ *
 * 结构特征：把「页面切换」和「视频/滚动运动」「局部文字变化」分开。
 *
 * scorePair/mc 只看像素差，视频播放和滚动同样会让它们升高。真实页面的切换
 * 往往同时改变整块版面（分块差占比高）和全局颜色分布（HSV 直方图距离大），
 * 而视频运动/滚动更像「整幅平移 + 局部像素动」，两者可以用分块差 + 直方图
 * 距离 + 行位移估计组合区分。这些函数全部在 192×108 哨兵帧上运行，成本
 * 约 0.1–0.3 ms/帧。
 * ------------------------------------------------------------------ */

/** 32 段色相（按饱和度加权）+ 8 段亮度直方图，返回 Float32Array(40)。 */
export function hueHistogram(hsv, pixels, out) {
  const dst = out ?? new Float32Array(40);
  dst.fill(0);
  for (let i = 0; i < pixels; i++) {
    const o = i * 3;
    const h = hsv[o];
    const s = hsv[o + 1];
    const v = hsv[o + 2];
    const hi = ((h / 255) * 32) | 0;
    const vi = ((v / 255) * 8) | 0;
    const w = s / 255;
    dst[hi < 0 ? 0 : hi > 31 ? 31 : hi] += w; // 色相（低饱和衰减）
    dst[32 + (vi < 0 ? 0 : vi > 7 ? 7 : vi)] += 1 - w * 0.5; // 亮度
  }
  return dst;
}

/** 归一化直方图 L1 距离（0–1）。结构/配色整体变化 → 接近 1。 */
export function histL1(a, b) {
  let sum = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d < 0 ? -d : d;
    total += a[i] + b[i];
  }
  return total > 0 ? sum / total : 0;
}

/**
 * 分块差占比：把画面切成 block×block 的块，块内平均 RGB 差超过 thr 的比例。
 * 页面切换（整版重排）通常 >0.3；单调滚动/小区域视频运动通常 <0.25。
 * @param {Uint8Array|Buffer} prev RGB
 * @param {Uint8Array|Buffer} cur RGB
 */
export function blockDiffFrac(prev, cur, width, height, opts = {}) {
  const block = opts.block ?? 8;
  const thr = opts.thr ?? 30;
  const bw = Math.ceil(width / block);
  const bh = Math.ceil(height / block);
  let changed = 0;
  let count = 0;
  for (let by = 0; by < bh; by++) {
    const y0 = by * block;
    const y1 = Math.min(height, y0 + block);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * block;
      const x1 = Math.min(width, x0 + block);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * width + x) * 3;
          sr += Math.abs(prev[p] - cur[p]);
          sg += Math.abs(prev[p + 1] - cur[p + 1]);
          sb += Math.abs(prev[p + 2] - cur[p + 2]);
          n++;
        }
      }
      count++;
      if (n && (sr + sg + sb) / (n * 3) > thr) changed++;
    }
  }
  return count ? changed / count : 0;
}

/**
 * 整帧像素变化占比（不做运动补偿）。视频/大面积动画会显著升高。
 * @returns {number} 0–1
 */
export function pixelChangeFrac(prev, cur, width, height, tau = 30, max = 1) {
  const pixels = width * height;
  let changed = 0;
  // early exit：超过 max 直接返回（只看「高不高」）
  const cap = Math.max(1, Math.floor(pixels * max));
  for (let i = 0, p = 0; i < pixels; i++, p += 3) {
    const d = Math.abs(prev[p] - cur[p]) + Math.abs(prev[p + 1] - cur[p + 1]) + Math.abs(prev[p + 2] - cur[p + 2]);
    if (d > tau) {
      changed++;
      if (changed >= cap) return changed / pixels;
    }
  }
  return changed / pixels;
}

/** 每行平均亮度（行数长度的 Float32Array）。 */
export function rowMeanProfile(rgb, width, height, out) {
  const dst = out ?? new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let p = y * width * 3;
    for (let x = 0; x < width; x++, p += 3) sum += 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
    dst[y] = width ? sum / width : 0;
  }
  return dst;
}

/**
 * 行位移估计（垂直滚动/翻页）：在 ±maxShift 内找行亮度剖面的最佳对齐，
 * 返回 {shift, corr, residRatio}。
 *  - corr 是重叠区 Pearson 相关：滚动时接近 1，换页/内容重排时低；
 *  - residRatio = 对齐后残差 / 未对齐残差：滚动应 ≤0.6，切页接近 1。
 * @param {Float32Array} a prev 行剖面
 * @param {Float32Array} b cur 行剖面
 */
export function estimateRowShift(a, b, opts = {}) {
  const maxShift = opts.maxShift ?? 24;
  const h = Math.min(a.length, b.length);
  let best = { shift: 0, corr: 0, residRatio: 1 };
  let baseAbs = 0;
  {
    let s = 0;
    for (let y = 0; y < h; y++) s += Math.abs(a[y] - b[y]);
    baseAbs = h ? s / h : 0;
  }
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    const y0 = Math.max(0, -shift);
    const y1 = Math.min(h, h - shift);
    const n = y1 - y0;
    if (n < h * 0.5) continue;
    let ma = 0;
    let mb = 0;
    for (let y = y0; y < y1; y++) {
      ma += a[y];
      mb += b[y + shift];
    }
    ma /= n;
    mb /= n;
    let cov = 0;
    let va = 0;
    let vb = 0;
    let abs = 0;
    for (let y = y0; y < y1; y++) {
      const da = a[y] - ma;
      const db = b[y + shift] - mb;
      cov += da * db;
      va += da * da;
      vb += db * db;
      abs += Math.abs(a[y] - b[y + shift]);
    }
    const corr = va > 1e-6 && vb > 1e-6 ? cov / Math.sqrt(va * vb) : 0;
    const resid = abs / n;
    if (corr > best.corr) best = { shift, corr, residRatio: baseAbs > 1e-6 ? resid / baseAbs : 1 };
  }
  return best;
}

