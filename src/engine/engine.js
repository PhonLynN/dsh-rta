/**
 * engine/engine.js — RTA 的运行时：采集 → 哨兵分析 → 选择 → 落盘 → 推送队列。
 *
 * 设计原则（和用户对齐过的）：
 *  - 没有"模式"：一条恒定管线，参数自适应；唯一的状态是 recording / idle。
 *  - 采集一直在跑：30Hz 哨兵（低分辨率、只做差分）+ 15Hz 存档（512px、全帧保留）。
 *  - 算法只决定"主动推送什么"，不删除任何帧——所有帧都在本地，可按时间戳回捞。
 *  - 推送的是"事件"，不是"图片流"：cut/integral/text/heartbeat/region 五类。
 *  - 图片不直接进会话：工具调用时才会把拼图交给 attachments，用完立刻 offload。
 *
 * 这个文件不 import 任何宿主 API，纯 Node，因此可以在 CLI 里 headless 跑
 * （bin/rta-run.mjs），也可以被 cordis 插件直接 new 出来。
 */

import { EventEmitter } from 'node:events';
import { createSelector } from '../algo/select.js';
import { frameToHsv, scorePair, mcRatioScore, meanLuma } from '../algo/color.js';
import { downscale, downscaleSample } from '../img/scale.js';
import { bgraToRgb } from '../img/png.js';
import { planSheet } from '../algo/tiers.js';
import { composeSheet } from '../algo/pack.js';
import { createRegionTracker, regionToFrame } from '../algo/regions.js';
import { SessionStore } from '../store/store.js';
import { PngWriter } from '../store/writer.js';
import { newSessionId, sessionsRoot } from '../store/paths.js';
import { createGdiSource } from '../capture/gdi.js';
import { isJpegAvailable } from '../native/gdiplus.js';
import { resolveFfmpeg, createRecorder } from '../record/ffmpeg.js';
import { VK } from '../capture/win32.js';

