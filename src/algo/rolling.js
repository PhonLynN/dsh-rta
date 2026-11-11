/**
 * algo/rolling.js — 在线"这帧算不算异常"的统计量。
 *
 * 不能用固定阈值：用户可能在全屏白底文档（差 2 就算大变化）和暗色播放器
 * （差 8 都很正常）之间切换。storyboard 的做法是滚动窗口里算 median/IQR，
 * 转成 z 分数，阈值跟着画面自适应。这里把它做成流式的：
 *  - 环形缓冲保留最近 window 帧；
 *  - 直方图每 5 帧重建一次（成本固定，不随帧率变化）；
 *  - median / sigma 从直方图分位算，sigma = max(1, (q75-q25)/1.349)。
 *
 * 用直方图而不是排序：每帧 O(bins)，30Hz 下开销 <0.01ms。
 */

export class RollingStats {
  /**
   * @param {{window?: number, bins?: number, rebuildEvery?: number, minSamples?: number}} [opts]
   */
  constructor(opts = {}) {
    this.window = opts.window ?? 300;
    this.bins = opts.bins ?? 64;
    this.rebuildEvery = opts.rebuildEvery ?? 5;
    this.minSamples = opts.minSamples ?? 12;
    this.buf = new Float32Array(this.window);
    this.head = 0;
    this.count = 0;
    this.sinceRebuild = 0;
    this.max = 255;
    this._median = 0;
    this._sigma = 1;
    this._q25 = 0;
    this._q75 = 0;
    this._mean = 0;
    this._sum = 0;
  }

  push(value) {
    const v = Number.isFinite(value) ? value : 0;
    if (this.count === this.window) this._sum -= this.buf[this.head];
    else this.count++;
    this.buf[this.head] = v;
    this._sum += v;
    this.head = (this.head + 1) % this.window;

    if (this.count >= this.minSamples) {
      if (++this.sinceRebuild >= this.rebuildEvery || this.count === this.minSamples) {
        this.sinceRebuild = 0;
        this._rebuild();
      }
    }
    return this;
  }

  _rebuild() {
    const n = this.count;
    const hist = new Uint32Array(this.bins);
    const scale = this.bins / (this.max + 1e-6);
    let maxV = 1;
    for (let i = 0; i < n; i++) {
      const v = this.buf[i] < 0 ? 0 : this.buf[i] > this.max ? this.max : this.buf[i];
      hist[(v * scale) | 0]++;
      if (v > maxV) maxV = v;
    }
    const q = (p) => {
      const want = p * n;
      let acc = 0;
      for (let b = 0; b < this.bins; b++) {
        acc += hist[b];
        if (acc >= want) return ((b + 0.5) / this.bins) * (this.max + 1e-6);
      }
      return maxV;
    };
    this._q25 = q(0.25);
    this._median = q(0.5);
    this._q75 = q(0.75);
    const iqr = Math.max(0, this._q75 - this._q25);
    this._sigma = Math.max(1, iqr / 1.349);
    this._mean = this._sum / n;
  }

  get median() { return this._median; }
  get sigma() { return this._sigma; }
  get mean() { return this._mean; }
  get q25() { return this._q25; }
  get q75() { return this._q75; }

  /** 当前 z 分数（窗口样本不足时返回 0，避免开局乱切） */
  z(value) {
    if (this.count < this.minSamples) return 0;
    return (value - this._median) / this._sigma;
  }

  /** 自适应阈值：median + k·sigma 与绝对下限取大。 */
  threshold({ min = 12, k = 3, floor = 15 } = {}) {
    if (this.count < this.minSamples) return Math.max(floor, min);
    return Math.max(min, floor, this._median + k * this._sigma);
  }

  reset() {
    this.count = 0;
    this.head = 0;
    this.sinceRebuild = 0;
    this._sum = 0;
    this._median = 0;
    this._sigma = 1;
    return this;
  }
}
