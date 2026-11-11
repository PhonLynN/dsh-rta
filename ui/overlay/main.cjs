/**
 * ui/overlay/main.cjs — RTA 全局浮窗的 Electron 宿主。
 *
 * 路线（用户拍板，2026-11）：**采集渲染方案**。
 *  - 窗口：透明置顶、不使用任何系统材质；
 *  - 玻璃：渲染层用 getDisplayMedia 捕获桌面 → 只取两张卡正后方的区域 →
 *    按设计稿 `blur(20px)` 预模糊后画进 canvas → 设计稿图层（渐变/描边/squircle/
 *    阴影）原样叠在上面。桌面在卡片区域之外仍然清晰透出。
 *  - 自反馈：窗口开 `setContentProtection(true)`（WDA_EXCLUDEFROMCAPTURE），
 *    抓屏里本窗口被挖掉、只留它背后的真实画面，否则会把自己的玻璃再糊一遍。
 *    代价：用户的截图/录屏里也看不到这个浮窗（DSH_RTA_OVERLAY_CP=0 可关闭，仅调试用）。
 *  - 对齐：渲染层通过 preload 取窗口 bounds + 所在显示器 bounds/scaleFactor，
 *    把「卡片在窗口内的位置」换算成捕获流里的像素坐标。
 *  - 一个窗口装两张卡（420×520 + 420×98 + 14 gap），四周 20px 给设计稿外阴影；
 *    卡外空白/缝隙点击穿透。
 */

