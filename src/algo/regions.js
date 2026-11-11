/**
 * algo/regions.js — 圈画区域的轨迹记录与坐标映射。
 *
 * 需求：按住 Shift+Ctrl+Alt 直接用鼠标画，不用按鼠标键；被画区域取鼠标轨迹
 * 坐标极值；区域要带时间戳，并且能映射回每一帧（发给 AI 的帧上叠红框）。
 *
 * 这里只做"记录 + 几何"，不做渲染（渲染在 pack.js 的 composeSheet 里）。
 * 坐标统一用**屏幕物理像素**；DPR/多屏信息挂在 monitor 字段上，不做换算——
 * 换算在采集层就完成了（抓到的帧本身就是物理像素）。
 */

/** 轨迹点最小移动距离（像素）：抖动的鼠标不值得记 60 个点 */
const MIN_MOVE = 2;

/** 点集 → 包围盒（带 padding，clamp 到屏幕内）。 */
export function bboxOf(points, { padding = 6, screen } = {}) {
  if (!points || points.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  x0 -= padding; y0 -= padding; x1 += padding; y1 += padding;
  if (screen) {
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(screen.width - 1, x1);
    y1 = Math.min(screen.height - 1, y1);
  }
  return { x: Math.round(x0), y: Math.round(y0), w: Math.max(1, Math.round(x1 - x0)), h: Math.max(1, Math.round(y1 - y0)) };
}

/** 一轮圈画的状态机（按下 Shift+Ctrl+Alt 开始 → 松开结束）。 */
export function createRegionTracker({ nextId = 1, screen } = {}) {
  let id = nextId;
  let active = null;

  return {
    get drawing() { return active !== null; },

    start(t = Date.now()) {
      active = { id: id++, tStart: t, tEnd: null, points: [], bbox: null, screen: screen ?? null };
      return active;
    },

    /** @returns {boolean} 是否真的记录了这个点（移动太小的点被忽略） */
    add(x, y, t = Date.now()) {
      if (!active) return false;
      const pts = active.points;
      const last = pts.length ? pts[pts.length - 1] : null;
      if (last && Math.abs(x - last.x) <= MIN_MOVE && Math.abs(y - last.y) <= MIN_MOVE) return false;
      pts.push({ x, y, t });
      active.bbox = bboxOf(pts, { screen: active.screen ?? undefined });
      return true;
    },

    finish(t = Date.now()) {
      if (!active) return null;
      active.tEnd = t;
      if (!active.bbox && active.points.length) {
        active.bbox = bboxOf(active.points, { screen: active.screen ?? undefined });
      }
      const done = active;
      active = null;
      // 不足 2 个点/1 像素的圈画当误触
      if (!done.bbox || done.points.length < 2) return null;
      return done;
    },

    cancel() { active = null; },
  };
}

/** 把屏幕坐标里的区域框映射到一帧的局部坐标（帧 = 屏幕上的一块矩形）。 */
export function regionToFrame(region, frameScreen) {
  if (!region?.bbox || !frameScreen) return null;
  const b = region.bbox;
  const x0 = Math.max(b.x, frameScreen.x);
  const y0 = Math.max(b.y, frameScreen.y);
  const x1 = Math.min(b.x + b.w, frameScreen.x + frameScreen.w);
  const y1 = Math.min(b.y + b.h, frameScreen.y + frameScreen.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return {
    id: region.id,
    tStart: region.tStart,
    tEnd: region.tEnd,
    bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    /* 帧内像素坐标（pack.js 用这个直接画） */
    local: {
      x: Math.round(x0 - frameScreen.x),
      y: Math.round(y0 - frameScreen.y),
      w: Math.round(x1 - x0),
      h: Math.round(y1 - y0),
    },
  };
}

/** 两个区域是否重叠（用于把连续几笔圈画合并成一组推送）。 */
export function overlaps(a, b, margin = 0) {
  if (!a?.bbox || !b?.bbox) return false;
  const A = a.bbox, B = b.bbox;
  return !(A.x + A.w + margin < B.x || B.x + B.w + margin < A.x || A.y + A.h + margin < B.y || B.y + B.h + margin < A.y);
}
