/**
 * store/paths.js — RTA 落盘目录约定。
 *
 * 一次"RTA 启用"= 一个 session 目录：
 *   ~/.dsh/rta/sessions/<yyyyMMdd-HHmmss>/
 *     manifest.json      会话元信息（开始/结束/保留期/屏幕/配置）
 *     index.jsonl        时间轴索引（每帧/每事件一行，文字永久保留）
 *     frames/            15Hz 基线帧（24h 后删）
 *     events/            触发帧（24h 后删）
 *     sheets/            拼图（24h 后删）
 *     video/             原始帧录像（分段 MPEG-TS，24h 后随场删除）
 *     annotations/       圈画区域 JSON（含坐标/时间，token 上永久）
 *     notes/             文字笔记（AI 理解/台词，永久）
 *
 * 为什么按 session 分目录而不是平铺：保留期/删除/回捞都是"整场"语义；
 * 目录名用本地时间，方便用户直接去文件夹里翻。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** RTA 根目录：env DSH_RTA_HOME > $DSH_HOME/rta > ~/.dsh/rta */
export function rtaHome(env = process.env) {
  if (env.DSH_RTA_HOME) return env.DSH_RTA_HOME;
  const dshHome = env.DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'rta');
}

export function sessionsRoot(env = process.env) {
  return join(rtaHome(env), 'sessions');
}

/** 本地时间 id：20261110-204512（排序即时间序）。 */
export function newSessionId(now = Date.now()) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function sessionPaths(root, id) {
  const dir = join(root, id);
  return {
    dir,
    manifest: join(dir, 'manifest.json'),
    index: join(dir, 'index.jsonl'),
    frames: join(dir, 'frames'),
    events: join(dir, 'events'),
    sheets: join(dir, 'sheets'),
    video: join(dir, 'video'),
    annotations: join(dir, 'annotations'),
    notes: join(dir, 'notes'),
  };
}
