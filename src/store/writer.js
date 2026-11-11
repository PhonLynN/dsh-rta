/**
 * store/writer.js — PngWriter：给主线程用的 worker 句柄。
 *
 * 只做三件事：投递编码任务、跟踪在途数量（背压用）、关闭时等所有任务落盘。
 * 采集循环不能 await 写盘，所以这里只返回值/回调，不阻塞。
 */

import { Worker } from 'node:worker_threads';

export class PngWriter {
  constructor({ logger } = {}) {
    this.logger = logger ?? null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.failures = 0;
    this.bytes = 0;
    this.worker = new Worker(new URL('./writer-worker.js', import.meta.url));
    this.worker.on('message', (msg) => {
      const job = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.op === 'wrote') {
        this.bytes += msg.bytes;
        job?.resolve?.(msg);
      } else {
        this.failures++;
        this.logger?.warn?.(`[rta] png write failed: ${msg.error}`);
        job?.resolve?.(msg);
      }
    });
    this.worker.on('error', (err) => {
      this.logger?.error?.(`[rta] writer worker error: ${err?.message ?? err}`);
      for (const job of this.pending.values()) job.resolve?.({ op: 'error', error: String(err) });
      this.pending.clear();
    });
    this.worker.unref?.();
  }

  get inFlight() { return this.pending.size; }

  /**
   * 投递一张图。背压：在途超过 maxInFlight 时直接丢掉这一帧（记日志），
   * 保证采集线程永远不会被磁盘拖死。
   * @param {{path:string,width:number,height:number,rgb:Uint8Array,level?:number,format?:'png'|'jpeg'}} job
   * @returns {Promise<object>|null}
   */
  write({ path, width, height, rgb, level = 3, format = 'png' }, { maxInFlight = 64 } = {}) {
    if (this.closed || !this.worker) return null;
    if (this.pending.size >= maxInFlight) {
      this.logger?.warn?.(`[rta] writer backlog ${this.pending.size}，丢一帧`);
      return null;
    }
    const id = this.nextId++;
    const promise = new Promise((resolve) => this.pending.set(id, { resolve }));
    this.worker.postMessage({ id, path, width, height, rgb, level, format });
    return promise;
  }

  /** 等所有在途任务结束（stop 时调用）。 */
  async flush() {
    while (this.pending.size) {
      await Promise.allSettled([...this.pending.values()].map((j) => j.resolve));
      if (this.pending.size) await new Promise((r) => setTimeout(r, 5));
    }
  }

  async close() {
    await this.flush();
    this.closed = true;
    try { await this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
  }
}
