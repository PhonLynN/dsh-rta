/**
 * host/live.js — 悬浮窗 ↔ 宿主 的桥（RTA client half 的数据面）。
 *
 * 为什么需要：悬浮窗是运行在 DSH Web 前端里的 DOM 浮层（src/client.js），
 * 它拿不到 Node 侧的引擎对象，只能过 HTTP 问宿主。这里用宿主的
 * `connection.fetch` 机制注册两条 `/api` 路由：
 *
 *   GET  /api/dsh-rta/state  → 当前 RTA 是否在跑、会话时长、前台窗口、事件数
 *   POST /api/dsh-rta/say    → 悬浮窗里发一句话，推进当前会话（followup/steer）
 *
 * 契约（对照 dsh-video-storyboard / dsh-cost-meter 的宿主接法）：
 *  - connection 是可选服务：没有它时插件照常工作，只是没有悬浮窗数据面；
 *  - 一律用 serviceOf(ctx, 'connection') 软探测，不进 inject（否则缺服务的机器会卡「加载中」）；
 *  - 路由的 fetch 拿到的是标准 Request，返回标准 Response（Node 22 全局）。
 */

import { serviceOf } from './service.js';

export const STATE_PATH = '/api/dsh-rta/state';
export const SAY_PATH = '/api/dsh-rta/say';

/** 把引擎状态压成悬浮窗能直接渲染的小 JSON（不含任何像素/路径敏感信息）。 */
export function liveState(rt) {
  const now = Date.now();
  const engine = rt?.engine;
  const state = engine?.state ?? 'idle';
  if (!engine || state === 'idle') {
    return { v: 1, active: false, state, serverTime: now };
  }

  let status = null;
  try {
    status = engine.status();
  } catch {
    status = null;
  }
  if (!status) return { v: 1, active: state === 'running', state, serverTime: now };

  const session = status.session ?? null;
  const capture = status.capture ?? null;
  const screen = status.source ?? null;
  const foreground = status.foreground ?? null;
  const video = status.video ?? null;

  return {
    v: 1,
    active: status.state === 'running',
    state: status.state,
    serverTime: now,
    session: session
      ? {
          id: session.id ?? null,
          startedAt: session.startedAt ?? null,
          retainUntil: session.retainUntil ?? null,
          counts: session.counts ?? null,
        }
      : null,
    capture: capture
      ? {
          tickHz: capture.tickHz ?? 0,
          ticks: capture.ticks ?? 0,
          archived: capture.archived ?? 0,
          grabErrors: capture.grabErrors ?? 0,
        }
      : null,
    screen: screen ? { width: screen.width ?? null, height: screen.height ?? null } : null,
    foreground: foreground
      ? {
          title: foreground.title ?? null,
          process: foreground.process ?? null,
          // 浮窗玻璃背板要按「前台窗口」做窗口捕获，必须知道它在屏幕上的物理矩形。
          rect: foreground.rect ?? null,
          hwnd: foreground.hwnd ?? null,
          visible: foreground.visible ?? null,
        }
      : null,
    video: video ? { active: !!video.active, files: video.files ?? 0, bytes: video.bytes ?? 0 } : null,
    lastPush: status.lastPush ?? null,
    recentEvents: Array.isArray(status.recentEvents) ? status.recentEvents.slice(-6) : [],
  };
}

function jsonResponse(body, statusCode = 200) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * 注册悬浮窗数据面路由。
 * @returns {boolean} 宿主是否具备 connection.fetch（false 时静默降级）
 */
export function wireLiveBridge(ctx, rt, disposers = []) {
  const connection = serviceOf(ctx, 'connection');
  const routes = connection?.fetch;
  if (!routes || typeof routes.register !== 'function') {
    try {
      ctx?.logger?.warn?.('[dsh-rta] floating window data bridge unavailable: host has no connection.fetch');
    } catch { /* ignore */ }
    return false;
  }

  try {
    disposers.push(
      routes.register({
        path: STATE_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => jsonResponse(liveState(rt)),
      }),
    );

    disposers.push(
      routes.register({
        path: SAY_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body = null;
          try {
            body = await request.json();
          } catch {
            return jsonResponse({ ok: false, reason: 'bad-json' }, 400);
          }
          const text = typeof body?.text === 'string' ? body.text : '';
          const say = rt?.summoner?.say;
          if (typeof say !== 'function') return jsonResponse({ ok: false, reason: 'unavailable' });
          try {
            const out = await say({ text });
            return jsonResponse(out ?? { ok: false, reason: 'unavailable' });
          } catch (err) {
            return jsonResponse({ ok: false, reason: 'say-failed', message: String(err?.message ?? err) });
          }
        },
      }),
    );

    try {
      ctx?.logger?.info?.(`[dsh-rta] floating window data bridge: ${STATE_PATH}, ${SAY_PATH}`);
    } catch { /* ignore */ }
    return true;
  } catch (err) {
    try {
      ctx?.logger?.warn?.(`[dsh-rta] live bridge registration failed: ${err?.message ?? err}`);
    } catch { /* ignore */ }
    return false;
  }
}
