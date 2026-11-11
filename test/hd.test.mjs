import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  HD_DEFAULT_WIDTH,
  KIND_LABEL,
  importance,
  pickInformativeFrames,
  pickSpread,
  cropRectFor,
  buildVf,
  widthForTokens,
  nativeFrameSize,
  makeHdDir,
  cleanHdDir,
  extractHdFrame,
  eventWall,
} from '../src/host/hd.js';
import { tokensFor } from '../src/algo/tiers.js';

const WIN = { title: 'DeepSeek Harness', process: 'dsh.exe', rect: { x: 0, y: 0, w: 2560, h: 1440 } };

function ev(kind, at, extra = {}) {
  return {
    seq: Math.round(at / 1000),
    kind,
    at,
    wall: at,
    score: 10,
    win: WIN,
    ...extra,
  };
}

test('hd: KIND_LABEL 覆盖全部事件类型，含中文说明', () => {
  for (const kind of ['region', 'manual', 'cut', 'text', 'integral', 'heartbeat']) {
    assert.equal(typeof KIND_LABEL[kind], 'string');
    assert.ok(KIND_LABEL[kind].length > 0);
  }
});

test('hd: importance 按类型排序 region > cut > integral > heartbeat', () => {
  const region = importance(ev('region', 1000, { region: { bbox: { x: 100, y: 100, w: 600, h: 400 } } }));
  const cut = importance(ev('cut', 1000));
  const integral = importance(ev('integral', 1000));
  const heartbeat = importance(ev('heartbeat', 1000));
  assert.ok(region > cut, `region ${region} > cut ${cut}`);
  assert.ok(cut > integral, `cut ${cut} > integral ${integral}`);
  assert.ok(integral > heartbeat, `integral ${integral} > heartbeat ${heartbeat}`);
});

test('hd: pickInformativeFrames 优先挑 region，跳过 heartbeat 与过期事件', () => {
  const now = 1_000_000;
  const otherWin = { title: '另一个窗口', process: 'x.exe', rect: WIN.rect };
  const events = [
    ev('heartbeat', now - 1000),
    ev('integral', now - 2000, { win: otherWin }),
    ev('cut', now - 3000, { win: otherWin }),
    ev('region', now - 4000, { region: { bbox: { x: 10, y: 10, w: 300, h: 200 } } }),
    ev('cut', now - 500_000), // 过期
  ];
  const picked = pickInformativeFrames(events, { limit: 2, now, maxAgeMs: 120_000 });
  assert.deepEqual(picked.map((p) => p.ev.kind), ['region', 'cut']);
});

test('hd: pickInformativeFrames 同一窗口内近重复只留一条', () => {
  const now = 1_000_000;
  const events = [ev('cut', now - 1000), ev('cut', now - 1500), ev('cut', now - 5000)];
  const picked = pickInformativeFrames(events, { limit: 3, now, maxAgeMs: 120_000, dedupeMs: 1500 });
  assert.equal(picked.length, 2);
  assert.ok(picked.every((p) => p.win?.title === WIN.title));
});

test('hd: cropRectFor region 用圈选 bbox 且扩 12%；窗口事件用 win.rect', () => {
  const region = cropRectFor(ev('region', 1000, { region: { bbox: { x: 200, y: 100, w: 400, h: 200 } } }));
  assert.deepEqual(region, { x: 152, y: 76, w: 496, h: 248 });

  const cut = cropRectFor(ev('cut', 1000));
  assert.deepEqual(cut, { x: -154, y: -86, w: 2868, h: 1612 });

  const tiny = cropRectFor(ev('cut', 1000, { win: { title: 'x', rect: { x: 0, y: 0, w: 10, h: 10 } } }));
  assert.equal(tiny, null);

  const fallback = cropRectFor(ev('cut', 1000, { win: null }), { foreground: { rect: { x: 10, y: 20, w: 800, h: 600 } } });
  assert.deepEqual(fallback, { x: -38, y: -16, w: 896, h: 672 });
});

test('hd: buildVf 裁窗+缩放，整幅(≥85%)时回退不裁', () => {
  const cropped = buildVf({ rect: { x: 100, y: 50, w: 1280, h: 720 }, frameWidth: 2560, frameHeight: 1440, maxWidth: 800 });
  assert.equal(cropped.vf, 'crop=1280:720:100:50,scale=800:-2');
  assert.equal(cropped.width, 800);
  assert.equal(cropped.height, 450);
  assert.equal(cropped.crop.w, 1280);

  const whole = buildVf({ rect: { x: 0, y: 0, w: 2500, h: 1400 }, frameWidth: 2560, frameHeight: 1440, maxWidth: 1600 });
  assert.equal(whole.crop.w, 2560);
  assert.equal(whole.crop.h, 1440);
  assert.equal(whole.vf, 'crop=2560:1440:0:0,scale=1600:-2');
});

