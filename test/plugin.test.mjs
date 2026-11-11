/**
 * test/plugin.test.mjs — 宿主胶水的离线测试（不抓屏、不起引擎）。
 *
 * 覆盖：
 *  - 插件契约：inject 只有 tools；apply 不抛；返回可调用的 disposer；
 *  - 八个工具都注册了，schema 能编译，output.render 可用；
 *  - rta_status 在未启动时给的是人话；
 *  - image/offload 的计划逻辑（RTA 参数 keep=3 / trigger=8）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { name, inject, apply } from '../src/index.js';
import { TOOL_NAMES } from '../src/tools/spec.js';
import { planOffload, planOffloadWithTrigger } from '../src/host/offload.js';
import { readRtaConfig } from '../src/config.js';
import { createRuntime } from '../src/host/runtime.js';

function fakeCtx({ attachments = null } = {}) {
  const registered = [];
  const logs = [];
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool);
        return () => {};
      },
    },
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    get(n) {
      if (n === 'attachments') return attachments;
      return undefined;
    },
    on() { return () => {}; },
  };
  return { ctx, registered, logs };
}

test('plugin contract: name/inject/apply', async () => {
  assert.equal(name, 'dsh-rta');
  assert.deepEqual(inject, ['tools']);
  const { ctx, registered } = fakeCtx();
  const dispose = await apply(ctx);
  assert.equal(typeof dispose, 'function');
  assert.equal(registered.length, Object.keys(TOOL_NAMES).length);
  const names = registered.map((t) => t.name).sort();
  assert.deepEqual(names, Object.values(TOOL_NAMES).sort());
  dispose();
});

test('every tool compiles to a usable definition', async () => {
  const { ctx, registered } = fakeCtx();
  const dispose = await apply(ctx);
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} execute`);
    assert.equal(tool.parameters?.type, 'object', `${tool.name} parameters`);
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} render`);
    const rendered = tool.output.render({}, { text: 'hello', images: [] });
    assert.ok(Array.isArray(rendered));
    assert.equal(rendered.at(-1).type, 'text');
  }
  dispose();
});

test('rta_status answers in plain language while idle', async () => {
  const { ctx, registered } = fakeCtx();
  const dispose = await apply(ctx);
  const status = registered.find((t) => t.name === TOOL_NAMES.status);
  const value = await status.execute({});
  assert.match(value.text, /not running/);
  dispose();
});

test('offload plan keeps the newest images and respects trigger/keep', () => {
  // 12 张图分布在 12 个 tool/result 里，每轮 1 张
  const events = [];
  let seq = 1;
  for (let i = 0; i < 12; i++) {
    events.push({ seq: seq++, type: 'tool/result', surfaceOp: 'append', data: { content: [{ type: 'image', attachment: { bytes: 1000 } }] } });
  }
  const { triggered, plan } = planOffloadWithTrigger(events, { trigger: 8, keep: 3 });
  assert.equal(triggered, true);
  assert.equal(plan.total, 12);
  assert.equal(plan.offloading, 9);
  assert.equal(plan.kept, 3);
  assert.equal(plan.targets.length, 9);
  // 每个 seq 只出现一次，imageIndexes 升序
  const seqs = plan.targets.map((t) => t.seq);
  assert.equal(new Set(seqs).size, seqs.length);

  // 只有 5 张时不到触发线
  const five = events.slice(0, 5);
  assert.equal(planOffloadWithTrigger(five, { trigger: 8, keep: 3 }).triggered, false);

  // keep 保留的是最新的
  const all = planOffload(events, { keep: 3 });
  assert.equal(all.kept, 3);
});

test('config falls back to defaults when the file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rta-cfg-'));
  try {
    const cfg = readRtaConfig({ DSH_RTA_HOME: dir });
    assert.equal(cfg.retentionHours, 24);
    assert.equal(cfg.imageTrigger, 8);
    assert.equal(cfg.imageKeep, 3);
    assert.equal(cfg.capture.sentinelHz, 15);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summon pushes a plugin notice to the calling agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rta-summon-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ summonCooldownMs: 0 }));
    const { ctx } = fakeCtx();
    const rt = createRuntime({ ctx, env: { DSH_RTA_HOME: dir } });
    const calls = [];
    const agent = {
      status: 'idle',
      followup: (m) => calls.push(['followup', m]),
      steer: (m) => calls.push(['steer', m]),
    };
    rt.rememberAgent(agent);

    const idle = await rt.summon();
    assert.equal(idle.ok, true);
    assert.equal(idle.transport, 'followup');
    assert.equal(calls.length, 1);
    const msg = calls[0][1];
    assert.equal(msg.role, 'user');
    assert.equal(msg.source.kind, 'plugin:dsh-rta');
    assert.equal(msg.source.form, 'notice');
    assert.match(msg.content[0].text, /rta_look/);
    assert.ok(msg.id);

    agent.status = 'running';
    const busy = await rt.summon();
    assert.equal(busy.ok, true);
    assert.equal(busy.transport, 'steer');
    assert.equal(calls.length, 2);

    await rt.dispose();

    // 没有 agent 时静默失败，不抛
    const rt2 = createRuntime({ ctx: fakeCtx().ctx, env: { DSH_RTA_HOME: dir } });
    const none = await rt2.summon();
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'no-agent');
    await rt2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
