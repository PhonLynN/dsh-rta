import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummaryPrompt, createSummarizer } from '../src/host/summarizer.js';

const DELIVER_PROMPT = Symbol.for('dsh.subagent.deliverPrompt');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeLogger() {
  const logs = [];
  return {
    logs,
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]),
  };
}

/**
 * 假宿主：一个常驻 subagents 服务 + 一个真实 notes 目录。
 * 每次 startActivation / deliverPrompt 之后，用一个假子代理把摘要写进
 * screen-log.md（mtime 单调递增），这样 awaiting 能在 watchMs 内清掉。
 */
function makeHarness({
  digest = '前台：DeepSeek Harness',
  subagents = true,
  config = {},
  notesDir = null,
  autoNote = true,
  onStartActivation = null,
} = {}) {
  const starts = [];
  const delivers = [];
  const interrupts = [];
  const drains = [];
  const dir = notesDir ?? mkdtempSync(join(tmpdir(), 'rta-sum-'));
  const noteFile = join(dir, 'screen-log.md');
  let noteCounter = 0;
  let digestText = digest;

  const writeNote = () => {
    if (!autoNote) return;
    noteCounter += 1;
    setTimeout(() => {
      try {
        writeFileSync(noteFile, `摘要 ${noteCounter}：前台 ${digestText}`, 'utf8');
        const t = new Date(1_000 + noteCounter * 1_000);
        utimesSync(noteFile, t, t);
      } catch { /* ignore */ }
    }, 2);
  };

  const agent = { session: { id: 'bound-session' }, header: { parentSession: undefined } };
  const settlements = [];
  const manager = {
    notifySettlement: (activation, terminal) => { settlements.push({ activation, terminal }); },
  };
  const fakeSub = {
    manager,
    list: () => ['spawn', 'fork'],
    startActivation: async (spec) => {
      starts.push(spec);
      if (onStartActivation) onStartActivation(spec);
      writeNote();
      // 常驻 activation 的 result 只在被 drain 时 settle —— 用永不 settle 的 promise 模拟。
      return { childId: spec.childId, result: new Promise(() => {}) };
    },
    interrupt: (id, authority) => interrupts.push({ id, authority }),
    drainChildren: async (parent, childIds) => { drains.push({ parent, childIds }); },
    [DELIVER_PROMPT]: async (parent, childId, content, source, signal, delivery) => {
      delivers.push({ parent, childId, content, source, signal, delivery });
      writeNote();
    },
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
    store: { paths: { notes: dir } },
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
    config: {
      enabled: true,
      intervalMs: 1_000,
      maxPer10Min: 18,
      eventEnabled: true,
      eventMinGapMs: 0,
      eventDebounceMs: 5,
      eventMinScore: 18,
      demandWaitMs: 3_000,
      watchMs: 5,
      pollMs: 10,
      ...config,
    },
    digest: () => digestText,
    now: () => clock,
  });
  return {
    summarizer,
    starts,
    delivers,
    interrupts,
    drains,
    settlements,
    manager,
    fakeSub,
    agent,
    dir,
    logger,
    advance: (ms) => { clock += ms; },
    clockNow: () => clock,
    setDigest: (text) => { digestText = text; },
    setEngineState: (state) => { engine.state = state; },
    dispose: () => {
      try { summarizer.dispose(); } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** 等 tickOnce 之后异步写出的假摘要被 watcher 看见，awaiting 清空。 */
const settle = async (h) => {
  for (let i = 0; i < 100 && h.summarizer.status().awaiting; i += 1) await sleep(10);
  await sleep(10);
};

test('summarizer: prompt 要求写 rta_note 并带上摘要与触发提示', () => {
  const prompt = buildSummaryPrompt({ digest: '前台：Chrome\n- 12:00:00 明显变化', prior: '上一版摘要', at: 1_700_000_000_000 });
  assert.match(prompt, /rta_note/);
  assert.match(prompt, /screen-log/);
  assert.match(prompt, /前台：Chrome/);
  assert.match(prompt, /上一版摘要/);
  assert.match(prompt, /后台子代理/);

  assert.match(buildSummaryPrompt({ trigger: 'event', at: 1 }), /密集屏幕变化/);
  assert.match(buildSummaryPrompt({ trigger: 'demand', at: 1 }), /主动要求最新摘要/);
  assert.match(buildSummaryPrompt({ trigger: 'start', at: 1 }), /采集刚启动/);
});

test('summarizer: 首次触发创建一个 continuable child（delivery caller + 预留 childId）', async () => {
  const h = makeHarness();
  try {
    assert.equal(await h.summarizer.tickOnce({ reason: 'start', force: true }), true);
    assert.equal(h.starts.length, 1);
    const spec = h.starts[0];
    assert.equal(spec.provider, 'spawn');
    assert.equal(spec.delivery, 'caller');
    assert.equal(spec.request.parent, h.agent);
    assert.ok(spec.childId, '必须预留 childId 才能后续复用同一个子代理');
    assert.ok(Array.isArray(spec.request.prompt));
    assert.equal(spec.request.prompt[0].type, 'text');
    assert.match(spec.request.prompt[0].text, /前台：DeepSeek Harness/);
    assert.match(spec.request.prompt[0].text, /采集刚启动/);
    assert.ok(spec.signal, 'startActivation 必须带 AbortSignal（宿主会 throwIfAborted）');
    assert.match(spec.label, /rta-screen-summary/);

    const st = h.summarizer.status();
    assert.equal(st.starts, 1);
    assert.equal(st.prompts, 1);
    assert.equal(st.childAlive, true);
  } finally {
    h.dispose();
  }
});

test('summarizer: 之后投递同一 child（symbol 通道），不再新建子代理', async () => {
  const h = makeHarness();
  try {
    assert.equal(await h.summarizer.tickOnce({ reason: 'start', force: true }), true);
    await settle(h);

    h.setDigest('前台：窗口 1');
    h.advance(1_500);
    assert.equal(await h.summarizer.tickOnce(), true);

    assert.equal(h.starts.length, 1, '整个会话只应该有一个摘要子代理');
    assert.equal(h.delivers.length, 1);
    const d = h.delivers[0];
    assert.equal(d.childId, h.starts[0].childId);
    assert.equal(d.delivery, 'queue');
    assert.equal(d.source.kind, 'user');
    assert.ok(Array.isArray(d.content));
    assert.equal(d.content[0].type, 'text');
    assert.match(d.content[0].text, /窗口 1/);
    assert.equal(h.summarizer.status().prompts, 2);
  } finally {
    h.dispose();
  }
});

test('summarizer: 间隔内、digest 不变时都不投递', async () => {
  const h = makeHarness({ config: { intervalMs: 5_000 } });
  try {
    assert.equal(await h.summarizer.tickOnce({ reason: 'start', force: true }), true);
    await settle(h);
    h.advance(1_000);
    assert.equal(await h.summarizer.tickOnce(), false);
    assert.equal(h.summarizer.status().lastSkip, 'interval');
    h.advance(5_000);
    assert.equal(await h.summarizer.tickOnce(), false);
    assert.equal(h.summarizer.status().lastSkip, 'same-digest');
    assert.equal(h.delivers.length, 0);
  } finally {
    h.dispose();
  }
});

test('summarizer: 10 分钟预算封顶（maxPer10Min）仍然复用同一个 child', async () => {
  const h = makeHarness({ config: { intervalMs: 0, maxPer10Min: 3 } });
  try {
    for (let i = 0; i < 6; i += 1) {
      h.setDigest(`前台：窗口 ${i}`);
      h.advance(1_000);
      await h.summarizer.tickOnce({ reason: 'start', force: true });
      await settle(h);
    }
    assert.equal(h.starts.length, 1);
    assert.equal(h.summarizer.status().prompts, 3);
    assert.equal(h.summarizer.status().lastSkip, 'rate-limited');
  } finally {
    h.dispose();
  }
});

test('summarizer: 密集事件（cut 或高分）触发一次摘要，heartbeat 不触发', async () => {
  const h = makeHarness();
  try {
    assert.equal(await h.summarizer.tickOnce({ reason: 'start', force: true }), true);
    await settle(h);
    h.setDigest('前台：Chrome — 用户在看视频');
    assert.equal(h.summarizer.onScreenEvent({ kind: 'cut', score: 40 }, h.clockNow()), true);
    await sleep(80);
    assert.equal(h.summarizer.status().prompts, 2);

    assert.equal(h.summarizer.onScreenEvent({ kind: 'heartbeat', score: 0 }, h.clockNow()), false);
    const before = h.summarizer.status().prompts;
    await sleep(40);
    assert.equal(h.summarizer.status().prompts, before);
  } finally {
    h.dispose();
  }
});

test('summarizer: 事件触发受 eventMinGapMs 节流', async () => {
  const h = makeHarness({ config: { eventMinGapMs: 10_000 } });
  try {
    assert.equal(await h.summarizer.tickOnce({ reason: 'start', force: true }), true);
    await settle(h);
    const before = h.summarizer.status().prompts;
    h.summarizer.onScreenEvent({ kind: 'cut', score: 40 }, h.clockNow());
    await sleep(80);
    assert.equal(h.summarizer.status().prompts, before);
    assert.equal(h.summarizer.status().lastSkip, 'burst-gap');
  } finally {
    h.dispose();
  }
});

test('summarizer: requestNow 等到子代理写出新摘要后返回', async () => {
  const h = makeHarness();
  try {
    const result = await h.summarizer.requestNow({ reason: 'demand', waitMs: 3_000 });
    assert.equal(result.ok, true);
    assert.match(result.summary, /摘要/);
    assert.equal(result.trigger, 'demand');
    assert.equal(h.starts.length, 1);
  } finally {
    h.dispose();
  }
});

test('summarizer: rta_stop / dispose 会 interrupt + drainChildren 清除常驻子代理', async () => {
  const h = makeHarness();
  try {
    await h.summarizer.tickOnce({ reason: 'start', force: true });
    await settle(h);
    const childId = h.starts[0].childId;
    await h.summarizer.stop('explicit');
    assert.equal(h.interrupts.length, 1);
    assert.equal(h.interrupts[0].id, childId);
    assert.deepEqual(h.interrupts[0].authority, { kind: 'ancestor', agent: h.agent });
    assert.equal(h.drains.length, 1);
    assert.deepEqual(h.drains[0].childIds, [childId]);
    const st = h.summarizer.status();
    assert.equal(st.child, null);
    assert.equal(st.childAlive, false);

    // 清理后（下一轮 rta_start）再触发会重建一个新 child。
    h.setDigest('前台：新会话');
    h.advance(5_000);
    assert.equal(await h.summarizer.tickOnce({ reason: 'start', force: true }), true);
    assert.equal(h.starts.length, 2);
  } finally {
    h.dispose();
  }
});

test('summarizer: 结算通知过滤器只吞本 child 的 notifySettlement，stop 后还原宿主方法', async () => {
  const h = makeHarness();
  const original = h.manager.notifySettlement;
  try {
    assert.equal(h.manager.notifySettlement, original);
    await h.summarizer.tickOnce({ reason: 'start', force: true });
    await settle(h);
    const childId = h.starts[0].childId;
    assert.equal(h.summarizer.status().settlementGuarded, true);
    assert.notEqual(h.manager.notifySettlement, original, '应该在 manager 上装过滤器');

    // 我们的 child：结算被吞掉（既不通知也不唤醒父会话）。
    h.manager.notifySettlement({ childId, announced: true }, 'done');
    assert.equal(h.settlements.length, 0);
    // 别的子代理：原样透传。
    h.manager.notifySettlement({ childId: 'other-child', announced: true }, 'done');
    assert.equal(h.settlements.length, 1);
    assert.equal(h.settlements[0].activation.childId, 'other-child');

    await h.summarizer.stop('explicit');
    assert.equal(h.manager.notifySettlement, original, 'stop 后必须还原宿主方法');
    // 还原后我们的 child 结算也能正常透传（避免 stop 后残留 patch）。
    h.manager.notifySettlement({ childId, announced: true }, 'done');
    assert.equal(h.settlements.length, 2);
  } finally {
    h.dispose();
  }
});

test('summarizer: 没有 subagents 服务时记录错误但不抛', async () => {
  const h = makeHarness({ subagents: false });
  try {
    assert.equal(await h.summarizer.tickOnce(), false);
    assert.equal(h.summarizer.status().errors, 1);
    assert.match(h.summarizer.status().lastError, /no-subagents-service/);
  } finally {
    h.dispose();
  }
});

test('summarizer: 引擎未运行 / 未绑定会话时跳过', async () => {
  const idle = makeHarness();
  try {
    idle.setEngineState('idle');
    assert.equal(await idle.summarizer.tickOnce(), false);
    assert.equal(idle.summarizer.status().lastSkip, 'engine-idle');
  } finally {
    idle.dispose();
  }

  const s2 = createSummarizer({
    rt: {
      ctx: { get: () => undefined },
      engine: { state: 'running', store: null },
      bound: null,
      boundSessionId: () => null,
      logger: makeLogger(),
    },
    config: { enabled: true },
    digest: () => 'x',
    now: () => 1,
  });
  assert.equal(await s2.tickOnce(), false);
  assert.equal(s2.status().lastSkip, 'no-binding');
  s2.dispose();
});

test('summarizer: 启动失败会计入 errors 并丢弃 child，下次重建', async () => {
  const logger = makeLogger();
  const failingSub = { list: () => ['spawn'], startActivation: async () => { throw new Error('boom'); } };
  const s = createSummarizer({
    rt: {
      ctx: { get: (n) => (n === 'subagents' ? failingSub : undefined) },
      engine: { state: 'running', sessionId: 's', store: null },
      bound: { agent: { session: { id: 'bound-session' } } },
      boundSessionId: () => 'bound-session',
      logger,
    },
    logger,
    config: { enabled: true, intervalMs: 0 },
    digest: () => '前台：X',
    now: () => 1_000,
  });
  assert.equal(await s.tickOnce(), false);
  assert.equal(s.status().errors, 1);
  assert.equal(s.status().child, null);
  s.dispose();
});

test('summarizer: latestSummary 读 notes/ 下最新的 md 且 clip 到 700 字符', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rta-sum-'));
  try {
    const oldFile = join(dir, 'old.md');
    const newFile = join(dir, 'new.md');
    writeFileSync(oldFile, '旧摘要', 'utf8');
    writeFileSync(newFile, `新摘要：${'很长'.repeat(600)}`, 'utf8');
    utimesSync(oldFile, new Date(1_000), new Date(1_000));
    utimesSync(newFile, new Date(5_000), new Date(5_000));

    const h = makeHarness({ notesDir: dir, autoNote: false });
    try {
      const text = await h.summarizer.latestSummary();
      assert.match(text, /新摘要/);
      assert.ok(text.length <= 701);
      assert.equal(h.summarizer.summaryText(), text);
    } finally {
      h.summarizer.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarizer: dispose 幂等，attach 重复调用不抛', async () => {
  const h = makeHarness();
  try {
    assert.doesNotThrow(() => { h.summarizer.attach(); h.summarizer.attach(); h.summarizer.dispose(); h.summarizer.dispose(); });
    await sleep(20);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
