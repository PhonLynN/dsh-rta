/**
 * store/store.js — 一场 RTA 会话的磁盘记录。
 *
 * 分工：
 *  - 这里只管 manifest/index/notes/annotations 这些小文件（同步写不会卡采集）；
 *  - 大文件（帧 PNG、拼图 PNG）由 writer-worker 在后台线程编码+写盘，
 *    这里只负责给它路径和登记 index。
 *
 * 保留策略（已和用户确认）：
 *  - 图片文件保留 retainUntil = endedAt + 24h；
 *  - 文字（index.jsonl、notes、annotations、manifest）永久保留，只给手动清空入口；
 *  - GC 整场删除，删完在 tombstones.jsonl 留一条记录，便于"图已过期"的人话提示。
 */

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { sessionsRoot, sessionPaths, rtaHome } from './paths.js';

export const DEFAULT_RETENTION_HOURS = 24;
const STALE_RECORDING_MS = 30 * 60 * 1000; // 30 分钟没有心跳 → 认为上次是崩溃退出

function iso(ms) { return new Date(ms).toISOString(); }

export class SessionStore {
  constructor({ id, root, now = Date.now(), screen, config, logger } = {}) {
    this.id = id;
    this.root = root ?? sessionsRoot();
    this.paths = sessionPaths(this.root, id);
    this.startedAt = now;
    this.lastActivityAt = now;
    this.screen = screen ?? null;
    this.config = config ?? {};
    this.logger = logger ?? null;
    this.status = 'recording';
    this.endedAt = null;
    this.retainUntil = null;
    this.counts = { frames: 0, events: 0, sheets: 0, regions: 0, notes: 0 };
    this._seq = 0;
    this._chain = Promise.resolve();
  }

  async init() {
    for (const dir of [this.paths.dir, this.paths.frames, this.paths.events, this.paths.sheets, this.paths.video, this.paths.annotations, this.paths.notes]) {
      await fsp.mkdir(dir, { recursive: true });
    }
    await this._writeManifest();
    await fsp.writeFile(this.paths.index, '', { flag: 'a' });
    this.appendRecord({ type: 'session', action: 'start', wall: this.startedAt, screen: this.screen });
    return this;
  }

  /** 下一帧序号（只增不减，和时间戳一起构成复合主键） */
  nextSeq() { return ++this._seq; }

  /** 帧文件路径（由 worker 写入；这里只算路径并计数） */
  framePath(kind, seq, wall, ext = 'png') {
    const dir = kind === 'event' ? this.paths.events : this.paths.frames;
    const name = `${String(seq).padStart(6, '0')}-${wall}.${ext}`;
    if (kind === 'event') this.counts.events++;
    else this.counts.frames++;
    return join(dir, name);
  }

  /** 录像轨索引行也算一帧（没有独立图片文件，但时间轴上有这一帧） */
  countVideoFrame() { this.counts.frames++; }

  sheetPath(seq, wall) {
    this.counts.sheets++;
    return join(this.paths.sheets, `${String(seq).padStart(6, '0')}-${wall}.png`);
  }

  regionPath(id) {
    this.counts.regions++;
    return join(this.paths.annotations, `region-${String(id).padStart(4, '0')}.json`);
  }

  /** 串行写 index.jsonl，保证顺序与采集顺序一致 */
  appendRecord(rec) {
    this.lastActivityAt = Date.now();
    const line = JSON.stringify(rec) + '\n';
    this._chain = this._chain.then(
      () => fsp.appendFile(this.paths.index, line, 'utf8'),
      () => fsp.appendFile(this.paths.index, line, 'utf8'),
    ).catch((err) => this.logger?.warn?.(`[rta] index append failed: ${err?.message ?? err}`));
    return this._chain;
  }

