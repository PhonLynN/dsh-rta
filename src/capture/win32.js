/**
 * capture/win32.js — 进程内 Win32 胶水：抓屏、光标、按键、前台窗口。
 *
 * 全部走 koffi 直接调 user32/gdi32/kernel32。为什么不用 PowerShell：
 *  - 每次截图 spawn 一个 powershell 是 40–70ms，还要过 AMSI（.ps1 落盘会被杀）；
 *  - 热键/画圈需要 60Hz 级的光标采样，进程间调用根本来不及。
 * 实测（本机 2560×1440）：
 *  - BitBlt 全屏 + GetDIBits ≈ 21ms（单次），GetCursorPos 1000 次 1.5ms，
 *    GetAsyncKeyState 1000 次 0.06ms，GetForegroundWindow+Rect+PID 1000 次 2.5ms。
 *
 * 所以设计是：**一个和进程同生命周期的抓屏器 + 一个 8ms 的采样定时器**。
 * 抓屏器复用 DC/位图/缓冲，不每帧分配 14MB；采样器只读内存里的几个 API。
 */

import { loadKoffi } from '../native/koffi.js';

/** Win32 常量（只列用到的）。 */
export const VK = Object.freeze({
  LBUTTON: 0x01, RBUTTON: 0x02, MBUTTON: 0x04,
  SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, // MENU = Alt
  TAB: 0x09,
  LSHIFT: 0xA0, RSHIFT: 0xA1, LCONTROL: 0xA2, RCONTROL: 0xA3, LMENU: 0xA4, RMENU: 0xA5,
  ESCAPE: 0x1B,
});

