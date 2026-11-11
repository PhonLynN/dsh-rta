/**
 * config.js — RTA 的用户配置（~/.dsh/rta/config.json）。
 *
 * 读取失败一律回退默认值：配置文件坏掉不能让插件起不来。
 * 写配置页（客户端插件）之后再说；现在只读。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rtaHome } from './store/paths.js';

export const DEFAULT_RTA_CONFIG = Object.freeze({
  capture: {
    sentinelHz: 15,          // 与 archiveFps 同值：一次 grab 两用（实测 30Hz 抓屏吃满 CPU）
    archiveFps: 15,
    sentinelWidth: 192,
    archiveWidth: 512,
    archiveFormat: 'jpeg',
    archiveMode: 'video',
    videoFps: 15,
    videoQuality: 26,
    videoSegmentSeconds: 300,
    videoEncoder: 'auto',   // 基线帧编码：jpeg（~14KB/帧）| png（~40KB/帧）
    dedupeScore: 1.0,        // 屏幕几乎没变时复用上一张 PNG/JPEG
    dedupeMc: 0.005,
    windowInfoEveryMs: 1000,
  },
  retentionHours: 24,        // endedAt 之后图片再留 24h，文字永久
  imageTrigger: 8,           // 会话里攒够 8 张图才跑一次 offload
  imageKeep: 3,              // offload 后保留最新 3 张
  maxSheetTokens: 560,       // 单张拼图的 token 预算上限
  summonPrompt: 'RTA 召唤：用户刚按了 Ctrl+Alt，想让你看当前屏幕。先调用 rta_look 拿最新画面（1–2 帧就够），然后用 1–2 句口语直接说你看到的关键内容；不要列表、不要长篇。',
  summonCooldownMs: 1500,    // 两次召唤之间的最小间隔，防按住键重复触发
});

export function rtaConfigPath(env = process.env) {
  return join(rtaHome(env), 'config.json');
}

/** 读配置：深合并 capture，其余键浅合并；类型不对的键忽略。 */
export function readRtaConfig(env = process.env) {
  const base = {
    ...DEFAULT_RTA_CONFIG,
    capture: { ...DEFAULT_RTA_CONFIG.capture },
  };
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(rtaConfigPath(env), 'utf8'));
  } catch {
    return base;
  }
  if (!raw || typeof raw !== 'object') return base;

  if (typeof raw.summonPrompt === 'string' && raw.summonPrompt.trim()) {
    base.summonPrompt = raw.summonPrompt.trim();
  }
  for (const key of ['retentionHours', 'imageTrigger', 'imageKeep', 'maxSheetTokens', 'summonCooldownMs']) {
    const v = Number(raw[key]);
    if (Number.isFinite(v) && v >= 0) base[key] = v;
  }
  if (raw.capture && typeof raw.capture === 'object') {
    for (const [key, value] of Object.entries(raw.capture)) {
      if (key === 'archiveFormat') {
        if (value === 'jpeg' || value === 'png') base.capture.archiveFormat = value;
        continue;
      }
      const v = Number(value);
      if (Number.isFinite(v) && v >= 0) base.capture[key] = v;
    }
  }
  return base;
}

/** 引擎用的配置子集。 */
export function engineConfig(config) {
  return {
    capture: { ...config.capture },
    retentionHours: config.retentionHours,
  };
}