const { app, BrowserWindow, screen, session, desktopCapturer, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 浮窗进程的诊断日志：GUI 进程静默退出时，这是唯一能看到走到哪一步的地方。
const LOG_FILE = path.join(os.homedir(), '.dsh', 'rta', 'logs', 'overlay-main.log');
function log(...parts) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${parts.join(' ')}\n`); } catch { /* ignore */ }
}
process.on('uncaughtException', (err) => { log('uncaughtException', err && err.stack ? err.stack : String(err)); });
process.on('unhandledRejection', (err) => { log('unhandledRejection', err && err.stack ? err.stack : String(err)); });

// 清掉上一次遗留的浮窗（例如插件重启后留下的旧实例）。只杀「命令行里带本插件 ui\overlay 的
// electron 进程」，按 PID 精确排除自己，绝不误杀 DSH 主进程/用户浏览器。
// 注意：taskkill 不支持 WINDOWTITLE 过滤器，用它当清理手段会静默失败、多实例越积越多。
function killStaleWindows() {
  try {
    const script = [
      '$me = ' + String(process.pid) + ';',
      'Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" |',
      '  Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -match \'dsh-rta\' -and $_.CommandLine -match \'ui[\\\\/]overlay\' } |',
      '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };',
    ].join(' ');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    log('stale overlay instances cleared');
  } catch (err) {
    log('stale overlay cleanup skipped', String((err && err.status) || ''));
  }
}

// ---- 前台窗口信息（渲染层窗口捕获背板需要）----
// 正常路径：插件 host 的 /api/dsh-rta/state 里带 foreground.rect（engine 每秒采集）。
// 兜底路径：host 还是旧版（没重启）时 state 里没有 rect，这里直接用 Win32 查，
// 免得「必须重启 DSH 才能用」。koffi 是 DSH 桌面版自带依赖（app.asar.unpacked），
// 浮窗是独立 Electron 进程，按绝对路径加载；加载失败就返回 null，渲染层回落整屏模式。
let win32api = null;
function loadWin32() {
  if (win32api !== null) return win32api;
  const candidates = [];
  if (process.env.DSH_KOFFI_PATH) candidates.push(process.env.DSH_KOFFI_PATH);
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources',
      'app.asar.unpacked', 'dsh', 'node_modules', 'koffi', 'index.cjs'));
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi', 'index.cjs'));
  }
  const errors = [];
  let koffi = null;
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) { errors.push('missing ' + file); continue; }
      koffi = require(file);
      break;
    } catch (err) {
      errors.push(String(err && err.message ? err.message : err));
    }
  }
  if (!koffi) {
    log('win32 ffi unavailable', errors.join(' | '));
    win32api = false;
    return win32api;
  }
  try {
    const user32 = koffi.load('user32.dll');
    const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    win32api = {
      GetForegroundWindow: user32.func('void* GetForegroundWindow()'),
      GetWindowRect: user32.func('bool GetWindowRect(void* hWnd, _Out_ RECT* lpRect)'),
      GetWindowTextW: user32.func('int GetWindowTextW(void* hWnd, _Out_ uint16_t* lpString, int nMaxCount)'),
    };
    log('win32 ffi ready');
  } catch (err) {
    log('win32 ffi failed', String(err && err.stack ? err.stack : err));
    win32api = false;
  }
  return win32api;
}

function foregroundWindowInfo() {
  const api = loadWin32();
  if (!api) return null;
  try {
    const hwnd = api.GetForegroundWindow();
    if (!hwnd) return null;
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!api.GetWindowRect(hwnd, rect)) return null;
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (!(width > 0) || !(height > 0)) return null;
    const buf = new Uint16Array(512);
    const n = api.GetWindowTextW(hwnd, buf, 512);
    const title = n > 0 ? Buffer.from(buf.buffer, 0, n * 2).toString('utf16le') : '';
    return { title, rect: { x: rect.left, y: rect.top, width, height }, hwnd: String(hwnd) };
  } catch (err) {
    log('foreground window failed', String(err && err.message ? err.message : err));
    return null;
  }
}

const HAS_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!HAS_SINGLE_INSTANCE_LOCK) log('another overlay instance is running; this one will exit');

const ENDPOINT = (process.env.RTA_OVERLAY_ENDPOINT || '').replace(/\/+$/, '');
const TOKEN = process.env.RTA_OVERLAY_TOKEN || '';

// ---- 设计稿尺寸（pen 导出 rta-reference.html） ----
const CARD_MESSAGES = { width: 420, height: 520 };
const CARD_COMPOSER = { width: 420, height: 98 };
const CARD_GAP = 14;
const PAD = 20; // 设计稿外阴影 blur 20 / offset 6，四周留 20px 才画得下
const WIN_WIDTH = CARD_MESSAGES.width + PAD * 2; // 460
const WIN_HEIGHT = PAD + CARD_MESSAGES.height + CARD_GAP + CARD_COMPOSER.height + PAD; // 672

const POLL_MS = 700;
const MAX_MISSES = 8; // ≈5s 连不上插件 → 隐藏窗口，避免孤儿窗
const HIT_TEST_MS = 60; // 鼠标命中测试节拍（决定点击穿透）

// ---- 收起态（设计稿「点 − 收起为右下角胶囊」）----
// 胶囊按设计尺寸渲染，窗口缩到胶囊大小，锚定在当前显示器右下角（right:100 / bottom:48）。
const PILL = { width: 150, height: 37 };
const PILL_MARGIN = 16; // 胶囊 box-shadow(0 4 16) 的留白
const PILL_RIGHT = 100;
const PILL_BOTTOM = 48;
let collapsed = false;
let expandedBounds = null;

// 抓屏时把本窗口排除掉，否则玻璃会采样到自己形成反馈。
// 默认关闭：远程桌面（RDP）本质是屏幕捕获，WDA_EXCLUDEFROMCAPTURE 的窗口
// 会被排除在远程画面之外 = 用户完全看不到这个浮窗（本机实测品红对照窗不可见）。
// 自反馈改由渲染层「遮掉卡片区域」解决（见 src/client.js maskSelf）。
// 只有纯本机、且愿意接受「截图/录屏里看不到浮窗」时才用 DSH_RTA_OVERLAY_CP=1 打开。
const CONTENT_PROTECTION = process.env.DSH_RTA_OVERLAY_CP === '1';

async function pickCaptureSource(display) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  return sources.find((s) => String(s.display_id) === String(display.id)) || sources[0] || null;
}

// 渲染层需要的全部对齐信息：窗口在屏幕上的位置 + 所在显示器 + 两张卡在窗口内的矩形。
function overlayGeometry() {
  const bounds = win && !win.isDestroyed()
    ? win.getBounds()
    : { x: 0, y: 0, width: WIN_WIDTH, height: WIN_HEIGHT };
  const display = displayFor(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  return {
    window: bounds,
    display: { id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor },
    cards: [
      { kind: 'messages', x: PAD, y: PAD, width: CARD_MESSAGES.width, height: CARD_MESSAGES.height, radius: 54 },
      { kind: 'composer', x: PAD, y: PAD + CARD_MESSAGES.height + CARD_GAP, width: CARD_COMPOSER.width, height: CARD_COMPOSER.height, radius: 40 },
    ],
  };
}

function sendGeometry() {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('rta:overlay-geometry', overlayGeometry()); } catch { /* 渲染层还没就绪 */ }
}

let win = null;
let pollTimer = null;
let hitTimer = null;
let misses = 0;
let saveTimer = null;
let ignoringMouse = null;

log('boot', 'electron=' + process.versions.electron, 'endpoint=' + (ENDPOINT ? 'yes' : 'no'), 'token=' + (TOKEN ? 'yes' : 'no'));

// ---- 位置记忆：userData 里，不污染插件目录 ----
function posFile() {
  return path.join(app.getPath('userData'), 'rta-overlay-window.json');
}

function loadPos() {
  try {
    const pos = JSON.parse(fs.readFileSync(posFile(), 'utf8'));
    if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) return { x: pos.x, y: pos.y };
  } catch { /* 第一次启动没有位置文件 */ }
  return null;
}

function savePos() {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getBounds();
    fs.writeFileSync(posFile(), JSON.stringify({ x: bounds.x, y: bounds.y }));
  } catch { /* 位置存不下来不影响窗口 */ }
}

function displayFor(x, y) {
  return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
}

// 设计稿：卡片右侧距画布右边 100、距顶部 88（1280×800 画布上的 760,88）。
// 这里算的是「消息卡」在屏幕上的位置，再减去 PAD 得到窗口位置。
function defaultPos() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - 100 - CARD_MESSAGES.width - PAD,
    y: area.y + 88 - PAD,
  };
}

// 允许跨屏，但窗口必须完整落在某块屏的工作区内；记录的位置来自旧显示器时夹回最近屏幕。
function clampToWorkArea(pos) {
  const display = displayFor(pos.x + WIN_WIDTH / 2, pos.y + WIN_HEIGHT / 2);
  const area = display.workArea;
  const maxX = area.x + area.width - WIN_WIDTH;
  const maxY = area.y + area.height - WIN_HEIGHT;
  return {
    x: Math.min(Math.max(area.x, Math.round(pos.x)), Math.max(area.x, maxX)),
    y: Math.min(Math.max(area.y, Math.round(pos.y)), Math.max(area.y, maxY)),
  };
}

// ---- 收起/展开：设计稿「点 − 收起为右下角胶囊」----
// 收起时窗口缩到胶囊大小（150×37 + 阴影留白），锚定在当前显示器右下角（右 100 / 下 48）；
// 展开时恢复原来的窗口 bounds，位置记忆不受影响。
function setCollapsed(next) {
  if (!win || win.isDestroyed()) return;
  const want = next === true;
  if (want === collapsed) return;
  collapsed = want;
  try {
    if (want) {
      const cur = win.getBounds();
      expandedBounds = cur;
      const area = displayFor(cur.x + cur.width / 2, cur.y + cur.height / 2).workArea;
      const w = PILL.width + PILL_MARGIN * 2;
      const h = PILL.height + PILL_MARGIN * 2;
      win.setBounds({
        x: Math.round(area.x + area.width - PILL_RIGHT - w),
        y: Math.round(area.y + area.height - PILL_BOTTOM - h),
        width: w,
        height: h,
      });
    } else if (expandedBounds) {
      const pos = clampToWorkArea(expandedBounds);
      win.setBounds({ x: pos.x, y: pos.y, width: WIN_WIDTH, height: WIN_HEIGHT });
      expandedBounds = null;
    }
  } catch (err) {
    log('collapse failed', String(err && err.message ? err.message : err));
  }
  sendGeometry();
  log('collapsed', collapsed);
}

// ---- 数据面：轮询插件宿主，决定浮窗显隐 ----
async function fetchState() {
  if (!ENDPOINT) return null;
  const url = `${ENDPOINT}/api/dsh-rta/state${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

let lastVisible = null;
function setVisible(next, why) {
  if (!win || win.isDestroyed()) return;
  if (next && !win.isVisible()) {
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  } else if (!next && win.isVisible()) {
    win.hide();
  }
  if (lastVisible !== next) {
    lastVisible = next;
    log(`visible ${next === true}`, why ? `why=${why}` : '');
  }
  try { win.webContents.send('rta:overlay-visible', next === true); } catch { /* ignore */ }
}

async function tick() {
  const state = await fetchState();
  if (!state) {
    misses += 1;
    if (misses === 1 || misses === MAX_MISSES) log('state fetch failed', `misses=${misses} endpoint=${ENDPOINT ? 'yes' : 'no'}`);
    if (misses >= MAX_MISSES) setVisible(false, 'fetch-miss');
    return;
  }
  misses = 0;
  setVisible(state.active === true, `state=${state.state ?? '?'}`);
}

// ---- 点击穿透：只有两张卡矩形内接收鼠标，阴影/缝隙区域交给下层应用 ----
const CARD_RECTS = [
  { x: PAD, y: PAD, width: CARD_MESSAGES.width, height: CARD_MESSAGES.height },
  { x: PAD, y: PAD + CARD_MESSAGES.height + CARD_GAP, width: CARD_COMPOSER.width, height: CARD_COMPOSER.height },
];

function cardAt(bounds, point) {
  const lx = point.x - bounds.x;
  const ly = point.y - bounds.y;
  return CARD_RECTS.some((r) => lx >= r.x && lx < r.x + r.width && ly >= r.y && ly < r.y + r.height);
}

function startHitTest() {
  if (hitTimer) return;
  hitTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    // 收起态整个小窗就是胶囊：全部接收鼠标（点击胶囊展开）。
    if (collapsed) {
      if (ignoringMouse !== false) {
        ignoringMouse = false;
        win.setIgnoreMouseEvents(false);
      }
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const inside = cardAt(win.getBounds(), cursor);
    if (inside === ignoringMouse) return;
    ignoringMouse = inside;
    if (inside) {
      win.setIgnoreMouseEvents(false);
    } else {
      // forward:true 让鼠标事件继续转发给页面，拖动 header 时不丢事件。
      win.setIgnoreMouseEvents(true, { forward: true });
    }
  }, HIT_TEST_MS);
}

function createWindow() {
  const pos = clampToWorkArea(loadPos() || defaultPos());
  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: pos.x,
    y: pos.y,
    transparent: true, // 透明置顶窗：桌面直接透过卡片
    frame: false,
    hasShadow: false, // 外阴影是设计稿图层的一部分（页面 drop-shadow），不用系统窗阴影
    roundedCorners: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'RTA',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 旧系统不支持 */ }

  // 抓屏排除本窗口会连远程桌面一起排除（RDP 就是抓屏），所以默认不开；
  // 自反馈由渲染层把卡片区域从捕获画面里替换掉解决。DSH_RTA_OVERLAY_CP=1 仅本机调试用。
  if (CONTENT_PROTECTION) {
    try {
      win.setContentProtection(true);
      log('content protection on');
    } catch (err) {
      log('content protection failed', String(err));
    }
  }

  const query = {};
  if (ENDPOINT) query.endpoint = ENDPOINT;
  if (TOKEN) query.token = TOKEN;

  win.webContents.on('did-finish-load', () => {
    log('window loaded');
    sendGeometry();
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => log('window load failed', code, desc));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    log('console', level, String(message), 'line=' + line, String(sourceId || ''));
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log('render-process-gone', JSON.stringify(details));
    app.quit();
  });
  win.on('closed', () => app.quit());
  win.on('moved', () => {
    // 收起态的位置由胶囊锚点决定，不写入展开态的位置记忆。
    if (collapsed) return;
    // 位置/尺寸没变（例如 clamp 回弹）不重复保存
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(savePos, 400);
  });
  // header 拖动窗口时，页面要保证非卡区域不拦截拖动（client.js 设置 app-region）。
  win.on('move', () => {
    ignoringMouse = null;
    sendGeometry();
  });
  win.on('resize', sendGeometry);

  void win.loadFile(path.join(__dirname, 'window.html'), { query });
}