  /** 圈画区域：JSON 小文件 + index 一行 */
  async saveRegion(region) {
    const file = this.regionPath(region.id);
    await fsp.writeFile(file, JSON.stringify(region, null, 2), 'utf8');
    this.appendRecord({
      type: 'region', id: region.id, tStart: region.tStart, tEnd: region.tEnd,
      bbox: region.bbox, file,
    });
    return file;
  }

  /** 文字笔记（AI 理解、台词摘要等），永久保留 */
  async saveNote(name, text) {
    const safe = String(name).replace(/[^\w.-]+/g, '_').slice(0, 80);
    const file = join(this.paths.notes, `${safe}.md`);
    await fsp.writeFile(file, text, 'utf8');
    this.counts.notes++;
    this.appendRecord({ type: 'note', name: safe, file, wall: Date.now() });
    return file;
  }

  async heartbeat() {
    this.lastActivityAt = Date.now();
    return this;
  }

  /** 结束会话：写 endedAt/retainUntil，之后 GC 只删图片文件。 */
  async end({ reason = 'explicit', now = Date.now(), retentionHours = this.config?.retentionHours ?? DEFAULT_RETENTION_HOURS } = {}) {
    if (this.status === 'ended') return this.manifest;
    this.status = 'ended';
    this.endedAt = now;
    this.retainUntil = now + retentionHours * 3600_000;
    await this._writeManifest({ reason });
    this.appendRecord({ type: 'session', action: 'end', wall: now, reason, retainUntil: this.retainUntil });
    await this._chain;
    return this.manifest;
  }

  get manifest() {
    return {
      version: 1,
      sessionId: this.id,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      retainUntil: this.retainUntil,
      retentionHours: this.config?.retentionHours ?? DEFAULT_RETENTION_HOURS,
      status: this.status,
      lastActivityAt: this.lastActivityAt,
      screen: this.screen,
      counts: this.counts,
      config: this.config,
    };
  }

