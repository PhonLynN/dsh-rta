/**
 * ui/overlay/main.cjs — RTA 全局浮窗的 Electron 宿主。
 *
 * 路线（用户拍板，2026-11）：**透明置顶窗 + 设计稿图层原样 + 网点纹理**。
 *  - 窗口：透明置顶、不使用任何系统材质（不用 DWM Acrylic/Mica，不加 tint/系统圆角）；
 *  - 模糊：不做模糊、不做采集；卡片用纯色半透明底（rgba(20,20,22,0.55)）+ 等距网点保证可读与质感。
 *  - 设计稿图层：描边/squircle/阴影全部按 pen 导出原值，不做任何近似或补偿层。
 *  - 自反馈：默认不开内容保护（远程桌面本身也是抓屏，开了用户就看不到浮窗）；
 *    需要时可用 DSH_RTA_OVERLAY_CP=1 打开 setContentProtection 做本机调试。
 *  - 热重载：再启动一次浮窗（拿不到单实例锁）会触发已有实例 reload，样式改动无需重启 RTA。
 *  - 一个窗口装两张卡（420×520 + 420×98 + 14 gap），四周 40px 是窗口内边距（只给设计稿外阴影留空间，不改变卡片间距）；
 *    卡外空白/缝隙点击穿透。
 */

const { app, BrowserWindow, screen, ipcMain } = require('electron');
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

const HAS_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!HAS_SINGLE_INSTANCE_LOCK) log('another overlay instance is running; this one will exit');

const ENDPOINT = (process.env.RTA_OVERLAY_ENDPOINT || '').replace(/\/+$/, '');
const TOKEN = process.env.RTA_OVERLAY_TOKEN || '';

// ---- 设计稿尺寸（pen 导出 rta-reference.html） ----
const CARD_MESSAGES = { width: 420, height: 520 };
const CARD_COMPOSER = { width: 420, height: 98 };
const CARD_GAP = 14;
const PAD = 20; // 窗口内边距（只给外阴影留空间，不是卡片间距；CARD_GAP 仍是 14）
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
// 现状：不再抓屏；卡片用纯色半透明底（见 src/client.js 的 .rta-glass）。
// 只有纯本机、且愿意接受「截图/录屏里看不到浮窗」时才用 DSH_RTA_OVERLAY_CP=1 打开。
const CONTENT_PROTECTION = process.env.DSH_RTA_OVERLAY_CP === '1';

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

  win.webContents.on('did-finish-load', () => {
    log('window loaded');
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
  });
  win.on('resize', () => {
  });
}

// 面板模式决定后才知道要不要让渲染层跳过自己的采集背板，所以页面在这里才加载。
function loadOverlayPage() {
  const query = {};
  if (ENDPOINT) query.endpoint = ENDPOINT;
  if (TOKEN) query.token = TOKEN;
  void win.loadFile(path.join(__dirname, 'window.html'), { query });
}

function startPolling() {
  if (pollTimer) return;
  void tick();
  pollTimer = setInterval(() => { void tick(); }, POLL_MS);
}

app.on('second-instance', () => {
  setVisible(true);
  // 第二次启动 = 一次「热重载」信号：重新加载页面，拿到安装副本里最新的 client.js，
  // 这样调样式不需要停掉 RTA 会话再重新召唤。
  try {
    log('second-instance: reloading overlay page');
    win?.webContents?.reloadIgnoringCache();
  } catch { /* ignore */ }
});

// 渲染层拿对齐信息（窗口位置 + 显示器 + 卡片矩形）。
app.whenReady().then(async () => {
  if (!HAS_SINGLE_INSTANCE_LOCK) { app.quit(); return; }
  log('ready');

  killStaleWindows();
  // 收起/展开：渲染层点 − 时调用，主进程把窗口缩成胶囊 / 恢复原尺寸。
  ipcMain.handle('rta:set-collapsed', (_event, next) => {
    setCollapsed(next === true);
    return collapsed;
  });
  try {
    createWindow();
    loadOverlayPage();
    startHitTest();
    startPolling();
    watchRendererFiles();
  } catch (err) {
    log('createWindow failed', err && err.stack ? err.stack : String(err));
    app.quit();
  }
});

// 热重载兜底（比 second-instance 可靠）：安装副本里的 client.js 一变，就重载浮窗页面，
// 这样改样式只要拷文件，不用停掉 RTA 会话再重新召唤。
function watchRendererFiles() {
  const clientFile = path.join(__dirname, '..', '..', 'src', 'client.js');
  let reloadTimer = null;
  try {
    fs.watch(clientFile, { persistent: false }, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        log('renderer file changed: reloading overlay page');
        try { win?.webContents?.reloadIgnoringCache(); } catch { /* ignore */ }
      }, 250);
    });
  } catch (err) {
    log('watch renderer files failed', String(err));
  }
}

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