function startPolling() {
  if (pollTimer) return;
  void tick();
  pollTimer = setInterval(() => { void tick(); }, POLL_MS);
}

app.on('second-instance', () => setVisible(true));

// 渲染层拿对齐信息（窗口位置 + 显示器 + 卡片矩形）。
ipcMain.handle('rta:overlay-geometry', () => overlayGeometry());

app.whenReady().then(() => {
  if (!HAS_SINGLE_INSTANCE_LOCK) { app.quit(); return; }
  log('ready');

  // 渲染层调用 getDisplayMedia 时，这里替它选「窗口当前所在的那块屏」。
  // 必须传真实的 DesktopCapturerSource（传 {id: display.id} 会 NotReadableError）。
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const bounds = win && !win.isDestroyed()
          ? win.getBounds()
          : { x: 0, y: 0, width: WIN_WIDTH, height: WIN_HEIGHT };
        const display = displayFor(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        const source = await pickCaptureSource(display);
        log('displayMedia request', 'display=' + display.id, 'source=' + (source ? source.id : 'none'));
        if (!source) throw new Error('no screen source');
        callback({ video: source });
      } catch (err) {
        log('displayMedia failed', err && err.message ? err.message : String(err));
        callback({});
      }
    }, { useSystemPicker: false });
    log('displayMedia handler ready');
  } catch (err) {
    log('displayMedia handler failed', String(err));
  }

  killStaleWindows();
  // 渲染层的玻璃背板：优先抓「前台窗口」的窗口流（窗口捕获不含置顶浮窗自己，
  // 没有自反馈、也不需要 setContentProtection，远程桌面照样可见）。
  ipcMain.handle('rta:window-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      return sources.map((s) => ({ id: s.id, name: s.name }));
    } catch (err) {
      log('window sources failed', String(err));
      return [];
    }
  });
  // 前台窗口几何：state 里没有 foreground.rect（旧版 host）时渲染层用这个兜底。
  ipcMain.handle('rta:foreground-window', () => foregroundWindowInfo());
  // 收起/展开：渲染层点 − 时调用，主进程把窗口缩成胶囊 / 恢复原尺寸。
  ipcMain.handle('rta:set-collapsed', (_event, next) => {
    setCollapsed(next === true);
    return collapsed;
  });
  try {
    createWindow();
    startHitTest();
    startPolling();
    screen.on('display-metrics-changed', sendGeometry);
    screen.on('display-added', sendGeometry);
    screen.on('display-removed', sendGeometry);
  } catch (err) {
    log('createWindow failed', err && err.stack ? err.stack : String(err));
    app.quit();
  }
});

app.on('window-all-closed', () => { log('window-all-closed'); app.quit(); });
app.on('before-quit', () => {
  log('before-quit');
  if (pollTimer) clearInterval(pollTimer);
  if (hitTimer) clearInterval(hitTimer);
  if (saveTimer) clearTimeout(saveTimer);
  pollTimer = null;
  hitTimer = null;
  saveTimer = null;
});
