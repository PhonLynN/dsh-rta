/**
 * host/hd.js — 高清注入：从原生分辨率录像里挑「有信息」的时刻，裁到窗口，缩到 token 预算。
 *
 * 为什么要有这一层（用户 m00761）：
 *   过去注入/回捞用的是 eventRing 里 512×288 的降采样帧，拼图后文字与细节都糊；
 *   但 RTA 的录像本来就是原生 2560×1440。差的是「按语义重要性挑时刻 + 裁到当时的
 *   窗口 + 按预算缩图」这条链，而不是分辨率。
 *
 * 这里只做纯函数 + 一次 engine.frameAt（ffmpeg 抽帧）：
 *   - pickInformativeFrames：region > manual > cut > text > integral，跳过 heartbeat，
 *     同窗口短时间去重（视频播放时 cut 会连发，全留着没有意义）。
 *   - pickSpread：按时间窗均分，每段挑最重要的一条 —— 长视频/长任务要的是「覆盖」，
 *     不是「最激烈的 3 帧都挤在开头」。
 *   - cropRectFor / buildVf：把窗口 rect（或圈选 bbox）变成 ffmpeg crop+scale，
 *     边界收敛、宽高偶数、面积过大时回退整幅。
 *   - widthForTokens：按 token 预算反推宽度（tokensFor 来自 algo/tiers）。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokensFor } from '../algo/tiers.js';

export const HD_DEFAULT_WIDTH = 1600;
export const HD_MAX_EVENT_AGE_MS = 120_000;

const KIND_WEIGHT = Object.freeze({
  region: 1000,
  manual: 400,
  cut: 200,
  text: 180,
  integral: 100,
  heartbeat: 0,
});

export const KIND_LABEL = Object.freeze({
  region: '用户圈选区域',
  manual: '手动快照',
  cut: '明显变化',
  text: '文字内容变化',
  integral: '持续变化（滚动/播放）',
  heartbeat: '静默确认',
});

export function eventWall(ev) {
  return Number(ev?.wall ?? ev?.at ?? ev?.wallMs ?? 0);
}

export function eventWindow(ev) {
  return ev?.win ?? ev?.window ?? null;
}

export function eventTitle(ev) {
  const win = eventWindow(ev);
  return win?.title ?? null;
}

/** 信息量打分：类型权重 + 变化强度 + 圈选面积（大区域通常更值得看）。 */
export function importance(ev) {
  const base = KIND_WEIGHT[ev?.kind] ?? 50;
  const score = Number(ev?.score) || 0;
  const bbox = ev?.kind === 'region' ? ev?.region?.bbox : null;
  const area = (Number(bbox?.w) || 0) * (Number(bbox?.h) || 0);
  const areaBonus = area > 0 ? Math.min(60, Math.log2(Math.max(1, area)) * 3) : 0;
  return base + score + areaBonus;
}

/**
 * 事件对应的「值得裁」屏幕矩形（原生像素）。
 * region 用用户圈选的 bbox 且不外扩（用户已经指明了关注点）；其余用事件发生时的窗口 rect。
 */
export function cropRectFor(ev, { foreground = null, padding = 0.06 } = {}) {
  let rect = null;
  if (ev?.kind === 'region' && ev?.region?.bbox) {
    rect = ev.region.bbox;
    padding = 0.12;
  } else {
    rect = eventWindow(ev)?.rect ?? ev?.rect ?? null;
  }
  if (!rect && foreground?.rect) rect = foreground.rect;
  const x = Number(rect?.x);
  const y = Number(rect?.y);
  const w = Number(rect?.w);
  const h = Number(rect?.h);
  if (![x, y, w, h].every(Number.isFinite) || w < 32 || h < 32) return null;
  const padX = Math.round(w * padding);
  const padY = Math.round(h * padding);
  return { x: x - padX, y: y - padY, w: w + padX * 2, h: h + padY * 2 };
}

function sameWindowTitle(a, b) {
  const t1 = a?.title ?? '';
  const t2 = b?.title ?? '';
  return Boolean(t1) && t1 === t2;
}

