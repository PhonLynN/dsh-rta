#!/usr/bin/env node
/**
 * bin/rta-run.mjs — headless 跑一段 RTA，用来在没有 UI 的情况下验证采集/算法/落盘。
 *
 * 用法：
 *   node bin/rta-run.mjs --seconds=10 --fps=30 --archive-fps=15
 *   node bin/rta-run.mjs --seconds=20 --json
 *
 * 输出：每秒的状态行、push 事件、结束后的 session 目录和磁盘统计。
 * 这是开发/验收工具，不是给用户用的入口（用户入口是插件工具 + 悬浮窗）。
 */

import { createEngine } from '../src/engine/engine.js';
import { sessionsRoot, rtaHome } from '../src/store/paths.js';
import { promises as fsp } from 'node:fs';

function arg(name, def) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  if (eq < 0) return true;
  const v = hit.slice(eq + 1);
  return v === 'true' ? true : v === 'false' ? false : v;
}

const seconds = Number(arg('seconds', 10));
const json = arg('json', false);
const quiet = arg('quiet', false);
const sentinelHz = Number(arg('fps', 30));
const archiveFps = Number(arg('archive-fps', 15));

const logger = quiet ? {} : console;
const engine = createEngine({
  logger,
  config: {
    capture: { sentinelHz, archiveFps },
  },
});

let pushes = 0;
engine.on('push', (ev) => {
  pushes++;
  if (!quiet) console.log(`[push ${ev.kind}] seq=${ev.seq} t=${new Date(ev.at).toLocaleTimeString()} ${ev.region ? `region#${ev.region.id}` : ''}`);
});
engine.on('exit', () => { if (!quiet) console.log('[exit] Ctrl+Tab'); });
engine.on('draw-start', () => { if (!quiet) console.log('[draw] start'); });
engine.on('draw-end', (e) => { if (!quiet) console.log(`[draw] end ${e.region ? `bbox=${JSON.stringify(e.region.bbox)} pts=${e.region.points}` : '(too small)'}`); });

const cpu0 = process.cpuUsage();
const t0 = Date.now();
await engine.start();
console.log(`[rta] session=${engine.sessionId} dir=${engine.store.paths.dir}`);

const timer = setInterval(() => {
  const st = engine.status();
  if (!quiet) {
    console.log(
      `[${((Date.now() - t0) / 1000).toFixed(1)}s] ticks=${st.capture.ticks} hz=${st.capture.tickHz} ` +
      `analysis=${st.capture.analysisMs}ms frames=${st.session.counts.frames} events=${st.session.counts.events} ` +
      `writer=${st.capture.writerInFlight} score=${st.selector?.lastScore?.toFixed?.(1) ?? '-'} z=${st.selector?.lastDecision?.z?.toFixed?.(1) ?? '-'}`,
    );
  }
}, 2000);

await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(timer);
await engine.stop({ reason: 'cli' });
const cpu = process.cpuUsage(cpu0);
const elapsedMs = Date.now() - t0;
const st = engine.status();
const dir = st.session.dir;

let files = 0;
try {
  files = (await fsp.readdir(`${dir}/frames`)).length;
} catch { /* ignore */ }

const summary = {
  seconds: elapsedMs / 1000,
  cpuPercent: Math.round(((cpu.user + cpu.system) / 1000) / elapsedMs * 1000) / 10,
  ticks: st.capture.ticks,
  tickHz: st.capture.tickHz,
  analysisMs: st.capture.analysisMs,
  archived: st.capture.archived,
  frameFiles: files,
  events: st.session.counts.events,
  pushes,
  session: st.session,
  home: rtaHome(),
  sessionsRoot: sessionsRoot(),
  lastError: st.lastError,
};

// manifest 校验
try {
  const m = JSON.parse(await fsp.readFile(`${dir}/manifest.json`, 'utf8'));
  summary.manifest = { status: m.status, endedAt: m.endedAt, retainUntil: m.retainUntil, counts: m.counts };
} catch (err) {
  summary.manifestError = String(err?.message ?? err);
}

if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log('\n=== summary ===');
  console.log(`cpu ${summary.cpuPercent}%  ${summary.seconds.toFixed(1)}s  ${summary.tickHz}Hz tick  analysis ${summary.analysisMs}ms`);
  console.log(`frames ${summary.frameFiles} files (${summary.archived} written)  events ${summary.events}  pushes ${summary.pushes}`);
  console.log(`session ${dir}`);
  console.log(`manifest ${JSON.stringify(summary.manifest)}`);
  if (summary.lastError) console.log(`lastError: ${summary.lastError}`);
}
process.exit(0);