const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const DIB_RGB_COLORS = 0;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** 创建 Win32 绑定；平台上不可用时返回 {ok:false, reason}。 */
export function createWin32() {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'not-windows' };
  }
  const loaded = loadKoffi();
  if (!loaded.koffi) {
    return { ok: false, reason: 'no-koffi', detail: loaded.error };
  }
  const koffi = loaded.koffi;

  // BITMAPINFOHEADER 不再注册成 koffi 命名类型：koffi 的类型注册是进程级全局的，
  // 同一进程里 createWin32() 会被调用多次（rta_stop 后再 rta_start、插件热重载），
  // 注册同名结构体会报 "Duplicate type name"。这里改成手工构造 40 字节 BMI Buffer，
  // GetDIBits 的 lpbmi 用 'void *' 直接接 Buffer，零注册、可重入。

  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  const f = {
    GetSystemMetrics: user32.func('int GetSystemMetrics(int nIndex)'),
    GetDC: user32.func('intptr_t GetDC(intptr_t hWnd)'),
    ReleaseDC: user32.func('int ReleaseDC(intptr_t hWnd, intptr_t hDC)'),
    GetCursorPos: user32.func('int GetCursorPos(_Out_ int32_t *pt)'),
    GetAsyncKeyState: user32.func('int16_t GetAsyncKeyState(int vKey)'),
    GetForegroundWindow: user32.func('intptr_t GetForegroundWindow()'),
    GetWindowRect: user32.func('int GetWindowRect(intptr_t hWnd, _Out_ int32_t *rect)'),
    GetWindowTextW: user32.func('int GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *buf, int max)'),
    GetWindowThreadProcessId: user32.func('uint32_t GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)'),
    IsWindowVisible: user32.func('int IsWindowVisible(intptr_t hWnd)'),

    CreateCompatibleDC: gdi32.func('intptr_t CreateCompatibleDC(intptr_t hdc)'),
    CreateCompatibleBitmap: gdi32.func('intptr_t CreateCompatibleBitmap(intptr_t hdc, int x, int y)'),
    SelectObject: gdi32.func('intptr_t SelectObject(intptr_t hdc, intptr_t h)'),
    BitBlt: gdi32.func('int BitBlt(intptr_t hdcDest, int x, int y, int w, int h, intptr_t hdcSrc, int x1, int y1, uint32_t rop)'),
    GetDIBits: gdi32.func('int GetDIBits(intptr_t hdc, intptr_t hbm, uint32_t start, uint32_t cLines, _Out_ uint8_t *lpvBits, void *lpbmi, uint32_t usage)'),
    DeleteObject: gdi32.func('int DeleteObject(intptr_t ho)'),
    DeleteDC: gdi32.func('int DeleteDC(intptr_t hdc)'),

    OpenProcess: kernel32.func('intptr_t OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    QueryFullProcessImageNameW: kernel32.func('int QueryFullProcessImageNameW(intptr_t hProc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'),
    CloseHandle: kernel32.func('int CloseHandle(intptr_t h)'),
  };

  const rectBuf = new Int32Array(4);
  const ptBuf = new Int32Array(2);
  const pidBuf = new Uint32Array(1);
  const titleBuf = Buffer.alloc(1024);
  const pathBuf = Buffer.alloc(2048);
  const pathLen = new Uint32Array(1);

  let screenDc = f.GetDC(0);

  const api = {
    ok: true,
    koffi,

    /** 主屏尺寸（物理像素）。 */
    primarySize() {
      return { width: f.GetSystemMetrics(0), height: f.GetSystemMetrics(1) };
    },

    /** 当前光标位置（物理像素，虚拟桌面坐标）。 */
    cursor() {
      f.GetCursorPos(koffi.as(ptBuf, 'int32_t *'));
      return { x: ptBuf[0], y: ptBuf[1] };
    },

    /** 某个虚拟键是否按下（Alt 在 Windows 里是 VK_MENU）。 */
    keyDown(vk) {
      return (f.GetAsyncKeyState(vk) & 0x8000) !== 0;
    },

    /** 前台窗口信息：句柄、进程、标题、矩形（可能被最小化到屏幕外）。 */
    foreground() {
      const hwnd = f.GetForegroundWindow();
      return api.windowInfo(hwnd);
    },

    windowInfo(hwnd) {
      if (!hwnd) return null;
      const visible = f.IsWindowVisible(hwnd) !== 0;
      f.GetWindowRect(hwnd, koffi.as(rectBuf, 'int32_t *'));
      const n = f.GetWindowTextW(hwnd, koffi.as(titleBuf, 'uint16_t *'), 512);
      f.GetWindowThreadProcessId(hwnd, koffi.as(pidBuf, 'uint32_t *'));
      const pid = pidBuf[0];
      return {
        hwnd: String(hwnd),
        pid,
        title: titleBuf.toString('utf16le', 0, Math.max(0, n) * 2),
        process: api.processName(pid),
        visible,
        rect: { x: rectBuf[0], y: rectBuf[1], w: rectBuf[2] - rectBuf[0], h: rectBuf[3] - rectBuf[1] },
      };
    },

    /** 进程可执行文件路径（拿不到返回 null；OpenProcess 失败很常见，不要抛）。 */
    processName(pid) {
      if (!pid) return null;
      const h = f.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!h) return null;
      try {
        pathLen[0] = pathBuf.length / 2;
        const ok = f.QueryFullProcessImageNameW(h, 0, koffi.as(pathBuf, 'uint16_t *'), koffi.as(pathLen, 'uint32_t *'));
        if (!ok) return null;
        const full = pathBuf.toString('utf16le', 0, pathLen[0] * 2);
        const base = full.split(/[\\/]/).pop() || full;
        return base;
      } finally {
        f.CloseHandle(h);
      }
    },

    /**
     * 抓一帧全屏到 BGRA 缓冲。
     * @param {{buffer?: Buffer, x?: number, y?: number, w?: number, h?: number}} [opts]
     *   默认抓主屏；给 x/y 时抓屏幕上的矩形（用于圈画区域的高清帧）
     * @returns {{bgra: Buffer, width: number, height: number}}
     */
    grab(opts = {}) {
      const size = api.primarySize();
      const width = Math.max(1, Math.min(size.width, (opts.w ?? size.width) | 0));
      const height = Math.max(1, Math.min(size.height, (opts.h ?? size.height) | 0));
      const x = Math.max(0, (opts.x ?? 0) | 0);
      const y = Math.max(0, (opts.y ?? 0) | 0);
      if (!screenDc) screenDc = f.GetDC(0);

      // 按尺寸缓存一块位图，避免每帧 CreateCompatibleBitmap（5ms 级开销）
      let cache = grabCache;
      if (!cache || cache.width !== width || cache.height !== height) {
        if (cache) {
          f.SelectObject(cache.memDc, cache.old);
          f.DeleteObject(cache.bmp);
          f.DeleteDC(cache.memDc);
        }
        const memDc = f.CreateCompatibleDC(screenDc);
        const bmp = f.CreateCompatibleBitmap(screenDc, width, height);
        const old = f.SelectObject(memDc, bmp);
        cache = { memDc, bmp, old, width, height, bgra: Buffer.allocUnsafe(width * height * 4), bmi: bmiFor(width, height) };
        grabCache = cache;
      }
      if (!f.BitBlt(cache.memDc, 0, 0, width, height, screenDc, x, y, SRCCOPY | CAPTUREBLT)) {
        throw new Error('BitBlt failed');
      }
      const lines = f.GetDIBits(cache.memDc, cache.bmp, 0, height, cache.bgra, cache.bmi, DIB_RGB_COLORS);
      if (lines !== height) throw new Error(`GetDIBits returned ${lines}/${height} lines`);
      return { bgra: cache.bgra, width, height };
    },

    dispose() {
      if (grabCache) {
        try { f.SelectObject(grabCache.memDc, grabCache.old); } catch { /* ignore */ }
        try { f.DeleteObject(grabCache.bmp); } catch { /* ignore */ }
        try { f.DeleteDC(grabCache.memDc); } catch { /* ignore */ }
        grabCache = null;
      }
      if (screenDc) {
        try { f.ReleaseDC(0, screenDc); } catch { /* ignore */ }
        screenDc = null;
      }
    },
  };

  let grabCache = null;
  // BITMAPINFOHEADER（40 字节，BI_RGB 32bpp，负高度 = 自上而下）
  function bmiFor(width, height) {
    const b = Buffer.alloc(40);
    b.writeUInt32LE(40, 0);
    b.writeInt32LE(width, 4);
    b.writeInt32LE(-height, 8);
    b.writeUInt16LE(1, 12);
    b.writeUInt16LE(32, 14);
    b.writeUInt32LE(0, 16); // BI_RGB
    b.writeUInt32LE(width * height * 4, 20);
    return b;
  }

  return api;
}
