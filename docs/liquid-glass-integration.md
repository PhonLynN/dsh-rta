# 液态玻璃浮窗集成说明（@hicccc77/electron-liquid-glass）

目标：在**全局置顶的透明浮窗**里做出「窗口背后真实模糊」，同时让 pen 设计稿的玻璃参数
**逐项原值**渲染（不做 tint 补偿、不凑圆角）。系统材质（DWM Acrylic/Mica）已被否决：
它会强加系统 tint、系统圆角与噪点。

## 架构

```
┌─ Electron 透明置顶窗 460×672（RTA）──────────────────────────┐
│  设计稿图层：SVG squircle 描边 / 渐变 / 内高光 / 外阴影       │
│  （src/client.js 的 .rta-card / .rta-glass / .rta-edge）      │
│                                                              │
│  ┌─ 原生模糊面板 420×520（@hicccc77，垫在窗口 z 序之下）──┐ │
│  │ DXGI Desktop Duplication 采集桌面 → D3D11 blurSigma=20 │ │
│  │ → DirectComposition 半透明面板（无 tint/无着色）      │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

- 只有 **消息卡** 有背景模糊（设计稿 `background_blur`）；composer 卡设计稿是纯色
  `#2c2c2e`，不创建面板。
- 面板以 `anchorWindow: win` 锚定在主窗口下方（z 序自动贴着窗口下沿），窗口移动/换屏时
  由 `syncGlassPanel()` 同步 `setBounds`；窗口隐藏或收起成胶囊时面板一起隐藏。
- 渲染层不再启动自己的 `getDisplayMedia` 采集背板（`window.__RTA_GLASS__ === true` →
  `startLiveBackdrop` 不执行，页面里没有 canvas），玻璃观感完全由面板提供。

## 设计值映射（与 pen 导出 `rta-reference.html` 对照）

| pen / CSS 设计值 | 实现 |
| --- | --- |
| `background_blur radius 40`（pen 单位）→ CSS `backdrop-filter: blur(20px)` | 面板 `blurSigma: 20` |
| 渐变 `linear-gradient(170deg, #FFFFFF12 0%, #FFFFFF08 100%)` | 窗口图层 `.rta-glass` 原样，面板不加 tint（`saturation: 1`） |
| 描边 `#ffffff1f` 1px / composer 0.5px | `.rta-edge` SVG path 原值（path 来自 pen geometry） |
| 外阴影 `0 6px 20px #0000004D` | `.rta-card{filter:drop-shadow(0 6px 20px rgba(0,0,0,0.302))}` |
| squircle 连续曲线（`M54 0l312 0 …`） | `.rta-glass{clip-path:path(PATH_MESSAGES)}`；面板 `cornerRadius: 54`（**当前是圆形 SDF，shader 精修 squircle 待做**） |
| composer `#2c2c2e` + `0 4px 16px #0000004D` | 窗口图层原样（无面板） |
| `displacementScale` / `aberrationIntensity` | 0 / 0 —— 设计稿没有透镜折射与色散 |

## 开关与排障

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `RTA_GLASS` | 开 | `0` 关闭面板，回退到渲染层采集方案（`src/client.js startLiveBackdrop`） |
| `RTA_GLASS_SIGMA` | `20` | 模糊半径（对应 CSS `blur(20px)`） |
| `RTA_GLASS_POLICY` | `dda-only` | 面板的捕获策略，见下表 |
| `RTA_LIQUID_GLASS` | 自动 | 显式指定 `@hicccc77/electron-liquid-glass` 包目录 |

`capturePolicy`（上游 0.4.0 语义）：

- `all`：`WDA_EXCLUDEFROMCAPTURE`，面板从**所有**截屏/录屏/远程画面中消失（默认值，向后兼容）；
- `dda-only`：只从面板自己的 DXGI 采集里排除（防自反馈），显示器级 WGC/GDI 截图能看到面板；
- `none`：不排除。

RTA 默认用 `dda-only`：既避免「玻璃采样到自己」，又让远程桌面/录屏里能看到浮窗。

## 安装

```bash
node scripts/install-overlay.mjs
```

会安装两个独立运行时（不塞进 DSH profile）：

1. `~/.dsh/rta/overlay-runtime` — Electron 本体；
2. `~/.dsh/rta/glass-runtime` — `@hicccc77/electron-liquid-glass`（N-API 预编译 `.node`，
   无需 VS 工具链；走 npm 官方源）。

主进程会依次尝试：`RTA_LIQUID_GLASS` → 插件 `ui/overlay/node_modules` →
`~/.dsh/rta/glass-runtime/node_modules` → 插件安装目录上一级的 `node_modules`；
都不可用则日志 `liquid glass unavailable` 并自动回退渲染层采集。

## 已知问题

- **DXGI Desktop Duplication 在远程桌面会话 / 虚拟显示器 / 混合显卡环境下可能只拿到黑帧**，
  表现为面板渲染成纯黑圆角块（采集循环 `framesAcquired` 在跑但内容为黑）。本机（Intel + NVIDIA +
  Oray 虚拟显示器，远程会话）已复现。本机直连显示器时需自测确认；不可用时 `RTA_GLASS=0` 回退。
- 面板圆角目前是圆形 SDF，与设计稿 54px squircle 有 1–2px 级差异；精确复刻需要改
  上游 shader 的距离场函数（MIT 许可，允许自编译）。
- 面板按创建时的 `dpr` 渲染；拖到不同缩放比例的显示器后如需精确 1:1，需要重建面板。
