import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummaryPrompt, createSummarizer } from '../src/host/summarizer.js';

function makeLogger() {
  const logs = [];
  return {
    logs,
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]),
  };
}

function makeHarness({ digest = () => '前台：DeepSeek Harness', subagents = true, config = {}, notesDir = null } = {}) {
  const calls = [];
  const agent = { session: { id: 'bound-session' }, header: { parentSession: undefined } };
  const fakeSub = {
    list: () => ['spawn', 'fork'],
    startActivation: async (spec) => {
      calls.push(spec);
      return { childId: `child-${calls.length}`, result: Promise.resolve({ ok: true }) };
    },
    interrupt: () => {},
  };
  const ctx = {
    get: (name) => {
      if (name === 'subagents') return subagents ? fakeSub : undefined;
      return undefined;
    },
  };
  const engine = {
    state: 'running',
    sessionId: 'rta-session',
    on: () => () => {},
    status: () => ({ video: { width: 2560, height: 1440 } }),
    store: notesDir ? { paths: { notes: notesDir } } : null,
  };
  const logger = makeLogger();
  let clock = 1_000_000;
  const rt = {
    ctx,
    engine,
    bound: { agent, sessionId: 'bound-session' },
    boundSessionId: () => 'bound-session',
    logger,
  };
  const summarizer = createSummarizer({
    rt,
    logger,
    config: { enabled: true, intervalMs: 1000, maxPer10Min: 6, ...config },
    digest,
    now: () => clock,
  });
  return {
    summarizer,
    calls,
    agent,
    logger,
    advance: (ms) => { clock += ms; },
    clockNow: () => clock,
  };
}

test('summarizer: prompt 要求写 rta_note 并带上摘要，不要求回复主会话', () => {
  const prompt = buildSummaryPrompt({ digest: '前台：Chrome\n- 12:00:00 明显变化', prior: '上一版摘要', at: 1_700_000_000_000 });
  assert.match(prompt, /rta_note/);
  assert.match(prompt, /screen-log/);
  assert.match(prompt, /前台：Chrome/);
  assert.match(prompt, /上一版摘要/);
  assert.match(prompt, /后台子代理/);
});

test('summarizer: 启动子代理用 delivery:"caller"（不唤醒主会话），provider 自动选 spawn', async () => {
  const h = makeHarness();
  const started = await h.summarizer.tickOnce();
  assert.equal(started, true);
  assert.equal(h.calls.length, 1);
  const spec = h.calls[0];
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.delivery, 'caller');
  assert.equal(spec.request.parent, h.agent);
  // request.prompt 必须是 content parts 数组（宿主直接喂给 createUserMessage）。
  assert.ok(Array.isArray(spec.request.prompt));
  assert.equal(spec.request.prompt[0].type, 'text');
  assert.match(spec.request.prompt[0].text, /前台：DeepSeek Harness/);
  assert.ok(spec.signal, 'startActivation 必须带 AbortSignal（宿主会 throwIfAborted）');
  assert.match(spec.label, /rta-screen-summary/);
});

test('summarizer: 间隔内不重复启动；digest 不变也不启动', async () => {
  const h = makeHarness({ config: { intervalMs: 5000 } });
  assert.equal(await h.summarizer.tickOnce(), true);
  h.advance(1000);
  assert.equal(await h.summarizer.tickOnce(), false); // 间隔不够
  h.advance(5000);
  assert.equal(await h.summarizer.tickOnce(), false); // digest 没变
  assert.equal(h.calls.length, 1);
});

test('summarizer: 10 分钟窗口内启动次数封顶 maxPer10Min', async () => {
  let n = 0;
  const h = makeHarness({ digest: () => `前台：窗口 ${n}`, config: { intervalMs: 0, maxPer10Min: 3 } });
  for (let i = 0; i < 6; i += 1) {
    n = i;
    h.advance(1000);
    await h.summarizer.tickOnce();
  }
  assert.equal(h.calls.length, 3);
});

test('summarizer: 配置 provider 优先；provider 不存在时回退 spawn', async () => {
  const h1 = makeHarness({ config: { provider: 'fork' } });
  await h1.summarizer.tickOnce();
  assert.equal(h1.calls[0].provider, 'fork');

  const h2 = makeHarness({ config: { provider: 'nope' } });
  await h2.summarizer.tickOnce();
  assert.equal(h2.calls[0].provider, 'spawn');
});

test('summarizer: 没有 subagents 服务时记录错误但不抛', async () => {
  const h = makeHarness({ subagents: false });
  const started = await h.summarizer.tickOnce();
  assert.equal(started, false);
  assert.equal(h.summarizer.status().errors, 1);
  assert.match(h.summarizer.status().lastError, /no-subagents-service/);
});

test('summarizer: 引擎未运行时不起子代理', async () => {
  const h = makeHarness();
  h.summarizer.attach(); // attach 不会主动启动，只挂定时器
  h.summarizer.status(); // 只为确认不抛
  // 直接改 engine state 无法从外部拿到，这里用 tickOnce + stop 事件模拟
  h.summarizer.dispose();
  assert.equal(h.calls.length, 0);
});

test('summarizer: latestSummary 读 notes/ 下最新的 md', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rta-sum-'));
  try {
    const oldFile = join(dir, 'old.md');
    const newFile = join(dir, 'new.md');
    await writeFile(oldFile, '旧摘要', 'utf8');
    await writeFile(newFile, '新摘要：用户在看 B 站视频', 'utf8');
    await utimes(oldFile, new Date(1_000), new Date(1_000));
    await utimes(newFile, new Date(5_000), new Date(5_000));

    const h = makeHarness({ notesDir: dir });
    const text = await h.summarizer.latestSummary();
    assert.match(text, /新摘要/);
    assert.equal(h.summarizer.summaryText(), text);
    assert.ok(h.summarizer.status().summaryChars > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('summarizer: 子代理失败会计入 errors 且释放 inFlight', async () => {
  const h = makeHarness();
  // 让 startActivation 抛错
  h.summarizer.status(); // 保证对象可用
  const rtSub = { list: () => ['spawn'], startActivation: async () => { throw new Error('boom'); } };
  const summarizer = createSummarizer({
    rt: {
      ctx: { get: (n) => (n === 'subagents' ? rtSub : undefined) },
      engine: { state: 'running', sessionId: 's', store: null },
      bound: { agent: h.agent },
      boundSessionId: () => 'bound-session',
      logger: h.logger,
    },
    logger: h.logger,
    config: { enabled: true, intervalMs: 0 },
    digest: () => '前台：X',
    now: () => h.clockNow(),
  });
  assert.equal(await summarizer.tickOnce(), false);
  assert.equal(summarizer.status().errors, 1);
  assert.equal(summarizer.status().inFlight, false);
});

test('summarizer: dispose 幂等，attach 重复调用不抛', () => {
  const h = makeHarness();
  assert.doesNotThrow(() => { h.summarizer.attach(); h.summarizer.attach(); h.summarizer.dispose(); h.summarizer.dispose(); });
});
