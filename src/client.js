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
#${ROOT_ID} .rta-glass{position:absolute;inset:0;clip-path:path("${PATH_MESSAGES}");backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);background:rgba(20,20,22,0.55);box-shadow:inset 0px 1px 0px #ffffff12}
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
#${ROOT_ID}.rta-overlay .rta-card{position:absolute;left:40px}
#${ROOT_ID}.rta-overlay .rta-card--messages{top:40px}
#${ROOT_ID}.rta-overlay .rta-card--composer{top:574px}
#${ROOT_ID}.rta-overlay .rta-pill-mini{left:16px;top:16px;right:auto;bottom:auto}
#${ROOT_ID} .rta-btn,#${ROOT_ID} .rta-send,#${ROOT_ID} .rta-input input{-webkit-app-region:no-drag}
/* 独立透明窗口没有可采样的背景：不做采集、不做 backdrop-filter。 */
#${ROOT_ID}.rta-overlay .rta-glass{backdrop-filter:none;-webkit-backdrop-filter:none}
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
      const OVERLAY = typeof window !== 'undefined' && window.__RTA_OVERLAY__ === true;
      const nativeBridge = OVERLAY && typeof window !== 'undefined' ? window.__rtaOverlay : null;
      if (OVERLAY) root.classList.add('rta-overlay');
      // 采集背板已移除（设计难度与成本不值得）：浮窗只保留设计稿图层（透明 + 描边/高光/外阴影）。

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