/**
 * 按信息量排序挑选事件帧。
 * @param {object[]} events 事件（host/live-buffer 归一化后的、或 engine.eventRing 原始 ev）
 * @param {object} [opts] {limit, now, maxAgeMs, dedupeMs}
 * @returns {{ev:object, wall:number, weight:number, win:object|null}[]}
 */
export function pickInformativeFrames(events, {
  limit = 2,
  now = Date.now(),
  maxAgeMs = HD_MAX_EVENT_AGE_MS,
  dedupeMs = 1500,
} = {}) {
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  const rows = (Array.isArray(events) ? events : [])
    .filter((ev) => ev && ev.kind && ev.kind !== 'heartbeat')
    .map((ev) => ({ ev, wall: eventWall(ev), weight: importance(ev), win: eventWindow(ev) }))
    .filter((row) => row.wall > 0);
  rows.sort((a, b) => b.weight - a.weight || b.wall - a.wall);

  const picked = [];
  for (const row of rows) {
    if (picked.length >= max) break;
    if (Number.isFinite(maxAgeMs) && now - row.wall > maxAgeMs) continue;
    const clash = picked.some((p) => {
      if (Math.abs(p.wall - row.wall) < Math.min(dedupeMs, 800)) return true;
      return sameWindowTitle(p.win, row.win) && Math.abs(p.wall - row.wall) < dedupeMs;
    });
    if (clash) continue;
    picked.push(row);
  }
  return picked;
}

/**
 * 在 [from, to] 里均分成 limit 段，每段挑一条最重要的事件；
 * 某段没有事件时用该段中间的录像帧（videoMs）补位，保证「覆盖」而不是「最激烈的一段」。
 *
 * @param {object[]} records index.jsonl 行（event 行有 kind/score/win，frame 行有 videoMs/wall）
 * @param {object} [opts] {limit, from, to}
 * @returns {{record:object, wall:number, weight:number, fromFrame:boolean}[]}
 */
export function pickSpread(records, { limit = 3, from = 0, to = Date.now() } = {}) {
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  const start = Number.isFinite(Number(from)) ? Number(from) : 0;
  const end = Number.isFinite(Number(to)) ? Number(to) : Date.now();
  const span = Math.max(1, end - start);
  const slice = span / max;
  const rows = (Array.isArray(records) ? records : [])
    .map((record) => ({ record, wall: eventWall(record) }))
    .filter((row) => row.wall >= start && row.wall <= end);
  const events = rows.filter((row) => row.record?.kind && row.record.kind !== 'heartbeat');
  const frames = rows.filter((row) => row.record?.type === 'frame' || Number.isFinite(Number(row.record?.videoMs)));

  const picked = [];
  for (let i = 0; i < max; i += 1) {
    const lo = start + i * slice;
    const hi = lo + slice;
    const inSlice = events.filter((row) => row.wall >= lo && row.wall < hi);
    if (inSlice.length) {
      inSlice.sort((a, b) => importance(b.record) - importance(a.record) || b.wall - a.wall);
      picked.push({ ...inSlice[0], weight: importance(inSlice[0].record), fromFrame: false });
      continue;
    }
    const mid = lo + slice / 2;
    const frameRows = frames.filter((row) => row.wall >= lo && row.wall < hi);
    if (frameRows.length) {
      frameRows.sort((a, b) => Math.abs(a.wall - mid) - Math.abs(b.wall - mid));
      const chosen = frameRows[0];
      picked.push({ ...chosen, weight: 0, fromFrame: true });
    }
  }
  return picked;
}

/**
 * 生成 ffmpeg filter：裁到 rect（越界收敛到画面内），再按宽度缩放；宽高都取偶数。
 * 裁掉的面积极小（<15%）时回退整幅，避免白付一次缩放。
 */
