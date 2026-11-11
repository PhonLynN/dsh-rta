/**
 * algo/pack.js — 把多帧拼成一张 sheet，并在帧上画关注标签/圈画红框。
 *
 * 为什么拼图而不是逐张发：一张 1050×630 的 2×2 拼图 392 tokens，
 * 四张 800×450 单独发是 4×233=932 tokens。而且拼图让模型能直接对比
 * "前后两帧哪里变了"——这正是 RTA 想让 AI 看懂的东西。
 *
 * 全部是纯像素操作（nearest 缩放 + 5×7 bitmap 字体），不依赖 canvas，
 * 这样在 cordis host 插件里不会被 Electron 的渲染进程限制卡住。
 */

const FONT = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  'T': [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  'A': [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  'R': [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  'S': [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  'C': [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  'M': [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
  '-': [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000],
  ':': [0b00000, 0b00100, 0b00000, 0b00000, 0b00000, 0b00100, 0b00000],
  '.': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100],
  '/': [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

/** 在 RGB 缓冲上画一个实心矩形（越界自动裁剪）。 */
export function fillRect(rgb, width, height, x, y, w, h, color) {
  const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
  const x1 = Math.min(width, x0 + (w | 0)), y1 = Math.min(height, y0 + (h | 0));
  for (let yy = y0; yy < y1; yy++) {
    let o = (yy * width + x0) * 3;
    for (let xx = x0; xx < x1; xx++, o += 3) {
      rgb[o] = color[0]; rgb[o + 1] = color[1]; rgb[o + 2] = color[2];
    }
  }
}

/** 画空心矩形（1px 线宽，用于圈画区域的高亮框）。 */
export function strokeRect(rgb, width, height, x, y, w, h, color, thickness = 2) {
  const t = Math.max(1, thickness | 0);
  fillRect(rgb, width, height, x, y, w, t, color);
  fillRect(rgb, width, height, x, y + h - t, w, t, color);
  fillRect(rgb, width, height, x, y, t, h, color);
  fillRect(rgb, width, height, x + w - t, y, t, h, color);
}

/** 画一段 5×7 位图文字（只支持 FONT 里的字符；scale 默认 2 → 10×14）。 */
export function drawText(rgb, width, height, x, y, text, opts = {}) {
  const scale = opts.scale ?? 2;
  const color = opts.color ?? [255, 235, 59];
  const pad = opts.pad ?? 2;
  const chars = String(text).toUpperCase();
  let caret = x;
  const maxY = y + GLYPH_H * scale + pad * 2;
  if (opts.background) {
    fillRect(rgb, width, height, x - pad, y - pad, chars.length * (GLYPH_W + 1) * scale + pad * 2, GLYPH_H * scale + pad * 2, opts.background);
  }
  for (const ch of chars) {
    const glyph = FONT[ch] ?? FONT[' '];
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const row = glyph[gy];
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (!(row & (1 << (GLYPH_W - 1 - gx)))) continue;
        fillRect(rgb, width, height, caret + gx * scale, y + gy * scale, scale, scale, color);
      }
    }
    caret += (GLYPH_W + 1) * scale;
  }
  return { x: caret, y: maxY };
}

/** nearest 缩放把 src 贴到 dst 的 (dx,dy,dw,dh)，保持宽高比居中 + 黑边。 */
export function blitFit(dst, dw, dh, src, sw, sh, dx, dy, cw, ch, bg = [12, 12, 12]) {
  fillRect(dst, dw, dh, dx, dy, cw, ch, bg);
  const scale = Math.min(cw / sw, ch / sh);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const ox = dx + Math.floor((cw - w) / 2);
  const oy = dy + Math.floor((ch - h) / 2);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, (y * sh / h) | 0);
    let so = sy * sw * 3;
    let do_ = ((oy + y) * dw + ox) * 3;
    for (let x = 0; x < w; x++, do_ += 3) {
      const sx = Math.min(sw - 1, (x * sw / w) | 0);
      const s = so + sx * 3;
      dst[do_] = src[s]; dst[do_ + 1] = src[s + 1]; dst[do_ + 2] = src[s + 2];
    }
  }
  return { x: ox, y: oy, w, h };
}

/**
 * 拼一张 sheet。
 *
 * @param {object} p
 * @param {Array<{rgb: Uint8Array, width: number, height: number, label?: string,
 *   region?: {bbox:{x:number,y:number,w:number,h:number}},
 *   screen?: {x:number,y:number,w:number,h:number}}>} p.frames
 * @param {{width:number,height:number,cols:number,rows:number,cellW:number,cellH:number}} p.plan
 * @param {number} [p.gap=2] 格子间距
 * @param {string} [p.title] 左上角总标题（如 "RTA 0123"）
 * @returns {{rgb: Uint8Array, width: number, height: number, cells: Array<object>}}
 */
export function composeSheet({ frames, plan, gap = 2, title = '' }) {
  const { width, height, cols, rows, cellW, cellH } = plan;
  const rgb = new Uint8Array(width * height * 3);
  fillRect(rgb, width, height, 0, 0, width, height, [8, 8, 8]);

  const cells = [];
  for (let i = 0; i < frames.length && i < cols * rows; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const dx = col * cellW + (col ? gap : 0);
    const dy = row * cellH + (row ? gap : 0);
    const cw = cellW - (col ? gap : 0);
    const ch = cellH - (row ? gap : 0);
    const frame = frames[i];
    const box = blitFit(rgb, width, height, frame.rgb, frame.width, frame.height, dx, dy, cw, ch);

    // 圈画区域红框：屏幕坐标 → 帧内坐标 → 格内坐标（三段线性映射）
    if (frame.region?.bbox && frame.screen?.w && frame.screen?.h) {
      const b = frame.region.bbox;
      const fx = (b.x - frame.screen.x) / frame.screen.w * box.w;
      const fy = (b.y - frame.screen.y) / frame.screen.h * box.h;
      const fw = (b.w / frame.screen.w) * box.w;
      const fh = (b.h / frame.screen.h) * box.h;
      strokeRect(rgb, width, height, Math.round(box.x + fx), Math.round(box.y + fy), Math.max(3, Math.round(fw)), Math.max(3, Math.round(fh)), [255, 48, 48], 2);
      if (frame.region.id) {
        drawText(rgb, width, height, Math.round(box.x + fx) + 3, Math.round(box.y + fy) + 3, `R${frame.region.id}`, { scale: 1, color: [255, 80, 80], background: [0, 0, 0] });
      }
    }

    // 帧标签（时间/序号）
    if (frame.label) {
      drawText(rgb, width, height, box.x + 4, box.y + 4, frame.label, {
        scale: 1, color: [255, 255, 255], background: [20, 20, 20], pad: 1,
      });
    }
    cells.push({ index: i, box, frame });
  }

  if (title) drawText(rgb, width, height, 4, height - 12, title, { scale: 1, color: [160, 160, 160] });
  return { rgb, width, height, cells };
}
