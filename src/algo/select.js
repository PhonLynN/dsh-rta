/**
 * algo/select.js — 决定"这一帧要不要让 AI 看"。
 *
 * 输入是采样器喂进来的分数（像素差分、运动补偿、平均亮度），输出是一个触发
 * （cut / integral / text / heartbeat / manual）或 null。这里刻意不做"二元判定
 * 丢弃"：所有帧都由采集层保留，这里只决定主动推送。规则借自 see-now 的双闸门
 * （cut + integral），另外加三样 RTA 需要的东西：
 *
 *  1. text：OCR/字幕发现文字变了 → 直接推送。画面变化再大也可能是装饰，
 *     文字变化几乎一定是信息变化，这是最高优先级硬信号。
 *  2. heartbeat：长时间没有推送也给一帧（保险帧），避免 AI 以为画面静止。
 *  3. governor：60 秒内推送次数上限 + 最小间隔，防止动画/视频把预算打爆。
 *
 * 注意：这里的"预算"是推送帧数，不是 token —— token 由 tiers.js 在打包时决定。
 */

import { lumaGain } from './color.js';

export const DEFAULT_SELECT = Object.freeze({
  minCutScore: 12,     // 绝对下限（storyboard 的 MIN_CUT_SCORE）
  cutZ: 3,             // 相对自身基线要显著
  cutMc: 0.2,          // 运动补偿后变化占比 >20% 才当切镜（整窗平移会被压到很低）
  cutGapMs: 400,       // 两次 cut 至少隔 400ms（storyboard 同值）
  integralNeed: 360,   // 累积变化阈值（约 4×30fps×3s，按 score 尺度缩放）
  integralMin: 2,      // 单帧至少贡献 2 才计入累积（过滤噪声）
  textGapMs: 250,      // 文字变化触发的冷却
  heartbeatMs: 25_000, // 最长静默：25s 没推送就给一帧
  minSelectGapMs: 800, // 任意两次推送的最小间隔
  maxPerMinute: 20,    // 60s 内主动推送上限
  window: 300,         // 自适应统计窗口（帧）
});

/** 触发类型（也用于 store 里记录原因） */
export const TRIGGER = Object.freeze({
  CUT: 'cut',
  INTEGRAL: 'integral',
  TEXT: 'text',
  HEARTBEAT: 'heartbeat',
  MANUAL: 'manual',
});

export function createSelector(opts = {}) {
  const cfg = { ...DEFAULT_SELECT, ...opts };
  const stats = new RollingStatsLike(cfg.window);
  const recent = []; // 最近 60s 的推送时间
  let startedAt = 0;
  let lastSelectAt = 0;
  let lastCutAt = 0;
  let lastTextAt = 0;
  let integral = 0;
  let textPending = false;
  let lastScore = 0;

  const prune = (t) => {
    while (recent.length && t - recent[0] > 60_000) recent.shift();
  };

  const accept = (t) => {
    lastSelectAt = t;
    recent.push(t);
    integral = 0;
    return true;
  };

  return {
    cfg,

    /** 文字变化（OCR diff / 字幕新句）由外部调用；下一帧优先推送。 */
    noteTextChange(t = Date.now()) {
      textPending = true;
      lastTextAt = t;
    },

    /**
     * 每帧调用一次。
     * @param {{t: number, score: number, mc: number, meanV: number}} sample
     * @returns {null | {kind: string, at: number, score: number, norm: number, z: number, mc: number, gain: number}}
     */
    ingest(sample) {
      const t = sample.t;
      if (!startedAt) startedAt = t;
      const meanV = sample.meanV ?? 128;
      const gain = lumaGain(meanV);
      const norm = (sample.score ?? 0) * gain;
      const mc = sample.mc ?? 0;
      lastScore = norm;

      stats.push(norm);
      const z = stats.z(norm);
      const threshold = stats.threshold({ min: cfg.minCutScore, k: cfg.cutZ, floor: 15 });

      prune(t);
      const rateLimited = recent.length >= cfg.maxPerMinute;
      const sinceSelect = t - (lastSelectAt || startedAt);

      const emit = (kind) => ({ kind, at: t, score: sample.score ?? 0, norm, z, mc, gain });

      // 1) 文字变化：最高优先级，只受 textGapMs 约束
      if (textPending && t - lastTextAt >= 0 && (!lastSelectAt || t - lastSelectAt >= cfg.textGapMs)) {
        textPending = false;
        lastCutAt = t;
        accept(t);
        return emit(TRIGGER.TEXT);
      }

      // 2) 切镜：分数显著高于绝对阈值和自身基线，且不是整窗平移
      if (norm >= threshold && z >= cfg.cutZ && mc >= cfg.cutMc && t - lastCutAt >= cfg.cutGapMs) {
        if (rateLimited) return null;
        lastCutAt = t;
        if (!lastSelectAt || t - lastSelectAt >= cfg.minSelectGapMs) {
          accept(t);
          return emit(TRIGGER.CUT);
        }
      }

      // 3) 累积变化：没有单帧爆点，但持续在变（视频/滚动/拖拽）
      if (norm > cfg.integralMin) integral += norm - cfg.integralMin;
      if (integral >= cfg.integralNeed && sinceSelect >= cfg.minSelectGapMs) {
        if (!rateLimited) {
          accept(t);
          return emit(TRIGGER.INTEGRAL);
        }
        integral = cfg.integralNeed; // 已经够了，等配额
      }

      // 4) 保险帧：长时间静默
      if (sinceSelect >= cfg.heartbeatMs) {
        accept(t);
        return emit(TRIGGER.HEARTBEAT);
      }

      return null;
    },

    /** 手动推送（用户圈画/按快捷键）不受节流，永远通过。 */
    manual(t = Date.now()) {
      lastSelectAt = t;
      recent.push(t);
      integral = 0;
      return { kind: TRIGGER.MANUAL, at: t, score: lastScore, norm: lastScore, z: 0, mc: 0, gain: 1 };
    },

    snapshot() {
      return {
        median: stats.median,
        sigma: stats.sigma,
        lastScore,
        integral,
        lastSelectAt,
        recentCount: recent.length,
      };
    },

    /** 最近 30 秒的推送密度（用于客户端把节奏可视化） */
    density30s(now = Date.now()) {
      let n = 0;
      for (let i = recent.length - 1; i >= 0 && now - recent[i] <= 30_000; i--) n++;
      return n;
    },
  };
}

/** 独立出来是为了避免 select.js 反向依赖 stats 模块名（rollup/单测都简单）。 */
import { RollingStats as RollingStatsLike } from './rolling.js';
