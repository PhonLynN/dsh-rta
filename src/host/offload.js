/**
 * host/offload.js — 把会话历史里较早的图「省略」掉，让它们不再被发出去。
 *
 * 改编自 dsh-video-storyboard 的 src/storyboard/offload.js（Apache-2.0，见 NOTICE），
 * 与 dsh-see-now 的同名机制保持一致。宿主原生支持 `image/offload`：
 * 往会话日志追加一条事件，声明「这几张图以后换成占位文本」，
 * 之后投影会把它们替换成一段占位文本 —— 图不再进请求，也能安全删文件。
 *
 * RTA 的参数和 storyboard 不同：RTA 的图集中在会话尾部，
 * 用 keep=3 / trigger=8（一次省到只剩 3 张，攒够 8 张才动一次），
 * 避免「每出一张图就改一次历史」导致前缀缓存全量失效。
 */

let afterDelivery = null;

/** 挂上「刚交付了图」的钩子（插件加载时调一次）。 */
export function setDeliveryHook(fn) {
  afterDelivery = typeof fn === 'function' ? fn : null;
}

/** 交付完图之后调一下；任何异常都不能影响交付。 */
export function notifyDelivery() {
  try { afterDelivery?.(); } catch { /* 省略绝不能影响这一轮的结果 */ }
}

/** 能承载图片的 surface 事件类型（宿主 `image/offload` 校验只认这两种）。 */
const IMAGE_CARRYING = new Set(['user/message', 'tool/result']);

/** 把一条消息里的图按 depth-first 顺序摊平（宿主就是这么编号的）。 */
function imagesIn(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  const visit = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'image') {
        const b = block?.attachment?.bytes;
        out.push({ index: out.length, bytes: Number.isFinite(b) && b > 0 ? b : 0 });
      } else if (Array.isArray(block.content)) {
        visit(block.content);
      }
    }
  };
  visit(content);
  return out;
}

/** 重放 surface：append 追加；replace 先遮蔽区间再追加（与宿主 attachments-gc 同一套规则）。 */
function replaySurface(events) {
  const nodes = [];
  for (const e of events) {
    const op = e?.surfaceOp;
    if (op === undefined) continue;
    if (op === 'append') {
      nodes.push({ seq: e.seq, event: e });
      continue;
    }
    if (op && op.op === 'replace') {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].seq >= op.startSeq && nodes[i].seq <= op.endSeq) nodes.splice(i, 1);
      }
      nodes.push({ seq: e.seq, event: e });
    }
  }
  return nodes;
}

/** 已经被省略过的 (seq, index)，避免重复标记 —— 宿主会拒绝重复 target。 */
function alreadyOffloaded(events) {
  const done = new Set();
  for (const e of events) {
    if (e?.type !== 'image/offload') continue;
    const targets = e?.data?.targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (!t || !Array.isArray(t.imageIndexes)) continue;
      for (const i of t.imageIndexes) done.add(`${t.seq}:${i}`);
    }
  }
  return done;
}

/** 保留最新 keep 张，更早的全部标记（keep 是「省完之后停在哪」）。 */
export function planOffload(events, limits = {}) {
  const keep = Math.max(0, Math.floor(Number(limits?.keep) || 0));

  const done = alreadyOffloaded(events);
  const nodes = replaySurface(events);

  const occurrences = [];
  let totalBytes = 0;
  for (const node of nodes) {
    if (!IMAGE_CARRYING.has(node.event?.type)) continue;
    const content = node.event?.data?.message?.content ?? node.event?.data?.content;
    for (const img of imagesIn(content)) {
      if (done.has(`${node.seq}:${img.index}`)) continue;
      occurrences.push({ seq: node.seq, index: img.index, bytes: img.bytes });
      totalBytes += img.bytes;
    }
  }

  const total = occurrences.length;
  const cut = Math.max(0, total - keep);
  const picked = occurrences.slice(0, cut);
  const kept = occurrences.slice(cut);
  const offloadingBytes = picked.reduce((a, o) => a + o.bytes, 0);
  const keptBytes = kept.reduce((a, o) => a + o.bytes, 0);

  // 按 seq 分组（宿主要求同一 seq 的 index 严格递增、且每个 seq 只出现一次）
  const bySeq = new Map();
  for (const { seq, index } of picked) {
    if (!bySeq.has(seq)) bySeq.set(seq, []);
    bySeq.get(seq).push(index);
  }
  const targets = [...bySeq.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seq, imageIndexes]) => ({ seq, imageIndexes: imageIndexes.sort((a, b) => a - b) }));

  return { targets, total, offloading: picked.length, kept: kept.length, keptBytes, offloadingBytes, totalBytes };
}

/** 涨到 trigger 张才动手，一次省到只剩 keep 张。 */
export function planOffloadWithTrigger(events, limits = {}) {
  const trigger = Math.max(0, Math.floor(Number(limits?.trigger) || 0));
  const keep = Math.max(0, Math.floor(Number(limits?.keep) || 0));

  const plan = planOffload(events, { keep });
  const triggered = trigger > 0 && trigger > keep && plan.total >= trigger && plan.offloading > 0;
  return { triggered, plan };
}

/**
 * 把计划写进会话，并确认落盘。算完立刻写，中间别 await 别的事情 ——
 * 否则 surface 变了会被宿主拒绝。
 */
export async function applyOffload(session, targets, sessions = null) {
  if (!session?.append) return { ok: false, reason: 'no-session' };
  if (!Array.isArray(targets) || targets.length === 0) return { ok: true, reason: 'nothing-to-do' };
  try {
    session.append('image/offload', { targets });
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 200) };
  }
  try {
    if (sessions?.flush) await sessions.flush(session);
  } catch {
    /* flush 失败不算失败：事件已经 append 进内存，下一次成功 flush 会带上 */
  }
  return { ok: true };
}
