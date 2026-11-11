/**
 * record/ffmpeg.js — 原生分辨率录像轨（归档帧的"原图"来源）。
 *
 * 为什么不是逐帧 JPEG：2560×1440 JPEG q75 实测约 450KB/帧，15fps ≈ 6.7MB/s ≈ 24GB/小时，
 * 24h 保留直接爆盘。改成 H.264 硬编录像后同样分辨率只有 0.2–3Mbps（0.1–1.4GB/小时），
 * 需要"回看原图"时按时间戳抽一帧（无损于原画面，文字清晰可读）。
 *
 * 视频文件按 segmentSeconds 分段（默认 300s，防崩溃丢整场）。
 * 段落时间映射：wallMs → offsetSec = (wallMs - startedAt)/1000 → segment = floor(offset/segmentTime)。
 * 精度 ±0.2s（进程启动首帧延迟），对"回看某一刻"足够。
 *
 * ffmpeg 不在 DSH 里；优先找 ~/.dsh/rta/tools/ffmpeg/bin/ffmpeg.exe，
 * 找不到时（ensureFfmpeg）从 npm 镜像下载 @ffmpeg-installer/win32-x64（约 22MB tar，
 * 内含 62MB ffmpeg.exe，GPL 构建，仅下载到本机不随插件分发）。
 */

import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rtaHome } from '../store/paths.js';

export const FFMPEG_NPM_PACKAGE = '@ffmpeg-installer/win32-x64';
export const FFMPEG_NPM_VERSION = '4.1.0';
const NPM_TARBALLS = [
  `https://registry.npmmirror.com/@ffmpeg-installer/win32-x64/-/win32-x64-${FFMPEG_NPM_VERSION}.tgz`,
  `https://registry.npmjs.org/@ffmpeg-installer/win32-x64/-/win32-x64-${FFMPEG_NPM_VERSION}.tgz`,
];
export const DEFAULT_SEGMENT_SECONDS = 300;

