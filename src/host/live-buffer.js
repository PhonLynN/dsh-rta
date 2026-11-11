/**
 * host/live-buffer.js — 屏幕的「活缓冲」：把引擎零散的事件整理成一份随时可读的状态。
 *
 * 定位：引擎只负责「这一刻屏幕上有没有明显变化」，本模块负责回答人/模型真正关心的问题——
 * 「现在在看什么？刚才发生了什么？」。它是纯内存、零 I/O、可单测的：
 *   engine 'push' ──► push(ev)          记一条事件
 *   status 轮询   ──► setForeground(fg) 更新前台窗口（不产生事件）
 *   每步 assemble ──► digest(now)        渲染成一段可直接注入上下文的短文本
 *
 * 渲染有一条硬约束：**同样的屏幕状态必须渲染出同样的文本**。文本只在「有事发生」时变化，
 * 否则宿主会认为 runtime context 变了而反复落消息（见 docs/review/01、03）。所以这里
 * 不出现「当前秒数」，相对时间只用粗粒度区间（<1m / 1–5m / 5–15m / >15m）。
 */

/** 事件种类 → 给模型看的中文说法。heartbeat 不进时间线（它只表示「没变化」）。 */
const KIND_TEXT = Object.freeze({
  cut: '明显变化',
  integral: '持续变化（滚动/播放）',
  text: '文字内容变化',
  heartbeat: '静默确认',
  region: '用户圈选区域',
  manual: '用户主动快照',
});

/** 聚合计数行里保留的种类（heartbeat 太多，单独不列）。 */
const COUNTED_KINDS = Object.freeze(['cut', 'integral', 'text', 'region', 'manual']);

