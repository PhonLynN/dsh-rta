/**
 * host/overlay.js — RTA 全局浮窗（Electron 独立进程）的宿主侧。
 *
 * 架构：
 *   dsh-rta（DSH 插件进程）
 *     ├─ 引擎启动 → 拉起本模块 → 起 127.0.0.1 回环 HTTP（随机端口 + 一次性 token）
 *     └─ spawn electron.exe ui/overlay  ──→ 透明置顶窗口（460×672）
 *                                           │  GET  /api/dsh-rta/state（active/时长/事件）
 *                                           └  POST /api/dsh-rta/say（把一句话推进绑定会话）
 *
 * 为什么不用宿主的 connection.fetch：那条路只服务 DSH 页面里的同源请求；
 * 独立进程不吃浏览器 cookie，所以这里自己起一个只监听回环地址、带 token 的小服务。
 * token 每次启动随机生成，进程退出即失效；不写盘、不进日志。
 *
 * 失败降级：没有 electron 运行时 / spawn 失败 → 只 warn，RTA 采集本身照常。
 */

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { liveState } from './live.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 8 * 1024;

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 寻找 Electron 运行时（按优先级）。 */
export function resolveElectronPath({ env = process.env, explicit = null } = {}) {
  const candidates = [
    explicit,
    env.DSH_RTA_ELECTRON,
    join(homeDir(), 'rta', 'overlay-runtime', 'node_modules', 'electron', 'dist', 'electron.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* 路径不可读就试下一个 */ }
  }
  return null;
}

/** 寻找浮窗 app 目录（workspace 里是 ui/overlay，安装后是 <plugin>/ui/overlay）。 */
export function resolveOverlayAppDir({ env = process.env, explicit = null } = {}) {
  const candidates = [
    explicit,
    env.DSH_RTA_OVERLAY_DIR,
    join(moduleDir, '..', '..', 'ui', 'overlay'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, 'main.cjs'))) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-rta-token',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
  };
}

/**
 * @param {object} opts
 * @param {object} opts.rt runtime
 * @param {{info:Function,warn:Function,error:Function}} [opts.logger]
 * @param {object} [opts.env]
 * @param {string} [opts.electronPath] 测试注入
 * @param {string} [opts.appDir] 测试注入
 * @param {Function} [opts.spawnFn] 测试注入（默认 child_process.spawn）
 */