export const DEFAULT_ENGINE_CONFIG = Object.freeze({
  capture: {
    sentinelHz: 30,          // 哨兵频率：低分辨率差分，决定"变没变"
    archiveFps: 15,          // 存档频率：512px 全帧，决定"回捞精度"
    sentinelWidth: 192,      // 哨兵宽度（1080p 下 192×108；4K 自动等比）
    archiveWidth: 512,       // 存档宽度（258×288 for 16:9）
    archiveFormat: 'jpeg',   // 基线帧编码：jpeg（~14KB/帧）| png（~40KB/帧）
    dedupeScore: 1.0,        // 近重复阈值：哨兵分数低于它 + 窗口没换 → 复用上一张
    dedupeMc: 0.005,         // 近重复阈值：变化格占比低于它 → 复用上一张
    archiveMode: 'video',    // 'video'：全量原始帧进录像（默认）；'jpeg'：逐帧 512px 图片
    videoFps: 15,            // 录像帧率（原始分辨率 2560×1440）
    videoQuality: 26,        // QSV global_quality / x264 CRF
    videoSegmentSeconds: 300,// 分段长度：录制中也能按段抽帧
    videoEncoder: 'auto',    // auto | h264_qsv | h264_nvenc | h264_amf | libx264
    windowInfoEveryMs: 1000, // 前台窗口标题/进程采样间隔
  },
  selection: {},             // 透传给 algo/select.js
  retentionHours: 24,        // endedAt 之后图片保留 24h（文字永久）
  maxEventsInMemory: 20,     // 推送事件 ring（含像素，~8MB；需要容纳一次连续切页的多个页面）
  maxArchiveInMemory: 24,    // 存档帧 ring（用于临时拼图回看）
  gcEveryMs: 3600_000,       // 每小时扫一次过期 session
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** FNV-1a：64KB 的哨兵缓冲 hash 约 0.1ms，够用来判"和上一帧是不是同一张"。 */
function fnv1a(bytes) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 窗口元信息也参与去重：同样的像素但换了窗口，仍然算新帧。 */
function winKeyOf(win) {
  return win ? `${win.hwnd}|${win.title}|${win.rect?.x},${win.rect?.y},${win.rect?.w},${win.rect?.h}|${win.visible}` : '';
}

/**
 * 「页面」身份：同一窗口里换 tab/路由时 hwnd 不变但标题会变；换应用时两者都变。
 * 只看 process+title，忽略 rect（窗口拖动不算换页）。
 */
function pageKeyOf(win) {
  if (!win) return '';
  return `${win.process ?? ''}|${win.title ?? ''}`;
}

/** 创建引擎。参数都可以注入，方便单测/CLI。 */
export function createEngine(opts = {}) {
  const bus = new EventEmitter();
  const logger = opts.logger ?? null;
  const env = opts.env ?? process.env;
  let cfg = mergeConfig(DEFAULT_ENGINE_CONFIG, opts.config);

  let source = null;
  let store = null;
  let writer = null;
  let selector = null;
  let regionTracker = null;
  let state = 'idle';
  let startedAt = 0;
  let sessionId = null;

  let tickTimer = null;
  let hotkeyTimer = null;
  let gcTimer = null;
  let tickIndex = 0;
  let lastTickStart = 0;
  let tickMs = 0;

  // 哨兵缓冲（双缓冲，避免每帧 new）
  let sentinelW = 0;
  let sentinelH = 0;
  let archiveW = 0;
  let archiveH = 0;
  let rgbA = null; let rgbB = null;
  let hsvA = null; let hsvB = null;
  let curRgb = null; let prevRgb = null;
  let curHsv = null; let prevHsv = null;
  let sentinelBuffersFlipped = false;

  // 最近事件/存档（内存 ring，只用于"刚发生了什么"的拼图和回捞）
  const eventRing = [];
  const archiveRing = [];
  // region 单独保活：视频播放时 cut/integral 会把 12 槽 eventRing 冲满，
  // 用户圈过的区域不能因此丢（rta_region 的 P0 缺口）。
  const regionRing = [];

  // 热键状态（8ms 轮询；不需要消息循环，见 win32.js 实测）
  const keys = { ctrl: false, alt: false, shift: false, esc: false, tab: false };
  let exitLatch = false;
  let lastCursor = { x: 0, y: 0 };
  let lastForeground = null;
  let foregroundAt = 0;

  const stats = {
    ticks: 0, grabErrors: 0, archived: 0, events: 0, dropped: 0,
    analysisMsEma: 0, tickHzEma: 0,
  };
  let lastDecision = null;
  let lastError = null;

  // 存档去重：屏幕没变时复用上一张 PNG 文件，时间轴仍然每个 tick 一行。
  // 静态桌面 15Hz 跑一小时不会写出 5 万张相同的图。
  let lastArchiveHash = 0;
  let lastArchiveFile = null;
  let lastArchiveWinKey = '';

  // 录像轨：全量原始帧进分段 TS 视频；索引每帧只记"视频内毫秒"。
  let recorder = null;

  function mergeConfig(base, patch) {
    if (!patch) return { ...base, capture: { ...base.capture }, selection: { ...base.selection } };
    return {
      ...base, ...patch,
      capture: { ...base.capture, ...(patch.capture ?? {}) },
      selection: { ...base.selection, ...(patch.selection ?? {}) },
    };
  }

  // ───────────────────────────── 生命周期 ─────────────────────────────

  async function start({ now = Date.now(), id = null, config = null } = {}) {
    if (state === 'running') return status();
    if (config) cfg = mergeConfig(cfg, config);

    source = opts.source ?? createGdiSource({ logger });
    if (!source.ok) throw new Error(`screen source unavailable: ${source.reason ?? 'unknown'}`);
    const { width: sw, height: sh } = source.size;

    sentinelW = cfg.capture.sentinelWidth;
    sentinelH = Math.max(2, Math.round(sentinelW * sh / sw / 2) * 2);
    archiveW = cfg.capture.archiveWidth;
    archiveH = Math.max(2, Math.round(archiveW * sh / sw / 2) * 2);

    const sentinelPixels = sentinelW * sentinelH;
    rgbA = new Uint8Array(sentinelPixels * 3);
    rgbB = new Uint8Array(sentinelPixels * 3);
    hsvA = new Float32Array(sentinelPixels * 3);
    hsvB = new Float32Array(sentinelPixels * 3);
    curRgb = rgbA; prevRgb = null;
    curHsv = hsvA; prevHsv = null;

    sessionId = id ?? newSessionId(now);
    store = new SessionStore({
      id: sessionId,
      root: opts.root ?? sessionsRoot(env),
      now,
      screen: { width: sw, height: sh },
      config: {
        retentionHours: cfg.retentionHours,
        capture: cfg.capture,
        selection: { ...cfg.selection },
      },
      logger,
    });
    await store.init();
    writer = new PngWriter({ logger });

    // 录像轨（archiveMode==='video'）：15Hz 原始分辨率进视频，回看时按时间戳抽帧。
    recorder = null;
    if (cfg.capture.archiveMode === 'video') {
      const ff = resolveFfmpeg(env);
      if (ff?.path) {
        try {
          const r = createRecorder({
            logger, ffmpegPath: ff.path,
            dir: store.paths.video,
            width: sw, height: sh,
            fps: cfg.capture.videoFps,
            quality: cfg.capture.videoQuality,
            segmentSeconds: cfg.capture.videoSegmentSeconds,
            encoder: cfg.capture.videoEncoder,
          });
          const started = await r.start();
          if (started?.ok) recorder = r;
          else logger?.warn?.(`[rta] recorder unavailable: ${started?.error ?? 'unknown'}`);
        } catch (err) {
          logger?.warn?.(`[rta] recorder failed: ${err?.message ?? err}`);
        }
      } else {
        logger?.warn?.('[rta] ffmpeg not found; archive falls back to per-frame images');
      }
    }

    selector = createSelector(cfg.selection);
    regionTracker = createRegionTracker({ nextId: 1, screen: { width: sw, height: sh } });
    state = 'running';
    startedAt = now;
    tickIndex = 0;
    lastTickStart = 0;
    stats.ticks = 0; stats.grabErrors = 0; stats.archived = 0; stats.events = 0; stats.dropped = 0;
    eventRing.length = 0; archiveRing.length = 0; regionRing.length = 0;
    lastDecision = null; lastError = null;
    lastArchiveHash = 0; lastArchiveFile = null; lastArchiveWinKey = '';
    exitLatch = false;
    keys.ctrl = false; keys.alt = false; keys.shift = false; keys.esc = false; keys.tab = false;

    if (opts.autoTick === false) {
      // 测试/嵌入模式：调用方自己 tick() 与 pollHotkeys()，便于确定性断言。
    } else {
      scheduleTick();
      hotkeyTimer = setInterval(pollHotkeys, 8);
      hotkeyTimer.unref?.();
      gcTimer = setInterval(() => {
        SessionStore.gc({ root: store.root, logger }).catch(() => {});
      }, cfg.gcEveryMs);
      gcTimer.unref?.();
    }

    bus.emit('start', status());
    return status();
  }

  async function stop({ reason = 'explicit', now = Date.now() } = {}) {
    if (state !== 'running') return status();
    state = 'stopping';
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    if (hotkeyTimer) { clearInterval(hotkeyTimer); hotkeyTimer = null; }
    if (gcTimer) { clearInterval(gcTimer); gcTimer = null; }
    regionTracker?.cancel();
    // 录像轨收尾：向 ffmpeg 写 q，让最后一段视频落盘（实例保留，会话内仍可回看抽帧）
    if (recorder?.state?.active) {
      try { await recorder.stop(); } catch (err) { logger?.warn?.(`[rta] recorder stop failed: ${err?.message ?? err}`); }
    }
    try { await writer?.close(); } catch { /* ignore */ }
    let manifest = null;
    try {
      manifest = await store?.end({ reason, now, retentionHours: cfg.retentionHours });
    } catch (err) {
      logger?.warn?.(`[rta] end session failed: ${err?.message ?? err}`);
    }
    try { source?.dispose?.(); } catch { /* ignore */ }
    source = null; writer = null;
    state = 'idle';
    bus.emit('stop', { sessionId, manifest });
    return status();
  }

  // ───────────────────────────── 采集主循环 ─────────────────────────────

  function scheduleTick() {
    if (state !== 'running') return;
    const interval = 1000 / cfg.capture.sentinelHz;
    const delay = Math.max(0, interval - (Date.now() - lastTickStart));
    tickTimer = setTimeout(() => {
      tickTimer = null;
      tick();
      scheduleTick();
    }, delay);
    tickTimer.unref?.();
  }

  /** 单次 tick（公开：headless 测试可以手动驱动）。 */
  function tick(now = Date.now()) {
    if (state !== 'running' || !source) return null;
    lastTickStart = now;
    const tStart = performance.now();
    let frame;
    try {
      frame = source.grab({});
    } catch (err) {
      stats.grabErrors++;
      lastError = String(err?.message ?? err);
      logger?.warn?.(`[rta] grab failed: ${lastError}`);
      return null;
    }

    // 1) 哨兵：采样降采样 → HSV → 分数
    const sPixels = sentinelW * sentinelH;
    if (sentinelBuffersFlipped) {
      curRgb = rgbA; curHsv = hsvA; prevRgb = rgbB; prevHsv = hsvB;
    } else {
      curRgb = rgbB; curHsv = hsvB; prevRgb = rgbA; prevHsv = hsvA;
    }
    if (stats.ticks === 0) { prevRgb = null; prevHsv = null; }
    downscaleSample(frame.bgra, frame.width, frame.height, sentinelW, sentinelH, curRgb);
    frameToHsv(curRgb, curHsv);
    const score = prevHsv ? scorePair(prevHsv, curHsv, sPixels) : 0;
    const mc = prevRgb ? mcRatioScore(prevRgb, curRgb, sentinelW, sentinelH) : 0;
    const meanV = meanLuma(curRgb);

    // 2) 选择
    const decision = selector.ingest({ t: now, score, mc, meanV });
    if (decision) lastDecision = decision;

    // 3) 前台窗口元信息（低频）
    if (!lastForeground || now - foregroundAt >= cfg.capture.windowInfoEveryMs) {
      try { lastForeground = source.foreground?.() ?? null; } catch { /* ignore */ }
      foregroundAt = now;
    }

    // 4) 存档帧（15Hz）
    const archiveEvery = Math.max(1, Math.round(cfg.capture.sentinelHz / cfg.capture.archiveFps));
    const archiveDue = tickIndex % archiveEvery === 0;
    let frameRgb = null;
    let frameMeta = null;
    if (archiveDue || decision) {
      frameRgb = downscale(frame.bgra, frame.width, frame.height, archiveW, archiveH);
      frameMeta = { rgb: frameRgb, width: archiveW, height: archiveH };
    }
    if (archiveDue && frameRgb) {
      const win = winMeta(lastForeground);
      let rec;
      if (recorder?.state?.active) {
        // 录像轨：原始帧已在视频里，索引只记"这一时刻 = 视频第 videoMs 毫秒"。
        rec = {
          seq: store.nextSeq(), wall: now, type: 'frame', video: true,
          videoMs: Math.max(0, now - recorder.state.startedAt),
          width: frame.width, height: frame.height,
        };
        store.countVideoFrame();
        stats.archived++;
      } else {
        const winKey = winKeyOf(win);
        const hash = fnv1a(curRgb);
        const nearDup = cfg.capture.dedupeScore > 0
          && !!lastArchiveFile
          && winKey === lastArchiveWinKey
          && score <= cfg.capture.dedupeScore
          && mc <= cfg.capture.dedupeMc;
        const duplicate = !!lastArchiveFile && nearDup || (!!lastArchiveFile && hash === lastArchiveHash && winKey === lastArchiveWinKey);
        if (duplicate) {
          // 不落盘，但索引照写：这个时刻在屏幕上"就是这张图"
          rec = { seq: store.nextSeq(), wall: now, file: lastArchiveFile, width: archiveW, height: archiveH, type: 'frame', duplicate: true };
        } else {
          rec = writeImage('frame', frameRgb, archiveW, archiveH);
          lastArchiveFile = rec.file;
          lastArchiveHash = hash;
          lastArchiveWinKey = winKey;
          stats.archived++;
        }
      }
      rec.type = 'frame';
      rec.score = round2(score);
      rec.mc = round2(mc);
      rec.meanV = round2(meanV);
      rec.wallMs = now;
      rec.win = win;
      store.appendRecord(rec);
      archiveRing.push({
        ...frameMeta, seq: rec.seq, wall: now, wallMs: now, kind: 'frame',
        file: rec.file ?? null, video: !!rec.video, videoMs: rec.videoMs ?? null,
        score: rec.score, mc: rec.mc, meanV: rec.meanV, win: rec.win,
      });
      while (archiveRing.length > cfg.maxArchiveInMemory) archiveRing.shift();
      frameMeta.seq = rec.seq;
    }

    // 5) 推送事件（只在 decision 时落一张 event 图 + index 记录）
    //    事件帧按原生分辨率落盘（回头能"看原图"）；拼图/内存里仍用 512 存档小图。
    if (decision && frameRgb) {
      const nativeRgb = bgraToRgb(frame.bgra, frame.width * frame.height);
      const rec = writeImage('event', nativeRgb, frame.width, frame.height, archiveFormat());
      rec.type = 'event';
      rec.kind = decision.kind;
      rec.score = round2(decision.norm);
      rec.z = round2(decision.z);
      rec.mc = round2(decision.mc);
      rec.wallMs = now;
      rec.win = winMeta(lastForeground);
      store.appendRecord(rec);
      stats.events++;
      const ev = {
        id: rec.seq, kind: decision.kind, at: now, wall: now, seq: rec.seq,
        file: rec.file, rgb: frameRgb, width: archiveW, height: archiveH,
        regionIds: [],
        win: winMeta(lastForeground),
      };
      eventRing.push(ev);
      while (eventRing.length > cfg.maxEventsInMemory) eventRing.shift();
      // win：让订阅方（host/live-buffer）不用再猜「这条变化发生在哪个窗口」。
      bus.emit('push', { ...ev, rgb: undefined, win: winMeta(lastForeground), decision });
    }

    tickIndex++;
    stats.ticks++;
    const elapsed = performance.now() - tStart;
    stats.analysisMsEma = stats.analysisMsEma ? stats.analysisMsEma * 0.9 + elapsed * 0.1 : elapsed;
    tickMs = elapsed;
    if (stats.ticks > 1) {
      const hz = 1000 / Math.max(1, now - (stats.lastTickAt ?? now));
      stats.tickHzEma = stats.tickHzEma ? stats.tickHzEma * 0.9 + hz * 0.1 : hz;
    }
    stats.lastTickAt = now;

    if (sentinelBuffersFlipped) sentinelBuffersFlipped = false; else sentinelBuffersFlipped = true;
    return { score, mc, meanV, decision };
  }

  /** 基线帧编码器：优先 JPEG（磁盘友好），GDI+ 不可用时退回 PNG。 */
  function archiveFormat() {
    return cfg.capture.archiveFormat === 'jpeg' && isJpegAvailable(env) ? 'jpeg' : 'png';
  }

  function writeImage(kind, rgb, width, height, formatOverride = null) {
    const seq = store.nextSeq();
    const wall = Date.now();
    const format = formatOverride ?? (kind === 'frame' ? archiveFormat() : 'png');
    const file = store.framePath(kind, seq, wall, format === 'jpeg' ? 'jpg' : 'png');
    const p = writer.write({ path: file, width, height, rgb: rgb.slice(), format });
    if (!p) stats.dropped++;
    return { seq, wall, file, width, height, type: kind, format };
  }

  function winMeta(fg) {
    if (!fg) return null;
    return { title: fg.title, process: fg.process, hwnd: fg.hwnd, rect: fg.rect, visible: fg.visible };
  }

  // ───────────────────────────── 热键 / 圈画 ─────────────────────────────

  function pollHotkeys() {
    if (state !== 'running' || !source?.keyDown) return;
    let ctrl = false, alt = false, shift = false, esc = false, tab = false;
    try {
      ctrl = source.keyDown(VK.CONTROL);
      alt = source.keyDown(VK.MENU);
      shift = source.keyDown(VK.SHIFT);
      esc = source.keyDown(VK.ESCAPE);
      tab = source.keyDown(VK.TAB);
    } catch (err) {
      logger?.warn?.(`[rta] hotkey poll failed: ${err?.message ?? err}`);
      return;
    }
    keys.ctrl = ctrl; keys.alt = alt; keys.shift = shift; keys.esc = esc; keys.tab = tab;

    // 召唤只由「引擎没跑时」的 idle 轮询触发（见 host/summon.js）。
    // 引擎在跑 = RTA 已经启用，再按 Ctrl+Alt 不重复召唤（需求：持续启用、Ctrl+Esc 才退出）。

    // 圈画（Ctrl+Alt+Shift 按住即画，不需要鼠标键）
    const drawing = ctrl && alt && shift;
    if (drawing) {
      let p;
      try { p = source.cursor(); } catch { return; }
      if (!regionTracker.drawing) {
        regionTracker.start(Date.now());
        lastCursor = p;
        regionTracker.add(p.x, p.y, Date.now());
        bus.emit('draw-start', { at: Date.now() });
      } else {
        lastCursor = p;
        regionTracker.add(p.x, p.y, Date.now());
      }
    } else if (regionTracker.drawing) {
      const region = regionTracker.finish(Date.now());
      bus.emit('draw-end', { at: Date.now(), region: region ? { id: region.id, bbox: region.bbox, points: region.points.length } : null });
      if (region) void handleRegion(region);
    }

    // Esc 取消正在画的圈
    if (esc && regionTracker.drawing) {
      regionTracker.cancel();
      bus.emit('draw-cancel', { at: Date.now() });
    }

    // 退出（Ctrl+Tab，上升沿一次）：结束本次 RTA，回到「未启用」状态。
    // 不用 Ctrl+Esc：Esc 留给「取消圈画」，也避免和 Windows 的开始菜单撞。
    const exitCombo = ctrl && tab && !alt;
    if (exitCombo && !exitLatch) {
      exitLatch = true;
      if (regionTracker.drawing) {
        regionTracker.cancel();
        bus.emit('draw-cancel', { at: Date.now() });
      }
      bus.emit('exit', { at: Date.now() });
    } else if (!ctrl || !tab) {
      exitLatch = false;
    }
  }

  /** 圈画结束：落区域 JSON + 从当前全屏抓一张高清图裁出区域 + 立刻推给 AI。 */
  async function handleRegion(region) {
    if (!store) return null;
    try {
      await store.saveRegion(region);
    } catch (err) {
      logger?.warn?.(`[rta] save region failed: ${err?.message ?? err}`);
    }
    let frame;
    try { frame = source.grab({}); } catch (err) {
      logger?.warn?.(`[rta] region grab failed: ${err?.message ?? err}`);
      return null;
    }
    // 区域裁切（BGRA → RGB），过大时限宽到 1024
    const b = region.bbox;
    const w = clamp(b.w, 1, frame.width);
    const h = clamp(b.h, 1, frame.height);
    const x = clamp(b.x, 0, frame.width - w);
    const y = clamp(b.y, 0, frame.height - h);
    const maxW = 1024;
    const scale = w > maxW ? maxW / w : 1;
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));
    const rgb = new Uint8Array(outW * outH * 3);
    for (let yy = 0; yy < outH; yy++) {
      const sy = y + Math.min(h - 1, Math.floor(yy / scale));
      for (let xx = 0; xx < outW; xx++) {
        const sx = x + Math.min(w - 1, Math.floor(xx / scale));
        const s = (sy * frame.width + sx) * 4;
        const d = (yy * outW + xx) * 3;
        rgb[d] = frame.bgra[s + 2]; rgb[d + 1] = frame.bgra[s + 1]; rgb[d + 2] = frame.bgra[s];
      }
    }
    const rec = writeImage('event', rgb, outW, outH);
    rec.type = 'event';
    rec.kind = 'region';
    rec.regionId = region.id;
    rec.bbox = region.bbox;
    rec.wallMs = Date.now();
    store.appendRecord(rec);
    stats.events++;

    const ev = {
      id: rec.seq, kind: 'region', at: Date.now(), wall: rec.wall, seq: rec.seq,
      file: rec.file, rgb, width: outW, height: outH,
      regionIds: [region.id],
      region: { id: region.id, bbox: region.bbox, tStart: region.tStart, tEnd: region.tEnd },
      screen: { x, y, w, h },
      win: winMeta(lastForeground),
    };
    eventRing.push(ev);
    while (eventRing.length > cfg.maxEventsInMemory) eventRing.shift();
    regionRing.push(ev);
    while (regionRing.length > 24) regionRing.shift();
    selector.manual(Date.now());
    bus.emit('push', { ...ev, rgb: undefined, win: winMeta(lastForeground), decision: { kind: 'region' } });
    return ev;
  }

  /** 工具/客户端调用：主动推一帧（用户圈画或“看一眼”）。 */
  function pushNow({ reason = 'manual' } = {}) {
    const ev = eventRing[eventRing.length - 1];
    if (!ev) return null;
    bus.emit('push', { ...ev, rgb: undefined, win: winMeta(lastForeground), decision: { kind: 'manual', reason } });
    return { ...ev, rgb: undefined };
  }

  // ───────────────────────────── 拼图 / 回捞 / 状态 ─────────────────────────────

  /**
   * 用最近的事件（没有就用存档帧）拼一张 sheet。
   * @param {{count?: number, maxTokens?: number}} [o]
   */
  function composeRecent({ count = 4, maxTokens } = {}) {
    return composeKind({ count, maxTokens });
  }

  /**
   * 按事件类型/过滤函数挑最近几帧拼图（rta_region 用）。
   * @param {{kind?: string|null, count?: number, maxTokens?: number, filter?: Function}} [o]
   */
  function composeKind({ kind = null, count = 4, maxTokens, filter = null } = {}) {
    let pool = kind === 'region' && regionRing.length ? regionRing : (eventRing.length ? eventRing : archiveRing);
    if (kind) pool = pool.filter((e) => e.kind === kind);
    if (filter) pool = pool.filter(filter);
    const picks = pool.slice(-Math.max(1, Math.min(12, count)));
    const full = source?.size ?? { width: archiveW, height: archiveH };
    const screen = { x: 0, y: 0, w: full.width, h: full.height };
    const frames = picks.map((ev) => ({
      rgb: ev.rgb, width: ev.width, height: ev.height,
      label: `T${ev.kind === 'region' ? 'R' : ''}${ev.seq}`,
      region: ev.region ? { id: ev.region.id, bbox: ev.region.bbox, tStart: ev.region.tStart, tEnd: ev.region.tEnd } : undefined,
      screen: ev.kind === 'region' && ev.screen ? ev.screen : screen,
    }));
    const plan = planSheet(frames.length, { maxTokens });
    const sheet = composeSheet({ frames, plan, title: `RTA ${sessionId ?? ''}`.trim() });
    return {
      rgb: sheet.rgb, width: sheet.width, height: sheet.height, plan,
      frames: picks.map((e) => ({
        seq: e.seq, kind: e.kind, file: e.file, wall: e.wall, wallMs: e.wallMs,
        score: e.score, mc: e.mc, region: e.region,
      })),
    };
  }

  /**
   * 把最近的事件按「页面」（process+窗口标题）归并成页面序列，每页取最后一次出现的帧。
   * 用户 m02213：连续切换多个页面后，模型应该能看到**经过的每一页**，而不是同一页的
   * 4 张近重复帧。返回 null 表示页面数不足（调用方退回单张 HD 帧）。
   *
   * @param {{count?: number, maxTokens?: number, maxAgeMs?: number, minPages?: number, now?: number}} [o]
   */
  function composePages({ count = 8, maxTokens = 700, maxAgeMs = 300_000, minPages = 2, now = Date.now() } = {}) {
    const max = Math.max(1, Math.min(12, Number(count) || 8));
    const floor = Math.max(2, Number(minPages) || 2);
    const pool = eventRing.filter((ev) => ev && ev.kind && ev.kind !== 'heartbeat' && ev.kind !== 'integral');
    const pages = [];
    for (const ev of pool) {
      const wall = Number(ev.wall ?? ev.at ?? 0);
      if (!wall || now - wall > maxAgeMs) continue;
      const key = pageKeyOf(ev.win);
      const last = pages[pages.length - 1];
      if (last && last.key === key) {
        last.ev = ev;
        last.wall = wall;
        continue;
      }
      pages.push({ key, ev, wall });
    }
    if (pages.length < floor) return null;
    const picks = pages.slice(-max);
    const full = source?.size ?? { width: archiveW, height: archiveH };
    const frames = picks.map((page) => ({
      rgb: page.ev.rgb,
      width: page.ev.width,
      height: page.ev.height,
      label: `T${page.ev.seq}`,
      screen: { x: 0, y: 0, w: full.width, h: full.height },
    }));
    const plan = planSheet(frames.length, { maxTokens });
    const sheet = composeSheet({ frames, plan, title: `RTA ${sessionId ?? ''}`.trim() });
    return {
      rgb: sheet.rgb,
      width: sheet.width,
      height: sheet.height,
      plan,
      pages: picks.map((page) => ({
        seq: page.ev.seq,
        kind: page.ev.kind,
        wall: page.wall,
        title: page.ev.win?.title ?? null,
        process: page.ev.win?.process ?? null,
      })),
    };
  }

  /** 把一张拼图存到 sheets/（工具调用时用）。 */
  function saveSheet(sheet) {
    const seq = store.nextSeq();
    const wall = Date.now();
    const file = store.sheetPath(seq, wall);
    writer.write({ path: file, width: sheet.width, height: sheet.height, rgb: sheet.rgb.slice() });
    store.appendRecord({ type: 'sheet', seq, wall, file, width: sheet.width, height: sheet.height, tokens: sheet.plan?.tokens });
    return { seq, wall, file, width: sheet.width, height: sheet.height, plan: sheet.plan };
  }

  /** 按时间范围/关键词回捞索引。 */
  async function recall({ from = 0, to = Date.now(), limit = 40, types = null } = {}) {
    if (!store) return { total: 0, records: [] };
    const { records } = await store.readIndex({ offset: 0, limit: 100000 });
    const filtered = records.filter((r) => {
      const t = r.wall ?? r.wallMs ?? r.tStart ?? 0;
      if (t < from || t > to) return false;
      if (types && !types.includes(r.type)) return false;
      return true;
    });
    return { total: filtered.length, records: filtered.slice(-limit) };
  }

  /** 回看：把某个 wallMs 对应的原始帧从录像里抽出来（JPEG 文件）。 */
  async function frameAt({ wallMs = Date.now(), outPath, vf = null }) {
    if (!recorder) return { ok: false, error: 'no-video-track' };
    return recorder.extractFrame(wallMs, outPath, vf ? { vf } : undefined);
  }

  function status() {
    const fg = lastForeground;
    return {
      state,
      source: source ? { name: source.name, width: source.size?.width, height: source.size?.height } : null,
      session: store ? {
        id: sessionId,
        dir: store.paths.dir,
        startedAt,
        endedAt: store.endedAt,
        retainUntil: store.retainUntil,
        counts: { ...store.counts },
      } : null,
      capture: {
        sentinelHz: cfg.capture.sentinelHz,
        archiveFps: cfg.capture.archiveFps,
        sentinel: { width: sentinelW, height: sentinelH },
        archive: {
          width: archiveW, height: archiveH,
          mode: cfg.capture.archiveMode,
        },
        ticks: stats.ticks,
        archived: stats.archived,
        grabErrors: stats.grabErrors,
        analysisMs: round2(stats.analysisMsEma),
        tickHz: round2(stats.tickHzEma),
        writerInFlight: writer?.inFlight ?? 0,
      },
      video: recorder ? {
        active: !!recorder.state.active,
        startedAt: recorder.state.startedAt || null,
        encoder: recorder.state.encoder,
        files: recorder.files().length,
        bytes: recorder.totalBytes(),
        error: recorder.state.error,
      } : null,
      selector: selector ? { ...selector.snapshot(), density30s: selector.density30s(), lastDecision } : null,
      keys: { ...keys, drawing: !!regionTracker?.drawing },
      foreground: fg ? { title: fg.title, process: fg.process, rect: fg.rect } : null,
      lastPush: eventRing.length ? summarize(eventRing[eventRing.length - 1]) : null,
      recentEvents: eventRing.slice(-6).map(summarize),
      lastError,
    };
  }

  function summarize(ev) {
    return {
      seq: ev.seq, kind: ev.kind, at: ev.at, file: ev.file,
      width: ev.width, height: ev.height, region: ev.region ?? null,
    };
  }

  return {
    on: (event, fn) => bus.on(event, fn),
    off: (event, fn) => bus.off(event, fn),
    start, stop, tick, pollHotkeys, status,
    pushNow, composeRecent, composeKind, composePages, saveSheet, recall, frameAt,
    noteTextChange: (t) => selector?.noteTextChange(t),
    get cfg() { return cfg; },
    get state() { return state; },
    get sessionId() { return sessionId; },
    get store() { return store; },
    get source() { return source; },
    get eventRing() { return eventRing; },
    get regionRing() { return regionRing; },
  };
}

function round2(v) { return Math.round((v ?? 0) * 100) / 100; }
