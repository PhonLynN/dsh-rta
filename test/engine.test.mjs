import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEngine } from '../src/engine/engine.js';
import { VK } from '../src/capture/win32.js';
import { isJpegAvailable } from '../src/native/gdiplus.js';

/**
 * 用假采集源 + autoTick:false 驱动引擎，验证确定性行为：
 *  - 每个 tick 都有一行 frame 索引（时间轴不丢时刻）
 *  - 屏幕不变时只落一个 PNG，后续索引指向同一个 file（存档去重）
 *  - 画面变化时每个 tick 一个 PNG
 *  - 按住 Ctrl+Alt+Shift 画圈 → region 事件 + 裁切图 + bbox
 */

const CONFIG = { capture: { sentinelHz: 8, archiveFps: 8, windowInfoEveryMs: 1000, dedupeScore: 0, dedupeMc: 0, archiveMode: 'jpeg' }, gcEveryMs: 0 };

function fakeSource({ width = 256, height = 144, mutate = () => {} } = {}) {
  const frame = { width, height, bgra: new Uint8Array(width * height * 4) };
  // 非纯色底：纯黑 PNG 压缩后太小，测不出"是否真的写了图"
  for (let i = 0; i < frame.bgra.length; i += 4) {
    const p = i / 4;
    frame.bgra[i] = (p * 7) & 0xff;
    frame.bgra[i + 1] = (p * 13) & 0xff;
    frame.bgra[i + 2] = (p * 29) & 0xff;
    frame.bgra[i + 3] = 255;
  }
  const down = new Set();
  let cursor = { x: 40, y: 30 };
  return {
    ok: true,
    name: 'fake',
    size: { width, height },
    capabilities: { cursor: true, hotkeys: true, windowInfo: true, regionGrab: true },
    grab() {
      mutate(frame);
      return { bgra: frame.bgra, width, height, ts: Date.now() };
    },
    cursor: () => ({ ...cursor }),
    foreground: () => ({
      hwnd: 1, pid: 1, title: 'fake window', process: 'fake.exe', visible: true,
      rect: { x: 0, y: 0, w: width, h: height },
    }),
    keyDown: (vk) => down.has(vk),
    dispose() {},
    setCursor(x, y) { cursor = { x, y }; },
    press(vk) { down.add(vk); },
    release(vk) { down.delete(vk); },
  };
}

function readIndex(dir) {
  const text = readFileSync(join(dir, 'index.jsonl'), 'utf8').trim();
  return text ? text.split('\n').map((l) => JSON.parse(l)) : [];
}

async function startEngine(engine, now = Date.now()) {
  await engine.start({ now, id: 'test-session' });
}

