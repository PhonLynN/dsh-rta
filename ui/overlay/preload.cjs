/**
 * ui/overlay/preload.cjs — 沙箱化渲染进程的唯一桥。
 * 渲染层只需要「收起/展开」一个能力：收起时主进程把窗口缩成设计稿胶囊尺寸，
 * 展开时恢复原 bounds。位置、显示器、窗口捕获等信息都在主进程内部处理，不暴露给页面。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__rtaOverlay', {
  /** 收起/展开：true=收起为右下角胶囊，false=展开回原 bounds */
  setCollapsed: (next) => ipcRenderer.invoke('rta:set-collapsed', next === true),
});