export function ffmpegCandidates(env = process.env) {
  const out = [];
  if (env.DSH_FFMPEG_PATH) out.push(env.DSH_FFMPEG_PATH);
  if (env.FFMPEG_PATH) out.push(env.FFMPEG_PATH);
  out.push(join(rtaHome(env), 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'));
  out.push(join(rtaHome(env), 'tools', 'ffmpeg', 'bin', 'ffmpeg'));
  const dshHome = env.DSH_HOME || join(env.USERPROFILE || '', '.dsh');
  out.push(join(dshHome, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'));
  return out;
}

/** 找一个能用的 ffmpeg（只看插件自己的 tools 目录和 env 覆盖，不扫描全网）。 */
export function resolveFfmpeg(env = process.env) {
  for (const c of ffmpegCandidates(env)) {
    if (c && existsSync(c)) return { path: c, source: 'local' };
  }
  return null;
}

function run(cmd, args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${err.message} ${String(stderr).slice(-400)}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return p;
    }
  }
  return null;
}

function downloadFile(url, dest, timeoutMs = 240_000, redirects = 4) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        downloadFile(next, dest, timeoutMs, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download ${url} -> HTTP ${res.statusCode}`));
        return;
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`download timeout: ${url}`)));
    req.on('error', reject);
  });
}

/**
 * 确保 ffmpeg 存在；缺了就下载（只写 ~/.dsh/rta/tools，不碰系统目录）。
 * @returns {Promise<{ok:boolean,path?:string,source?:string,reason?:string,error?:string}>}
 */
export async function ensureFfmpeg({ env = process.env, logger = null, download = true } = {}) {
  const found = resolveFfmpeg(env);
  if (found) return { ok: true, ...found };
  if (!download) return { ok: false, reason: 'ffmpeg-not-found' };

  const binDir = join(rtaHome(env), 'tools', 'ffmpeg', 'bin');
  mkdirSync(binDir, { recursive: true });
  const tgz = join(tmpdir(), `rta-ffmpeg-${process.pid}.tgz`);
  const extractDir = join(tmpdir(), `rta-ffmpeg-${process.pid}`);
  let lastError = null;
  for (const url of NPM_TARBALLS) {
    try {
      logger?.info?.(`[rta] downloading ffmpeg from ${url}`);
      await downloadFile(url, tgz);
      mkdirSync(extractDir, { recursive: true });
      await run('tar', ['-xzf', tgz, '-C', extractDir], 120_000);
      const exe = findFile(extractDir, 'ffmpeg.exe');
      if (!exe) throw new Error('ffmpeg.exe not found in package tarball');
      const dest = join(binDir, 'ffmpeg.exe');
      copyFileSync(exe, dest);
      await run(dest, ['-hide_banner', '-version'], 20_000);
      logger?.info?.(`[rta] ffmpeg installed: ${dest}`);
      return { ok: true, path: dest, source: 'download' };
    } catch (err) {
      lastError = err;
      logger?.warn?.(`[rta] ffmpeg download failed: ${err?.message ?? err}`);
    } finally {
      try { if (existsSync(tgz)) unlinkSync(tgz); } catch { /* ignore */ }
    }
  }
  return { ok: false, reason: 'download-failed', error: String(lastError?.message ?? lastError) };
}

const encoderCache = new Map();

/** 检测可用编码器：优先硬件（QSV/NVENC/AMF），最后 libx264。 */
export async function pickEncoder(ffmpegPath) {
  if (encoderCache.has(ffmpegPath)) return encoderCache.get(ffmpegPath);
  let picked = 'libx264';
  try {
    const { stdout } = await run(ffmpegPath, ['-hide_banner', '-encoders'], 20_000);
    for (const name of ['h264_qsv', 'h264_nvenc', 'h264_amf', 'libx264']) {
      if (new RegExp(`\\b${name}\\b`).test(stdout)) { picked = name; break; }
    }
  } catch { /* 探测失败就用 libx264 */ }
  encoderCache.set(ffmpegPath, picked);
  return picked;
}

function encoderArgs(encoder, quality) {
  switch (encoder) {
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', String(quality), '-look_ahead', '0', '-pix_fmt', 'nv12'];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'fast', '-rc', 'vbr', '-cq', String(quality), '-pix_fmt', 'yuv420p'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(quality + 2), '-qp_p', String(quality + 4), '-pix_fmt', 'yuv420p'];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(quality + 2), '-pix_fmt', 'yuv420p'];
  }
}

/**
 * 录像器：start() 后 ffmpeg 常驻，按段写 mp4；stop() 优雅收尾；extractFrame() 按时间戳抽原图。
 */
export function createRecorder({
  logger = null,
  ffmpegPath,
  dir,
  width,
  height,
  fps = 15,
  quality = 26,
  segmentSeconds = DEFAULT_SEGMENT_SECONDS,
  encoder = 'auto',
} = {}) {
  const state = {
    active: false,
    startedAt: 0,
    exitedAt: 0,
    encoder: null,
    error: null,
    dir,
    segmentSeconds,
    width,
    height,
    fps,
  };
  let child = null;
  let stderrTail = '';
  let waiters = [];

  const files = () => {
    try {
      return readdirSync(dir).filter((n) => /^seg-\d+\.ts$/i.test(n)).sort();
    } catch { return []; }
  };

  function finish(code, signal) {
    state.active = false;
    state.exitedAt = Date.now();
    const ws = waiters; waiters = [];
    for (const w of ws) w({ code, signal });
  }

  async function start() {
    mkdirSync(dir, { recursive: true });
    state.encoder = encoder === 'auto' ? await pickEncoder(ffmpegPath) : encoder;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab', '-framerate', String(fps),
      '-offset_x', '0', '-offset_y', '0', '-video_size', `${width}x${height}`,
      '-i', 'desktop', '-an',
      ...encoderArgs(state.encoder, quality),
      // 2 秒一个关键帧：抽帧定位快、精度高（代价是码率略升）
      '-g', String(Math.max(2, fps * 2)), '-keyint_min', String(Math.max(2, fps * 2)), '-sc_threshold', '0',
      // 分段 MPEG-TS：录制中也能直接读（flush_packets=1），崩溃最多丢最后几秒
      '-f', 'segment', '-segment_time', String(segmentSeconds),
      '-reset_timestamps', '1',
      '-segment_format', 'mpegts',
      '-segment_format_options', 'flush_packets=1',
      join(dir, 'seg-%03d.ts'),
    ];
    stderrTail = '';
    child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr?.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    child.on('exit', (code, signal) => {
      if (code && code !== 0) state.error = stderrTail.trim() || `ffmpeg exit ${code}`;
      logger?.warn?.(`[rta] recorder exited code=${code} signal=${signal ?? ''}`);
      finish(code, signal);
    });
    state.active = true;
    state.startedAt = Date.now();
    state.exitedAt = 0;
    state.error = null;
    // 等 900ms：编码器初始化失败时 ffmpeg 会立刻退出
    await new Promise((r) => setTimeout(r, 900));
    if (!state.active) {
      return { ok: false, error: state.error ?? 'ffmpeg exited early' };
    }
    return { ok: true, startedAt: state.startedAt, encoder: state.encoder };
  }

  /** 优雅停止：向 stdin 写 q，等 6s，超时强杀。 */
  async function stop() {
    if (!child || !state.active) return { ok: true };
    try { child.stdin.write('q'); child.stdin.end(); } catch { /* ignore */ }
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 6000);
      waiters.push(() => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    return { ok: true, files: files().length, bytes: totalBytes() };
  }

  function totalBytes() {
    let sum = 0;
    for (const n of files()) {
      try { sum += statSync(join(dir, n)).size; } catch { /* ignore */ }
    }
    return sum;
  }

  /** 抽某一时刻的原生帧到 outPath。 */
  /**
   * 抽帧：wallMs → 段文件 + 段内秒数。
   *
   * 混合 seek：先 input seek 到目标前 2 秒（快），再 output seek 走完剩下 2 秒（准）。
   * 只做 input seek 在接近段尾时会失败（TS 时间戳/关键帧边界），只做 output seek
   * 又要从段首解到目标（300s 段太慢），所以两者组合。
   */
  async function extractFrame(wallMs, outPath, { quality: jpegQuality = 2 } = {}) {
    const offsetSec = Math.max(0, (wallMs - state.startedAt) / 1000);
    const segIndex = Math.floor(offsetSec / segmentSeconds);
    const local = offsetSec - segIndex * segmentSeconds;
    const list = files();
    const seg = list[segIndex] ?? list[list.length - 1];
    if (!seg) return { ok: false, reason: 'segment-not-found', offsetSec, segIndex, files: list.length };
    const segPath = join(dir, seg);
    const jpg = ['-frames:v', '1', '-q:v', String(jpegQuality), '-y', outPath];
    const hasOutput = () => existsSync(outPath) && statSync(outPath).size > 0;

    const pre = Math.max(0, local - 2);
    const post = local - pre;
    try {
      await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', pre.toFixed(3), '-i', segPath, '-ss', post.toFixed(3), ...jpg], 60_000);
    } catch { /* 落到下面的兜底 */ }

    if (!hasOutput()) {
      // 兜底 1：纯 output seek（解码整段；段内目标在最后一帧之后时也失败）
      try {
        await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', segPath, '-ss', local.toFixed(3), ...jpg], 60_000);
      } catch { /* ignore */ }
    }
    if (!hasOutput()) {
      // 兜底 2：这一段的最后一帧（回看"刚才"时通常就是想要的画面）
      try {
        await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-sseof', '-1.0', '-i', segPath, ...jpg], 60_000);
      } catch { /* ignore */ }
    }
    if (!hasOutput()) return { ok: false, reason: 'extract-failed', offsetSec, segIndex, seg: segPath };
    return { ok: true, path: outPath, seg: segPath, offsetSec, localSec: local, fallbackLastFrame: local - 2 > offsetSec };
  }

  function status() {
    return {
      mode: 'video',
      active: state.active,
      encoder: state.encoder,
      width: state.width,
      height: state.height,
      fps: state.fps,
      startedAt: state.startedAt,
      segmentSeconds,
      files: files().length,
      bytes: totalBytes(),
      error: state.error,
    };
  }

  return { start, stop, files, totalBytes, extractFrame, status, state };
}
