/**
 * src/client.js — RTA 客户端半：DSH Web 前端里的悬浮小窗。
 *
 * 这是「激活 RTA 后屏幕右上角出现的聊天小窗」。它由 client-modules 作为
 * `dsh.client` 客户端模块加载（package.json → exports["./client"] + dsh.client），
 * 在页面里直接挂一个 fixed 定位的 DOM 浮层，视觉参数全部来自 pen 设计稿：
 *   - .pen 导出：_exports/review/rta-reference.html（唯一数值来源，禁止截图目测）
 * 数据面由服务端半提供（src/host/live.js）：
 *   GET  /api/dsh-rta/state   → 是否启用、会话时长、前台窗口、事件数
 *   POST /api/dsh-rta/say     → 用户在浮窗里发一句话，推进当前会话
 *
 * 设计约束（用户 m00598）：尺寸 / 材质 / 圆角 / 字体 / 图标 / 间距必须与设计稿完全一致；
 * 但「是否需要显示、显示多大」由运行时决定（这里窗口本体固定 420×632，位置可拖）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-rta',
  factory: () => {
    const name = 'dsh-rta';
    const inject = [];

    // 两种宿主：
    //  - DSH 页面内：同源 /api（浏览器 cookie 认证）；
    //  - Electron 全局浮窗（ui/overlay/main.cjs 注入）：http://127.0.0.1:PORT + 一次性 token。
    function rtaUrl(path) {
      const w = typeof window !== 'undefined' ? window : null;
      const base = w?.__RTA_ENDPOINT__ ? String(w.__RTA_ENDPOINT__) : '';
      const token = w?.__RTA_TOKEN__ ? String(w.__RTA_TOKEN__) : '';
      if (!base) return path;
      return `${base}${path}${token ? `${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : ''}`;
    }

    const HTML_NS = 'http://www.w3.org/2000/svg';
    const ROOT_ID = 'dsh-rta-float';
    const STYLE_ID = 'dsh-rta-float-style';
    const POS_KEY = 'dsh-rta.float.pos';
    const POLL_MS = 800;

    // ---- 设计稿精确 path（pen 导出 rta-reference.html，420×520 与 420×98） ----
    const PATH_MESSAGES =
      'M54 0l312 0 15.93 0.04 5.59 0.13 4.12 0.22 3.36 0.3 2.88 0.39 2.53 0.47 2.25 0.57 2.04 0.66 1.85 0.76 1.68 0.85 1.54 0.95 1.4 1.05 1.28 1.16 1.16 1.28 1.05 1.4 0.95 1.54 0.85 1.68 0.76 1.85 0.66 2.04 0.57 2.25 0.47 2.53 0.39 2.88 0.3 3.36 0.22 4.12 0.13 5.59 0.04 15.93 0 412-0.04 15.93-0.13 5.59-0.22 4.12-0.3 3.36-0.39 2.88-0.47 2.53-0.57 2.25-0.66 2.04-0.76 1.85-0.85 1.68-0.95 1.54-1.05 1.4-1.16 1.28-1.28 1.16-1.4 1.05-1.54 0.95-1.68 0.85-1.85 0.76-2.04 0.66-2.25 0.57-2.53 0.47-2.88 0.39-3.36 0.3-4.12 0.22-5.59 0.13-15.93 0.04-312 0-15.93-0.04-5.59-0.13-4.12-0.22-3.36-0.3-2.88-0.39-2.53-0.47-2.25-0.57-2.04-0.66-1.85-0.76-1.68-0.85-1.54-0.95-1.4-1.05-1.28-1.16-1.16-1.28-1.05-1.4-0.95-1.54-0.85-1.68-0.76-1.85-0.66-2.04-0.57-2.25-0.47-2.53-0.39-2.88-0.3-3.36-0.22-4.12-0.13-5.59-0.04-15.93 0-412 0.04-15.93 0.13-5.59 0.22-4.12 0.3-3.36 0.39-2.88 0.47-2.53 0.57-2.25 0.66-2.04 0.76-1.85 0.85-1.68 0.95-1.54 1.05-1.4 1.16-1.28 1.28-1.16 1.4-1.05 1.54-0.95 1.68-0.85 1.85-0.76 2.04-0.66 2.25-0.57 2.53-0.47 2.88-0.39 3.36-0.3 4.12-0.22 5.59-0.13 15.93-0.04z';
    const PATH_COMPOSER =
      'M40 0l340 0 11.8 0.03 4.14 0.1 3.05 0.16 2.49 0.22 2.13 0.29 1.88 0.35 1.67 0.42 1.51 0.49 1.36 0.56 1.25 0.63 1.14 0.7 1.04 0.78 0.94 0.87 0.87 0.94 0.78 1.04 0.7 1.14 0.63 1.25 0.56 1.36 0.49 1.51 0.42 1.67 0.35 1.88 0.29 2.13 0.22 2.49 0.16 3.05 0.1 4.14 0.03 11.8 0 18-0.03 11.8-0.1 4.14-0.16 3.05-0.22 2.49-0.29 2.13-0.35 1.88-0.42 1.67-0.49 1.51-0.56 1.36-0.63 1.25-0.7 1.14-0.78 1.04-0.87 0.94-0.94 0.87-1.04 0.78-1.14 0.7-1.25 0.63-1.36 0.56-1.51 0.49-1.67 0.42-1.88 0.35-2.13 0.29-2.49 0.22-3.05 0.16-4.14 0.1-11.8 0.03-340 0-11.8-0.03-4.14-0.1-3.05-0.16-2.49-0.22-2.13-0.29-1.88-0.35-1.67-0.42-1.51-0.49-1.36-0.56-1.25-0.63-1.14-0.7-1.04-0.78-0.94-0.87-0.87-0.94-0.78-1.04-0.7-1.14-0.63-1.25-0.56-1.36-0.49-1.51-0.42-1.67-0.35-1.88-0.29-2.13-0.22-2.49-0.16-3.05-0.1-4.14-0.03-11.8 0-18 0.03-11.8 0.1-4.14 0.16-3.05 0.22-2.49 0.29-2.13 0.35-1.88 0.42-1.67 0.49-1.51 0.56-1.36 0.63-1.25 0.7-1.14 0.78-1.04 0.87-0.94 0.94-0.87 1.04-0.78 1.14-0.7 1.25-0.63 1.36-0.56 1.51-0.49 1.67-0.42 1.88-0.35 2.13-0.29 2.49-0.22 3.05-0.16 4.14-0.1 11.8-0.03z';

    const CSS = `
#${ROOT_ID}{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#f9fafb;-webkit-font-smoothing:antialiased}
#${ROOT_ID} *{box-sizing:border-box}
#${ROOT_ID} .rta-win{position:fixed;width:420px;pointer-events:auto;display:flex;flex-direction:column;gap:14px}
#${ROOT_ID} .rta-card{position:relative;width:420px;filter:drop-shadow(0px 6px 20px rgba(0,0,0,0.302))}
#${ROOT_ID} .rta-glass{position:absolute;inset:0;clip-path:path("${PATH_MESSAGES}");backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);background:transparent;box-shadow:inset 0px 1px 0px #ffffff12}
#${ROOT_ID} .rta-card--messages{height:520px}
#${ROOT_ID} .rta-card--composer{height:98px;filter:drop-shadow(0px 4px 16px rgba(0,0,0,0.302))}
#${ROOT_ID} .rta-card--composer .rta-glass{clip-path:path("${PATH_COMPOSER}");backdrop-filter:none;-webkit-backdrop-filter:none;background:#2c2c2e;box-shadow:none}
#${ROOT_ID} .rta-edge{position:absolute;inset:0;pointer-events:none}
#${ROOT_ID} .rta-content{position:relative;display:flex;flex-direction:column;gap:12px;padding:16px}
#${ROOT_ID} .rta-content--messages{height:520px}
#${ROOT_ID} .rta-content--composer{height:98px;padding:8px 0 0 0;gap:12px}
#${ROOT_ID} .rta-header{display:flex;align-items:center;justify-content:space-between;height:24px;flex:none}
#${ROOT_ID} .rta-header__left{display:flex;align-items:center;gap:8px}
#${ROOT_ID} .rta-header__right{display:flex;align-items:center;gap:10px}
#${ROOT_ID} .rta-wordmark{font-size:15px;font-weight:700;letter-spacing:.6px;line-height:22px;color:#f9fafb}
#${ROOT_ID} .rta-pill{display:flex;align-items:center;gap:5px;height:23px;padding:3px 7px;border-radius:999px;background:rgba(255,255,255,0.059);font-size:11.5px;line-height:17px;color:#cfd3d6;white-space:nowrap}
#${ROOT_ID} .rta-dot{width:5px;height:5px;border-radius:999px;background:#22c55e;flex:none}
#${ROOT_ID} .rta-switch{display:flex;align-items:center;gap:4px;height:23px;padding:3px 8px;border-radius:8px;background:rgba(255,255,255,0.059);font-size:11.5px;line-height:17px;color:#cfd3d6;cursor:default;white-space:nowrap}
#${ROOT_ID} .rta-icon{display:block;flex:none}
#${ROOT_ID} .rta-btn{display:flex;align-items:center;justify-content:center;border:0;background:transparent;padding:0;cursor:pointer;color:#81858c}
#${ROOT_ID} .rta-btn:hover{color:#cfd3d6}
#${ROOT_ID} .rta-body{flex:1 1 0;min-height:0;display:flex;flex-direction:column;justify-content:flex-end;gap:12px;overflow:hidden}
#${ROOT_ID} .rta-watch{display:flex;flex-direction:column;gap:8px}
#${ROOT_ID} .rta-watch__label{font-size:11px;line-height:16px;color:#81858c;display:flex;align-items:center;gap:6px}
#${ROOT_ID} .rta-watch__title{font-size:16px;line-height:26px;color:#f9fafb;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
#${ROOT_ID} .rta-meta{display:flex;flex-direction:column;gap:6px;font-size:11px;line-height:16px;color:#81858c}
#${ROOT_ID} .rta-meta__row{display:flex;align-items:center;gap:6px}
#${ROOT_ID} .rta-events{display:flex;flex-direction:column;gap:4px;font-size:11px;line-height:16px;color:#81858c;max-height:72px;overflow:hidden}
#${ROOT_ID} .rta-events__row{display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .rta-events__t{color:#adb2b8;font-variant-numeric:tabular-nums;flex:none}
#${ROOT_ID} .rta-msg{font-size:11px;line-height:16px;color:#7aaaff;min-height:0;display:none}
#${ROOT_ID} .rta-msg.is-error{display:block;color:#ff9a8a}
#${ROOT_ID} .rta-status{display:flex;align-items:center;gap:6px;height:16px;flex:none;font-size:11px;line-height:16px;color:#81858c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${ROOT_ID} .rta-input{flex:none;display:flex;align-items:center;height:36px;gap:2px;padding:4px 8px 0 14px}
#${ROOT_ID} .rta-input input{flex:1 1 0;min-width:0;border:0;outline:0;background:transparent;color:#f9fafb;font-size:16px;line-height:26px;font-family:inherit;padding:0}
#${ROOT_ID} .rta-input input::placeholder{color:#81858c}
#${ROOT_ID} .rta-tools{flex:none;display:flex;align-items:center;justify-content:space-between;height:42px;padding:2px 8px 6px 8px}
#${ROOT_ID} .rta-tools__left{display:flex;align-items:center;gap:12px}
#${ROOT_ID} .rta-tools__right{display:flex;align-items:center;gap:12px}
#${ROOT_ID} .rta-add{width:28px;height:28px;border-radius:999px;background:#353638;display:flex;align-items:center;justify-content:center;border:0;cursor:default;color:#f9fafb}
#${ROOT_ID} .rta-label{display:flex;align-items:center;gap:4px;font-size:13px;line-height:19px;color:#cfd3d6;white-space:nowrap;cursor:default}
#${ROOT_ID} .rta-send{width:34px;height:34px;border-radius:999px;background:#7aaaff;display:flex;align-items:center;justify-content:center;border:0;cursor:pointer;color:#fff;transition:filter .15s ease}
#${ROOT_ID} .rta-send:hover{filter:brightness(1.06)}
#${ROOT_ID} .rta-send:active{filter:brightness(.94)}
#${ROOT_ID} .rta-pill-mini{position:fixed;right:100px;bottom:48px;display:none;align-items:center;gap:7px;height:37px;padding:0 14px;border-radius:999px;background:rgba(35,35,36,0.92);border:1px solid rgba(255,255,255,0.122);box-shadow:0px 4px 16px rgba(0,0,0,0.302);font-size:12px;color:#cfd3d6;cursor:pointer;pointer-events:auto;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
#${ROOT_ID} .rta-pill-mini.is-on{display:flex}
#${ROOT_ID} .rta-pill-mini b{font-size:12.5px;font-weight:700;letter-spacing:.4px;color:#f9fafb}
#${ROOT_ID} .rta-hidden{display:none !important}
#${ROOT_ID}.rta-overlay{position:fixed;inset:0;overflow:hidden}
#${ROOT_ID}.rta-overlay .rta-win{position:absolute;inset:0;width:auto;display:block;gap:0}
#${ROOT_ID}.rta-overlay .rta-card{position:absolute;left:20px}
#${ROOT_ID}.rta-overlay .rta-card--messages{top:20px}
#${ROOT_ID}.rta-overlay .rta-card--composer{top:554px}
#${ROOT_ID}.rta-overlay .rta-pill-mini{left:16px;top:16px;right:auto;bottom:auto}
#${ROOT_ID} .rta-btn,#${ROOT_ID} .rta-send,#${ROOT_ID} .rta-input input{-webkit-app-region:no-drag}
/* 采集渲染方案：canvas 是「卡片正后方的桌面画面 + 设计稿 blur(20px)」，
   画在设计稿渐变之下；CSS backdrop-filter 在独立窗口里采不到桌面，禁用。 */
