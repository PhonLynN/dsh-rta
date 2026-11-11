import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/store/store.js';

test('store: purge 提前清图，只删旧图片/视频，保留文字', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rta-store-'));
  const now = Date.now();
  const store = new SessionStore({
    id: '20260101-000000',
    root,
    now: now - 3_600_000,
    screen: { width: 100, height: 100 },
    config: {},
  });
  await store.init();

  const oldWall = now - 10 * 60_000;
  const oldFile = store.framePath('frame', store.nextSeq(), oldWall, 'png');
  writeFileSync(oldFile, 'old');
  const newFile = store.framePath('frame', store.nextSeq(), now, 'png');
  writeFileSync(newFile, 'new');
  const oldEvent = store.framePath('event', store.nextSeq(), oldWall, 'jpg');
  writeFileSync(oldEvent, 'ev');
  const oldSheet = store.sheetPath(store.nextSeq(), oldWall);
  writeFileSync(oldSheet, 'sheet');

  mkdirSync(join(store.paths.dir, 'video'), { recursive: true });
  const oldSeg = join(store.paths.dir, 'video', 'seg-000.ts');
  writeFileSync(oldSeg, 'seg-old');
  const past = new Date(now - 10 * 60_000);
  utimesSync(oldSeg, past, past);
  const newSeg = join(store.paths.dir, 'video', 'seg-001.ts');
  writeFileSync(newSeg, 'seg-new');

  await store.saveNote('n1', 'hello');
  await store.end({ reason: 'test', now });

  const before = now - 5 * 60_000;
  const res = await SessionStore.purge({ root, sessionId: store.id, before, now });
  assert.equal(res.ok, true);
  assert.equal(res.files, 4, `removed 4 files, got ${JSON.stringify(res)}`);
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(oldEvent), false);
  assert.equal(existsSync(oldSheet), false);
  assert.equal(existsSync(oldSeg), false);
  assert.equal(existsSync(newFile), true);
  assert.equal(existsSync(newSeg), true);
  assert.equal(existsSync(store.paths.index), true);
  assert.equal(existsSync(store.paths.manifest), true);
  assert.equal(existsSync(join(store.paths.notes, 'n1.md')), true);
  assert.equal(existsSync(join(store.paths.dir, 'purges.jsonl')), true);
  const manifest = JSON.parse(readFileSync(store.paths.manifest, 'utf8'));
  assert.ok(manifest.imagesPurgedAt >= now);
  rmSync(root, { recursive: true, force: true });
});

test('store: purge dry-run 不删文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rta-store-dry-'));
  const now = Date.now();
  const store = new SessionStore({ id: '20260101-000001', root, now: now - 3_600_000, screen: { width: 10, height: 10 }, config: {} });
  await store.init();
  const f = store.framePath('frame', store.nextSeq(), now - 600_000, 'png');
  writeFileSync(f, 'x');
  await store.end({ reason: 'test', now });
  const res = await SessionStore.purge({ root, sessionId: store.id, before: now - 300_000, now, dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(res.files, 1);
  assert.equal(existsSync(f), true);
  assert.equal(existsSync(join(store.paths.dir, 'purges.jsonl')), false);
  rmSync(root, { recursive: true, force: true });
});
