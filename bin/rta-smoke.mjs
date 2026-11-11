/**
 * bin/rta-smoke.mjs — 真机冒烟（会抓屏，跑几秒）。
 *
 * 用假 attachments 服务接住工具提交的 PNG，验证：
 *   起引擎 → 真抓屏 → 真拼图 → 真编码 → rta_look 文本 → rta_recall 文本 → 停止。
 * 产物：_probe/look.png（可直接看拼图是否正确）。
 *
 *   node bin/rta-smoke.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRuntime } from '../src/host/runtime.js';
import * as handlers from '../src/tools/handlers.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', '_probe', 'look.png');
mkdirSync(dirname(outPath), { recursive: true });

const logger = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.warn(`[warn] ${m}`),
  error: (m) => console.error(`[error] ${m}`),
};

let saved = null;
const attachments = {
  async saveImage({ data, mediaType, name }) {
    saved = { bytes: data.length ?? data.byteLength ?? 0, mediaType, name };
    writeFileSync(outPath, Buffer.from(data));
    return { type: 'image', attachment: { name, mediaType, bytes: saved.bytes } };
  },
};

const ctx = {
  logger,
  get: (n) => (n === 'attachments' ? attachments : undefined),
};

const rt = createRuntime({ ctx });
const t0 = Date.now();

try {
  rt.start();
  await new Promise((r) => setTimeout(r, 2600));

  const status = await handlers.status(ctx, rt);
  console.log('--- status ---');
  console.log(status.text);

  const look = await handlers.look(ctx, rt, { count: 2, maxTokens: 560 });
  console.log('--- rta_look ---');
  console.log(look.text);
  console.log('images:', look.images?.length ?? 0, 'png:', saved);

  const recall = await handlers.recall(ctx, rt, { limit: 6, types: 'frame,event' });
  console.log('--- rta_recall ---');
  console.log(recall.text.slice(0, 1200));

  const listed = await handlers.sessions(ctx, rt, { limit: 3 });
  console.log('--- rta_sessions ---');
  console.log(listed.text);
} finally {
  rt.stop({ reason: 'smoke' });
  rt.dispose();
  console.log(`--- done in ${Date.now() - t0} ms; session ${rt.engine?.sessionId ?? 'n/a'} ---`);
}
