/**
 * algo/tiers.js — 拼图档位与 token 估算。
 *
 * 数字来自对 see-now / storyboard 实测账单的归纳：模型按 42px 网格切图，
 * 一张图的 tokens ≈ rows × (cols + 1) + 2，其中 rows=ceil(h/42)、cols=ceil(w/42)。
 * 所以"少发几张大图"永远比"多发几张小图"便宜：800×450 只有 233 tokens，
 * 而 4 张 800×450 单独发是 4×233，拼成一张 2×2 的 1050×630 只要 392。
 *
 * RTA 的档位（沿用 see-now 的四档，宽度对齐 42px）：
 *   1–2 帧 → 800×450（233 tokens）
 *   3–4 帧 → 1050×630（392 tokens）
 *   5–8 帧 → 1260×756（560 tokens）
 *   9–12 帧 → 1596×924（860 tokens）
 */

export const SHEET_TIERS = Object.freeze([
  { name: 'single', width: 800, height: 450, cols: 1, rows: 1, maxFrames: 1 },
  { name: 'pair', width: 800, height: 450, cols: 2, rows: 1, maxFrames: 2 },
  { name: 'quad', width: 1050, height: 630, cols: 2, rows: 2, maxFrames: 4 },
  { name: 'octet', width: 1260, height: 756, cols: 4, rows: 2, maxFrames: 8 },
  { name: 'dozen', width: 1596, height: 924, cols: 4, rows: 3, maxFrames: 12 },
]);

/** 42px 网格下的 token 估算（向上取整，宁多勿少）。 */
export function tokensFor(width, height) {
  const cols = Math.ceil(width / 42);
  const rows = Math.ceil(height / 42);
  return rows * (cols + 1) + 2;
}

/** 按帧数选档位；返回的 plan 里带 cell 尺寸。 */
export function planSheet(frameCount, opts = {}) {
  const n = Math.max(1, Math.min(12, frameCount | 0));
  let tier = SHEET_TIERS.find((t) => n <= t.maxFrames) ?? SHEET_TIERS[SHEET_TIERS.length - 1];
  if (opts.maxTokens && tokensFor(tier.width, tier.height) > opts.maxTokens) {
    // 超预算就往小一档走；小到 800×450 还超就接受（不能不发）
    const idx = SHEET_TIERS.indexOf(tier);
    for (let i = idx - 1; i >= 0; i--) {
      const t = SHEET_TIERS[i];
      if (t.maxFrames >= n && tokensFor(t.width, t.height) <= opts.maxTokens) { tier = t; break; }
    }
  }
  const cellW = Math.floor(tier.width / tier.cols);
  const cellH = Math.floor(tier.height / tier.rows);
  return {
    tier: tier.name,
    width: tier.width,
    height: tier.height,
    cols: tier.cols,
    rows: tier.rows,
    cellW,
    cellH,
    tokens: tokensFor(tier.width, tier.height),
  };
}

/** 把一批帧按档位切成若干张 sheet（每张最多 12 帧）。 */
export function chunkFrames(frames, maxFrames = 12) {
  const out = [];
  for (let i = 0; i < frames.length; i += maxFrames) out.push(frames.slice(i, i + maxFrames));
  return out;
}
