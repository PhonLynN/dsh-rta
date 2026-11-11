import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbToHsv, scorePair, frameToHsv, mcRatioScore, meanLuma, lumaGain } from '../src/algo/color.js';
import { RollingStats } from '../src/algo/rolling.js';
import { createSelector, TRIGGER } from '../src/algo/select.js';
import { tokensFor, planSheet } from '../src/algo/tiers.js';
import { composeSheet } from '../src/algo/pack.js';
import { bboxOf, createRegionTracker, regionToFrame } from '../src/algo/regions.js';

test('rgbToHsv: 红/绿/蓝/白/黑的色相', () => {
  assert.equal(Math.round(rgbToHsv(255, 0, 0)[0]), 0);
  assert.equal(Math.round(rgbToHsv(0, 255, 0)[0]), 85);
  assert.equal(Math.round(rgbToHsv(0, 0, 255)[0]), 170);
  assert.equal(rgbToHsv(255, 255, 255)[1], 0);
  assert.equal(rgbToHsv(0, 0, 0)[2], 0);
});

test('scorePair: 相同为 0，不同为正，色相环绕正确', () => {
  const a = new Float32Array([250, 200, 200, 0, 200, 200]);
  const b = new Float32Array([250, 200, 200, 0, 200, 200]);
  assert.equal(scorePair(a, b, 2), 0);
  const c = new Float32Array([5, 200, 200, 0, 200, 200]); // 250 vs 5 环绕差 = 10
  const s = scorePair(a, c, 2);
  assert.ok(s > 0 && s < 10, `环绕差应很小，实际 ${s}`);
});

test('mcRatioScore: 整帧平移不算变化，局部改动才算', () => {
  const w = 32, h = 18;
  const make = (shift) => {
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const v = ((x + shift) * 7 + y * 3) % 200;
      rgb[o] = v; rgb[o + 1] = v; rgb[o + 2] = v;
    }
    return rgb;
  };
  const shifted = make(1);
  const original = make(0);
  const shiftRatio = mcRatioScore(original, shifted, w, h);
  assert.ok(shiftRatio < 0.2, `平移应被运动补偿吃掉，实际 ${shiftRatio}`);

  const local = make(0);
  for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) {
    const o = (y * w + x) * 3;
    local[o] = 255; local[o + 1] = 0; local[o + 2] = 0;
  }
  const localRatio = mcRatioScore(original, local, w, h);
  assert.ok(localRatio > 0.02, `局部改动应被看到，实际 ${localRatio}`);
});

test('frameToHsv / meanLuma / lumaGain', () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 0, 0, 255, 255, 255]);
  const hsv = frameToHsv(rgb);
  assert.equal(hsv.length, 9);
  assert.equal(Math.round(hsv[0]), 0);
  assert.ok(meanLuma(rgb) > 0);
  assert.equal(lumaGain(160), 1);
  assert.equal(lumaGain(40), 3); // clamp 到 gainMax
  assert.equal(lumaGain(10), 3); // vFloor 保护
});

test('RollingStats: 常值画面 sigma 不低于 1，尖峰 z 很大', () => {
  const rs = new RollingStats({ window: 60, minSamples: 10 });
  for (let i = 0; i < 30; i++) rs.push(5);
  assert.ok(rs.sigma >= 1);
  const z = rs.z(200);
  assert.ok(z > 10, `尖峰 z 应很大，实际 ${z}`);
});

test('select: 静默不触发，尖峰触发 cut，文字变化优先', () => {
  const sel = createSelector({ window: 60 });
  let t = 1000;
  let fired = null;
  for (let i = 0; i < 40; i++, t += 33) {
    fired = sel.ingest({ t, score: 4 + (i % 3), mc: 0.5, meanV: 120 });
    assert.equal(fired, null, `静默帧不应触发（第 ${i} 帧）`);
  }
  t += 33;
  fired = sel.ingest({ t, score: 90, mc: 0.8, meanV: 120 });
  assert.equal(fired?.kind, TRIGGER.CUT);

  sel.noteTextChange(t + 1000);
  const text = sel.ingest({ t: t + 1000, score: 0, mc: 0, meanV: 120 });
  assert.equal(text?.kind, TRIGGER.TEXT);
});

test('select: 长时间静默给保险帧', () => {
  const sel = createSelector({ window: 60, heartbeatMs: 5000, minSelectGapMs: 100 });
  const first = sel.ingest({ t: 1000, score: 0, mc: 0, meanV: 120 });
  assert.equal(first, null);
  const hb = sel.ingest({ t: 7000, score: 0, mc: 0, meanV: 120 });
  assert.equal(hb?.kind, TRIGGER.HEARTBEAT);
});

test('tiers: token 估算与档位选择', () => {
  assert.equal(tokensFor(800, 450), 233);
  assert.equal(tokensFor(1050, 630), 392);
  assert.equal(tokensFor(1260, 756), 560);
  const p1 = planSheet(1);
  assert.equal(p1.width, 800);
  assert.equal(p1.cellW, 800);
  const p4 = planSheet(4);
  assert.equal(p4.cols, 2);
  assert.equal(p4.cellW, 525);
  assert.equal(p4.tokens, 392);
});

test('pack: 拼 4 帧并画标签/红框，输出尺寸正确', () => {
  const mk = (v) => {
    const rgb = new Uint8Array(160 * 90 * 3);
    for (let i = 0; i < rgb.length; i += 3) { rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v; }
    return rgb;
  };
  const frames = [0, 1, 2, 3].map((i) => ({
    rgb: mk(30 + i * 40), width: 160, height: 90,
    label: `T+${i}`,
    region: i === 1 ? { id: 1, bbox: { x: 100, y: 100, w: 80, h: 40 } } : undefined,
    screen: { x: 100, y: 100, w: 1600, h: 900 },
  }));
  const plan = planSheet(4);
  const sheet = composeSheet({ frames, plan, title: 'RTA TEST' });
  assert.equal(sheet.width, 1050);
  assert.equal(sheet.height, 630);
  assert.equal(sheet.cells.length, 4);
  // 红框那格必须真的有红色像素
  let red = 0;
  for (let i = 0; i < sheet.rgb.length; i += 3) {
    if (sheet.rgb[i] > 200 && sheet.rgb[i + 1] < 100 && sheet.rgb[i + 2] < 100) red++;
  }
  assert.ok(red > 50, `应有红色圈画框，实际红色像素 ${red}`);
});

test('regions: 包围盒、轨迹记录、坐标映射', () => {
  const bbox = bboxOf([{ x: 10, y: 20 }, { x: 110, y: 120 }], { padding: 0, screen: { width: 200, height: 200 } });
  assert.deepEqual(bbox, { x: 10, y: 20, w: 100, h: 100 });

  const tracker = createRegionTracker({ nextId: 7, screen: { width: 2560, height: 1440 } });
  tracker.start(1000);
  assert.equal(tracker.add(10, 10, 1001), true);
  assert.equal(tracker.add(11, 11, 1002), false, '移动太小应被忽略');
  tracker.add(200, 150, 1003);
  const region = tracker.finish(2000);
  assert.ok(region);
  assert.equal(region.id, 7);
  assert.equal(region.tStart, 1000);
  assert.equal(region.tEnd, 2000);
  assert.ok(region.bbox.w >= 190);

  const mapped = regionToFrame(region, { x: 0, y: 0, w: 1280, h: 720 });
  assert.ok(mapped);
  assert.equal(mapped.id, 7);
  assert.ok(mapped.local.x >= 0 && mapped.local.y >= 0);
});