test('engine: 6 个 tick 全被索引，静止屏只落一个 PNG', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rta-engine-'));
  const source = fakeSource();
  const engine = createEngine({ source, root, logger: null, autoTick: false, config: CONFIG });
  const t0 = Date.now();
  try {
    await startEngine(engine, t0);
    for (let i = 0; i < 6; i++) engine.tick(t0 + i * 125);
    await engine.stop({ reason: 'test', now: t0 + 800 });

    const dir = engine.store.paths.dir;
    const index = readIndex(dir);
    const frames = index.filter((r) => r.type === 'frame');

    assert.equal(frames.length, 6, '每个 tick 一行 frame 索引');
    const files = readdirSync(join(dir, 'frames'));
    assert.equal(files.length, 1, '同一张屏只落一个 PNG');
    for (const f of frames) assert.equal(f.file, frames[0].file, '后续索引复用同一文件');
    assert.ok(statSync(frames[0].file).size > 100);
    if (isJpegAvailable()) assert.match(frames[0].file, /\.jpg$/i, '基线帧默认用 JPEG');
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i].wallMs > frames[i - 1].wallMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('engine: 画面变化时每个 tick 各落一张 PNG', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rta-engine-'));
  let n = 0;
  const source = fakeSource({
    mutate(frame) {
      n += 1;
      const off = ((n * 977) % (frame.width * frame.height)) * 4;
      for (let i = 0; i < 64; i++) {
        const o = (off + i * 4) % frame.bgra.length;
        frame.bgra[o] = (n * 37) & 0xff;
      }
    },
  });
  const engine = createEngine({ source, root, logger: null, autoTick: false, config: CONFIG });
  const t0 = Date.now();
  try {
    await startEngine(engine, t0);
    for (let i = 0; i < 4; i++) engine.tick(t0 + i * 125);
    await engine.stop({ reason: 'test', now: t0 + 600 });
    const files = readdirSync(join(engine.store.paths.dir, 'frames'));
    assert.equal(files.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('engine: 近重复（光标闪一下）复用上一张图，索引照写', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rta-engine-'));
  let n = 0;
  const source = fakeSource({
    mutate(frame) {
      n += 1;
      frame.bgra[(n * 4) % frame.bgra.length] = (n * 7) & 0xff;
    },
  });
  const engine = createEngine({
    source, root, logger: null, autoTick: false,
    config: { capture: { sentinelHz: 8, archiveFps: 8, windowInfoEveryMs: 1000, dedupeScore: 5, dedupeMc: 1, archiveMode: 'jpeg' }, gcEveryMs: 0 },
  });
  const t0 = Date.now();
  try {
    await startEngine(engine, t0);
    for (let i = 0; i < 4; i++) engine.tick(t0 + i * 125);
    await engine.stop({ reason: 'test', now: t0 + 600 });
    const dir = engine.store.paths.dir;
    const frames = readIndex(dir).filter((r) => r.type === 'frame');
    assert.equal(frames.length, 4, '时间轴每个 tick 一行');
    assert.equal(readdirSync(join(dir, 'frames')).length, 1, '小变化复用上一张图');
    for (const f of frames) assert.equal(f.file, frames[0].file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('engine: Ctrl+Alt+Shift 画圈 → region 事件 + 裁切图 + bbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rta-engine-'));
  const source = fakeSource();
  const engine = createEngine({ source, root, logger: null, autoTick: false, config: CONFIG });
  const t0 = Date.now();
  const drawEnd = [];
  engine.on('draw-end', (e) => drawEnd.push(e));
  try {
    await startEngine(engine, t0);
    // 按住三个键开始画（不需要鼠标键），移动三次后松开 Shift 结束
    source.press(VK.CONTROL); source.press(VK.MENU); source.press(VK.SHIFT);
    source.setCursor(30, 20); engine.pollHotkeys();
    source.setCursor(90, 70); engine.pollHotkeys();
    source.setCursor(140, 110); engine.pollHotkeys();
    source.release(VK.SHIFT); engine.pollHotkeys();
    await new Promise((r) => setTimeout(r, 400));
    await engine.stop({ reason: 'test', now: Date.now() });

    const index = readIndex(engine.store.paths.dir);
    const regions = index.filter((r) => r.type === 'event' && r.kind === 'region');
    assert.equal(regions.length, 1, '一次圈画一个 region 事件');
    const b = regions[0].bbox;
    assert.ok(b.w >= 2 && b.h >= 2, 'bbox 宽高为正');
    assert.ok(b.x <= 30 && b.y <= 20, 'bbox 覆盖起点');
    assert.ok(statSync(regions[0].file).size > 100, '裁切图已落盘');
    assert.equal(drawEnd.length, 1, 'draw-end 事件触发一次');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('engine: 运行中 Ctrl+Alt 不重复召唤；Ctrl+Tab 退出；画圈时 Esc 只取消', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rta-engine-'));
  const source = fakeSource();
  const engine = createEngine({ source, root, logger: null, autoTick: false, config: CONFIG });
  const exits = [];
  const summons = [];
  const cancels = [];
  engine.on('exit', (e) => exits.push(e));
  engine.on('summon', (e) => summons.push(e));
  engine.on('draw-cancel', (e) => cancels.push(e));
  try {
    await startEngine(engine);
    // 已启用时按 Ctrl+Alt：不召唤、不退出
    source.press(VK.CONTROL); source.press(VK.MENU);
    engine.pollHotkeys(); engine.pollHotkeys();
    assert.equal(summons.length, 0, '启用中 Ctrl+Alt 不重复召唤');
    assert.equal(exits.length, 0);
    source.release(VK.CONTROL); source.release(VK.MENU);

    // 画圈时按 Esc：只取消这一笔，不退出
    source.press(VK.CONTROL); source.press(VK.MENU); source.press(VK.SHIFT);
    engine.pollHotkeys();
    source.press(VK.ESCAPE); engine.pollHotkeys();
    assert.equal(cancels.length, 1, '画圈时 Esc 取消');
    assert.equal(exits.length, 0, '画圈时 Esc 不退出');
    source.release(VK.ESCAPE); source.release(VK.SHIFT); source.release(VK.CONTROL); source.release(VK.MENU);
    engine.pollHotkeys();

    // Ctrl+Tab：上升沿一次
    source.press(VK.CONTROL); source.press(VK.TAB);
    engine.pollHotkeys(); engine.pollHotkeys();
    assert.equal(exits.length, 1, 'Ctrl+Tab 只触发一次 exit');
    source.release(VK.TAB); source.release(VK.CONTROL);
    engine.pollHotkeys();

    // 松开后再按可以再次触发
    source.press(VK.CONTROL); source.press(VK.TAB);
    engine.pollHotkeys();
    assert.equal(exits.length, 2, '再次按下可再触发');
    source.release(VK.TAB); source.release(VK.CONTROL);
    await engine.stop({ reason: 'test' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('engine: 事件帧按原生分辨率落盘（可回看原图）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rta-engine-'));
  const source = fakeSource();
  const config = { capture: { sentinelHz: 8, archiveFps: 8, archiveWidth: 128, windowInfoEveryMs: 1000, dedupeScore: 0, dedupeMc: 0, archiveMode: 'jpeg' }, gcEveryMs: 0 };
  const engine = createEngine({ source, root, logger: null, autoTick: false, config });
  const t0 = Date.now();
  try {
    await startEngine(engine, t0);
    engine.noteTextChange(t0 + 20);
    engine.tick(t0 + 30);
    engine.tick(t0 + 155);
    await engine.stop({ reason: 'test', now: t0 + 300 });
    const index = readIndex(engine.store.paths.dir);
    const events = index.filter((r) => r.type === 'event' && r.kind !== 'region');
    assert.ok(events.length >= 1, '文字变化触发事件帧');
    const ev = events[0];
    assert.equal(ev.width, 256, '事件帧宽 = 原生宽度');
    assert.equal(ev.height, 144, '事件帧高 = 原生高度');
    assert.ok(statSync(ev.file).size > 100);
    const frames = index.filter((r) => r.type === 'frame');
    assert.equal(frames[0].width, 128, '存档帧仍是小图');
    if (isJpegAvailable()) assert.match(ev.file, /\.jpg$/i, '事件帧默认 JPEG');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('engine: composePages 按页面归并、每页只留最后一帧；不足 minPages 返回 null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rta-engine-'));
  const source = fakeSource();
  const engine = createEngine({ source, root, logger: null, autoTick: false, config: CONFIG });
  const t0 = Date.now();
  const mkRgb = (r, g, b) => {
    const rgb = new Uint8Array(16 * 9 * 3);
    for (let i = 0; i < rgb.length; i += 3) { rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b; }
    return rgb;
  };
  const ev = (seq, kind, wall, win, rgb) => ({ seq, kind, wall, rgb, width: 16, height: 9, win, score: 1 });
  try {
    await startEngine(engine, t0);
    const ring = engine.eventRing;
    ring.push(ev(1, 'cut', t0 + 1000, { process: 'msedge.exe', title: 'Page A' }, mkRgb(10, 20, 30)));
    ring.push(ev(2, 'cut', t0 + 2000, { process: 'msedge.exe', title: 'Page A' }, mkRgb(40, 50, 60)));
    ring.push(ev(3, 'heartbeat', t0 + 3000, { process: 'msedge.exe', title: 'Page B' }, mkRgb(70, 80, 90)));
    ring.push(ev(4, 'cut', t0 + 4000, { process: 'msedge.exe', title: 'Page B' }, mkRgb(70, 80, 90)));
    ring.push(ev(5, 'cut', t0 + 5000, { process: 'notepad.exe', title: 'Page C' }, mkRgb(100, 110, 120)));

    const all = engine.composePages({ minPages: 2, now: t0 + 6000 });
    assert.ok(all, '3 个页面应返回拼图');
    assert.deepEqual(all.pages.map((p) => p.title), ['Page A', 'Page B', 'Page C']);
    assert.equal(all.pages[0].seq, 2, '同页连续帧只留最后一帧');
    assert.equal(all.rgb.length, all.width * all.height * 3);

    const onlyRecent = engine.composePages({ minPages: 2, now: t0 + 6000, maxAgeMs: 1000 });
    assert.equal(onlyRecent, null, '窗口内页面数不足时返回 null');
    await engine.stop({ reason: 'test' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
