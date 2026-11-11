/**
 * host/messages.js — 构造「注入到会话」的消息。
 *
 * 两条通道的来源不同，但消息形状一致：`{id, role:'user', content, source}`。
 * 运行期宿主不校验 shape（docs/review/01），但约定要守住：
 *   - source.kind 非空且 != 'plugin'，第三方用 `plugin:<插件 id>`；
 *   - form:'snapshot' 时 source.sections 必须是非空数组，每项 {name, text}；
 *   - content 必须 JSON 可序列化；图片项 {type:'image', attachment:ref}，
 *     ref 来自 attachments.saveImage()（见 host/service.js attachRgb）。
 *
 * 文本里的「〔RTA … · 非用户消息〕」不是装饰：注入消息 role 是 user，
 * 模型与转录 UI 都容易把它当成用户说的话，标记能降低误判。
 */

import { randomUUID } from 'node:crypto';
import { KIND_LABEL } from './hd.js';

export const SOURCE_KIND = 'plugin:dsh-rta';

/** 拼一条「屏幕状态」注入消息（纯文本；图片通道也会用它带图）。 */
export function buildScreenMessage({ text, images = [], summary = 'RTA 屏幕感知（自动注入）' } = {}) {
  const body = String(text ?? '');
  const content = [];
  for (const attachment of images) {
    if (attachment) content.push({ type: 'image', attachment });
  }
  content.push({ type: 'text', text: body });
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content,
    source: Object.freeze({
      kind: SOURCE_KIND,
      form: 'snapshot',
      sections: Object.freeze([Object.freeze({ name: 'RTA screen', text: body })]),
      summary,
    }),
  });
}

function clock(at) {
  const d = new Date(Number(at) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function clampText(raw, max = 80) {
  const text = String(raw ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 自动截图消息的说明文字：告诉模型「这是什么时刻的画面、怎么看细节」。
 *
 * @param {object} input {frames, foreground, at}
 */
export function buildImageCaption({ frames = [], foreground = null, at = Date.now() } = {}) {
  const lines = ['〔RTA 自动截图 · 插件注入，非用户消息〕'];
  if (foreground?.title) {
    lines.push(`前台：${clampText(foreground.title)}${foreground.process ? ` [${clampText(foreground.process, 40)}]` : ''}`);
  }
  const labels = frames.map((frame) => (frame?.label ? String(frame.label) : null)).filter(Boolean);
  const when = frames.length ? clock(frames[frames.length - 1]?.wall ?? at) : clock(at);
  lines.push(`时间：${when} · ${Math.max(1, frames.length)} 帧拼图${labels.length ? `（${labels.slice(-4).join(' / ')}）` : ''}`);
  lines.push('这是本轮回答开始时用户屏幕的画面；需要更新用 rta_look，要精确区域用 rta_region。');
  return lines.join('\n');
}

/**
 * 高清截图（从原生录像抽帧、裁窗、缩图）的说明文字。
 * 与 buildImageCaption 的区别：这里明确「这是原生分辨率、算法挑的一帧」，
 * 并告诉模型「想继续跟踪就 rta_note 记一句摘要」——注入过程本身就是摘要起点。
 *
 * @param {object} input {event, foreground, hd, at}
 */
export function buildHdCaption({ event = null, foreground = null, hd = null, at = Date.now() } = {}) {
  const lines = ['〔RTA 高清截图 · 插件注入，非用户消息〕'];
  const title = foreground?.title ?? event?.win?.title ?? event?.window?.title ?? null;
  const process = foreground?.process ?? event?.win?.process ?? null;
  if (title) lines.push(`前台：${clampText(title)}${process ? ` [${clampText(process, 40)}]` : ''}`);
  const when = clock(event?.wall ?? event?.at ?? at);
  const kind = KIND_LABEL[event?.kind] ?? '画面';
  const score = Number(event?.score) > 0 ? `（强度 ${Math.round(Number(event.score))}）` : '';
  const size = hd?.width && hd?.height ? ` · ${hd.width}×${hd.height}` : '';
  const crop = hd?.rect ? '（已裁到当时的窗口/圈选区域）' : '';
  lines.push(`时间：${when} · ${kind}${score}${size}${crop}`);
  lines.push('这是本轮开始前信息量最大的一帧；需要更新的画面用 rta_look，更早历史用 rta_recall(images:true)。');
  lines.push('如果这段活动值得跟踪，用 rta_note 记 1–2 句摘要（name=screen-log），后续注入会带上它。');
  return lines.join('\n');
}