#${ROOT_ID}.rta-overlay .rta-glass{backdrop-filter:none;-webkit-backdrop-filter:none}
#${ROOT_ID}.rta-overlay .rta-backdrop-clip{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}
#${ROOT_ID}.rta-overlay .rta-card--messages .rta-backdrop-clip{clip-path:path("${PATH_MESSAGES}")}
#${ROOT_ID}.rta-overlay .rta-backdrop{position:absolute;left:-40px;top:-40px;width:500px;height:600px;display:block;pointer-events:none;filter:blur(20px);transition:opacity .12s linear}
`;

    // 图标：设计稿里的 lucide 图标（尺寸/颜色与 pen 导出一致）
    const ICON = {
      message: ['M11 2.5H3.5A1.5 1.5 0 0 0 2 4v4.6a1.5 1.5 0 0 0 1.5 1.5h.7v2.15c0 .36.42.55.68.31L6.6 11H11a1.5 1.5 0 0 0 1.5-1.5V4A1.5 1.5 0 0 0 11 2.5Z', '#adb2b8', 11],
      chevronDown: ['M3.2 5.2 6 8l2.8-2.8', '#81858c', 12],
      chevronDownSm: ['M3.2 5.2 6 8l2.8-2.8', '#81858c', 11],
      minus: ['M2.4 7h9.2', '#81858c', 14],
      plus: ['M7 2.4v9.2M2.4 7h9.2', '#f9fafb', 14],
      arrowUp: ['M7 11.5V2.9M3.1 6.6 7 2.7l3.9 3.9', '#ffffff', 16],
    };

    function iconSvg(key) {
      const [d, color, size] = ICON[key];
      return `<svg class="rta-icon" width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="${d}" stroke="${color}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }

    function el(tag, cls, html) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (html !== undefined) node.innerHTML = html;
      return node;
    }

    function svgCard(kind) {
      const svg = document.createElementNS(HTML_NS, 'svg');
      svg.setAttribute('class', 'rta-edge');
      svg.setAttribute('width', '420');
      svg.setAttribute('height', kind === 'messages' ? '520' : '98');
      svg.setAttribute('viewBox', kind === 'messages' ? '0 0 420 520' : '0 0 420 98');
      svg.setAttribute('fill', 'none');
      const path = document.createElementNS(HTML_NS, 'path');
      path.setAttribute('d', kind === 'messages' ? PATH_MESSAGES : PATH_COMPOSER);
      path.setAttribute('stroke', '#ffffff1f');
      // 设计稿：消息卡描边 1px，输入卡描边 0.5px（pen strokeWidth 分别 1 / 0.5）。
      path.setAttribute('stroke-width', kind === 'composer' ? '0.5' : '1');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(path);
      return svg;
    }

    function buildWindow(only) {
      const root = el('div');
      root.id = ROOT_ID;

      const win = el('div', 'rta-win');
      const wantMessages = only !== 'composer';
      const wantComposer = only !== 'messages';

      // 消息卡
      const card = el('div', 'rta-card rta-card--messages');
      card.appendChild(el('div', 'rta-glass'));
      card.appendChild(svgCard('messages'));
      const content = el('div', 'rta-content rta-content--messages');

      const header = el('div', 'rta-header');
      header.innerHTML =
        `<div class="rta-header__left"><span class="rta-wordmark">RTA</span>` +
        `<span class="rta-pill" data-rta="statePill"><span class="rta-dot"></span><span data-rta="stateText">未启用</span></span></div>` +
        `<div class="rta-header__right"><span class="rta-switch">${iconSvg('message')}<span>默认对话</span>${iconSvg('chevronDownSm')}</span>` +
        `<button class="rta-btn" data-rta="collapse" title="收起">${iconSvg('minus')}</button></div>`;
      content.appendChild(header);

      const body = el('div', 'rta-body');
      body.innerHTML =
        `<div class="rta-watch"><div class="rta-watch__label"><span class="rta-dot"></span><span data-rta="watchLabel">正在观看</span></div>` +
        `<div class="rta-watch__title" data-rta="watchTitle">等待画面…</div></div>` +
        `<div class="rta-meta"><div class="rta-meta__row" data-rta="metaRow">—</div></div>` +
        `<div class="rta-events" data-rta="events"></div>` +
        `<div class="rta-msg" data-rta="msg"></div>`;
      content.appendChild(body);

      const status = el('div', 'rta-status');
      status.innerHTML = `<span class="rta-dot"></span><span data-rta="statusText">RTA 未启用</span>`;
      content.appendChild(status);

      card.appendChild(content);

      // 输入卡
      const composer = el('div', 'rta-card rta-card--composer');
      composer.appendChild(el('div', 'rta-glass'));
      composer.appendChild(svgCard('composer'));
      const ccontent = el('div', 'rta-content rta-content--composer');
      ccontent.innerHTML =
        `<div class="rta-input"><input data-rta="input" type="text" placeholder="说说你在看什么…" autocomplete="off" spellcheck="false" /></div>` +
        `<div class="rta-tools"><div class="rta-tools__left"><span class="rta-add">${iconSvg('plus')}</span>` +
        `<span class="rta-label">完全权限${iconSvg('chevronDown')}</span></div>` +
        `<div class="rta-tools__right"><span class="rta-label">V4.1-Flash${iconSvg('chevronDown')}</span>` +
        `<button class="rta-send" data-rta="send" title="发送">${iconSvg('arrowUp')}</button></div></div>`;
      composer.appendChild(ccontent);

      // 全局浮窗模式：一张卡一个原生窗口（系统亚克力只能整窗生效），只渲染自己那张。
      if (wantMessages) win.appendChild(card);
      if (wantComposer) win.appendChild(composer);
      root.appendChild(win);

      // 收起态的小胶囊只在「DSH 页面内」使用；全局浮窗没有收起到任务栏的语义。
      if (!only) {
        const mini = el('div', 'rta-pill-mini');
        mini.innerHTML = `<span class="rta-dot"></span><b>RTA</b><span data-rta="miniText">00:00</span>`;
        root.appendChild(mini);
      }

      return root;
    }

    function fmtClock(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const mm = String(m).padStart(2, '0');
      const ss = String(s).padStart(2, '0');
      return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }

    function fmtBytes(bytes) {
      const n = Number(bytes) || 0;
      if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
      return `${n} B`;
    }

    // ---- 采集渲染（全局浮窗）：桌面画面 → 只取消息卡正后方 → 设计稿 blur(20px) → canvas ----
    // 独立窗口里的 CSS backdrop-filter 采不到桌面；所以由这里用 getDisplayMedia 捕获，
    // 预模糊后贴在设计稿渐变层下面。不能用 setContentProtection 挖掉自己：远程桌面
    // 本质就是抓屏，开了它用户就看不到窗口；自反馈改由 maskSelf() 把卡片区域替换掉。
    function startLiveBackdrop(root) {
      const bridge = typeof window !== 'undefined' ? window.__rtaOverlay : null;
      const card = root.querySelector('.rta-card--messages');
      if (!card || typeof document === 'undefined') return null;

      const clip = document.createElement('div');
      clip.className = 'rta-backdrop-clip';
      const canvas = document.createElement('canvas');
      canvas.className = 'rta-backdrop';
      clip.appendChild(canvas);
      card.insertBefore(clip, card.firstChild);
      const g2d = canvas.getContext('2d', { alpha: true, desynchronized: true });

      // 帧差检测：桌面静止时 WGC 因为本窗重绘而反复给「内容相同」的帧，
      // 全部重画会把 CPU 白烧掉。先用 32×20 缩略图比对，没变化就不重画（画面本来就静止）。
      const probe = document.createElement('canvas');
      probe.width = 32;
      probe.height = 20;
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      let lastProbe = null;
      const PROBE_W = 32;
      const PROBE_H = 20;
      const PROBE_TOL = 1.5;

      let stream = null;
      let video = null;
      let geo = null;
      let displayId = null;
      let running = true;
      let paused = false;
      let acquiring = false;
      let refreshTimer = null;
      let pendingReveal = false;
      let offGeometry = null;
      let offVisible = null;

      // 玻璃背板的两种来源：
      //  - window：捕获「前台窗口」的窗口流。窗口捕获不含置顶的浮窗自己 → 没有自反馈、
      //    不需要 setContentProtection（远程桌面下也能看到浮窗），拖动时内容连续、稳定。
      //  - screen：整屏流 + maskSelf 遮罩。仅当前台窗口拿不到时兜底。
      let mode = 'screen';
      let fg = null;      // 前台窗口 { title, rect, process }
      let targetId = null; // 正在捕获的窗口 source id
      let pollTimer = null;
      let acquiringWindow = false;

      const BLUR = 20; // 设计稿 blur(20px)
      const EXPAND = 40; // 源区域向外多取 2×模糊半径，避免边缘采样不足出现暗边

      function logWarn() {
        try { console.warn('[rta]', ...arguments); } catch { /* ignore */ }
      }

      // ---- 前台窗口流（首选背板）----
      // 窗口捕获（WGC window item）只含窗口自己的内容，不含盖在它上面的置顶浮窗 →
      // 没有自反馈、不需要 setContentProtection（远程桌面下浮窗仍可见），且坐标只由
      // 「前台窗口的屏幕矩形」决定，拖动浮窗时内容连续，不会跳变。
      async function fetchState() {
        try {
          const res = await fetch(rtaUrl('/api/dsh-rta/state'), { cache: 'no-store' });
          if (!res.ok) return null;
          return await res.json();
        } catch { return null; }
      }

      function rectOf(r) {
        if (!r) return null;
        const x = Number(r.x ?? r.left ?? 0);
        const y = Number(r.y ?? r.top ?? 0);
        const width = Number(r.width ?? ((r.right ?? 0) - x));
        const height = Number(r.height ?? ((r.bottom ?? 0) - y));
        if (!(width > 0) || !(height > 0)) return null;
        return { x, y, width, height };
      }

      async function acquireWindow(sourceId) {
        if (acquiringWindow || !running) return;
        acquiringWindow = true;
        try {
          stopStream();
          const s = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: sourceId,
                maxWidth: 4096,
                maxHeight: 4096,
                maxFrameRate: 30,
              },
            },
          });
          if (!running) { s.getTracks().forEach((t) => t.stop()); return; }
          stream = s;
          targetId = sourceId;
          mode = 'window';
          video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.srcObject = s;
          await video.play();
          s.getVideoTracks().forEach((t) => {
            t.addEventListener('ended', () => {
              if (running) setTimeout(() => { targetId = null; void refreshForeground(); }, 500);
            });
          });
          logWarn('window capture start', sourceId, video.videoWidth + 'x' + video.videoHeight);
          pendingReveal = true;
          canvas.style.opacity = '1';
          drawFrame();
          loop();
        } catch (err) {
          logWarn('window capture failed', err && err.message ? err.message : String(err));
          targetId = null;
          mode = 'screen';
          if (running) setTimeout(() => { void acquire(); }, 600);
        } finally {
          acquiringWindow = false;
        }
      }

      async function pickWindowSource() {
        if (!fg || !bridge || typeof bridge.windowSources !== 'function') return;
        let sources = [];
        try { sources = await bridge.windowSources(); } catch { sources = []; }
        if (!Array.isArray(sources) || !sources.length) return;
        const want = String(fg.title || '');
        if (!want) return;
        const hit = sources.find((s) => s.name === want)
          || sources.find((s) => s.name && s.name.length >= 8 && want.startsWith(s.name))
          || sources.find((s) => s.name && s.name.length >= 8 && want.includes(s.name));
        if (!hit || !hit.id) return;
        if (hit.id === targetId && video) return;
        await acquireWindow(hit.id);
      }

      async function refreshForeground() {
        if (!running) return;
        // 1) 首选：主进程直接用 Win32 查前台窗口（标题 + 屏幕矩形）。不依赖 host 版本，
        //    DSH 没重启（state 里还没有 foreground.rect）时窗口捕获也能工作。
        let f = null;
        if (bridge && typeof bridge.foregroundWindow === 'function') {
          try { f = await bridge.foregroundWindow(); } catch { f = null; }
        }
        // 2) 兜底：插件 host 的 /api/dsh-rta/state（新版 host 才带 foreground.rect）。
        if (!f || !f.rect) {
          const st = await fetchState();
          const s = st && st.foreground ? st.foreground : null;
          if (s && s.rect) f = s;
        }
        const rect = rectOf(f && f.rect);
        if (!f || !f.title || !rect) {
          if (mode === 'window') { mode = 'screen'; targetId = null; void acquire(); }
          return;
        }
        // 前台是我们自己的浮窗（用户正在拖动/在输入框里打字）时沿用上一次的目标窗口，
        // 这样拖动浮窗不会换捕获源，玻璃内容保持连续。
        if (/^RTA$/i.test(String(f.title))) return;
        fg = { title: String(f.title), rect, process: f.process ?? null };
        await pickWindowSource();
      }

      function sizeCanvas() {
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        // canvas 比卡片四周各大 EXPAND：模糊需要的边缘采样在卡片外，裁剪交给 .rta-backdrop-clip
        const w = Math.max(1, Math.round((420 + EXPAND * 2) * dpr));
        const h = Math.max(1, Math.round((520 + EXPAND * 2) * dpr));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        drawFrame();
      }

      // 自反馈消除：卡片正后方在捕获画面里就是「我们自己的玻璃」。直接拿它当背板
      // 会递归采样自己（几帧后整卡糊成灰白）。这里把卡片区域换成屏幕上一块干净的
      // 同尺寸画面（优先下方/上方同列，其次左右），再交给 CSS blur(20px)。
      // 因为最终要模糊 20px，替换块和真实背景的差异会被抹成色块，不会出现可读文字。
      function maskSelf({ sx, sy, sw, sh, expand, ppd, db, geo }) {
        const cw = canvas.width;
        const ch = canvas.height;
        const scaleX = cw / (sw + expand * 2);
        const scaleY = ch / (sh + expand * 2);
        const innerX = expand * scaleX;
        const innerY = expand * scaleY;
        const innerW = sw * scaleX;
        const innerH = sh * scaleY;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const wx = (geo.window.x - db.x) * ppd;
        const wy = (geo.window.y - db.y) * ppd;
        const ww = geo.window.width * ppd;
        const wh = geo.window.height * ppd;
        const gap = Math.max(4, Math.round(expand * 0.25));
        // 候选区域必须落在「整个窗口矩形之外」（窗口自身含 20px 阴影留白 + 输入卡，
        // 只避开卡片矩形的话会采到自己的 composer/玻璃，形成自反馈）。同一列上下优先，
        // 因为文字页/聊天流里上下方内容风格最接近，模糊后最像真实背景。
        const outGap = gap * 2;
        const candidates = [
          { x: sx, y: wy + wh + outGap },
          { x: sx, y: wy - outGap - sh },
          { x: wx + ww + outGap, y: sy },
          { x: wx - outGap - sw, y: sy },
        ];
        const usable = (c) => c.x >= 0 && c.y >= 0 && c.x + sw <= vw && c.y + sh <= vh
          && (c.x + sw <= wx || c.x >= wx + ww || c.y + sh <= wy || c.y >= wy + wh);
        const pick = candidates.find(usable);
        if (pick) {
          try {
            g2d.save();
            g2d.filter = `blur(${Math.round(BLUR * 0.7)}px)`;
            g2d.drawImage(video, pick.x, pick.y, sw, sh, innerX, innerY, innerW, innerH);
            g2d.restore();
            return;
          } catch { /* 落到兜底填充 */ }
        }
        try {
          const px = g2d.getImageData(
            Math.max(0, Math.floor(innerX / 2)),
            Math.floor(innerY + innerH / 2),
            1, 1,
          ).data;
          g2d.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`;
          g2d.fillRect(innerX, innerY, innerW, innerH);
        } catch { /* ignore */ }
      }

      // 源矩形：单位是捕获流像素。窗口模式按「前台窗口物理矩形」换算，
      // 整屏兜底按显示器 bounds 换算。
      function sourceRect() {
        if (!geo || !video || !video.videoWidth) return null;
        const cardGeo = (geo.cards || []).find((c) => c.kind === 'messages');
        if (!cardGeo) return null;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const s = geo.display.scaleFactor || 1;
        if (mode === 'window' && fg && fg.rect && fg.rect.width > 0) {
          const ppd = vw / fg.rect.width; // 流像素 / 屏幕物理像素
          return {
            vw, vh, s, ppd,
            sx: ((geo.window.x + cardGeo.x) * s - fg.rect.x) * ppd,
            sy: ((geo.window.y + cardGeo.y) * s - fg.rect.y) * ppd,
            sw: cardGeo.width * s * ppd,
            sh: cardGeo.height * s * ppd,
            expand: EXPAND * s * ppd,
            db: null,
          };
        }
        const db = geo.display.bounds;
        const ppd = vw / db.width;
        return {
          vw, vh, s, ppd, db,
          sx: (geo.window.x + cardGeo.x - db.x) * ppd,
          sy: (geo.window.y + cardGeo.y - db.y) * ppd,
          sw: Math.max(1, cardGeo.width * ppd),
          sh: Math.max(1, cardGeo.height * ppd),
          expand: EXPAND * ppd,
        };
      }

      function drawFrame() {
        if (paused || !g2d || !geo || !video || video.readyState < 2 || !video.videoWidth) return;
        const r = sourceRect();
        if (!r) return;
        const cw = canvas.width;
        const ch = canvas.height;
        const { vw, vh, expand, sx, sy, sw, sh } = r;
        const fullW = sw + expand * 2;
        const fullH = sh + expand * 2;
        // 卡片可能比前台窗口还大（或贴边）：源矩形夹到视频范围内，目标矩形等比同步缩放，
        // 不做二次拉伸，保证屏幕坐标严格对齐。
        const srcX = Math.max(0, sx - expand);
        const srcY = Math.max(0, sy - expand);
        const srcR = Math.min(vw, sx + sw + expand);
        const srcB = Math.min(vh, sy + sh + expand);
        if (srcR <= srcX || srcB <= srcY) return;
        const dstX = ((srcX - (sx - expand)) / fullW) * cw;
        const dstY = ((srcY - (sy - expand)) / fullH) * ch;
        const dstW = ((srcR - srcX) / fullW) * cw;
        const dstH = ((srcB - srcY) / fullH) * ch;

        // 帧差检测（先缩小到 32×20 再比）：没变化就直接省掉这一帧的重绘。
        let changed = true;
        try {
          pctx.drawImage(video, srcX, srcY, srcR - srcX, srcB - srcY, 0, 0, PROBE_W, PROBE_H);
          const data = pctx.getImageData(0, 0, PROBE_W, PROBE_H).data;
          if (lastProbe) {
            let sum = 0;
            for (let i = 0; i < data.length; i += 4) {
              sum += Math.abs(data[i] - lastProbe[i])
                + Math.abs(data[i + 1] - lastProbe[i + 1])
                + Math.abs(data[i + 2] - lastProbe[i + 2]);
            }
            changed = sum / (PROBE_W * PROBE_H * 3) > PROBE_TOL;
          } else {
            lastProbe = new Uint8ClampedArray(PROBE_W * PROBE_H * 4);
          }
          lastProbe.set(data);
        } catch { changed = true; }
        if (!changed && !pendingReveal) return;

        g2d.setTransform(1, 0, 0, 1, 0, 0);
        g2d.clearRect(0, 0, cw, ch);
        // 窗口模式下卡片若超出前台窗口，超出部分是「没有画面」的：用深色垫底。
        if (mode === 'window' && (dstX > 0 || dstY > 0 || dstX + dstW < cw || dstY + dstH < ch)) {
          g2d.fillStyle = '#0e0e10';
          g2d.fillRect(0, 0, cw, ch);
        }
        try {
          // 不在这里做 blur：把「卡片 + 四周 40px」整块清晰画面画进 canvas，
          // 由 CSS `filter:blur(20px)` 在合成器上做（GPU、严格 20 CSS px、一帧一次）。
          g2d.drawImage(video, srcX, srcY, srcR - srcX, srcB - srcY, dstX, dstY, dstW, dstH);
        } catch {
          /* 视频帧还没就绪 */
        }
        if (mode === 'screen') {
          maskSelf({ sx, sy, sw, sh, expand, ppd: r.ppd, db: r.db, geo });
        }
        if (pendingReveal) {
          pendingReveal = false;
          canvas.style.opacity = '1';
        }
      }

      function loop() {
        if (!running) return;
        drawFrame();
        if (video && typeof video.requestVideoFrameCallback === 'function') {
          video.requestVideoFrameCallback(loop);
        } else {
          requestAnimationFrame(loop);
        }
      }

      function stopStream() {
        if (video) {
          try { video.pause(); } catch { /* ignore */ }
          try { video.srcObject = null; } catch { /* ignore */ }
          video = null;
        }
        if (stream) {
          try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
          stream = null;
        }
      }

      async function acquire() {
        if (acquiring || !running || !geo) return;
        acquiring = true;
        try {
          stopStream();
          const s = await navigator.mediaDevices.getDisplayMedia({
            audio: false,
            // 玻璃只需要「卡片 + 40px」那一小块，且最终一定被 blur(20px) 糊掉：
            // 30fps + 720p 足够，能显著降低捕获/合成成本（实测 42fps@1440p 会占 ~70% CPU）。
            video: {
              frameRate: { ideal: 30, max: 30 },
              width: { max: 640 },
              height: { max: 360 },
            },
          });
          if (!running) { s.getTracks().forEach((t) => t.stop()); return; }
          stream = s;
          displayId = geo.display.id;
          video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.srcObject = s;
          await video.play();
          s.getVideoTracks().forEach((t) => {
            t.addEventListener('ended', () => { if (running) setTimeout(() => { void acquire(); }, 800); });
          });
          logWarn('capture start', video.videoWidth + 'x' + video.videoHeight);
          loop();
        } catch (err) {
          logWarn('capture failed', err && err.message ? err.message : String(err));
          if (running) setTimeout(() => { void acquire(); }, 1000);
        } finally {
          acquiring = false;
        }
      }

      async function syncGeometry(next) {
        try {
          const g = next || (bridge && typeof bridge.geometry === 'function' ? await bridge.geometry() : null);
          if (!g || !running) return;
          const changedDisplay = displayId !== null && displayId !== g.display.id;
          geo = g;
          if (mode === 'window' && video) {
            // 窗口流和浮窗位置无关：拖动只需按新位置重新采样，不用重开流（不会黑一下/跳变）。
            if (changedDisplay) { displayId = g.display.id; void refreshForeground(); }
            drawFrame();
            return;
          }
          if (!video) { void acquire(); return; }
          if (changedDisplay) {
            canvas.style.opacity = '0';
            pendingReveal = true;
            void acquire();
            return;
          }
          if (next) {
            // 整屏兜底：窗口移动后旧帧对应旧位置，而 WGC 在静止桌面上不会主动产新帧；
            // 先隐藏（露出清晰桌面），停手 220ms 后重开捕获流拿一张新位置的整帧。
            canvas.style.opacity = '0';
            pendingReveal = true;
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => { if (running) void acquire(); }, 220);
          } else {
            drawFrame();
          }
        } catch (err) {
          logWarn('geometry failed', err && err.message ? err.message : String(err));
        }
      }

      sizeCanvas();
      window.addEventListener('resize', sizeCanvas);
      if (bridge) {
        if (typeof bridge.onGeometry === 'function') {
          offGeometry = bridge.onGeometry((g) => { void syncGeometry(g); });
        }
        if (typeof bridge.onVisible === 'function') {
          offVisible = bridge.onVisible((visible) => {
            paused = !visible;
            if (!paused) void syncGeometry();
          });
        }
      }
      void syncGeometry();
      // 前台窗口变化（切应用/换标题）→ 换窗口流；500ms 轮询对 CPU 可忽略。
      void refreshForeground();
      pollTimer = setInterval(() => { void refreshForeground(); }, 500);

      return {
        stop() {
          running = false;
          if (refreshTimer) clearTimeout(refreshTimer);
          if (pollTimer) clearInterval(pollTimer);
          window.removeEventListener('resize', sizeCanvas);
          if (typeof offGeometry === 'function') offGeometry();
          if (typeof offVisible === 'function') offVisible();
          stopStream();
          try { clip.remove(); } catch { /* ignore */ }
        },
      };
    }

    function apply(ctx) {
      const doc = document;
      if (!doc || !doc.body) return () => {};
      doc.getElementById(ROOT_ID)?.remove();

      if (!doc.getElementById(STYLE_ID)) {
        const style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (doc.head ?? doc.documentElement).appendChild(style);
      }

      // 全局浮窗：一张卡一个窗口（window.html 会注入 __RTA_CARD__）。
      const CARD =
        typeof window !== 'undefined' && window.__RTA_CARD__ ? String(window.__RTA_CARD__) : null;
      const root = buildWindow(CARD || undefined);
      doc.body.appendChild(root);

      const q = (sel) => root.querySelector(`[data-rta="${sel}"]`);
      const ui = {
        win: root.querySelector('.rta-win'),
        stateText: q('stateText'),
        watchTitle: q('watchTitle'),
        watchLabel: q('watchLabel'),
        metaRow: q('metaRow'),
        events: q('events'),
        msg: q('msg'),
        statusText: q('statusText'),
        input: q('input'),
        send: q('send'),
        collapse: q('collapse'),
        mini: root.querySelector('.rta-pill-mini'),
        miniText: q('miniText'),
      };

      let stopped = false;
      let timer = null;
      let collapsed = false;
      let dragging = false;
      let current = null;

      // Electron 全局浮窗模式（ui/overlay/window.html 注入 __RTA_OVERLAY__）：
      // 窗口是透明置顶窗（无系统材质）；模糊由 startLiveBackdrop() 的采集背板提供。
      //  - 渲染层采集（回退）：startLiveBackdrop() 抓前台窗口 → canvas 预模糊 → 垫在设计稿渐变下。
      const OVERLAY = typeof window !== 'undefined' && window.__RTA_OVERLAY__ === true;
      const nativeBridge = OVERLAY && typeof window !== 'undefined' ? window.__rtaOverlay : null;
      if (OVERLAY) root.classList.add('rta-overlay');
      const liveBackdrop = OVERLAY ? startLiveBackdrop(root) : null;

      // 位置记忆（拖动后保存）；默认按设计稿在 1280 宽画布上的落点换算成右侧 100 / 顶部 88
      if (OVERLAY) {
        // 卡片窗口自己就是卡片，内容从 (0,0) 开始，窗口位置由 main 进程管理。
        ui.win.style.left = '0';
        ui.win.style.top = '0';
      } else {
        try {
          const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
          if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
            ui.win.style.left = `${saved.left}px`;
            ui.win.style.top = `${saved.top}px`;
          } else {
            ui.win.style.right = '100px';
            ui.win.style.top = '88px';
          }
        } catch {
          ui.win.style.right = '100px';
          ui.win.style.top = '88px';
        }
      }

      function clampPosition(left, top) {
        const w = 420;
        const h = 632;
        const maxLeft = Math.max(8, window.innerWidth - w - 8);
        const maxTop = Math.max(8, window.innerHeight - h - 8);
        return {
          left: Math.min(Math.max(8, left), maxLeft),
          top: Math.min(Math.max(8, top), maxTop),
        };
      }

      function positionFromRect() {
        const rect = ui.win.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
      }

      function setCollapsed(next) {
        collapsed = next === true;
        ui.win.classList.toggle('rta-hidden', collapsed);
        // 设计稿：点 − 收起为右下角胶囊（保留会话计时），点胶囊恢复。
        // 全局浮窗里胶囊不是页面内定位，而是让主进程把窗口缩成胶囊大小并锚到屏幕右下角。
        if (ui.mini) ui.mini.classList.toggle('is-on', collapsed && root.dataset.active === '1');
        if (OVERLAY && nativeBridge && typeof nativeBridge.setCollapsed === 'function') {
          try { nativeBridge.setCollapsed(collapsed); } catch { /* ignore */ }
        }
      }

      function setActive(active) {
        root.dataset.active = active ? '1' : '0';
        if (!active) {
          if (collapsed) {
            // RTA 停了：先恢复展开态，避免下次启动时窗口还缩在胶囊尺寸。
            collapsed = false;
            ui.win.classList.remove('rta-hidden');
            if (OVERLAY && nativeBridge && typeof nativeBridge.setCollapsed === 'function') {
              try { nativeBridge.setCollapsed(false); } catch { /* ignore */ }
            }
          }
          ui.win.classList.add('rta-hidden');
          if (ui.mini) ui.mini.classList.remove('is-on');
          return;
        }
        ui.win.classList.toggle('rta-hidden', collapsed);
        if (ui.mini) ui.mini.classList.toggle('is-on', collapsed);
      }

      function render(state) {
        current = state;
        const active = state?.active === true;
        setActive(active);
        // 输入卡窗口只有输入区：状态/消息/观看信息全部由消息卡窗口展示。
        if (CARD === 'composer') return;
        if (!active) {
          ui.statusText.textContent = 'RTA 未启用';
          return;
        }
        const startedAt = Number(state?.session?.startedAt) || 0;
        const elapsed = startedAt > 0 ? (Number(state.serverTime) || Date.now()) - startedAt : 0;
        const clock = fmtClock(elapsed);
        ui.stateText.textContent = `已启用 ${clock}`;
        // mini 胶囊只在页内浮层存在；全局浮窗一张卡一个窗口，没有 mini。
        if (ui.miniText) ui.miniText.textContent = clock;

        const title = state?.foreground?.title || '当前屏幕';
        ui.watchTitle.textContent = title;
        ui.watchLabel.textContent = '正在观看';

        const cap = state?.capture ?? {};
        const pieces = [`${Number(cap.tickHz) > 0 ? Number(cap.tickHz).toFixed(1) : '15'} Hz`];
        if (cap.archived) pieces.push(`${cap.archived} 帧已归档`);
        if (state?.video?.bytes) pieces.push(fmtBytes(state.video.bytes));
        ui.metaRow.textContent = pieces.join(' · ');

        const events = Array.isArray(state?.recentEvents) ? state.recentEvents.slice(-3) : [];
        ui.events.innerHTML = events
          .map((ev) => {
            const t = Number(ev?.at) || 0;
            const clockText = t > 0 ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--';
            const kind = String(ev?.kind ?? 'event');
            const size = ev?.width && ev?.height ? ` · ${ev.width}×${ev.height}` : '';
            return `<div class="rta-events__row"><span class="rta-events__t">${clockText}</span><span>${kind}${size}</span></div>`;
          })
          .join('');

        const process = state?.foreground?.process ? ` · ${state.foreground.process}` : '';
        ui.statusText.textContent = `正在观看 ${title}${process}`;
      }

      async function poll() {
        if (stopped) return;
        try {
          const response = await fetch(rtaUrl('/api/dsh-rta/state'), {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
          });
          if (response.ok) {
            const state = await response.json();
            if (!stopped) render(state);
          } else if (!stopped) {
            // 数据面不可用（路由未注册 / 未授权）：按未启用处理，绝不让空窗留在屏幕上。
            render({ active: false });
          }
        } catch {
          /* 宿主不支持或暂时不可达：按未启用处理，下一轮再试 */
          if (!stopped) render({ active: false });
        }
        if (!stopped) timer = setTimeout(poll, POLL_MS);
      }

      function showMessage(text, isError = false) {
        ui.msg.textContent = text || '';
        ui.msg.classList.toggle('is-error', Boolean(isError));
      }

      async function send() {
        const text = String(ui.input.value ?? '').trim();
        if (!text) return;
        ui.send.disabled = true;
        showMessage('');
        try {
          const response = await fetch(rtaUrl('/api/dsh-rta/say'), {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          });
          const out = await response.json().catch(() => ({}));
          if (out?.ok) {
            ui.input.value = '';
            showMessage('已发送');
            setTimeout(() => showMessage(''), 1600);
          } else if (out?.reason === 'no-agent') {
            showMessage('还没有活动会话：先在 DSH 里打开一个对话', true);
          } else if (out?.reason === 'empty') {
            /* 空输入不提示 */
          } else {
            showMessage(`发送失败：${out?.reason ?? response.status}`, true);
          }
        } catch {
          showMessage('发送失败：宿主不可达', true);
        } finally {
          ui.send.disabled = false;
        }
      }

      // 拖拽（header 按下）
      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        if (event.target.closest('button')) return;
        const rect = ui.win.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;
        dragging = true;
        ui.win.style.right = '';
        const move = (ev) => {
          if (!dragging) return;
          const pos = clampPosition(ev.clientX - offsetX, ev.clientY - offsetY);
          ui.win.style.left = `${pos.left}px`;
          ui.win.style.top = `${pos.top}px`;
        };
        const up = () => {
          dragging = false;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          try {
            localStorage.setItem(POS_KEY, JSON.stringify(positionFromRect()));
          } catch { /* ignore */ }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };

      const onCollapse = (event) => {
        event.preventDefault();
        event.stopPropagation();
        setCollapsed(true);
      };
      const onMini = () => setCollapsed(false);
      const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault();
          void send();
        }
      };

      const headerEl = ui.win.querySelector('.rta-header');
      if (headerEl && OVERLAY) {
        // 原生窗口拖动：header 可拖，按钮在 window.html 里单独设 no-drag
        headerEl.style.setProperty('-webkit-app-region', 'drag');
      } else {
        headerEl?.addEventListener('pointerdown', onPointerDown);
      }
      ui.collapse?.addEventListener('click', onCollapse);
      // 收起胶囊只在页内浮层可用；全局浮窗一张卡一个窗口，收起/展开没有对应形态。
      if (CARD) {
        if (ui.collapse) ui.collapse.style.display = 'none';
        ui.collapse?.removeEventListener('click', onCollapse);
      } else {
        ui.mini?.addEventListener('click', onMini);
      }
      ui.send?.addEventListener('click', () => void send());
      ui.input?.addEventListener('keydown', onKeyDown);

      // 打开时把窗口拉进视口（浮窗模式的窗口尺寸由原生窗口决定，固定 20px 边距，不参与页面内 clamp）
      if (!OVERLAY) {
        const pos = clampPosition(ui.win.getBoundingClientRect().left, ui.win.getBoundingClientRect().top);
        if (ui.win.style.right === '') {
          ui.win.style.left = `${pos.left}px`;
          ui.win.style.top = `${pos.top}px`;
        }
      }

      // 默认隐藏：只有宿主明确回报 active=true 才出现（用户要求：仅 RTA 启动时出现）。
      setActive(false);
      void poll();

      const cleanup = () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        liveBackdrop?.stop();
        ui.win.querySelector('.rta-header')?.removeEventListener('pointerdown', onPointerDown);
        ui.collapse?.removeEventListener('click', onCollapse);
        ui.mini?.removeEventListener('click', onMini);
        ui.input?.removeEventListener('keydown', onKeyDown);
        root.remove();
      };

      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => cleanup, 'dsh-rta: floating window');
        return undefined;
      }
      return cleanup;
    }

    const exports_ = { name, inject, apply };
    return exports_;
  },
});