  async _writeManifest(extra = {}) {
    const data = { ...this.manifest, ...extra };
    const tmp = `${this.paths.manifest}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, this.paths.manifest);
  }

  /** 读索引（回捞用；按需分页） */
  async readIndex({ offset = 0, limit = 500 } = {}) {
    const text = await fsp.readFile(this.paths.index, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const slice = lines.slice(offset, offset + limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return { total: lines.length, offset, records: slice };
  }

  /**
   * GC：整场删除过期 session 的图片目录，文字保留；写墓碑。
   * @param {{root?: string, now?: number, retentionHours?: number, logger?: object}} [opts]
   */
  static async gc({ root = sessionsRoot(), now = Date.now(), logger } = {}) {
    const removed = [];
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return { removed, scanned: 0 };
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = join(root, ent.name);
      let manifest;
      try {
        manifest = JSON.parse(await fsp.readFile(join(dir, 'manifest.json'), 'utf8'));
      } catch {
        continue;
      }
      const ended = manifest.status === 'ended' || (manifest.endedAt && manifest.endedAt > 0);
      const stale = !ended && now - (manifest.lastActivityAt ?? manifest.startedAt ?? 0) > STALE_RECORDING_MS;
      if (!ended && !stale) continue;
      const retainUntil = manifest.retainUntil ?? (manifest.endedAt ?? now) + DEFAULT_RETENTION_HOURS * 3600_000;
      if (!stale && retainUntil > now) continue;

      // 整场删除前先把文字留在墓碑里（图片过期后，回捞提示要能说出"有过这一场"）
      const tombstone = {
        sessionId: manifest.sessionId ?? ent.name,
        startedAt: manifest.startedAt, endedAt: manifest.endedAt ?? now,
        removedAt: now, stale, counts: manifest.counts,
      };
      try {
        await fsp.appendFile(join(rtaHome(), 'tombstones.jsonl'), JSON.stringify(tombstone) + '\n', 'utf8');
      } catch { /* 墓碑写失败不影响删除 */ }
      try {
        await fsp.rm(dir, { recursive: true, force: true });
        removed.push(tombstone);
        logger?.info?.(`[rta] gc removed ${ent.name}`);
      } catch (err) {
        logger?.warn?.(`[rta] gc failed ${ent.name}: ${err?.message ?? err}`);
      }
    }
    return { removed, scanned: entries.length };
  }

  /** 列出所有 session（manifest 摘要，倒序） */
  /**
   * 提前清图（通过工具调用触发，正常保留期仍是 24h）：
   * 删除 before 之前的 frames/events/sheets 图片与已经写完的 video 分段，
   * 保留 index.jsonl / notes / annotations / manifest 等文字记录；
   * 清理动作追加到 purges.jsonl，manifest 标记 imagesPurgedAt。
   *
   * 语义是"已经总结成文字、不再需要的图"，所以默认保留最近 keepMinutes 分钟
   * （调用方传入 before 时间点），不删正在写的当前视频分段。
   */
  static async purge({ root = sessionsRoot(), sessionId = null, before = Date.now(), now = Date.now(), dryRun = false } = {}) {
    const sessions = await SessionStore.list({ root });
    let target;
    if (sessionId) target = sessions.find((m) => m.sessionId === sessionId);
    else target = sessions.find((m) => m.status !== 'recording') ?? sessions[0];
    if (!target) return { ok: false, reason: 'no-session', scanned: sessions.length };

    const dir = join(root, target.sessionId);
    const kinds = { frames: 0, events: 0, sheets: 0, video: 0 };
    let files = 0;
    let bytes = 0;

    const wallOf = (name) => {
      const m = /^\d+-(\d+)\.[a-z0-9]+$/i.exec(name);
      return m ? Number(m[1]) : null;
    };
    const removeFile = async (file) => {
      const st = await fsp.stat(file).catch(() => null);
      if (!st?.isFile()) return false;
      if (!dryRun) await fsp.unlink(file).catch(() => {});
      return true;
    };

    for (const kind of ['frames', 'events', 'sheets']) {
      const d = join(dir, kind);
      let names = [];
      try { names = await fsp.readdir(d); } catch { continue; }
      for (const name of names) {
        const wall = wallOf(name);
        if (wall == null || wall >= before) continue;
        if (await removeFile(join(d, name))) {
          const st = await fsp.stat(join(d, name)).catch(() => null);
          files++; bytes += st?.size ?? 0; kinds[kind]++;
        }
      }
    }

    // 视频：只删"已经写完"的分段（mtime 早于 before），正在写的当前段不动
    try {
      const names = (await fsp.readdir(join(dir, 'video'))).filter((n) => /^seg-\d+\.ts$/i.test(n));
      for (const name of names) {
        const file = join(dir, 'video', name);
        const st = await fsp.stat(file).catch(() => null);
        if (!st?.isFile() || st.mtimeMs >= before) continue;
        if (!dryRun) await fsp.unlink(file).catch(() => {});
        files++; bytes += st.size; kinds.video++;
      }
    } catch { /* no video dir */ }

    if (!dryRun) {
      const rec = { at: now, before, sessionId: target.sessionId, files, bytes, kinds };
      await fsp.appendFile(join(dir, 'purges.jsonl'), JSON.stringify(rec) + '\n').catch(() => {});
      try {
        const mf = JSON.parse(await fsp.readFile(join(dir, 'manifest.json'), 'utf8'));
        mf.imagesPurgedAt = now;
        await fsp.writeFile(join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
      } catch { /* manifest 不可读时忽略 */ }
    }

    return { ok: true, sessionId: target.sessionId, dir, before, dryRun, files, bytes, kinds };
  }

  static async list({ root = sessionsRoot() } = {}) {
    let entries = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      try {
        const m = JSON.parse(await fsp.readFile(join(root, ent.name, 'manifest.json'), 'utf8'));
        out.push(m);
      } catch { /* 忽略半成品目录 */ }
    }
    out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return out;
  }
}

export { iso };