test('hd: buildVf 越界收敛且宽高取偶数', () => {
  const vf = buildVf({ rect: { x: 2000, y: 1300, w: 1000, h: 800 }, frameWidth: 2560, frameHeight: 1440, maxWidth: 720 });
  assert.equal(vf.crop.x % 2, 0);
  assert.equal(vf.crop.y % 2, 0);
  assert.ok(vf.crop.x + vf.crop.w <= 2560, `${vf.crop.x}+${vf.crop.w} <= 2560`);
  assert.ok(vf.crop.y + vf.crop.h <= 1440);
  // 目标宽度 720 已不小于裁切宽度 560，所以不需要 scale。
  assert.equal(vf.vf, `crop=${vf.crop.w}:${vf.crop.h}:${vf.crop.x}:${vf.crop.y}`);
  assert.equal(vf.width, 560);
});

test('hd: widthForTokens 预算越小宽度越小，且都在 720 以上', () => {
  const big = widthForTokens(1600);
  const mid = widthForTokens(800);
  const small = widthForTokens(300);
  assert.ok(big >= mid && mid >= small, `${big} >= ${mid} >= ${small}`);
  assert.ok(small >= 720);
  assert.ok(tokensFor(720, 405) <= 400);
  assert.equal(widthForTokens(100000), HD_DEFAULT_WIDTH);
});

test('hd: pickSpread 在长窗口均分挑帧，空段用录像帧补位', () => {
  const from = 1_000_000;
  const to = from + 90_000;
  const records = [
    { seq: 1, type: 'event', kind: 'cut', wall: from + 2_000, score: 30, win: WIN },
    { seq: 2, type: 'event', kind: 'integral', wall: from + 25_000, score: 5, win: WIN },
    { seq: 3, type: 'frame', wall: from + 45_000, videoMs: 45_000 },
    { seq: 4, type: 'frame', wall: from + 75_000, videoMs: 75_000 },
  ];
  const picked = pickSpread(records, { limit: 3, from, to });
  assert.equal(picked.length, 3);
  assert.equal(picked[0].record.seq, 1);
  assert.equal(picked[1].fromFrame, true);
  assert.equal(picked[1].record.seq, 3);
  assert.equal(picked[2].fromFrame, true);
  assert.equal(picked[2].record.seq, 4);
});

test('hd: extractHdFrame 把 vf 传给 frameAt 并回报尺寸/token', async () => {
  const calls = [];
  const engine = {
    frameAt: async (args) => {
      calls.push(args);
      return { ok: true, path: args.outPath, wall: args.wallMs };
    },
    status: () => ({ video: { width: 2560, height: 1440 } }),
  };
  const dir = await makeHdDir();
  try {
    const shot = await extractHdFrame(engine, ev('cut', 1_000_000), { dir, maxWidth: 800, frameWidth: 2560, frameHeight: 1440 });
    assert.equal(shot.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].vf, /^crop=\d+:\d+:\d+:\d+,scale=800:-2$/);
    assert.equal(shot.width, 800);
    assert.equal(shot.height, 450);
    assert.equal(shot.tokens, tokensFor(800, 450));
  } finally {
    await cleanHdDir(dir);
  }
});

test('hd: extractHdFrame 在无 frameAt / 抽帧失败时优雅返回', async () => {
  assert.equal((await extractHdFrame(null, ev('cut', 1))).ok, false);
  const failing = { frameAt: async () => ({ ok: false, reason: 'segment-not-found' }) };
  const out = await extractHdFrame(failing, ev('cut', 1_000_000));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'segment-not-found');
});

test('hd: nativeFrameSize 读 video 尺寸，读不到回退 2560×1440', () => {
  assert.deepEqual(nativeFrameSize({ status: () => ({ video: { width: 1920, height: 1080 } }) }), { width: 1920, height: 1080 });
  assert.deepEqual(nativeFrameSize({ status: () => ({}) }), { width: 2560, height: 1440 });
  assert.deepEqual(nativeFrameSize(null), { width: 2560, height: 1440 });
});

test('hd: eventWall 兼容 wall/at/wallMs 三种字段', () => {
  assert.equal(eventWall({ wall: 5 }), 5);
  assert.equal(eventWall({ at: 7 }), 7);
  assert.equal(eventWall({ wallMs: 9 }), 9);
  assert.equal(eventWall({}), 0);
});

test('hd: makeHdDir / cleanHdDir 建删临时目录', async () => {
  const dir = await makeHdDir();
  assert.equal(existsSync(dir), true);
  await cleanHdDir(dir);
  assert.equal(existsSync(dir), false);
});
