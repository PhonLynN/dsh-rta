/**
 * ui/overlay/preload.cjs — 沙箱化渲染进程的唯一桥。
 *
 * 渲染层需要知道「窗口在屏幕上的位置 / 所在显示器的 bounds+缩放」，才能把 30fps
 * 桌面流按屏幕坐标裁剪成两张卡正后方的区域；这些信息只有主进程拿得到。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__rtaOverlay', {
  /** 当前几何：窗口 bounds、所在显示器 bounds/workArea/scaleFactor、两张卡的窗口内矩形 */
  geometry: () => ipcRenderer.invoke('rta:overlay-geometry'),

  /** 可捕获的窗口列表（id/name）：玻璃背板用「前台窗口」的窗口流，避免采到自己 */
  windowSources: () => ipcRenderer.invoke('rta:window-sources'),

  /** 前台窗口的标题/屏幕矩形（主进程用 Win32 查；host 的 state 里没有 rect 时兜底） */
  foregroundWindow: () => ipcRenderer.invoke('rta:foreground-window'),

  /** 收起/展开：收起时主进程把窗口缩成设计稿胶囊（右下角），展开时恢复原 bounds */
  setCollapsed: (next) => ipcRenderer.invoke('rta:set-collapsed', next === true),

  /** 窗口移动/显示器变化时推送新几何（回调返回取消订阅函数） */
  onGeometry(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, geo) => {
      try { callback(geo); } catch { /* 渲染层自己兜底 */ }
    };
    ipcRenderer.on('rta:overlay-geometry', listener);
    return () => { try { ipcRenderer.removeListener('rta:overlay-geometry', listener); } catch { /* ignore */ } };
  },

  /** 浮窗显示/隐藏（隐藏时暂停抓屏绘制，省 CPU/GPU） */
  onVisible(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => {
      try { callback(value === true); } catch { /* 渲染层自己兜底 */ }
    };
    ipcRenderer.on('rta:overlay-visible', listener);
    return () => { try { ipcRenderer.removeListener('rta:overlay-visible', listener); } catch { /* ignore */ } };
  },
});
