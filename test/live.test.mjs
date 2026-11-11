/**
 * test/live.test.mjs — 持续注入面（live-buffer / injector / channel / lifecycle）。
 *
 * 这里刻意不碰真抓屏：live-buffer 与 injector 是纯函数式的；channel/lifecycle 用假 ctx 与假引擎，
 * 断言「宿主注入 API 的用法」与「节流/预算/绑定过滤」这些最容易悄悄回归的地方。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createLiveBuffer,
  renderDigest,
  renderStopped,
  activityBucket,
  normalizeForeground,
  cleanTitle,
} from '../src/host/live-buffer.js';
import { createInjector, createImageGovernor } from '../src/host/injector.js';
import { createScreenChannel } from '../src/host/channel.js';
import { buildScreenMessage, buildImageCaption } from '../src/host/messages.js';
import { createLiveLifecycle } from '../src/host/lifecycle.js';
import { readRtaConfig, DEFAULT_RTA_CONFIG } from '../src/config.js';

// ───────────────────────────────────────────────────── helpers

function fakeCtx({ attachments } = {}) {
  const contexts = [];
  const handlers = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get() { return undefined; },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {
        const list = handlers.get(event) ?? [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
    systemPrompt: {
      context(spec) { contexts.push(spec); return () => {}; },
      getContextOrder() { return undefined; },
    },
    attachments: attachments ?? {
      saveImage(spec) { return { id: 'att-test', mediaType: spec.mediaType, name: spec.name }; },
    },
  };
  return { ctx, contexts, handlers };
}

function busEngine({ running = true } = {}) {
  const handlers = new Map();
  const engine = {
    state: running ? 'running' : 'idle',
    sessionId: 'rta-session-1',
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {};
    },
    emit(event, payload) { for (const fn of handlers.get(event) ?? []) fn(payload); },
    status() { return { foreground: { title: 'Visual Studio Code — live.test.mjs', process: 'Code.exe' } }; },
    composeRecent() {
      return {
        rgb: new Uint8Array(4 * 2 * 3),
        width: 4,
        height: 2,
        plan: { count: 2 },
        frames: [
          { seq: 12, label: 'T12', wall: Date.now() - 1000 },
          { seq: 15, label: 'T15', wall: Date.now() },
        ],
      };
    },
  };
  return { engine, handlers };
}

const AGENT = { session: { id: 'sess-1' } };
const OTHER_AGENT = { session: { id: 'sess-other' } };
const SUBAGENT = { session: { id: 'sess-1' }, header: { parentSession: 'sess-1', delegationDepth: 1 } };

// ───────────────────────────────────────────────────── live-buffer

test('live-buffer: 同一状态渲染同一文本，静止屏幕不会变', () => {
  const buf = createLiveBuffer();
  buf.reset({ sessionId: 's1', at: 1_000, running: true });
  buf.setForeground({ title: 'Visual Studio Code — a.js', process: 'Code.exe' }, 1_000);
  buf.beat({ at: 1_000, running: true });

  const a = buf.digest(6_000, { eventTtlMs: 120_000 });
  const b = buf.digest(6_000, { eventTtlMs: 120_000 });
  assert.equal(a, b);
  assert.match(a, /〔RTA 屏幕感知 · 自动注入，非用户消息〕/);
  assert.match(a, /前台：Visual Studio Code — a\.js \[Code\.exe\]/);
  assert.match(a, /最近 1 分钟内有变化/);
  assert.match(a, /时间线：最近没有显著变化/);
});

test('live-buffer: heartbeat 不改变文本（静默期不刷历史）', () => {
  const buf = createLiveBuffer();
  buf.reset({ sessionId: 's1', at: 10_000, running: true });
  buf.setForeground({ title: 'A', process: 'a.exe' }, 10_000);
  const before = buf.digest(11_000, {});
  buf.push({ kind: 'heartbeat', seq: 3, at: 11_000, win: { title: 'A', process: 'a.exe' } }, 11_000);
  buf.beat({ at: 11_000, running: true });
  assert.equal(buf.digest(11_000, {}), before);
});

test('live-buffer: 事件进时间线，窗口只在变化时追加后缀', () => {
  const buf = createLiveBuffer();
  buf.reset({ sessionId: 's1', at: 0, running: true });
  buf.push({ kind: 'cut', seq: 1, at: 5_000, score: 42, win: { title: 'A — file.js', process: 'Code.exe' } }, 5_000);
  buf.push({ kind: 'cut', seq: 2, at: 9_000, score: 20, win: { title: 'A — file.js', process: 'Code.exe' } }, 9_000);
  buf.push({ kind: 'cut', seq: 3, at: 12_000, score: 61, win: { title: 'Chrome', process: 'chrome.exe' } }, 12_000);
  const text = buf.digest(13_000, { eventTtlMs: 120_000, maxEvents: 4 });
  const timeline = text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(timeline.length, 3);
  assert.match(timeline[0], /明显变化（强度 42）\s*→ 窗口「A — file\.js」/);
  assert.doesNotMatch(timeline[1], /窗口/);           // 同窗口：不重复写
  assert.match(timeline[2], /→ 窗口「Chrome」/);        // 换窗口：写出来
});

test('live-buffer: 行数/字符双上限生效', () => {
  const buf = createLiveBuffer();
  buf.reset({ sessionId: 's1', at: 0, running: true });
  for (let i = 0; i < 12; i += 1) {
    buf.push({ kind: 'cut', seq: i + 1, at: 1_000 + i * 100, score: 30 + i, win: { title: `窗口 ${i}`, process: 'p.exe' } }, 1_000 + i * 100);
  }
  const text = buf.digest(20_000, { eventTtlMs: 120_000, maxEvents: 8, maxLines: 8, maxTextTokens: 120 });
  assert.ok(text.split('\n').length <= 8, 'lines <= 8');
  assert.ok(text.length <= 120 * 1.5 + 40, `chars within budget: ${text.length}`);
  assert.match(text, /rta_look/);
});

test('live-buffer: 行数超限时保留「时间线」标题、只砍最早事件', () => {
  const buf = createLiveBuffer();
  buf.reset({ sessionId: 's1', at: 0, running: true });
  for (let i = 0; i < 6; i += 1) {
    buf.push({ kind: 'cut', seq: i + 1, at: 1_000 + i * 1_000, score: 30, win: { title: `窗口 ${i}`, process: 'p.exe' } }, 1_000 + i * 1_000);
  }
  const text = buf.digest(20_000, { eventTtlMs: 120_000, maxEvents: 6, maxLines: 8 });
  const lines = text.split('\n');
  assert.ok(lines.length <= 8, `lines <= 8 (${lines.length})`);
  assert.match(text, /时间线（本地时间）：/);
  const timeline = lines.filter((line) => line.startsWith('- '));
  assert.ok(timeline.length >= 1);
  // 砍掉的是最早的：最新一条（窗口 5）必须还在。
  assert.match(timeline[timeline.length - 1], /窗口 5/);
  assert.doesNotMatch(text, /窗口 0/);
});

test('live-buffer: 计数行只算事件窗口，不是整场累计', () => {
  const buf = createLiveBuffer();
  buf.reset({ sessionId: 's1', at: 0, running: true });
  buf.push({ kind: 'cut', at: 5_000, score: 30, win: { title: 'A', process: 'a.exe' } }, 5_000);
  buf.push({ kind: 'cut', at: 100_000, score: 30, win: { title: 'B', process: 'b.exe' } }, 100_000);
  const text = buf.digest(130_000, { eventTtlMs: 120_000 });
  assert.match(text, /明显变化 ×1/); // 5s 那条已过期，不累计
  assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 1);
});

test('live-buffer: 采集延迟与静止时长用粗粒度文案（不会逐秒变化）', () => {
  const buf = createLiveBuffer();
  buf.reset({ sessionId: 's1', at: 0, running: true });
  buf.beat({ at: 0, running: true });
  assert.match(buf.digest(40_000, {}), /采集数据已超过 30 秒没有更新/);
  buf.beat({ at: 40_000, running: true });
  buf.beat({ at: 40_000 + 6 * 60_000, running: true });
  const idle = buf.digest(40_000 + 6 * 60_000, {});
  assert.match(idle, /已 5–15 分钟无明显变化/);
});

test('live-buffer: 辅助函数——标题清洗/前台规范化/活动分桶/停止文案', () => {
  assert.equal(cleanTitle('  a\n\tb   c  ', 80), 'a b c');
  assert.equal(normalizeForeground(null), null);
  assert.deepEqual(
    (({ title, process }) => ({ title, process }))(normalizeForeground({ title: 'X', process: 'x.exe' })),
    { title: 'X', process: 'x.exe' },
  );
  assert.equal(activityBucket(0), 'hot');
  assert.equal(activityBucket(60_000), 'recent');
  assert.equal(activityBucket(5 * 60_000), 'idle');
  assert.equal(activityBucket(15 * 60_000), 'dormant');
  assert.match(renderStopped('explicit'), /已停止[\s\S]*用户主动停止/);
  assert.match(renderDigest({ now: 0, events: [], running: false }), /采集未在运行/);
});

// ───────────────────────────────────────────────────── injector

test('injector: 首次发布、文本不变不发布、变化才发布', () => {
  let t = 1_000;
  const buffer = createLiveBuffer();
  const published = [];
  const injector = createInjector({
    config: { minIntervalMs: 4_000, maxPerMinute: 8, eventTtlMs: 120_000 },
    buffer,
    now: () => t,
    onPublish: (info) => published.push(info),
  });
  buffer.reset({ sessionId: 's1', at: t, running: true });
  injector.start({ sessionId: 's1' });
  assert.equal(published.length, 1);

  t += 500;
  buffer.push({ kind: 'cut', seq: 1, at: t, score: 30, win: { title: 'A', process: 'a.exe' } }, t);
  assert.equal(injector.flush(), false, 'minInterval 未到 → hold');
  assert.equal(published.length, 1);

  t += 4_000;
  assert.equal(injector.flush(), true);
  assert.equal(published.length, 2);
  assert.match(injector.text(), /明显变化/);

  assert.equal(injector.flush(), false, '文本没变 → 不发布');
  assert.equal(published.length, 2);
});

test('injector: 每分钟条数硬上限', () => {
  let t = 0;
  const buffer = createLiveBuffer();
  const injector = createInjector({
    config: { minIntervalMs: 0, maxPerMinute: 2, eventTtlMs: 120_000 },
    buffer,
    now: () => t,
  });
  buffer.reset({ sessionId: 's1', at: t, running: true });
  injector.start({ sessionId: 's1' });           // 1
  t += 1_000;
  buffer.push({ kind: 'cut', seq: 1, at: t, score: 10, win: { title: 'A', process: 'a.exe' } }, t);
  assert.equal(injector.flush(), true);          // 2
  t += 1_000;
  buffer.push({ kind: 'cut', seq: 2, at: t, score: 90, win: { title: 'B', process: 'b.exe' } }, t);
  assert.equal(injector.flush(), false, 'rate limited');
  t += 61_000;
  assert.equal(injector.flush(), true, '窗口滑走后恢复');
});

test('injector: stop 后文本变成「已停止」，disabled 不发布', () => {
  let t = 1_000;
  const buffer = createLiveBuffer();
  const injector = createInjector({ config: { minIntervalMs: 0, maxPerMinute: 8 }, buffer, now: () => t });
  buffer.reset({ sessionId: 's1', at: t, running: true });
  injector.start({ sessionId: 's1' });
  injector.stop('explicit');
  assert.match(injector.text(), /RTA 屏幕感知 · 已停止/);

  const off = createInjector({ config: { enabled: false }, buffer, now: () => t });
  off.start();
  assert.equal(off.text(), '');
  assert.equal(off.flush({ force: true }), false);
});

test('image governor: 间隔/窗口预算/在飞数', () => {
  let t = 0;
  const g = createImageGovernor({ config: { minIntervalMs: 60_000, windowMs: 600_000, maxPerWindow: 2, maxInFlight: 1 }, now: () => t });
  const first = g.tryAcquire();
  assert.ok(first);
  assert.equal(g.tryAcquire(), null, '在飞名额只有 1');
  g.commit(first);
  assert.equal(g.tryAcquire(), null, '间隔未到');
  t += 61_000;
  const second = g.tryAcquire();
  assert.ok(second);
  g.commit(second);
  t += 61_000;
  assert.equal(g.tryAcquire(), null, '窗口预算用完');
  t += 600_000;
  assert.ok(g.tryAcquire(), '预算窗口滑走后恢复');
});

// ───────────────────────────────────────────────────── messages / channel

test('messages: 注入消息形状合法（source.kind / sections / 图在前文在后）', () => {
  const msg = buildScreenMessage({ text: 'hello', images: [{ id: 'a1' }], summary: 'x' });
  assert.equal(msg.role, 'user');
  assert.ok(msg.id);
  assert.equal(msg.source.kind, 'plugin:dsh-rta');
  assert.equal(msg.source.form, 'snapshot');
  assert.ok(Array.isArray(msg.source.sections) && msg.source.sections.length > 0);
  assert.ok(msg.source.sections.every((s) => typeof s.name === 'string' && typeof s.text === 'string'));
  assert.deepEqual(msg.content.map((part) => part.type), ['image', 'text']);
  // JSON 可序列化
  assert.ok(JSON.parse(JSON.stringify(msg)));

  const caption = buildImageCaption({ frames: [{ label: 'T12', wall: Date.now() }], foreground: { title: 'A', process: 'a.exe' } });
  assert.match(caption, /RTA 自动截图/);
  assert.match(caption, /T12/);
});

test('channel: 注册 systemPrompt.context（interpolate=false），文本按绑定过滤', () => {
  const { ctx, contexts, handlers } = fakeCtx();
  let text = '屏幕摘要';
  const channel = createScreenChannel({
    ctx,
    text: (context) => (context?.agent?.session?.id === 'sess-1' ? text : ''),
  });
  // 没有 images 回调 → 只开文字通道（pre-step 不必注册）
  assert.equal(channel.mode, 'context');
  assert.equal(handlers.get('agent/pre-step')?.length ?? 0, 0);
  assert.equal(contexts.length, 1);
  const spec = contexts[0];
  assert.equal(spec.name, 'rta:screen');
  assert.equal(spec.interpolate, false);
  assert.equal(spec.text({ agent: AGENT }), '屏幕摘要');
  assert.equal(spec.text({ agent: OTHER_AGENT }), '');
  assert.equal(spec.text({}), '');
  channel.dispose();
});

test('channel: pre-step 处理器 await next() 一次并追加消息；reject 原样返回', async () => {
  const { ctx, handlers } = fakeCtx();
  const channel = createScreenChannel({
    ctx,
    text: () => 'x',
    images: (payload) => (payload?.step === 1 ? { pick: 'img' } : null),
  });
  const handler = handlers.get('agent/pre-step')?.[0];
  assert.ok(typeof handler === 'function');

  let nextCalls = 0;
  const decision = await handler(
    { step: 1, signal: { aborted: false } },
    async () => { nextCalls += 1; return { kind: 'enter', messages: ['base'] }; },
  );
  assert.equal(nextCalls, 1);
  assert.deepEqual(decision.messages, ['base', { pick: 'img' }]);

  const rejected = await handler(
    { step: 1, signal: { aborted: false } },
    async () => ({ kind: 'reject', reason: 'nope' }),
  );
  assert.equal(rejected.kind, 'reject');
  channel.dispose();
});

// ───────────────────────────────────────────────────── lifecycle（假引擎/假 ctx）

function fakeRt({ engine, ctx, inject } = {}) {
  let boundAgent = AGENT;
  const engineHooks = [];
  const rt = {
    ctx,
    config: {
      inject: {
        ...DEFAULT_RTA_CONFIG.inject,
        minIntervalMs: 0,
        ...(inject ?? {}),
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    get engine() { return engine; },
    boundSessionId: () => boundAgent?.session?.id ?? null,
    onEngine(fn) { engineHooks.push(fn); fn(engine); return () => {}; },
    onBind(fn) { rt._bind = fn; return () => {}; },
    _setBound(agent) { boundAgent = agent; },
  };
  return rt;
}

test('lifecycle: 引擎事件 → 文本通道；图片通道每轮首步一张且只给绑定会话', async () => {
  const { ctx, contexts, handlers } = fakeCtx();
  const { engine } = busEngine();
  const rt = fakeRt({ engine, ctx });
  const live = createLiveLifecycle({ rt });
  live.attach();
  try {
    engine.emit('start', { session: { id: 'rta-session-1' } });
    const textSpec = contexts[0];
    const boundText = textSpec.text({ agent: AGENT });
    assert.match(boundText, /〔RTA 屏幕感知/);

    // 事件进来 → 文本变化（minInterval=0 便于测试）
    engine.emit('push', { kind: 'cut', seq: 7, at: Date.now(), score: 50, win: { title: 'VS Code', process: 'Code.exe' } });
    // 图片通道：同一轮首步，交给 pre-step 处理器
    const preStep = handlers.get('agent/pre-step')[0];
    const decision = await preStep(
      { agent: AGENT, step: 1, signal: { aborted: false } },
      async () => ({ kind: 'enter', messages: [] }),
    );
    assert.equal(decision.messages.length, 1);
    const injected = decision.messages[0];
    assert.equal(injected.source.kind, 'plugin:dsh-rta');
    assert.deepEqual(injected.content.map((p) => p.type), ['image', 'text']);
    assert.match(injected.content[1].text, /RTA 自动截图/);

    // 未绑定会话 / 子代理：不注入
    const other = await preStep({ agent: OTHER_AGENT, step: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(other.messages.length, 0);
    const sub = await preStep({ agent: SUBAGENT, step: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(sub.messages.length, 0);

    // step>1 不抓图
    const later = await preStep({ agent: AGENT, step: 2, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(later.messages.length, 0);

    const status = live.status();
    assert.equal(status.channel, 'context+pre-step');
    assert.ok(status.text.publishes >= 1);
    assert.equal(status.image.injected, 1);
  } finally {
    live.dispose();
  }
});

test('lifecycle: 未绑定会话时文本通道返回空（不打扰其它会话）', () => {
  const { ctx, contexts } = fakeCtx();
  const { engine } = busEngine();
  const rt = fakeRt({ engine, ctx });
  const live = createLiveLifecycle({ rt });
  live.attach();
  try {
    engine.emit('start', { session: { id: 'rta-session-1' } });
    rt._setBound(null);
    assert.equal(contexts[0].text({ agent: AGENT }), '');
  } finally {
    live.dispose();
  }
});

test('lifecycle: 停止后文本声明已停止（仍只在绑定会话可见）', () => {
  const { ctx, contexts } = fakeCtx();
  const { engine } = busEngine();
  const rt = fakeRt({ engine, ctx });
  const live = createLiveLifecycle({ rt });
  live.attach();
  try {
    engine.emit('start', { session: { id: 'rta-session-1' } });
    engine.emit('stop', { reason: 'explicit' });
    assert.match(contexts[0].text({ agent: AGENT }), /已停止/);
  } finally {
    live.dispose();
  }
});

// ───────────────────────────────────────────────────── config

test('config: inject 默认值与文件覆盖（含 image.enabled）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rta-cfg-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      inject: { enabled: false, minIntervalMs: 1234, image: { enabled: false, maxFrames: 2 } },
    }), 'utf8');
    const cfg = readRtaConfig({ DSH_RTA_HOME: dir });
    assert.equal(cfg.inject.enabled, false);
    assert.equal(cfg.inject.minIntervalMs, 1234);
    assert.equal(cfg.inject.image.enabled, false);
    assert.equal(cfg.inject.image.maxFrames, 2);
    assert.equal(cfg.inject.maxPerMinute, DEFAULT_RTA_CONFIG.inject.maxPerMinute);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