export function buildVf({ rect = null, frameWidth, frameHeight, maxWidth = HD_DEFAULT_WIDTH } = {}) {
  // 只取偶数即可；注意 0 是合法值（整幅画面从 0,0 开始），不能像旧实现那样把 0 变成 2。
  const even = (n) => {
    const v = Math.round(Number(n) / 2) * 2;
    return Number.isFinite(v) ? v : 0;
  };
  const fw = Math.max(2, even(frameWidth || 2560));
  const fh = Math.max(2, even(frameHeight || 1440));
  let x = 0;
  let y = 0;
  let w = fw;
  let h = fh;
  if (rect && Number(rect.w) >= 32 && Number(rect.h) >= 32) {
    x = Math.min(Math.max(0, Number(rect.x) || 0), fw - 2);
    y = Math.min(Math.max(0, Number(rect.y) || 0), fh - 2);
    w = Math.min(Number(rect.w), fw - x);
    h = Math.min(Number(rect.h), fh - y);
  }
  if (w * h >= fw * fh * 0.85) {
    x = 0;
    y = 0;
    w = fw;
    h = fh;
  }
  x = Math.max(0, even(x));
  y = Math.max(0, even(y));
  w = Math.max(2, Math.min(even(w), fw - x));
  h = Math.max(2, Math.min(even(h), fh - y));
  const targetW = Math.max(2, Math.min(Math.max(720, Number(maxWidth) || HD_DEFAULT_WIDTH), w));
  const needsScale = targetW !== w;
  const outH = Math.max(2, even(Math.round((h * targetW) / w)));
  const vf = needsScale
    ? `crop=${w}:${h}:${x}:${y},scale=${targetW}:-2`
    : `crop=${w}:${h}:${x}:${y}`;
  return { vf, width: targetW, height: outH, crop: { x, y, w, h } };
}

/** 按 token 预算反推可用宽度（默认按 16:9 估；真实高度由 buildVf 按裁切比例算）。 */
export function widthForTokens(maxTokens, aspect = 16 / 9, candidates = [1600, 1440, 1280, 1160, 1024, 900, 800, 720]) {
  const budget = Math.max(120, Number(maxTokens) || 400);
  for (const width of candidates) {
    const height = Math.max(2, Math.round(width / aspect / 2) * 2);
    if (tokensFor(width, height) <= budget) return width;
  }
  return candidates[candidates.length - 1];
}

/** 原生录像的宽高（engine.status().video），拿不到就回退常见 2560×1440。 */
export function nativeFrameSize(engine, fallback = { width: 2560, height: 1440 }) {
  try {
    if (typeof engine?.status === 'function') {
      const video = engine.status()?.video ?? null;
      if (Number(video?.width) > 0 && Number(video?.height) > 0) {
        return { width: Number(video.width), height: Number(video.height) };
      }
    }
  } catch { /* ignore */ }
  return fallback;
}

export async function makeHdDir() {
  return mkdtemp(join(tmpdir(), 'rta-hd-'));
}

export async function cleanHdDir(dir) {
  if (!dir) return;
  try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * 从录像里抽一张 HD 帧（裁到事件窗口/圈选区域，缩到 maxWidth）。
 * 唯一 I/O 依赖：engine.frameAt({wallMs, outPath, vf})。
 */
export async function extractHdFrame(engine, ev, {
  dir,
  foreground = null,
  frameWidth = null,
  frameHeight = null,
  maxWidth = HD_DEFAULT_WIDTH,
  outPath = null,
} = {}) {
  if (!engine || typeof engine.frameAt !== 'function') return { ok: false, reason: 'no-video-track' };
  const wall = eventWall(ev);
  if (!wall) return { ok: false, reason: 'no-wall' };
  const size = frameWidth && frameHeight
    ? { width: frameWidth, height: frameHeight }
    : nativeFrameSize(engine);
  const rect = cropRectFor(ev, { foreground });
  const viewer = buildVf({ rect, frameWidth: size.width, frameHeight: size.height, maxWidth });
  const target = outPath ?? join(dir ?? tmpdir(), `hd-${ev?.seq ?? Math.round(wall)}-${Math.round(wall)}.jpg`);
  try {
    const res = await engine.frameAt({ wallMs: wall, outPath: target, vf: viewer.vf });
    if (!res?.ok) return { ok: false, reason: res?.reason ?? 'extract-failed', wall, rect, vf: viewer.vf };
    return {
      ok: true,
      path: target,
      wall,
      rect,
      vf: viewer.vf,
      width: viewer.width,
      height: viewer.height,
      tokens: tokensFor(viewer.width, viewer.height),
    };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err), wall };
  }
}