export function createOverlayHost({
  rt,
  logger = null,
  env = process.env,
  electronPath = null,
  appDir = null,
  spawnFn = spawn,
} = {}) {
  let server = null;
  let child = null;
  let token = null;
  let endpoint = null;

  function send(res, statusCode, body) {
    const payload = JSON.stringify(body ?? { ok: false });
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      ...corsHeaders(),
    });
    res.end(payload);
  }

  function authorized(req, url) {
    if (!token) return false;
    const queryToken = url?.searchParams?.get('token')
      ?? new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token');
    const headerToken = req.headers['x-rta-token'];
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return safeEqual(queryToken, token) || safeEqual(headerToken, token) || safeEqual(bearer, token);
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new Error('body too large');
      chunks.push(chunk);
    }
    if (!chunks.length) return null;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      send(res, 400, { ok: false, reason: 'bad-url' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (!authorized(req, url)) {
      send(res, 401, { ok: false, reason: 'unauthorized' });
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/dsh-rta/state') {
        const state = liveState(rt);
        send(res, 200, {
          ...state,
          // 单会话约束：浮窗只服务绑定的那个会话
          bound: { sessionId: rt.boundSessionId?.() ?? null },
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/dsh-rta/say') {
        const body = await readJson(req);
        const text = typeof body?.text === 'string' ? body.text : '';
        const summoner = rt.summoner;
        if (!summoner || typeof summoner.say !== 'function') {
          send(res, 503, { ok: false, reason: 'not-ready' });
          return;
        }
        const result = await summoner.say({ text });
        send(res, result.ok ? 200 : 409, result);
        return;
      }

      send(res, 404, { ok: false, reason: 'not-found' });
    } catch (err) {
      logger?.warn?.(`[rta] overlay http error: ${err?.message ?? err}`);
      send(res, 400, { ok: false, reason: 'bad-request' });
    }
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => { void handle(req, res); });
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        server = srv;
        const address = srv.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        endpoint = `http://127.0.0.1:${port}`;
        resolve(endpoint);
      });
    });
  }

  function killChild() {
    if (!child) return;
    const proc = child;
    child = null;
    try {
      proc.kill();
    } catch { /* 已经退出 */ }
  }

  /** 启动回环服务 + 拉起 Electron 浮窗。@returns {Promise<boolean>} */
  async function start() {
    if (child && endpoint) return true;

    const electron = resolveElectronPath({ env, explicit: electronPath });
    const overlayDir = resolveOverlayAppDir({ env, explicit: appDir });
    if (!electron) {
      logger?.warn?.('[rta] overlay skipped: electron runtime not installed (run scripts/install-overlay.mjs)');
      return false;
    }
    if (!overlayDir) {
      logger?.warn?.('[rta] overlay skipped: ui/overlay app not found');
      return false;
    }

    try {
      if (!server) await listen();
    } catch (err) {
      logger?.warn?.(`[rta] overlay http listen failed: ${err?.message ?? err}`);
      return false;
    }

    token = randomBytes(24).toString('hex');
    // 注意：DSH 自身可能带 ELECTRON_RUN_AS_NODE=1（它自己是 Electron 应用）。
    // 继承给浮窗的 electron.exe 会让它变成纯 Node 进程、根本不开窗，必须剔除。
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...childEnv } = env;
    // 浮窗进程的输出落到 ~/.dsh/rta/logs/overlay.log：GUI 进程在某些宿主环境里
    // 静默退出（崩溃码进不了 DSH 日志），没有这份日志就无法定位。
    let logFd = null;
    try {
      const dir = join(homeDir(), 'rta', 'logs');
      mkdirSync(dir, { recursive: true });
      logFd = openSync(join(dir, 'overlay.log'), 'a');
    } catch { /* 日志不可写不影响浮窗 */ }
    try {
      if (logFd !== null) {
        const interesting = Object.entries(childEnv)
          .filter(([key]) => /^(ELECTRON|CHROME|CRASHPAD|NODE_OPTIONS|ASAR)/i.test(key))
          .map(([key, value]) => `${key}=${String(value).slice(0, 160)}`)
          .join(' ');
        appendFileSync(logFd, `\n[parent] spawn ${electron} ${overlayDir}\n[parent] env ${interesting}\n`);
      }
      // `--no-sandbox/--disable-gpu-sandbox`：本机在受限宿主环境里直接起 GPU 沙箱会立刻崩溃
      // （0x80000003），所以关掉 GPU 沙箱进程；但**不能**用 --disable-gpu —— 采集渲染方案
      // 依赖 GPU 合成做 canvas 的 blur(20px)，禁用 GPU 会退回软件模糊、CPU 占用高一个量级。
      child = spawnFn(electron, [overlayDir, '--no-sandbox', '--disable-gpu-sandbox'], {
        env: {
          ...childEnv,
          RTA_OVERLAY_ENDPOINT: endpoint,
          RTA_OVERLAY_TOKEN: token,
          ELECTRON_ENABLE_LOGGING: '1',
          ELECTRON_ENABLE_STACK_DUMPING: '1',
        },
        stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
        windowsHide: false,
      });
      child?.once?.('exit', (code, signal) => {
        logger?.warn?.(`[rta] overlay exited code=${code} signal=${signal}`);
        if (logFd !== null) { try { appendFileSync(logFd, `[parent] exit code=${code} signal=${signal}\n`); } catch { /* ignore */ } }
        child = null;
      });
      child?.once?.('error', (err) => {
        logger?.warn?.(`[rta] overlay spawn failed: ${err?.message ?? err}`);
        child = null;
      });
    } catch (err) {
      logger?.warn?.(`[rta] overlay spawn failed: ${err?.message ?? err}`);
      child = null;
      return false;
    }

    logger?.info?.(`[rta] overlay started (${endpoint})`);
    return true;
  }

  /** 结束浮窗（先杀 Electron，再收 HTTP 服务）。 */
  async function stop() {
    killChild();
    token = null;
    endpoint = null;
    if (server) {
      const srv = server;
      server = null;
      await new Promise((resolve) => srv.close(() => resolve()));
    }
  }

  return {
    start,
    stop,
    get running() { return !!child; },
    get endpoint() { return endpoint; },
    get appDir() { return resolveOverlayAppDir({ env, explicit: appDir }); },
    get electronPath() { return resolveElectronPath({ env, explicit: electronPath }); },
  };
}
