import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rgbToHsv, scorePair, frameToHsv, mcRatioScore, meanLuma, lumaGain,
  hueHistogram, histL1, blockDiffFrac, pixelChangeFrac, estimateRowShift,
} from '../src/algo/color.js';
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

test('结构特征: 直方图距离、分块差占比、像素变化占比', () => {
  const solid = (w, h, r, g, b) => {
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; }
    return rgb;
  };
  const w = 32, h = 18;
  const red = solid(w, h, 220, 20, 20);
  const blue = solid(w, h, 20, 20, 220);
  const redHsv = frameToHsv(red);
  const blueHsv = frameToHsv(blue);
  const h1 = hueHistogram(redHsv, w * h);
  const h2 = hueHistogram(blueHsv, w * h);
  assert.equal(histL1(h1, h1), 0);
  assert.ok(histL1(h1, h2) > 0.5, '红蓝整版换色，直方图距离应很大');

  // 整帧亮度平移：分块差应接近 1（整版都变了）
  const gray = solid(w, h, 100, 100, 100);
  const brighter = solid(w, h, 180, 180, 180);
  assert.ok(blockDiffFrac(gray, brighter, w, h) > 0.9);

  // 只有左上角一小块变了：分块差应很小
  const local = gray.slice();
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const o = (y * w + x) * 3;
    local[o] = 255; local[o + 1] = 0; local[o + 2] = 255;
  }
  const frac = blockDiffFrac(gray, local, w, h);
  assert.ok(frac > 0 && frac < 0.2, `小区域改动不该被判整版重排，实际 ${frac}`);
  assert.ok(pixelChangeFrac(gray, local, w, h) < 0.2, '整帧像素变化占比应很小');
  assert.ok(pixelChangeFrac(gray, brighter, w, h) > 0.9);
});

test('结构特征: 行位移估计能识别滚动，残差给出可解释度', () => {
  const h = 108;
  const a = new Float32Array(h);
  for (let y = 0; y < h; y++) a[y] = 80 + 60 * Math.sin(y * 0.21) + ((y * 37) % 11);
  const b = new Float32Array(h);
  const shift = 8;
  for (let y = 0; y < h; y++) b[y] = y - shift >= 0 ? a[y - shift] : a[0];
  const r = estimateRowShift(a, b, { maxShift: 24 });
  assert.ok(Math.abs(r.shift) === shift, `位移估计应接近 ${shift}px，实际 ${r.shift}`);
  assert.ok(r.corr > 0.9, `滚动相关性应很高，实际 ${r.corr}`);
  assert.ok(r.residRatio < 0.5, `对齐后残差应显著下降，实际 ${r.residRatio}`);

  // 不相关的内容（换页）：相关低、残差比接近 1
  const c = new Float32Array(h);
  for (let y = 0; y < h; y++) c[y] = 80 + 60 * Math.cos(y * 0.13 + 1.7) + ((y * 53) % 7);
  const r2 = estimateRowShift(a, c, { maxShift: 24 });
  assert.ok(r2.residRatio > 0.7, `换页时位移无法解释变化，实际 ${r2.residRatio}`);
});

test('select: 滚动/视频运动不算切镜，整版重排才算', () => {
  const quiet = { mc: 0.02, meanV: 120, bFrac30: 0.01, histL1: 0.01, pixFrac30: 0, shiftPx: 0, shiftCorr: 0, scrollResid: 1 };
  const sel = createSelector({ window: 60 });
  let t = 1000;
  for (let i = 0; i < 40; i++, t += 33) {
    assert.equal(sel.ingest({ t, score: 4 + (i % 3), ...quiet }), null);
  }
  // 滚动帧：分数高、mc 高、结构也强，但行位移可解释 → 不是切镜
  t += 33;
  const scroll = sel.ingest({
    t, score: 90, mc: 0.7, meanV: 120,
    bFrac30: 0.7, histL1: 0.4, pixFrac30: 0.3,
    shiftPx: 12, shiftCorr: 0.9, scrollResid: 0.3,
  });
  assert.equal(scroll, null, '滚动应被降级为 integral，不产生 cut');
  // 隔 500ms 后真正的整版重排 → cut
  t += 500;
  const page = sel.ingest({
    t, score: 90, mc: 0.8, meanV: 120,
    bFrac30: 0.8, histL1: 0.5, pixFrac30: 0.4,
    shiftPx: 0, shiftCorr: 0, scrollResid: 1,
  });
  assert.equal(page?.kind, TRIGGER.CUT);
});

test('select: 视频播放退避——持续运动后提高 cut 门槛，真换页仍能通过', () => {
  const quiet = { mc: 0.02, meanV: 120, bFrac30: 0.01, histL1: 0.01, pixFrac30: 0, shiftPx: 0, shiftCorr: 0, scrollResid: 1 };
  const sel = createSelector({ window: 60 });
  let t = 1000;
  for (let i = 0; i < 40; i++, t += 33) sel.ingest({ t, score: 4, ...quiet });
  // 连续运动帧（视频在播）：结构不强，不产生 cut，但进入播放模式
  for (let i = 0; i < 12; i++, t += 33) {
    assert.equal(sel.ingest({
      t, score: 12, mc: 0.3, meanV: 120,
      bFrac30: 0.2, histL1: 0.05, pixFrac30: 0.2,
      shiftPx: 0, shiftCorr: 0, scrollResid: 1,
    }), null);
  }
  assert.equal(sel.snapshot().playback, true, '应进入播放模式');
  // 中等结构变化：播放模式下不够格（需要 bFrac≥0.6 且 hist≥0.35 且 mc≥0.45）
  t += 33;
  const mid = sel.ingest({
    t, score: 90, mc: 0.5, meanV: 120,
    bFrac30: 0.5, histL1: 0.25, pixFrac30: 0.3,
    shiftPx: 0, shiftCorr: 0, scrollResid: 1,
  });
  assert.ok(!mid || mid.kind !== TRIGGER.CUT, `播放模式下的中等变化不该判 cut，实际 ${mid?.kind}`);
  // 真正的整版重排：强结构 + 高 mc → 仍然 cut（等过 800ms 选帧间隔）
  t += 900;
  const strong = sel.ingest({
    t, score: 120, mc: 0.7, meanV: 120,
    bFrac30: 0.9, histL1: 0.55, pixFrac30: 0.6,
    shiftPx: 0, shiftCorr: 0, scrollResid: 1,
  });
  assert.equal(strong?.kind, TRIGGER.CUT, '真换页在播放模式下也要被发现');
});
