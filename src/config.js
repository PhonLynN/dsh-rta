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
  summonPrompt: 'RTA 召唤：用户刚按了 Ctrl+Alt，想让你看当前屏幕。屏幕状态本来就在持续注入；先看上下文，不够再调用 rta_look 拿最新画面，然后用 1–2 句口语直接说你看到的关键内容；不要列表、不要长篇。',
  summonCooldownMs: 1500,    // 两次召唤之间的最小间隔，防按住键重复触发

  /**
   * 持续注入（默认开）：「启用即持续注入」——rta_start 之后，屏幕摘要会自动进入
   * 当前会话的 runtime context，不需要模型每隔几秒调一次工具。
   *
   * 文本通道永不唤醒会话（只在本来要跑的下一步生效）；图片更稀缺，每轮最多一张。
   * 所有旋钮都可关：inject.enabled=false 退回纯 pull（旧的 rta_look 模式）；
   * inject.image.enabled=false 只注入文字、不注入截图。
   */
  inject: {
    enabled: true,
    minIntervalMs: 4000,      // 两条文本注入之间的最小间隔（防抖屏刷历史）
    maxPerMinute: 8,          // 每分钟最多落几条 runtime-context
    maxEvents: 4,             // 时间线最多列几条事件
    maxLines: 12,             // digest 总行数上限（标题/状态/计数/时间线/脚注一起算）
    maxTextTokens: 400,       // digest 目标 token 预算（按字符近似）
    eventTtlMs: 120_000,      // 时间线只覆盖最近 2 分钟
    staleMs: 15_000,          // 超过这么久没有采集心跳 → 文本里标注「数据不新鲜」
    image: {
      enabled: true,          // 每轮开头自动带一张屏幕拼图
      minIntervalMs: 45_000,  // 两张自动截图至少间隔 45s
      windowMs: 600_000,      // 预算窗口 10 分钟
      maxPerWindow: 6,        // 每 10 分钟最多 6 张
      maxInFlight: 1,         // 同时只允许一张在飞
      maxFrames: 4,           // 拼图帧数
      maxSheetTokens: 400,    // 单张拼图 token 预算
    },
  },
});

export function rtaConfigPath(env = process.env) {
  return join(rtaHome(env), 'config.json');
}

/** 读配置：深合并 capture 与 inject，其余键浅合并；类型不对的键忽略。 */
export function readRtaConfig(env = process.env) {
  const base = {
    ...DEFAULT_RTA_CONFIG,
    capture: { ...DEFAULT_RTA_CONFIG.capture },
    inject: {
      ...DEFAULT_RTA_CONFIG.inject,
      image: { ...DEFAULT_RTA_CONFIG.inject.image },
    },
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
  // inject 只认两类值：布尔（enabled）与有限非负数（间隔/上限/预算）。
  if (raw.inject && typeof raw.inject === 'object') {
    if (typeof raw.inject.enabled === 'boolean') base.inject.enabled = raw.inject.enabled;
    for (const [key, value] of Object.entries(raw.inject)) {
      if (key === 'enabled' || key === 'image') continue;
      const v = Number(value);
      if (Number.isFinite(v) && v >= 0) base.inject[key] = v;
    }
    const image = raw.inject.image;
    if (image && typeof image === 'object') {
      if (typeof image.enabled === 'boolean') base.inject.image.enabled = image.enabled;
      for (const [key, value] of Object.entries(image)) {
        if (key === 'enabled') continue;
        const v = Number(value);
        if (Number.isFinite(v) && v >= 0) base.inject.image[key] = v;
      }
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