const MAX_TITLE_CHARS = 80;
const MAX_PROCESS_CHARS = 40;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 时间戳兜底：0 也是合法时间（测试与 epoch 场景），不能当 falsy 丢掉。 */
function timeOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 本地时间 HH:MM:SS（不带日期：注入文本越短越好）。 */
export function formatClock(at) {
  const d = new Date(Number(at) || 0);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 窗口标题/进程名里的换行、制表符、连续空白压成单空格，再按长度截断。 */
export function cleanTitle(raw, maxChars = MAX_TITLE_CHARS) {
  const text = String(raw ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
}

/** 引擎传来的 win 元组（winMeta）或 status.foreground 统一成内部形状。 */
export function normalizeForeground(fg) {
  if (!fg || typeof fg !== 'object') return null;
  const title = cleanTitle(fg.title);
  const process = cleanTitle(fg.process, MAX_PROCESS_CHARS);
  if (!title && !process) return null;
  return { title, process, hwnd: fg.hwnd ?? null, rect: fg.rect ?? null };
}

/** 状态粗粒度区间：用来描述「画面多久没明显变化」，同时保证文本不会逐秒变化。 */
export function activityBucket(staticMs) {
  const ms = Number(staticMs);
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 60_000) return 'hot';
  if (ms < 5 * 60_000) return 'recent';
  if (ms < 15 * 60_000) return 'idle';
  return 'dormant';
}

const ACTIVITY_TEXT = Object.freeze({
  hot: '最近 1 分钟内有变化',
  recent: '已 1–5 分钟无明显变化',
  idle: '已 5–15 分钟无明显变化',
  dormant: '已超过 15 分钟无明显变化',
  unknown: '暂无状态',
});

/** 单条事件的短描述（不含时间前缀与窗口后缀）。 */
export function describeEvent(ev) {
  const kind = ev?.kind;
  if (kind === 'cut') {
    const score = Number(ev?.score);
    return Number.isFinite(score) ? `${KIND_TEXT.cut}（强度 ${Math.round(score)}）` : KIND_TEXT.cut;
  }
  if (kind === 'region') {
    const id = ev?.region?.id ?? ev?.regionId;
    const bbox = ev?.region?.bbox;
    const where = bbox && Number.isFinite(bbox.x) && Number.isFinite(bbox.y)
      ? ` bbox=${Math.round(bbox.x)},${Math.round(bbox.y)},${Math.round(bbox.w ?? 0)}x${Math.round(bbox.h ?? 0)}`
      : '';
    return `${KIND_TEXT.region}${id != null ? ` R${id}` : ''}${where}`;
  }
  return KIND_TEXT[kind] ?? String(kind ?? '事件');
}

/** 一条时间线里的窗口变化后缀：只在窗口相对上一条真的变了时出现。 */
function windowSuffix(win) {
  if (!win?.title) return '';
  return ` → 窗口「${win.title}」`;
}

function sameWindow(a, b) {
  return (a?.title ?? '') === (b?.title ?? '') && (a?.process ?? '') === (b?.process ?? '');
}

/**
 * 渲染注入文本。纯函数：只依赖传入的字段，便于单测与「同状态同文本」校验。
 *
 * @param {object} state {now, events, foreground, counts, running, startedAt, lastSignificantAt, lastBeatAt}
 * @param {object} [opts] {eventTtlMs, maxEvents, maxLines, maxTextTokens, windowLabel}
 * @returns {string} 0 行（隐藏）或一段短文本
 */
export function renderDigest(state, opts = {}) {
  const now = Number(state?.now) || Date.now();
  const eventTtlMs = Number(opts.eventTtlMs) > 0 ? Number(opts.eventTtlMs) : 120_000;
  const maxLines = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : 12;
  const maxTextTokens = Number(opts.maxTextTokens) > 0 ? Number(opts.maxTextTokens) : 400;
  const maxChars = Math.max(120, Math.round(maxTextTokens * 1.5));
  const maxEvents = Number(opts.maxEvents) > 0 ? Number(opts.maxEvents) : 4;

  const events = Array.isArray(state?.events) ? state.events : [];
  // 时间线与计数行用同一个窗口（最近 eventTtlMs），避免「最近 N 分钟」写成整场累计。
  const windowEvents = events
    .filter((ev) => ev && ev.kind !== 'heartbeat' && ev.kind !== 'frame')
    .filter((ev) => now - Number(ev.at ?? now) <= eventTtlMs);
  const visible = windowEvents.slice(-maxEvents);

  const lines = ['〔RTA 屏幕感知 · 自动注入，非用户消息〕'];

  const fg = state?.foreground;
  if (fg?.title) {
    lines.push(`前台：${fg.title}${fg.process ? ` [${fg.process}]` : ''}`);
  } else if (state?.running) {
    lines.push('前台：未知（采集已启动，等待窗口信息）');
  } else {
    lines.push('前台：未知（采集未在运行）');
  }

  // 状态行：采集是否还在喂数据，比「静止多久」更紧急，优先显示。
  const beatRaw = state?.lastBeatAt;
  const beatAge = beatRaw === null || beatRaw === undefined ? -1 : now - timeOr(beatRaw, now);
  const sigRaw = state?.lastSignificantAt;
  const lastSig = sigRaw === null || sigRaw === undefined
    ? timeOr(state?.startedAt, now)
    : timeOr(sigRaw, now);
  const staticMs = Math.max(0, now - lastSig);
  if (beatAge > 30_000) lines.push('状态：采集数据已超过 30 秒没有更新');
  else if (beatAge > 5_000) lines.push('状态：采集数据超过 5 秒没有更新');
  else lines.push(`状态：${ACTIVITY_TEXT[activityBucket(staticMs)] ?? ACTIVITY_TEXT.unknown}`);

  // 计数行：窗口内各类事件各几次（与时间线同一窗口）。
  const parts = [];
  for (const kind of COUNTED_KINDS) {
    const n = windowEvents.reduce((acc, ev) => acc + (ev.kind === kind ? 1 : 0), 0);
    if (n > 0) parts.push(`${KIND_TEXT[kind]} ×${n}`);
  }
  if (parts.length) {
    const minutes = Math.max(1, Math.round(eventTtlMs / 60_000));
    lines.push(`最近 ${minutes} 分钟：${parts.join(' · ')}`);
  }

  if (visible.length) {
    lines.push('时间线（本地时间）：');
    let prevWindow = null;
    for (const ev of visible) {
      // 事件线太多时先丢最旧的：总行数（含头/状态/脚注）受 maxLines 约束。
      lines.push(`- ${formatClock(ev.at)} ${describeEvent(ev)}${windowSuffix(ev.window && !sameWindow(ev.window, prevWindow) ? ev.window : null)}`);
      prevWindow = ev.window ?? prevWindow;
    }
  } else {
    lines.push('时间线：最近没有显著变化。');
  }

  lines.push('需要原始画面：rta_look；更早历史：rta_recall。');

  // 行数上限：只砍时间线里最早的事件行，保留标题与尾巴；时间线至少留一条。
  const timelineHeaderIdx = 1 + 1 + 1 + (parts.length ? 1 : 0); // 〔RTA〕+ 前台 + 状态（+ 计数）
  const timelineStart = timelineHeaderIdx + (visible.length ? 1 : 0); // 第一条事件行
  if (visible.length) {
    while (lines.length > maxLines && lines.length > timelineStart + 1) {
      lines.splice(timelineStart, 1);
    }
  }

  // 字符上限：从最旧的事件行开始丢，至少保留最近一条（短而稳）。
  while (lines.join('\n').length > maxChars) {
    const idx = lines.findIndex((line, i) => i >= 2 && line.startsWith('- '));
    if (idx < 0) break;
    if (lines.filter((line) => line.startsWith('- ')).length <= 1) break;
    lines.splice(idx, 1);
  }

  return lines.join('\n');
}

/** 停止后的最后一条文本（仍带「非用户消息」标记，避免模型误以为用户又说了话）。 */
export function renderStopped(reason = '') {
  return [
    '〔RTA 屏幕感知 · 已停止〕',
    `屏幕采集已结束${reason ? `（${reason === 'explicit' ? '用户主动停止' : reason}）` : ''}，之后不再自动更新屏幕状态。`,
    '需要时可直接调用 rta_start 重新启用，或 rta_recall 回看历史。',
  ].join('\n');
}

/**
 * 创建一个活缓冲。所有方法都不抛错，也不做 I/O。
 *
 * @param {object} [opts] {maxEvents}
 */
export function createLiveBuffer({ maxEvents = 64 } = {}) {
  /** @type {Array<object>} 最近的事件，旧的在前 */
  let events = [];
  let foreground = null;
  let sessionId = null;
  let startedAt = null;
  let lastSignificantAt = null;
  let lastBeatAt = null;
  let running = false;
  let rev = 0;
  let counts = {};

  function emptyCounts() {
    const out = {};
    for (const kind of COUNTED_KINDS) out[kind] = 0;
    out.heartbeat = 0;
    return out;
  }

  /** 新会话开始：清空事件与计数。 */
  function reset({ sessionId: sid = null, at = Date.now(), running: isRunning = true } = {}) {
    events = [];
    foreground = null;
    sessionId = sid ?? null;
    startedAt = timeOr(at, Date.now());
    lastSignificantAt = null;
    lastBeatAt = startedAt;
    running = Boolean(isRunning);
    counts = emptyCounts();
    rev += 1;
  }

  /**
   * 记一条引擎事件（engine 'push' 的载荷）。
   * @returns {object|null} 规范化后的事件
   */
  function push(ev, at = Date.now()) {
    if (!ev || typeof ev !== 'object' || !ev.kind) return null;
    const when = timeOr(ev.at ?? ev.wall ?? at, Date.now());
    const item = {
      seq: Number(ev.seq ?? ev.id ?? 0) || 0,
      kind: String(ev.kind),
      at: when,
      score: Number.isFinite(Number(ev.score)) ? Number(ev.score) : (Number.isFinite(Number(ev.decision?.score)) ? Number(ev.decision.score) : null),
      region: ev.region && typeof ev.region === 'object' ? { id: ev.region.id ?? ev.regionId ?? null, bbox: ev.region.bbox ?? null } : null,
      regionId: ev.regionId ?? ev.region?.id ?? null,
      window: normalizeForeground(ev.win),
    };
    if (item.kind === 'frame') return item; // 存档帧不是「发生了什么」
    events.push(item);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    if (item.window) foreground = { ...item.window, at: item.at };
    if (item.kind !== 'heartbeat' && item.kind !== 'text') lastSignificantAt = item.at;
    rev += 1;
    return item;
  }

  /**
   * 更新前台窗口（来自 status 轮询，不是事件）。
   * @returns {boolean} 是否真的变化了
   */
  function setForeground(fg, at = Date.now()) {
    const next = normalizeForeground(fg);
    if (!next) return false;
    const when = timeOr(at, Date.now());
    if (foreground && sameWindow(foreground, next)) {
      foreground = { ...foreground, at: when };
      return false;
    }
    foreground = { ...next, at: when };
    rev += 1;
    return true;
  }

  /** 心跳：标记「数据源还活着」，用于识别采集卡死（只表示新鲜度，不改变文本）。 */
  function beat({ at = Date.now(), running: isRunning } = {}) {
    lastBeatAt = timeOr(at, Date.now());
    if (isRunning !== undefined && Boolean(isRunning) !== running) {
      running = Boolean(isRunning);
      rev += 1;
    }
  }

  /** 渲染当前状态下的注入文本。 */
  function digest(at = Date.now(), opts = {}) {
    return renderDigest({
      now: at,
      events,
      foreground,
      counts: { ...counts },
      running,
      startedAt,
      lastSignificantAt,
      lastBeatAt,
    }, opts);
  }

  /** 给 rta_status / 浮窗看的结构化快照（不是给模型的文本）。 */
  function snapshot() {
    return {
      rev,
      sessionId,
      running,
      startedAt,
      counts: { ...counts },
      lastSignificantAt,
      lastBeatAt,
      foreground: foreground ? { ...foreground } : null,
      events: events.slice(-8).map((ev) => ({ ...ev })),
    };
  }

  return {
    reset,
    push,
    setForeground,
    beat,
    digest,
    snapshot,
    get rev() { return rev; },
    get running() { return running; },
    get sessionId() { return sessionId; },
    get size() { return events.length; },
  };
}
