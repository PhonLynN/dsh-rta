/**
 * tools/handlers.js — RTA 八个工具的 execute。
 *
 * 这里只做「参数 → 引擎调用 → 文本/附件」的转换，不实现采集/选择算法。
 * 出图失败（宿主没有 attachments）一律降级成纯文本，不抛错。
 */

import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { attachRgb, attachPngFile } from '../host/service.js';
import {
  KIND_LABEL, pickInformativeFrames, pickSpread, extractHdFrame, makeHdDir, cleanHdDir,
  nativeFrameSize, widthForTokens,
} from '../host/hd.js';
import { notifyDelivery } from '../host/offload.js';
import { SessionStore } from '../store/store.js';
import { sessionsRoot } from '../store/paths.js';

const MAX_TEXT = 24_000;

function iso(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '?';
  return new Date(ms).toISOString();
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return n < lo ? lo : n > hi ? hi : n;
}

function clip(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (truncated)` : text;
}

function parseTime(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (Number.isFinite(n) && n > 1e11) return n; // epoch ms
  const d = Date.parse(String(value));
  return Number.isFinite(d) ? d : fallback;
}

/** 一帧/一条事件的单行索引。 */
function bboxText(b) {
  if (!b) return 'bbox=?';
  if (Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h)) {
    return `bbox=${b.x},${b.y},${b.w}x${b.h}`;
  }
  return `bbox=${b.x0},${b.y0},${b.x1},${b.y1}`;
}

function recordLine(r) {
  const at = iso(r.wall ?? r.wallMs ?? r.tStart ?? 0);
  if (r.type === 'frame') {
    if (r.video || r.videoMs != null) {
      const sec = Math.max(0, Number(r.videoMs) || 0) / 1000;
      return `${at}  frame   seq=${r.seq} video@${sec.toFixed(1)}s score=${r.score ?? '?'} mc=${r.mc ?? '?'}`;
    }
    return `${at}  frame   seq=${r.seq} score=${r.score ?? '?'} mc=${r.mc ?? '?'}`;
  }
  if (r.type === 'event') return `${at}  event   kind=${r.kind} seq=${r.seq} score=${r.score ?? '?'} z=${r.z ?? '?'}`;
  if (r.type === 'region') {
    return `${at}  region  R${r.id ?? r.regionId} ${bboxText(r.bbox)}`;
  }
  if (r.type === 'note') return `${at}  note    ${r.name}`;
  if (r.type === 'sheet') return `${at}  sheet   seq=${r.seq} tokens=${r.tokens ?? '?'}`;
  return `${at}  ${r.type ?? 'record'}`;
}

/** 拼图结果 → 时间轴文本。 */
function sheetText(engine, recent, note) {
  const lines = [
    `RTA ${engine.sessionId} — ${recent.frames.length} recent frame(s), sheet ${recent.width}x${recent.height}, ~${recent.plan?.tokens ?? '?'} tokens.`,
    'wall (UTC)                kind   seq    file (under the session dir)',
  ];
  for (const f of recent.frames) {
    const when = iso(f.wall ?? f.wallMs);
    const name = f.file
      ? basename(f.file)
      : (f.videoMs != null ? `video@${(f.videoMs / 1000).toFixed(1)}s` : '?');
    lines.push(`${when}  ${String(f.kind ?? 'frame').padEnd(6)} ${String(f.seq ?? '?').padEnd(5)}  ${name}`);
  }
  if (note) lines.push(`note: ${note}`);
  lines.push('older frames: rta_recall(from,to); circled areas: rta_region; save a memory: rta_note.');
  return lines.join('\n');
}

async function attachOne(ctx, rgb, width, height, name) {
  const attachment = await attachRgb(ctx, { rgb, width, height, name });
  if (attachment) notifyDelivery();
  return attachment;
}

export async function start(ctx, rt) {
  try {
    const engine = await rt.start();
    const status = engine.status();
    const text = [
      `RTA recording. session=${engine.sessionId}`,
      `dir=${status.session?.dir ?? '?'}`,
      `capture=${status.capture.sentinel.width}x${status.capture.sentinel.height}@${status.capture.sentinelHz ?? rt.config.capture.sentinelHz}Hz sentinel, archive ${status.capture.archive.mode ?? 'jpeg'} ${status.capture.archive.width}x${status.capture.archive.height}`,
      status.video
        ? `video: original frames -> ${status.session?.dir ?? '?'}${'\\'}video (encoder=${status.video.encoder ?? '?'})`
        : 'video: off — per-frame images only',
      'hotkeys: Ctrl+Alt = summon & keep RTA on (only while off), hold Shift+Ctrl+Alt = circle an area, Ctrl+Tab = exit, Esc = cancel a circle.',
      rt.overlay?.running
        ? `floating window: on (${rt.overlay.endpoint ?? '?'}) — always on top, click-through card, drag by the header.`
        : 'floating window: unavailable (run `node scripts/install-overlay.mjs` to install the Electron runtime).',
      'RTA now serves this session only; other conversations get a notice until rta_stop (single-session binding).',
      'continuous screen awareness: ON — from now on the screen state is injected into this conversation automatically (a short runtime-context snapshot whenever something changes), so you do not need to call rta_look to know what the user is doing. rta_look is only for a fresh close-up; HD screenshots are also attached at the start of a turn (at most one per turn, budgeted).',
      'background summarizer: ON — ONE persistent subagent for this session writes a rolling 2-4 sentence summary (note name="screen-log"): refreshed periodically, when dense screen changes happen, and on demand via rta_summarize. The newest summary is read and attached at the start of each turn. The main conversation is never interrupted or woken by it, and rta_stop clears that subagent.',
      'turn it off with inject.enabled=false (text) or inject.image.enabled=false (screenshots) in the config, or fully with rta_stop. frames are stored locally and images expire 24h after the session ends.',
    ].join('\n');
    return { text };
  } catch (err) {
    return { text: `RTA could not start capture: ${err?.message ?? err}` };
  }
}

export async function stop(ctx, rt, args = {}) {
  const engine = rt.engine;
  if (!engine) return { text: 'RTA is not running.' };
  const status = await rt.stop({ reason: String(args.reason ?? 'explicit') });
  const s = status?.session;
  if (!s) return { text: 'RTA is not running.' };
  return {
    text: [
      'RTA stopped.',
      `session=${s.id} dir=${s.dir}`,
      `startedAt=${iso(s.startedAt)} endedAt=${iso(s.endedAt)}`,
      `images retained until ${iso(s.retainUntil)} (then deleted; text records stay forever).`,
      `counts: frames=${s.counts?.frames ?? 0} events=${s.counts?.events ?? 0} regions=${s.counts?.regions ?? 0} notes=${s.counts?.notes ?? 0}`,
    ].join('\n'),
  };
}

export function status(ctx, rt) {
  const engine = rt.engine;
  if (!engine) {
    return { text: `RTA is not running. config: ${rt.configPath}` };
  }
  const s = engine.status();
  const lines = [
    `RTA ${s.state}. session=${s.session?.id ?? '?'}`,
    s.session ? `dir=${s.session.dir} retainUntil=${iso(s.session.retainUntil)}` : null,
    `capture: ${s.capture.sentinel.width}x${s.capture.sentinel.height} sentinel @${s.capture.tickHz ?? 0}Hz, archive ${s.capture.archive.mode ?? 'jpeg'} ${s.capture.archive.width}x${s.capture.archive.height}, analysis ${s.capture.analysisMs ?? 0}ms, writerInFlight=${s.capture.writerInFlight ?? 0}`,
    s.video
      ? `video: ${s.video.active ? 'recording' : 'stopped'} encoder=${s.video.encoder ?? '?'} files=${s.video.files} bytes=${s.video.bytes}${s.video.error ? ` error=${String(s.video.error).slice(0, 200)}` : ''}`
      : 'video: off (archiveMode=jpeg)',
    `frames: archived=${s.capture.archived ?? 0} events=${s.session?.counts?.events ?? 0}`,
    rt.bound ? `bound session: ${rt.bound.sessionId}` : 'bound session: none (rta_start binds the caller)',
    (() => {
      let live = null;
      try { live = rt.lifecycle?.status?.() ?? null; } catch { live = null; }
      if (!live) return 'injection: not attached (pull-only: call rta_look)';
      const last = live.text?.lastPublishAt ? ` last=${iso(live.text.lastPublishAt)}` : '';
      return `injection: ${live.enabled ? 'on' : 'off'} channel=${live.channel} published=${live.text?.publishes ?? 0}${last} screenshots=${live.image?.injected ?? 0}${live.lastError ? ` lastError=${String(live.lastError).slice(0, 160)}` : ''}`;
    })(),
    (() => {
      let live = null;
      try { live = rt.lifecycle?.status?.() ?? null; } catch { live = null; }
      let sum = live?.summarizer ?? null;
      if (!sum) {
        try { sum = rt.summarizer?.status?.() ?? null; } catch { sum = null; }
      }
      if (!sum) return null;
      const age = Number.isFinite(sum.summaryAgeMs) && sum.summaryAgeMs >= 0
        ? `${Math.round(sum.summaryAgeMs / 1000)}s ago`
        : 'none yet';
      const child = sum.child ? `${String(sum.child).slice(0, 8)}${sum.childSettled ? '(settled)' : ''}` : 'none';
      return `summarizer: ${sum.enabled ? 'on' : 'off'} provider=${sum.provider ?? 'auto'} attached=${sum.attached ? 'yes' : 'no'} subagents=${sum.subagents ? 'yes' : 'no'} engine=${sum.running ? 'running' : 'idle'} child=${child}${sum.settlementGuarded ? ' guard=on' : ''} prompts=${sum.prompts ?? 0} trigger=${sum.lastTrigger ?? 'none'}${sum.awaiting ? ' awaiting=1' : ''} ticks=${sum.ticks ?? 0}${sum.lastSkip ? ` skip=${sum.lastSkip}` : ''} started=${sum.starts ?? 0} errors=${sum.errors ?? 0}${sum.inFlight ? ' inFlight=1' : ''} summary=${sum.summaryChars ? `${sum.summaryChars}ch (${age})` : 'none yet'}${sum.lastError ? ` lastError=${String(sum.lastError).slice(0, 160)}` : ''}`;
    })(),
    rt.overlay
      ? `floating window: ${rt.overlay.running ? 'on' : 'off'} endpoint=${rt.overlay.endpoint ?? 'n/a'}`
      : 'floating window: not started',
    s.foreground ? `foreground: "${s.foreground.title}" (${s.foreground.process})` : null,
    s.keys ? `keys: ctrl=${s.keys.ctrl} alt=${s.keys.alt} shift=${s.keys.shift} drawing=${s.keys.drawing}` : null,
    s.recentEvents?.length ? `recent: ${s.recentEvents.map((e) => `${e.kind}#${e.seq}`).join(', ')}` : 'recent: none',
    s.lastError ? `lastError: ${s.lastError}` : null,
    `config: ${rt.configPath}`,
  ].filter(Boolean);
  return { text: clip(lines.join('\n')) };
}

// On-demand summary (user m01656): nudge the persistent summarizer child and wait for
// it to write a new note. Never touches the main conversation — this is a normal tool call.
export async function summarize(ctx, rt, args = {}) {
  const summarizer = rt.lifecycle?.summarizer ?? rt.summarizer ?? null;
  if (!rt.engine) {
    return { text: 'RTA is not running — call rta_start first; no background summarizer is active.' };
  }
  if (!summarizer || typeof summarizer.requestNow !== 'function') {
    return { text: 'The background summarizer is not available in this build.' };
  }
  const waitMs = clampInt(args.waitMs, 0, 60_000, rt.config.inject?.summarizer?.demandWaitMs ?? 25_000);
  let result = null;
  try {
    result = await summarizer.requestNow({ reason: String(args.reason ?? 'tool'), waitMs });
  } catch (err) {
    return { text: `RTA summarize failed: ${err?.message ?? err}` };
  }
  const st = summarizer.status?.() ?? {};
  const trigger = result?.trigger ?? st.lastTrigger ?? 'unknown';
  if (!result || result.ok === false) {
    const age = Number.isFinite(st.summaryAgeMs) && st.summaryAgeMs >= 0
      ? `latest summary is ${Math.round(st.summaryAgeMs / 1000)}s old`
      : 'no summary has been written yet (the subagent may still be starting; try again in a few seconds)';
    return {
      text: [
        'RTA summarize: no fresh summary arrived.',
        `reason=${result?.reason ?? 'unknown'} trigger=${trigger} waitMs=${waitMs}`,
        age,
        st.lastError ? `lastError=${String(st.lastError).slice(0, 160)}` : null,
        result?.summary ? `previous summary:\n${result.summary}` : null,
      ].filter(Boolean).join('\n'),
    };
  }
  return {
    text: [
      `RTA fresh summary (trigger=${trigger}, ${iso(result.summaryAt)}):`,
      String(result.summary ?? '').trim(),
      `session=${rt.engine.sessionId ?? '?'} (the main conversation was not woken by this).`,
    ].join('\n'),
  };
}

function kindLabel(ev) {
  return KIND_LABEL[ev?.kind] ?? String(ev?.kind ?? '画面');
}

/**
 * 按「信息量」从原生录像抽 HD 帧：取最近事件里最值得看的 count 条，
 * 各自裁到当时的窗口/圈选区域，按 token 预算缩图。
 * 失败（录像没就绪/无 ffmpeg）返回空数组，调用方回落 512 拼图。
 */
async function hdFrames(ctx, rt, engine, { count, maxTokens, note = null }) {
  const events = Array.isArray(engine.eventRing) ? engine.eventRing.slice(-128) : [];
  const picked = pickInformativeFrames(events, { limit: count, now: Date.now(), maxAgeMs: 180_000 });
  if (!picked.length) return { images: [], lines: [] };

  let foreground = null;
  try { foreground = engine.status?.()?.foreground ?? null; } catch { foreground = null; }
  const size = nativeFrameSize(engine);
  const perImage = Math.max(200, Math.floor(maxTokens / picked.length));
  const maxWidth = widthForTokens(perImage);
  const dir = await makeHdDir();
  const images = [];
  const lines = [];
  try {
    for (const row of picked) {
      const shot = await extractHdFrame(engine, row.ev, {
        dir, foreground, frameWidth: size.width, frameHeight: size.height, maxWidth,
      });
      if (!shot.ok) continue;
      const attachment = await attachPngFile(ctx, {
        file: shot.path,
        name: `rta-look-hd-${row.ev?.seq ?? Math.round(row.wall)}-${Date.now()}.jpg`,
      });
      if (!attachment) continue;
      images.push(attachment);
      notifyDelivery();
      lines.push(`${iso(row.wall)}  ${kindLabel(row.ev)}${row.ev?.score ? ` 强度 ${Math.round(row.ev.score)}` : ''}  ${shot.width}×${shot.height} ~${shot.tokens} tok`);
    }
  } finally {
    void cleanHdDir(dir);
  }
  if (!images.length) return { images: [], lines: [] };

  const text = [
    `RTA ${engine.sessionId} — ${images.length} HD frame(s) picked by importance (region > cut > integral), cropped to the window at that moment.`,
    ...(note ? [`note: ${note}`] : []),
    ...lines,
    'originals stay in the 2560×1440 recording; more frames: rta_recall(images:true), earlier history: rta_recall.',
  ].join('\n');
  return { images, text: clip(text) };
}

export async function look(ctx, rt, args = {}) {
  const count = clampInt(args.count, 1, 4, 2);
  const maxTokens = args.maxTokens ? clampInt(args.maxTokens, 200, 2400, 1200) : 1200;
  const note = args.note ? String(args.note).slice(0, 400) : null;

  let engine;
  try {
    engine = await rt.start();
  } catch (err) {
    return { images: [], text: `RTA could not start capture: ${err?.message ?? err}` };
  }

  if (args.hd !== false) {
    const hd = await hdFrames(ctx, rt, engine, { count, maxTokens, note });
    if (hd.images.length) return hd;
  }

  // 回落：eventRing 拼图（旧行为，保留给录像不可用的情况）。
  const recent = engine.composeRecent({ count, maxTokens: Math.min(maxTokens, rt.config.maxSheetTokens) });
  if (!recent.frames.length) {
    return {
      images: [],
      text: `RTA is recording (session ${engine.sessionId}) but no frame has been archived yet — retry in a second.`,
    };
  }

  let attachment = null;
  try {
    attachment = await attachOne(ctx, recent.rgb, recent.width, recent.height,
      `rta-look-${engine.sessionId}-${Date.now()}.png`);
  } catch (err) {
    rt.logger.warn(`[rta] look attach failed: ${err?.message ?? err}`);
  }
  const text = sheetText(engine, recent, note);
  if (!attachment) {
    return { images: [], text: `${text}\n\n(host has no attachments service: the sheet image could not be shown)` };
  }
  return { images: [attachment], text };
}

export async function region(ctx, rt, args = {}) {
  const engine = rt.engine;
  if (!engine) return { images: [], text: 'RTA is not running — call rta_start (or rta_look) first.' };

  const count = clampInt(args.count, 1, 4, 1);
  const regionId = args.regionId === undefined ? null : Number(args.regionId);
  const filter = regionId === null ? undefined : (ev) => ev.region?.id === regionId;
  const recent = engine.composeKind({ kind: 'region', count, maxTokens: rt.config.maxSheetTokens, filter });
  if (!recent.frames.length) {
    return {
      images: [],
      text: regionId === null
        ? 'No circled screen area yet. The user can hold Shift+Ctrl+Alt and draw to point at something.'
        : `No region with id ${regionId} in this session.`,
    };
  }

  let attachment = null;
  try {
    attachment = await attachOne(ctx, recent.rgb, recent.width, recent.height,
      `rta-region-${engine.sessionId}-${Date.now()}.png`);
  } catch (err) {
    rt.logger.warn(`[rta] region attach failed: ${err?.message ?? err}`);
  }
  const lines = [`RTA ${engine.sessionId} — ${recent.frames.length} circled area(s), sheet ${recent.width}x${recent.height}.`];
  for (const f of recent.frames) {
    const ev = f.region ? `R${f.region.id} ${bboxText(f.region.bbox)} t=${iso(f.region.tStart)}→${iso(f.region.tEnd)}` : 'region';
    lines.push(`${iso(f.wall)}  ${ev}  file=${f.file ?? ''}`);
  }
  lines.push('screen coordinates are capture pixels (2560x1440 primary); 圈画时间戳是 tStart/tEnd。');
  if (!attachment) lines.push('(host has no attachments service: the crop could not be shown)');
  return { images: attachment ? [attachment] : [], text: lines.join('\n') };
}

/** 读某个 session 目录的 index.jsonl（引擎没在跑时回捞旧会话用）。 */
async function readIndexFile(dir) {
  const text = await readFile(join(dir, 'index.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export async function recall(ctx, rt, args = {}) {
  const limit = clampInt(args.limit, 1, 200, 40);
  const types = typeof args.types === 'string' && args.types.trim()
    ? args.types.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const now = Date.now();
  const from = parseTime(args.from, 0);
  const to = parseTime(args.to, now);
  const wantImages = args.images === true;
  const maxImages = clampInt(args.maxImages, 1, 4, 3);

  let records = [];
  let scope = null;
  const engine = rt.engine;
  if (engine?.store) {
    scope = { sessionId: engine.sessionId, dir: engine.store.paths.dir };
    const r = await engine.recall({ from, to, limit: 100000, types });
    records = r.records;
  } else {
    const list = await SessionStore.list({ root: sessionsRoot() });
    const latest = list[0];
    if (!latest) return { images: [], text: 'No RTA session exists yet.' };
    scope = { sessionId: latest.sessionId, dir: join(sessionsRoot(), latest.sessionId) };
    records = (await readIndexFile(scope.dir)).filter((r) => {
      const t = r.wall ?? r.wallMs ?? r.tStart ?? 0;
      if (t < from || t > to) return false;
      if (types && !types.includes(r.type)) return false;
      return true;
    });
  }

  // 默认把 15fps 的逐帧行藏起来：它们是录像索引，不是「发生过什么」。事件优先。
  const frameRows = types ? 0 : records.filter((r) => r.type === 'frame').length;
  const visible = types ? records : records.filter((r) => r.type !== 'frame');
  const picked = visible.slice(-limit);

  const images = [];
  const expired = [];
  const shotLines = [];
  if (wantImages) {
    const dir = await makeHdDir();
    try {
      const windowFrom = from || (records[0]?.wall ?? now - 60_000);
      const picks = pickSpread(records, { limit: maxImages, from: windowFrom, to });
      const perImage = Math.max(240, Math.floor(2400 / maxImages));
      for (const row of picks) {
        const rec = row.record;
        let attachment = null;
        let label = row.fromFrame ? 'video frame' : kindLabel(rec);
        // 首选：从原生录像抽帧 + 裁窗 + 缩图（引擎在跑、该时刻有录像时）。
        if (engine && typeof engine.frameAt === 'function') {
          const shot = await extractHdFrame(engine, rec, {
            dir,
            foreground: null,
            maxWidth: widthForTokens(perImage),
          });
          if (shot.ok) {
            attachment = await attachPngFile(ctx, {
              file: shot.path,
              name: `rta-recall-hd-${rec.seq ?? Math.round(row.wall)}.jpg`,
            });
            if (attachment) label += ` ${shot.width}×${shot.height}`;
          }
        }
        if (!attachment && rec.file) {
          try { attachment = await attachPngFile(ctx, { file: rec.file }); } catch { /* ignore */ }
        }
        if (attachment) {
          images.push(attachment);
          notifyDelivery();
          shotLines.push(`${iso(row.wall)}  ${label}${row.fromFrame ? '  (evenly sampled)' : `  weight=${Math.round(row.weight)}`}`);
        } else {
          expired.push(`${rec.seq ?? '?'}@${iso(row.wall)}`);
        }
      }
    } finally {
      void cleanHdDir(dir);
    }
  }

  const lines = [
    `RTA recall ${iso(from)} → ${iso(to)} — ${picked.length}/${records.length} record(s) from ${scope.sessionId}${frameRows ? ` (${frameRows} raw frame rows hidden; pass types:"frame" to see them)` : ''}`,
    `dir=${scope.dir}`,
  ];
  if (!picked.length) lines.push('(no records in this window)');
  for (const r of picked) lines.push(recordLine(r));
  if (wantImages && shotLines.length) lines.push('', 'HD frames (algorithm-picked, native resolution, cropped to window):', ...shotLines);
  if (expired.length) lines.push(`images unreadable: ${expired.slice(0, 6).join(', ')}`);
  if (images.length) lines.push(`attached ${images.length} image(s).`);
  return { images, text: clip(lines.join('\n')) };
}

export async function note(ctx, rt, args = {}) {
  const engine = rt.engine;
  if (!engine?.store) return { text: 'RTA is not running — notes are stored in a session, so call rta_start first.' };
  const name = String(args.name ?? '').trim();
  const text = String(args.text ?? '').trim();
  if (!name || !text) return { text: 'rta_note needs both name and text.' };
  const file = await engine.store.saveNote(name, text);
  return { text: `note saved: ${file}` };
}

export async function purge(ctx, rt, args = {}) {
  const now = Date.now();
  const keepMinutes = clampInt(args.keepMinutes, 0, 1440, 2);
  const before = args.before != null ? parseTime(args.before, now - keepMinutes * 60_000) : now - keepMinutes * 60_000;
  const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId.trim() : null;
  const dryRun = args.dryRun === true;
  const res = await SessionStore.purge({ root: sessionsRoot(), sessionId, before, now, dryRun });
  if (!res.ok) return { text: `Nothing purged: ${res.reason} (no RTA session found).` };
  const mb = (res.bytes / 1024 / 1024).toFixed(1);
  const kinds = Object.entries(res.kinds).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
  if (!res.files) {
    return { text: `${dryRun ? 'Would purge' : 'Purged'} 0 files from ${res.sessionId}: nothing older than ${iso(before)} (kept the last ${keepMinutes} min).` };
  }
  const head = dryRun
    ? `Dry run: would purge ${res.files} file(s) (${mb} MB) from ${res.sessionId} older than ${iso(before)} [${kinds}]`
    : `Purged ${res.files} file(s) (${mb} MB) from ${res.sessionId} older than ${iso(before)} [${kinds}]`;
  return {
    text: `${head}. index/notes/annotations/manifest kept (text is permanent). Normal retention is still 24h; this only frees images already summarized into text.`,
  };
}

export async function sessions(ctx, rt, args = {}) {
  const limit = clampInt(args.limit, 1, 20, 8);
  const list = await SessionStore.list({ root: sessionsRoot() });
  if (!list.length) return { text: 'No RTA session exists yet.' };
  const lines = [`${list.length} RTA session(s), newest first (images expire 24h after endedAt; text stays):`];
  for (const m of list.slice(0, limit)) {
    lines.push(`${m.sessionId}  ${iso(m.startedAt)} → ${iso(m.endedAt)}  status=${m.status}  frames=${m.counts?.frames ?? 0} regions=${m.counts?.regions ?? 0} notes=${m.counts?.notes ?? 0}  retainUntil=${iso(m.retainUntil)}${m.imagesPurgedAt ? `  imagesPurgedAt=${iso(m.imagesPurgedAt)}` : ''}`);
  }
  return { text: clip(lines.join('\n')) };
}
