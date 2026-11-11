#!/usr/bin/env node
/**
 * bin/rta-purge.mjs — 提前清图（默认保留最近 2 分钟，保留全部文字记录）。
 *
 * 用法：
 *   node bin/rta-purge.mjs                          # 最近一场已结束会话，清 2 分钟前的图
 *   node bin/rta-purge.mjs --session 20261110-224307
 *   node bin/rta-purge.mjs --before 2026-11-10T14:40:00Z
 *   node bin/rta-purge.mjs --keep-minutes 0 --dry-run
 */
import { SessionStore } from '../src/store/store.js';
import { sessionsRoot } from '../src/store/paths.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const dryRun = args.includes('--dry-run');
const sessionId = opt('session');
const beforeArg = opt('before');
const keepMinutes = Number(opt('keep-minutes') ?? 2);
const now = Date.now();
const before = beforeArg
  ? (Number.isFinite(Number(beforeArg)) && String(beforeArg).trim() !== '' ? Number(beforeArg) : Date.parse(beforeArg))
  : now - keepMinutes * 60_000;

if (!Number.isFinite(before)) {
  console.error('bad --before value');
  process.exit(2);
}
const res = await SessionStore.purge({ root: sessionsRoot(), sessionId, before, now, dryRun });
console.log(JSON.stringify(res, null, 2));
