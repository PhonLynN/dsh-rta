# Windows 11 实时「背景模糊毛玻璃卡片」技术核查

- 任务：`task-3`（研究 C：Electron/Windows 实时毛玻璃可行性权威资料核查）
- 作者：glass-research（Team Lead: lead）
- 日期：2026-11-11（所有结论以该日期可访问的资料为准）
- 目标环境：RTA = DSH 的 Electron 插件；Electron **38.8.6**；Windows 11 **build 26200 / 25H2**；独立置顶透明浮窗；设计目标 = pen 设计稿的「实时背景模糊 20px 毛玻璃卡片」
- 范围：**纯文献核查**，不包含桌面实测（实测由 cap-probe / dwm-probe 负责）。引用前均已用 web_fetch 打开确认内容；无法打开或找不到权威来源的结论明确标注。

## 证据等级约定

| 等级 | 含义 |
|---|---|
| A | 官方文档 / 官方规范（Electron docs、Microsoft Learn、CSS 规范） |
| B | 官方源码 / 官方仓库（Electron、Chromium、WebRTC、MicrosoftDocs 源文件） |
| C | issue / PR / 社区讨论（GitHub issue、产品 PR、开发者问答） |
| D | 基于上述证据的推断（本文明确标注「推断」） |
| E | 未找到官方依据（明确标注，不当作事实引用） |

## 结论速览（8 问）

| # | 问题 | 结论 | 等级 |
|---|---|---|---|
| 1 | CSS `backdrop-filter` 能否模糊透明窗背后的桌面？ | **不能。** 采样范围被限制在文档/合成层内（Backdrop Root），桌面不在其中，且 Electron 主进程 issue 已被官方明确「永远不可能」。 | A + C |
| 2 | Electron `backgroundMaterial` 的限制？ | 只有 Win11 22H2+（build 22621）生效；由 DWM 整窗绘制、半径/着色不可配；`transparent`/`backgroundColor`/`setShape` 的交互官方无规定，社区报告互相矛盾；已知失焦/节能/遮挡/最大化等 bug。 | A + B + C |
| 3 | Mica / Acrylic 语义与 DWM 取值？ | Mica = **壁纸**（opaque，仅采样壁纸一次，整窗、长寿命窗口）；Desktop Acrylic = **背后内容**（transient），但失焦即变纯色；`DWMSBT_MAINWINDOW`=Mica、`DWMSBT_TRANSIENTWINDOW`=Desktop Acrylic、`DWMSBT_TABBEDWINDOW`=Mica Alt。公开 DWM 无自定义模糊半径；`SetWindowCompositionAttribute` 未文档化，Win11 22H2 起 blur accent 已被移除（社区证据）。 | A + B + C |
| 4 | `setContentProtection` / WDA 能否把自己排除出捕获？ | **Electron 的 API 不行**：它走 Chromium `SetAllowScreenshots` → `WDA_MONITOR`，在抓屏里是**黑块**（不是消失）。要真正排除必须自己调 `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`；代价是用户截图/录屏里卡片也消失，且有版本/远程会话回归风险。 | A + B + C |
| 5 | 实时桌面流的正确姿势？ | 建**一条持久的 `getDisplayMedia` 流**（主进程 `setDisplayMediaRequestHandler` 授权），不要每 80ms 调 `desktopCapturer.getSources`——官方明确缩略图有捕获成本，且 issue 证明每次桌面捕获 session 会泄漏 GPU buffer（窗口缩略图约 15MB/次）。 | A + C |
| 6 | 24H2/25H2 回归、虚拟显示适配器、`--disable-gpu`？ | 24H2 有 DDA + 捕获排除窗口的行为回归（依赖 MPO，KB5046617 已修复）；虚拟显示适配器导致 DXGI duplicator 初始化失败有 **WebRTC 源码级**说明（会跳过坏 adapter，全失败则 `INITIALIZATION_FAILED`）；Oray IDD、25H2、`--disable-gpu` 均**未找到官方专门说明**（标注 E，给出推断）。 | B + C + E |
| 7 | 商业产品怎么做？ | 全部走**系统材质**（WinUI/WinAppSDK XAML 材质、WPF UI 封装的 DWM backdrop、任务栏 accent）；没有任何主流产品用「整屏捕获 + 自绘模糊」实现通用桌面毛玻璃浮层；自定义模糊半径只能 hook DWM（DWMBlurGlass 路线，不可用于产品）。 | A + B + C |
| 8 | 2026 栈下可行路线？ | 满足「任意应用之上 + 实时 + 20px + 空间对齐」**只有一条**：持久 WGC 桌面捕获 + 自绘 20px 模糊 + 用 `WDA_EXCLUDEFROMCAPTURE` 把自己从捕获中挖掉 + 屏幕坐标对齐的透明置顶窗。DWM Acrylic 只能做「近似降级」（整窗、系统半径、失焦变实色）。 | A/B/C 综合 + D |

---

## Q1. CSS `backdrop-filter` 的采样范围：页面内 vs 桌面

### 结论

`backdrop-filter` 的采样对象是**元素所在文档/合成层内、位于 Backdrop Root 之后绘制的内容**，不包含窗口背后的桌面或其它应用窗口。`transparent: true` 只让窗口自身透明，不会把桌面像素喂给 CSS 滤镜。因此「透明独立窗 + `backdrop-filter: blur(20px)`」在任何 Electron/Chromium 版本上都不会出现「桌面被模糊」的效果。

### 依据

**A（规范）** CSS Filter Effects 2，`backdrop-filter` 的 Backdrop Root Image 算法：

> "Paint all content ... between (and including) the ancestor Backdrop Root element and element E. Flatten the painted content into a 2D screen-space buffer. Transform the border box of element E to 2D screen-space, and clip the final painted output to this border quad."
>
> — <https://drafts.csswg.org/filter-effects-2/#backdrop-filter>

采样起点是「最近的祖先 Backdrop Root」，桌面窗口不属于任何文档的 Backdrop Root。

**C（Electron issue，官方维护者回复）** electron/electron#30412「Support backdrop-filter with transparent window」：

> "The CSS `backdrop-filter` property is and forever will be limited to the domain of Chromium's renderer... It does not, cannot and will never have access to whatever is 'underneath' the Electron window."

— <https://github.com/electron/electron/issues/30412>（2021-08-05 创建，2026-09-25 关闭；2026-09-25 仍有用户报告最新 Electron 未支持）

**B（Chromium 源码，旁证）** Chromium 自己的窗口系统只为「非 translucent」窗口加系统 backdrop（见 Q2 源码引用），也从侧面说明透明窗口与「背后内容」的采样在设计上就是分离的。

### 判定

- 不可行，不是 API 用法问题，也不是 `transparent`/`frameless`/`backgroundColor` 配置问题。
- 任何「加一层 `backdrop-filter` 就能糊桌面」的方案可以直接排除。

---

## Q2. Electron `backgroundMaterial`（Windows）的官方语义与限制

### 官方语义

**A（Electron 文档 v38.8.6）** `BrowserWindow` 构造选项 `backgroundMaterial`：

> `backgroundMaterial` string (optional) _Windows_ - "Set the window's system-drawn background material, including behind the non-client area."

取值：`'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed'`。
— <https://www.electronjs.org/docs/latest/api/structures/base-window-options>（源文件 `docs/api/structures/base-window-options.md:106-113`，<https://raw.githubusercontent.com/electron/electron/v38.8.6/docs/api/structures/base-window-options.md>）

**A（Electron 文档）** `win.setBackgroundMaterial(material)`：

- `auto`：让 DWM 自动决定（默认）
- `none`：不绘制
- `mica`：long-lived window 的材质
- `acrylic`：transient window 的材质
- `tabbed`：tabbed title bar 的材质

> "This method sets the browser window's system-drawn background material, including behind the non-client area."
> NOTE: "This method is only supported on Windows 11 22H2 and up."

— <https://www.electronjs.org/docs/latest/api/browser-window#winsetbackgroundmaterialmaterial-windows>（源文件 `docs/api/browser-window.md:1673` 附近）

**B（Electron 源码 v38.8.6）** 实现就是把字符串映射到 DWM 属性，不是 Electron 自己画：

- `shell/browser/native_window_views.cc:97` `DWM_SYSTEMBACKDROP_TYPE GetBackdropFromString(const std::string& material)`
- `shell/browser/native_window_views.cc:1534` `NativeWindowViews::SetBackgroundMaterial(...)` → `:1542` 取 `backdrop_type` → `:1559` `DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ...)`

— <https://raw.githubusercontent.com/electron/electron/v38.8.6/shell/browser/native_window_views.cc>

### 限制清单（按证据强度排序）

1. **系统版本**（A）：仅 Windows 11 22H2+（build 22621）。Win10 上调用无效或表现异常——issue #48440 报告 Electron 38.2.0 / Win10 22H2（19045）上 `acrylic` 不生效（白底/黑屏）：<https://github.com/electron/electron/issues/48440>。
2. **整窗绘制，无法只画卡片区域**（A+B）：DWM 在窗口背后整面绘制材质（`DWMSBT_*` 文档：behind the entire window bounds），没有「按元素/按区域」的接口；`setShape` 是窗口绘制区域，但**与 DWM 材质的交互没有任何官方说明**（推断：DWM backdrop 很可能仍是整矩形，需 dwm-probe 实测）。
3. **模糊半径/算法/着色不可配**（A+D）：官方只暴露材质类型（Electron 层）/`TintColor`、`TintOpacity`、`LuminosityOpacity`、`FallbackColor`（Windows App SDK 控制器层，Electron 未暴露）。**没有任何公开参数能设置「20px」**；系统材质的 blur 半径由 DWM 固定。
4. **语义错位**（A）：
   - `mica` = 采样桌面**壁纸**（opaque，只采样一次），不是「背后的应用内容」；
   - `acrylic` = 采样**背后内容**（Desktop Acrylic），但它是为 transient 表面设计的，且**窗口失活时会替换为纯色**（见 Q3）。
5. **透明窗交互，官方沉默**（A 文档未规定 + C 社区矛盾 + D 需实测）：
   - Electron 文档没有要求 `transparent: false`，也没写 `backgroundColor` 要求；
   - Chromium 源码只为**非 translucent** 窗口自动加系统 backdrop（见下）；
   - Electron 因为显式调用 `DwmSetWindowAttribute`，绕过了 Chromium 这个判断，所以在 `transparent: true` 窗口上会发生什么属于**未文档化行为**；
   - 社区报告互相矛盾：#49443 称 `setBackgroundMaterial('acrylic')` 只在 `transparent: true` 时生效（<https://github.com/electron/electron/issues/49443>）；#48031 中有人报告 html/body 设置不透明背景后材质不生效（<https://github.com/electron/electron/issues/48031>）。
   - **推断**：`backgroundMaterial` 与透明窗不是设计上的组合，稳定性不能作为产品依赖；必须实测。
6. **frameless 要求只来自 `transparent`**（A）：Electron 文档写明 Windows 上 `transparent` 必须配合 `frameless` 才生效（`docs/api/structures/base-window-options.md:73`）；`backgroundMaterial` 本身未要求 frameless（但带 frame 时材质只作用于标题栏，见第 7 条）。
7. **已知 bug（C，issue 讨论）**：
   - #48031（Electron 37.2.6–38 alpha，Win11 24H2 26100）：带 frame 时材质只作用于标题栏；窗口拖到屏幕外/被完全遮挡时背景变黑；Electron 38+ 需要 Energy Saver 关闭且窗口有焦点；失焦或节能时材质禁用但留下灰色背景。
   - #41073：maximized 时 `backgroundMaterial` 黑屏。
   - #41676：frameless Mica 窗口显示时动画/抖动。
   - #42393：maximized window with backgroundMaterial 相关问题。
8. **`WS_CHILD` 无效**（A+B，转引自 Windows Terminal 团队 spec）：`DWMWA_SYSTEMBACKDROP_TYPE` 对子窗口无效，这是他们实测结论：「Apparently, that API does not work at all for `WS_CHILD` windows, by design.」— <https://github.com/microsoft/terminal/blob/80c529acedc999355bc6c90a953dd02befadebbb/doc/specs/drafts/%233327%20-%20Application%20Theming/%2310509%20-%20Mica.md>

### 判定

`backgroundMaterial` 是「免费但不可控」的系统材质：**整窗、系统固定模糊、固定着色、失焦回退**。它既不满足 20px，也不能只糊卡片那一小块，语义上 `mica` 还完全不是「背后内容」。最多作为降级方案。

---

## Q3. Mica vs Acrylic、DWMSBT 取值、SetWindowCompositionAttribute 是否退化成 tint

### 语义对照

| 材质 | 采样对象 | 透明/不透明 | 适用 | 回退 |
|---|---|---|---|---|
| **Mica** | **桌面壁纸**（只采样一次） | opaque（不透明，但带材质纹理） | 长寿命窗口的基底/标题栏 | 失活、省电、关透明效果、低端硬件、Windows < 22000 → 纯色 `SolidBackgroundFillColorBase/Alt` |
| **Mica Alt** | 壁纸（更强 tint） | opaque | tabbed 标题栏 | 同上；WinAppSDK 1.1+ / Win11 22000+ |
| **Desktop Acrylic**（`DWMSBT_TRANSIENTWINDOW`） | 壁纸 + **背后其它窗口内容** | 半透明 | transient 表面（flyout/菜单） | 省电、关透明效果、低端硬件、**窗口失活时背景 acrylic 变纯色** |
| **In-app Acrylic**（WinUI `AcrylicBrush`） | **仅应用内 XAML 内容**，不采样桌面 | 半透明 | 应用内分层 | 同上 |
| **Legacy accent blur**（`SetWindowCompositionAttribute`） | 背后内容（历史行为） | 半透明 | Win10 任务栏/窗口 | Win11 22H2 起 blur 被移除（C） |

**A（Microsoft Learn）** Mica：

> "Mica is an opaque, dynamic material that incorporates theme and desktop wallpaper to paint the background of long-lived windows... it only samples the desktop wallpaper once to create its visualization."

— <https://learn.microsoft.com/en-us/windows/apps/design/style/mica>

**A（Microsoft Learn）** Acrylic：

> "Background acrylic reveals the desktop wallpaper and other windows that are behind the currently active app..."
> "Acrylic effects are automatically disabled when a device enters Battery Saver mode."
> "only background acrylic will replace its translucency and texture with a solid color: When an app window on desktop deactivates."

— <https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic>（2026-10-02 更新）

**A（Microsoft Learn，2026-08 更新）** WinUI 3 关键澄清（对「浮层」尤其重要）：

> "In WinUI 3, `AcrylicBrush` provides **in-app acrylic only** — it applies a blur and tint to XAML content within the app window, not to the desktop or content behind the window. The UWP `BackgroundSource` property (which enabled a `HostBackdrop` mode for window-level acrylic) is not available in WinUI 3."

— <https://learn.microsoft.com/en-us/windows/apps/develop/ui/in-app-acrylic>（源文档：<https://raw.githubusercontent.com/MicrosoftDocs/windows-dev-docs/main/hub/apps/develop/ui/in-app-acrylic.md>）

### DWMSBT 取值（DWM_SYSTEMBACKDROP_TYPE）

**A（Microsoft Learn）**：<https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type>

| 值 | 含义 |
|---|---|
| `DWMSBT_AUTO`（0） | 默认；只画在默认 Win32 标题栏后面，可能完全不画；要整窗材质必须选具体值 |
| `DWMSBT_NONE`（1） | 不画 |
| `DWMSBT_MAINWINDOW`（2） | 长寿命窗口；Win11 上 = **Mica** 默认变体，behind the entire window bounds |
| `DWMSBT_TRANSIENTWINDOW`（3） | transient 窗口；Win11 上 = **Desktop Acrylic**（Background Acrylic）最亮变体 |
| `DWMSBT_TABBEDWINDOW`（4） | tabbed 标题栏；= **Mica Alt** |

> Minimum supported client: **Windows 11 Build 22621**（官方）。

**A** `DWMWA_SYSTEMBACKDROP_TYPE` 在 `DWMWINDOWATTRIBUTE` 枚举文档：<https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute>；同文档还有：
- `DWMWA_USE_HOSTBACKDROPBRUSH`（让非 UWP Win32 窗口通过 `Windows::UI::Composition` 的 `Compositor.CreateHostBackdropBrush` 构建透明效果）
- `DWMWA_REDIRECTIONBITMAP_ALPHA`（redirection bitmap 使用预乘 alpha；**Windows 11 Build 26100+**）
- `DWMWA_BORDER_MARGINS`（边框 margin，全 0 关闭）

### 自定义模糊半径：公开 API 里没有

**B** Windows App SDK 的 Mica/Acrylic 控制器只暴露 `TintColor`、`TintOpacity`、`LuminosityOpacity`、`FallbackColor`，没有 blur radius：

> "Apply Mica or Acrylic materials in desktop apps for Windows 11" — <https://learn.microsoft.com/en-us/windows/apps/develop/ui/system-backdrops>
> Win32 路径（Windows App SDK `MicaController` + `Compositor` 目标）：<https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-mica-win32>

**C（官方仓库 README，旁证）** DWMBlurGlass 明确说自定义模糊半径需要**逆向 DWM**：

> "We reverse-analyzed DWM and created a custom blur method"
> "Customizable global blur radius or title bar blur radius"
> "if you choose the SystemBackdrop blur method, it uses the system's publicly available interfaces and has the same effect as MicaForEveryone"

— <https://github.com/Maplespe/DWMBlurGlass>（README）

即：走公开接口 = 系统固定半径（MicaForEveryone/DWMBlurGlass 的 SystemBackdrop 模式）；要自定义半径 = hook/逆向 DWM（仅标题栏，不适合产品）。

### `SetWindowCompositionAttribute` / accent 是否退化

- **A（Microsoft Learn）** 公开 API `DwmEnableBlurBehindWindow` 自 Win8 起已不产生模糊：
  > "Note: Beginning with Windows 8, calling this function doesn't result in the blur effect, due to a style change in the way windows are rendered."
  — <https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmenableblurbehindwindow>
- **A**：`SetWindowCompositionAttribute` 是**未文档化** API（Microsoft 官方无文档、无保证）。
- **C（社区/产品 issue）** Win11 22H2 移除了原生 blur accent：
  - TranslucentTB README：任务栏 Blur 状态仅支持 "Windows 10 and Windows 11 build 22000"，Acrylic 才在 Win10/Win11 都可用：<https://github.com/TranslucentTB/TranslucentTB>
  - TranslucentTB issue #905 / #922：
    > "Per #905, Windows version update 22H2 has removed the native 'blur' translucency effect, and there is no way to reenable or reinstall it."
    — <https://github.com/TranslucentTB/TranslucentTB/issues/922>，<https://github.com/TranslucentTB/TranslucentTB/issues/905>
- **D（推断）** 在 Win11 22H2+ 上对普通窗口调 `ACCENT_ENABLE_BLURBEHIND` 很可能只剩 tint/无效；`ACCENT_ENABLE_ACRYLICBLURBEHIND` 的表现依 build 而异，且没有任何官方保证。RTA 当前「DWM accent（koffi 调 `SetWindowCompositionAttribute`）效果不对」与这些证据一致。

### 判定

- 需求里的「背景模糊 20px」是 CSS 语义，**无法映射**到 Mica（壁纸、不透明）或 Desktop Acrylic（系统半径、整窗、失焦回退）。
- Win11 上可靠的系统材质入口是 `DWMWA_SYSTEMBACKDROP_TYPE`（build 22621+），Electron 的 `backgroundMaterial` 就是它的封装；更底层的 WinAppSDK 控制器也**不提供**半径/局部区域参数（唯一例外见 Q8 的 2026 新增 `SystemBackdropElement`：区域级、圆角，但材质半径仍由系统决定，且仅 WinUI3）。

---

## Q4. `setContentProtection` / `WDA_EXCLUDEFROMCAPTURE`：能否把本窗口排除出捕获，代价是什么

### Electron API 文档 vs 实际实现

**A（Electron 文档，声称会用 EXCLUDEFROMCAPTURE）**：

> "Prevents the window contents from being captured by other apps. On Windows, it calls `SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE`. For Windows 10 version 2004 and up the window will be removed from capture entirely, older Windows versions behave as if `WDA_MONITOR` is applied capturing a black window."

— <https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-windows-macos>（源文件 `docs/api/browser-window.md:1571-1584`）

**B（Electron 源码，实际是 WDA_MONITOR）**：

- `shell/browser/native_window_views.cc:1344` `void NativeWindowViews::SetContentProtection(const bool enable)` → `:1346` `widget()->SetAllowScreenshots(!enable);`
- Chromium `ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc` 的 `UpdateDisplayAffinity()` 注释：
  > "WDA_MONITOR obscures the window with a black rectangle in the capture, explicitly signaling to the user that the content is intentionally hidden. In contrast, WDA_EXCLUDEFROMCAPTURE completely removes the window from the capture stream, leaving no visual cue."

— Electron 源码：<https://raw.githubusercontent.com/electron/electron/v38.8.6/shell/browser/native_window_views.cc>；Chromium 源码：<https://raw.githubusercontent.com/chromium/chromium/main/ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc>

**C（issue #45990）**：Electron 35.0.1 / Win11 23H2（22631）上，`setContentProtection(true)` 的窗口在抓屏中显示为**不透明黑色矩形**，而不是消失；维护者确认这是 Chromium 的选择（为了让用户「看见内容被隐藏」），Electron 不打算长期 patch：
<https://github.com/electron/electron/issues/45990>

**C（issue #47834，仍在处理）**：`setContentProtection(true)` 的窗口在部分 Windows build 上仍会被抓到（Win10 19045、Win11 22000 可复现；22621/22631/26100 正常）；与 `setOpacity` / `setIgnoreMouseEvents` 有交互；workaround 是设置任意 opacity 再调用：
<https://github.com/electron/electron/issues/47834>

### WDA 的官方语义

**A** `SetWindowDisplayAffinity`（<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity>）：

| 值 | 官方描述 |
|---|---|
| `WDA_NONE` | 无限制 |
| `WDA_MONITOR` | 窗口内容只在「显示器」上显示；在捕获结果中该窗口 **appears with no content**（黑块） |
| `WDA_EXCLUDEFROMCAPTURE` | 窗口在捕获中 **does not appear at all**（完全消失）；Windows 10 2004+ 支持，旧系统按 `WDA_MONITOR` 处理 |

Remarks（官方）：
- 只在 DWM 合成桌面时有效；
- 不是安全/DRM 保证（不能防恶意程序，也不能防显卡级采集）。

### 对 DXGI Desktop Duplication / WGC 是否生效

- **C（robmikh/Win32CaptureSample issue #83，含微软 Capture 相关工程师参与）**：带 `WDA_EXCLUDEFROMCAPTURE` 的置顶 layered 窗口内容在 DDA 捕获中**不可见**；24H2 曾出现「排除窗口自身更新也触发 `AcquireNextFrame`」的行为变化（依赖 MPO），最终 **KB5046617 修复**：
  <https://github.com/robmikh/Win32CaptureSample/issues/83>
- **D（推断，需 cap-probe 实测）**：捕获的是 DWM 合成后的桌面，因此排除掉自身窗口后，其区域应显示**下方应用/桌面的真实像素**（这正是自绘模糊需要的「背后内容」）。该行为是整条 capture 路线的关键前提，必须实测确认（预期：可见下层内容，而不是黑块/旧帧）。

### 代价与限制

1. **用户截图/录屏里看不到卡片**：WDA_EXCLUDEFROMCAPTURE 对截图工具、OBS、会议共享全部生效，且**没有视觉提示**（用户会觉得卡片「消失」了）。这是产品决策点。
2. **远程会话**：Chromium 的 `IsCaptureExclusionAllowed()` 默认在远程会话（`SM_REMOTESESSION`）禁止 capture exclusion，除非开启 `AllowWindowCaptureExclusionInRemoteSessions` feature（B）。RDP/远程共享场景下排除会失效。
3. **版本回归**：Electron 的 `setContentProtection` 路径在部分 build 上有回归（#47834）；自己调 `SetWindowDisplayAffinity` 可以绕开 Electron 的实现，但 Chromium 是否会在 show/resize/DPI 变化时重设 affinity **未确认**（D，需实测）。
4. **重复调用副作用**：Chromium 源码注释引用 crbug.com/359921643——即使 `WDA_NONE`，`SetWindowDisplayAffinity` 也可能让 DWM 把窗口画成 blank rectangle，所以「不要反复设置」。
5. **可用性前提**：仅 Win10 2004+；顶层窗口；DWM 合成开启（Win11 恒开）；不是安全边界。

### 判定

- **不能用 Electron 的 `setContentProtection(true)`** 来实现「自己从捕获中消失」——它给你黑块。
- 要用 **koffi 直接调 `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`**（绕过 Electron/Chromium 的 `SetAllowScreenshots`），并接受截图不可见、远程会话失效、版本回归风险。
- 25H2 是否有变化：**未找到官方说明**（E）；按 24H2 已修复的基线处理。

---

## Q5. Electron 实时桌面流的正确姿势：持久流 vs 反复 `getSources`

### 官方推荐架构

**A（Electron 文档，desktopCapturer）** 当前官方示例是「主进程 `setDisplayMediaRequestHandler` 授权 + 渲染进程 `getDisplayMedia`」：

```js
// main.js
session.defaultSession.setDisplayMediaRequestHandler(
  (request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(
      (sources) => callback({ video: sources[0], audio: 'loopback' }),
      () => callback(null)
    )
  },
  { useSystemPicker: true }
)
```

```js
// renderer.js
const stream = await navigator.mediaDevices.getDisplayMedia({
  audio: true,
  video: { width: 320, height: 240, frameRate: 30 }
})
video.srcObject = stream
```

- `getDisplayMedia` **不允许用 `deviceId` 选择源**（官方 note，W3C 规范如此）。
- `getSources` 的 `thumbnailSize` 官方 note：
  > "Set width or height to 0 when you do not need the thumbnails. This will save the processing time required for capturing the content of each window and screen."

— <https://www.electronjs.org/docs/latest/api/desktop-capturer>（源文件 `docs/api/desktop-capturer.md`）

### 反复 `getSources`（例如每 80ms）为什么错

1. **官方明确缩略图有捕获成本**（上面 note）：每次 `getSources` 都可能枚举 + 抓取每个窗口/屏幕的缩略图，即使你不使用缩略图。
2. **GPU buffer 泄漏（C，issue #55180，Electron 45 / Chromium 156）**：每次桌面捕获（WGC）`getUserMedia` session 会在主进程泄漏一块 source 大小的 GPU buffer，直到进程退出；`getSources({types:['window'], thumbnailSize:{width:320,height:180}})` 每次调用约泄漏 **15MB**（`types:['screen']` 的缩略图不泄漏）。抓屏底层是 Chromium `DesktopCaptureDevice` / WebRTC `WgcCaptureSession`：
   <https://github.com/electron/electron/issues/55180>
3. **反复建会话的固有开销**：每次 capture session 建立/销毁都有 GPU 资源、同步、首帧延迟；80ms 一次 = 每秒 12.5 次会话，既慢又不稳。
4. **每帧 `toDataURL`/`nativeImage` 读回**会强制 GPU→CPU 拷贝，是 4K 下最大的瓶颈。

### 正确做法（综合 A + C + D）

1. **一条持久流**：`getDisplayMedia`（主进程 handler 直接授权指定屏幕，避免用户每次选择；不需要 `useSystemPicker` 时不要开）。源 ID 在 handler 里取一次即可，之后不再调用 `getSources`。
2. **帧数据留在 GPU**：`<video>` → `requestVideoFrameCallback()` 或 `MediaStreamTrackProcessor`（renderer 可用）拿 `VideoFrame`，直接 `texImage2D` 上传到 WebGL 纹理；不要 `canvas.drawImage + getImageData`。
3. **只处理需要的区域**：模糊只在卡片区域做；帧率按需（30fps 通常足够，模糊会掩盖时间噪声）。
4. **传统 `chromeMediaSource` 约束**：`getUserMedia({video:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId}}})` 是 Chromium 私有约束，Electron 当前官方文档不再示例（历史用法），issue 复现代码仍在用（C）。新代码应优先 `getDisplayMedia` + `setDisplayMediaRequestHandler`；`getDisplayMedia` 不能指定 deviceId，因此「选哪块屏」要由主进程 handler 决定。
5. **失败/取消处理**：用户取消、源不存在时要 `callback(null)`；长期运行要监听 track `ended` 并重建。

### 判定

- 「每 80ms `getSources` + 截图」是**错误架构**，不只是慢：官方说缩略图有成本，issue 证明反复建 session 有 GPU 泄漏。
- 唯一正确姿势是**一条持久流 + GPU 内处理**。

---

## Q6. Win11 24H2/25H2 回归、虚拟显示适配器、`--disable-gpu`

### 24H2：DDA 捕获行为变化（有证据，已修复）

**C（Win32CaptureSample issue #83，robmikh = 微软 Capture 相关工程师）**：24H2 上，带 `WDA_EXCLUDEFROMCAPTURE` 的置顶 layered 窗口会导致 Desktop Duplication 的 `AcquireNextFrame` 行为改变（排除窗口自身更新也触发帧），依赖 Multiplane Overlay (MPO)；23H2 行为不同。最终确认 **KB5046617 修复**：
<https://github.com/robmikh/Win32CaptureSample/issues/83>

**含义**：capture 路线依赖「排除窗口」的地方（Q4）在 24H2 早期版本上可能有帧节流/DDA 异常；25H2 (26200) 基于 24H2，若已装最新累积更新应已修复，但仍需实测（cap-probe）。

### DWM 材质在截图中缺失/变黑

- **D（推断）**：Mica/Acrylic 是 DWM 合成器绘制的材质，不属于窗口自己的 redirection surface。用 `PrintWindow`/`BitBlt` 这一类「抓窗口位图」的 API 时，材质区域可能缺失/变黑；Desktop Duplication / WGC 抓的是**合成后的桌面**，理论上应包含材质效果——但本次**未找到微软官方文档明确说明**（E），需要用 cap-probe/dwm-probe 的抓屏实测验证。
- **C**：Electron issue #48031 报告 backgroundMaterial 窗口在被遮挡/拖出屏幕时变黑——这说明系统材质的合成状态与遮挡/可见性相关，进一步说明截图行为不可想当然。

### 虚拟显示适配器（Oray IDD / 向日葵等）

**B（WebRTC/Chromium 源码，官方仓库）** `dxgi_duplicator_controller.cc` 注释原文：

> "There may be several video cards on the system, some of them may not support IDXGOutputDuplication. But they should not impact others from taking effect, so we should continually try other adapters. This usually happens when a non-official virtual adapter is installed on the system."

实现行为：
- 逐个 adapter/output 尝试 `IDXGIOutput1::DuplicateOutput`，单个失败 log `"Failed to initialize DxgiOutputDuplicator on output i"` 并跳过；
- 所有 adapter 都失败 → `"Cannot initialize any DxgiAdapterDuplicator instance."` / `"Cannot initialize any DxgiOutputDuplicator instance."`，`Duplicate()` 返回 `Result::INITIALIZATION_FAILED`；
- session 0 不支持（`IsCurrentSessionSupported`）；
- 非 console session（detached/RDP）可能只产出最多 4 帧后停止且不报错，因此代码会跳过 5 帧才判定初始化成功。

— WebRTC 源码：`third_party/libwebrtc/modules/desktop_capture/win/dxgi_duplicator_controller.cc`、`dxgi_adapter_duplicator.cc`（经 gecko-dev 镜像 raw 读取确认）

**E（未找到官方依据）**：没有找到 Microsoft/Oray 关于「向日葵 Oray IDD 导致 Electron/Chromium 无法初始化 DXGI Duplicator」的官方说明；但**同类问题**（非官方虚拟显示适配器）有上面源码级依据。实际影响：捕获初始化可能失败，或选中错误 monitor；需要 fallback（WGC/GDI）与「按显示设备选择 source」的策略。

### `--disable-gpu`

- **E（未找到官方文档）**：没有找到「`--disable-gpu` 对 Electron Desktop Duplication/WGC 的影响」的官方说明。
- **D（推断）**：`--disable-gpu` 关闭 GPU 硬件加速；WGC 需要 D3D11 设备，Chromium 在无 GPU 时可能回退到 GDI 捕获（WebRTC 存在 `screen_capturer_win_gdi.cc` 实现），结果是 CPU 占用升高、帧率/延迟变差，甚至无法建立 WGC 流。**不要**把 `--disable-gpu` 当作兼容性修复手段；若必须使用，需要实测捕获是否仍工作。

### 25H2

- **E**：截至 2026-11-11，**未找到**针对 25H2 (build 26200) 的 DWM 材质/捕获相关官方变更或已知问题文档。25H2 是 24H2 的启用包，建议按 24H2 基线 + 最新累积更新验证。

### 其它捕获边界（通用）

- **安全桌面**（UAC、锁屏、Ctrl+Alt+Del）不可被普通进程捕获（系统设计，未找到需要单独引用的官方文档；D 推断，但属通用 OS 行为）。
- **HDR 内容**：Desktop Duplication 官方文档明确输出为 `DXGI_FORMAT_B8G8R8A8_UNORM`（SDR）——HDR 屏上颜色会经 tone mapping，和肉眼所见可能不一致：<https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api>
- **受保护内容/独占全屏**：可能黑屏；DDA 文档未单列，属推断（D）。
- **多显示器/负坐标**：捕获帧尺寸、原点、DPI scaleFactor 都要处理（见 Q8）。

---

## Q7. 商业产品参考：各自的技术路线

| 产品 | 路线 | 关键证据 | 等级 |
|---|---|---|---|
| **Windows Terminal** | WinUI 3 / Windows App SDK 的 XAML 材质：`useAcrylic` + `opacity`（profile 设置），Mica 走主题设置；窗口级材质 + 应用内 AcrylicBrush | 官方文档："When useAcrylic is set to true, the window will use the acrylic material to create a blurred background for the terminal."；"When Mica is enabled in the theme settings, Mica will appear underneath the Terminal contents when the opacity of the Terminal is set to a value <100." — <https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-appearance> | A |
| **Windows Terminal（内部设计）** | 明确「Mica 只能整窗/root，Acrylic 才能到元素级（HostBackdrop brush）」；DWM 新 API 对 `WS_CHILD` 无效；自绘 Mica 不可行（依赖闭源 IGraphicsEffect） | Terminal spec #10509「Mica」：<https://github.com/microsoft/terminal/blob/80c529acedc999355bc6c90a953dd02befadebbb/doc/specs/drafts/%233327%20-%20Application%20Theming/%2310509%20-%20Mica.md> | A/B |
| **PowerToys Run** | WPF + WPF UI 的 `WindowBackdropType.Acrylic`（Win11 上 = `DWMSBT_TRANSIENTWINDOW`），Win10 走 legacy 分支；用 `DwmSetWindowAttribute` 改 caption color 修 accent 渗透；窗口内容用半透明 Grid（Opacity 0.8） | PR #33458（diff）：<https://patch-diff.githubusercontent.com/raw/microsoft/PowerToys/pull/33458.diff>；WPF UI `WindowBackdrop.cs`：<https://raw.githubusercontent.com/lepoco/wpfui/303f0aefcd59a142bc681415dc4360a34a15f33d/src/Wpf.Ui/Controls/Window/WindowBackdrop.cs>（Windows 11 22H1+ 用 `DWMWA_SYSTEMBACKDROP_TYPE`；更旧系统用未文档化 `DWMWA_MICA_EFFECT`=1029） | B/C |
| **TranslucentTB** | 对任务栏窗口用未文档化的 `SetWindowCompositionAttribute` + accent policy；非常轻量 | README：Blur 仅 Win10 / Win11 build 22000，Acrylic 双平台；"A lightweight (uses a few MB of RAM and almost no CPU)" — <https://github.com/TranslucentTB/TranslucentTB> | C |
| **MicaForEveryone** | 用公开 DWM system backdrop 接口按窗口设置材质（与系统材质等效，不能自定义半径） | DWMBlurGlass README 对比："if you choose the SystemBackdrop blur method, it uses the system's publicly available interfaces and has the same effect as MicaForEveryone" — <https://github.com/Maplespe/DWMBlurGlass> | C |
| **DWMBlurGlass** | 逆向/hook DWM 实现自定义模糊半径与样式（标题栏），仅系统标题栏范围 | README："We reverse-analyzed DWM and created a custom blur method"；"Customizable global blur radius or title bar blur radius" — <https://github.com/Maplespe/DWMBlurGlass> | C |

### 观察

1. **没有任何主流产品**用「捕获桌面 + 自绘模糊」实现「任意应用之上的毛玻璃浮层」。它们全部使用 **OS/框架提供的材质**，接受系统固定半径与语义（Mica 只壁纸、Acrylic 整窗/元素）。
2. 需要更多控制的产品（DWMBlurGlass）只能 hook DWM；需要「自定义半径 + 任意区域 + 任意应用之上」的公开、稳定路径**不存在**。
3. WinUI 3 / WinAppSDK 2026 新增了 `SystemBackdropElement`（区域级系统材质，支持 `CornerRadius`，需要 Windows App SDK 2.0+，仅 XAML 树内）——这是「卡片级 Acrylic」的官方能力，但：
   - 只适用于 WinUI3/WinAppSDK 应用，**Electron 用不了**；
   - 材质仍是系统 Acrylic（系统模糊半径/着色，不能 20px 自定义）。
   — <https://learn.microsoft.com/en-us/windows/apps/develop/ui/system-backdrops>
4. 任务里提到的 "Raycast Windows"：**未找到权威实现说明**（E），不作为证据使用。

---

## Q8. 2026 年技术栈下的可行路线与硬限制

### 需求拆解

| 需求 | 含义 |
|---|---|
| 任意应用之上 | 置顶、不依赖目标应用配合 |
| 实时 | 视觉上跟手（≤ 1–2 帧，16–33ms） |
| 20px 模糊 | 与 pen 设计稿一致的模糊强度（CSS `blur(20px)` 语义） |
| 空间对齐 | 卡片内显示的模糊内容与屏幕上卡片背后像素**逐像素对齐** |
| 局部卡片 | 圆角、可多张、可移动 |

### 路线对照

| 路线 | 能满足 20px？ | 能满足局部卡片？ | 实时 | 成本 | 结论 |
|---|---|---|---|---|---|
| **A. CSS `backdrop-filter`** | —（无桌面采样） | 可以 | — | 0 | **不可行**（Q1） |
| **B. DWM 系统材质**（BackgroundMaterial / DWMSBT_MAINWINDOW/TRANSIENTWINDOW） | ❌ 系统固定半径 | ❌ 整窗矩形（`setShape` 交互未定义） | ✅ | 极低 | **只能近似降级**（Q2/Q3） |
| **C. 捕获 + 自绘模糊**（WGC 持久流 + WebGL shader + WDA 排除自己） | ✅ 半径任意（20px 精确） | ✅ 卡片级 mask/圆角 | ✅ 1–3 帧延迟 | 高（GPU/带宽/功耗） | **唯一满足设计目标的路线** |
| **D. hook/逆向 DWM**（DWMBlurGlass 式） | ✅ | 受限于标题栏/系统表面 | ✅ | 极高、不可维护 | 不可用于产品 |
| **E. 原生 WinUI3 辅助窗**（WinAppSDK 2.0 `SystemBackdropElement`） | ❌ 系统半径 | ✅ 区域级 + 圆角 | ✅ | 中（额外原生进程/窗口） | 有区域级但无 20px；Electron 集成成本高 |

### 推荐方案（C 为主，B 为降级）

**C 路线的最小可行架构**（与 RTA 当前实现对照）：

```
[主进程]
  session.setDisplayMediaRequestHandler → 选中目标 screen source（一次）
  koffi: SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)   // 把自己从捕获里挖掉
        ↑ 不要用 setContentProtection(true)（那是 WDA_MONITOR 黑块）
[渲染进程（透明置顶 overlay）]
  getDisplayMedia({ video: { frameRate: 30 } }) → 一条持久 MediaStream
  <video> → requestVideoFrameCallback / MediaStreamTrackProcessor
        → WebGL texture（整帧或屏幕区域）
        → fragment shader: 20 CSS px 高斯/dual-Kawase + 圆角 mask + tint/noise
        → 画到 overlay 的屏幕坐标位置
[对齐]
  overlay 使用 screen 坐标（DIP × scaleFactor 得物理像素）
  捕获帧的 display 原点/尺寸映射到 overlay 本地坐标
```

关键实现点：

1. **单流**：只在启动时取一次 source；之后不再 `getSources`。缩略图尺寸设 0 或不取缩略图。
2. **自排除**：`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`（0x11）。这是让「卡片背后内容」进入捕获画面的关键；若不做，捕获画面里是卡片自己，形成反馈/鬼影。
3. **对齐**：Electron 窗口坐标是 DIP；捕获帧是物理像素。用 `screen.getDisplayMatching(bounds)` 拿 `scaleFactor` 与 display bounds，把卡片 rect 换算成捕获帧内的像素区域；多显示器注意负坐标与各屏 DPI 不同。
4. **模糊**：20 CSS px 对应物理像素 = 20 × scaleFactor（125% 屏上是 25px）。用可分离高斯或 dual-Kawase 在卡片区域做，成本只和卡片面积相关，而不是全屏。
5. **时序**：WGC 帧到达有 1–3 帧延迟；卡片拖动时「被挖掉的洞」跟着移动，洞边缘会短暂露出未模糊/旧内容。缓解：拖动时降低模糊或暂时改为纯色/更高不透明度，停下后恢复。
6. **帧率/功耗**：捕获 30fps、只渲染卡片区域；4K 全屏纹理上传仍可观，建议直接用 GPU 纹理（`texImage2D(VideoFrame)`），不要读回 CPU。
7. **窗口形态**：一个覆盖目标显示器的透明置顶窗（或每卡片一个小窗）都可以；前者对齐简单但窗口大，后者省 GPU 但要处理多窗口/纹理共享与每窗排除。
8. **降级**：若 WDA 排除在某些环境失败（远程会话/个别 build），可退化为：
   - 对「已知单一背景窗口」直接捕获该窗口 source（`types:['window']`）而不是整屏；
   - 或退回 B（DWM Acrylic）并接受设计偏差。

### 硬限制清单（必须写进产品预期）

| # | 限制 | 影响 | 证据 |
|---|---|---|---|
| 1 | CSS `backdrop-filter` 永远无法采样桌面 | 排除 A 路线 | Q1 / #30412 |
| 2 | DWM 材质只有整窗、系统固定模糊、固定着色；Win11 22H2+ | 20px/局部卡片无法实现 | Q2/Q3 |
| 3 | Mica 采样壁纸（不透明）；Acrylic 失焦/省电/关透明效果时变纯色 | 置顶浮窗经常失焦 → 材质消失 | Q3 |
| 4 | Electron `setContentProtection` = WDA_MONITOR，抓屏黑块 | 不能用于自排除；必须自调 WDA | Q4 / #45990 |
| 5 | `WDA_EXCLUDEFROMCAPTURE` 让用户截图/录屏/共享里**看不到卡片** | 产品可见性代价；需向用户说明 | Q4 |
| 6 | 远程会话默认禁止 capture exclusion（Chromium feature gate） | RDP/远程共享场景退化 | Q4 / Chromium 源码 |
| 7 | 反复 `getSources`/建 capture session 泄漏 GPU buffer（窗口缩略图约 15MB/次） | 必须持久单流 | Q5 / #55180 |
| 8 | 捕获有 1–3 帧延迟；移动时边缘短暂错位 | 「实时」是 30–50ms 级，不是 0 | D（推断，需 cap-probe 实测） |
| 9 | 安全桌面/UAC/锁屏不可捕获；HDR 内容为 SDR B8G8R8A8；受保护内容可能黑屏 | 特定场景无效果 | Q6 / DDA 文档 |
| 10 | 虚拟显示适配器（Oray IDD 等）可能导致 DXGI duplicator 初始化失败 | 初始化失败/选错屏；需 fallback | Q6 / WebRTC 源码（E 针对 Oray 具体） |
| 11 | 24H2 早期 DDA + 排除窗口行为回归（KB5046617 修复） | 需按最新累积更新测试 | Q6 / Win32CaptureSample #83 |
| 12 | `setShape` 与 DWM 材质/捕获排除的交互未文档化 | 圆角卡片在系统材质路线下需实测 | Q2 |
| 13 | Win11 25H2 无专门官方资料 | 结论按 24H2 基线外推 | E |

### 交给探针的实测清单（cap-probe / dwm-probe）

1. **WDA_EXCLUDEFROMCAPTURE hole 语义**（最高优先级）：在 Electron 窗口上 koffi 调 `SetWindowDisplayAffinity(hwnd, 0x11)`，用 `getDisplayMedia` 抓全屏，确认卡片区域是「下方真实内容」而非黑块/旧帧；同时确认截图工具行为。
2. **Chromium 是否重设 affinity**：窗口 show/hide、resize、DPI 变化、setIgnoreMouseEvents 后，affinity 是否保持。
3. **backgroundMaterial 组合**：`transparent:true` + `frameless:true` + `backgroundMaterial:'acrylic'` 实测效果与失焦行为；`backgroundColor` 透明/不透明对比（对应 #49443/#48031 的矛盾）。
4. **setShape + 系统材质**：材质是否被裁剪为 shape 区域（决定 B 路线能否圆角卡片）。
5. **捕获延迟/GPU/CPU**：4K 30/60fps 单流 + WebGL 20px 模糊的帧时间、GPU 占用、功耗。
6. **`--disable-gpu` / 无独显环境**：捕获是否仍工作（验证 D 推断）。
7. **Oray IDD/虚拟显示器**（如测试机装有）：WGC/DXGI 是否初始化失败，Electron 报错形态。
8. **多显示器/混合 DPI**：对齐误差与帧尺寸变化。

---

## 参考来源清单

### A. 官方文档 / 规范

1. CSS Filter Effects 2（backdrop-filter / Backdrop Root）— <https://drafts.csswg.org/filter-effects-2/>
2. Electron `BrowserWindow`（setBackgroundMaterial / setShape / setContentProtection）— <https://www.electronjs.org/docs/latest/api/browser-window>
3. Electron BaseWindow 选项（backgroundMaterial / transparent）— <https://www.electronjs.org/docs/latest/api/structures/base-window-options>
4. Electron desktopCapturer（getSources / setDisplayMediaRequestHandler 示例）— <https://www.electronjs.org/docs/latest/api/desktop-capturer>
5. Microsoft Learn：Mica — <https://learn.microsoft.com/en-us/windows/apps/design/style/mica>
6. Microsoft Learn：Acrylic — <https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic>
7. Microsoft Learn：Apply Mica or Acrylic materials in desktop apps for Windows 11（`SystemBackdropElement`/controller）— <https://learn.microsoft.com/en-us/windows/apps/develop/ui/system-backdrops>
8. Microsoft Learn：In-app acrylic（WinUI 3 不采样桌面）— <https://learn.microsoft.com/en-us/windows/apps/develop/ui/in-app-acrylic>
9. Microsoft Learn：Apply Mica in Win32 desktop apps（Windows App SDK MicaController）— <https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-mica-win32>
10. Microsoft Learn：`DWM_SYSTEMBACKDROP_TYPE` — <https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type>
11. Microsoft Learn：`DWMWINDOWATTRIBUTE` — <https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute>
12. Microsoft Learn：`DwmEnableBlurBehindWindow`（Win8 起无效）— <https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmenableblurbehindwindow>
13. Microsoft Learn：`SetWindowDisplayAffinity`（WDA_MONITOR / WDA_EXCLUDEFROMCAPTURE）— <https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity>
14. Microsoft Learn：Desktop Duplication API — <https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api>
15. Microsoft Learn：Windows Terminal profile appearance（useAcrylic / opacity / Mica）— <https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-appearance>

### B. 官方源码 / 官方仓库

16. Electron v38.8.6 `docs/api/structures/base-window-options.md` — <https://raw.githubusercontent.com/electron/electron/v38.8.6/docs/api/structures/base-window-options.md>
17. Electron v38.8.6 `docs/api/browser-window.md` — <https://raw.githubusercontent.com/electron/electron/v38.8.6/docs/api/browser-window.md>
18. Electron v38.8.6 `shell/browser/native_window_views.cc` — <https://raw.githubusercontent.com/electron/electron/v38.8.6/shell/browser/native_window_views.cc>
19. Chromium `ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc` — <https://raw.githubusercontent.com/chromium/chromium/main/ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc>
20. WebRTC `modules/desktop_capture/win/dxgi_duplicator_controller.cc`、`dxgi_adapter_duplicator.cc`（经 gecko-dev 镜像 raw 读取）
21. MicrosoftDocs `hub/apps/develop/ui/system-backdrops.md` — <https://raw.githubusercontent.com/MicrosoftDocs/windows-dev-docs/main/hub/apps/develop/ui/system-backdrops.md>
22. MicrosoftDocs `hub/apps/develop/ui/in-app-acrylic.md` — <https://raw.githubusercontent.com/MicrosoftDocs/windows-dev-docs/main/hub/apps/develop/ui/in-app-acrylic.md>
23. MicrosoftDocs `hub/apps/desktop/modernize/ui/apply-mica-win32.md` — <https://raw.githubusercontent.com/MicrosoftDocs/windows-dev-docs/main/hub/apps/desktop/modernize/ui/apply-mica-win32.md>

### C. issue / PR / 社区讨论

24. electron/electron#30412（backdrop-filter 不能采样桌面）— <https://github.com/electron/electron/issues/30412>
25. electron/electron#45990（setContentProtection 抓屏黑块）— <https://github.com/electron/electron/issues/45990>
26. electron/electron#47834（setContentProtection 回归）— <https://github.com/electron/electron/issues/47834>
27. electron/electron#55180（桌面捕获 GPU buffer 泄漏）— <https://github.com/electron/electron/issues/55180>
28. electron/electron#49443（acrylic 与 transparent）— <https://github.com/electron/electron/issues/49443>
29. electron/electron#48031（backgroundMaterial 失焦/遮挡/黑底）— <https://github.com/electron/electron/issues/48031>
30. electron/electron#48440（Win10 上 acrylic 无效）— <https://github.com/electron/electron/issues/48440>
31. robmikh/Win32CaptureSample#83（24H2 DDA 行为变化，KB5046617 修复）— <https://github.com/robmikh/Win32CaptureSample/issues/83>
32. microsoft/terminal spec #10509「Mica」— <https://github.com/microsoft/terminal/blob/80c529acedc999355bc6c90a953dd02befadebbb/doc/specs/drafts/%233327%20-%20Application%20Theming/%2310509%20-%20Mica.md>
33. microsoft/PowerToys PR #33458 diff — <https://patch-diff.githubusercontent.com/raw/microsoft/PowerToys/pull/33458.diff>
34. WPF UI `WindowBackdrop.cs`（pinned）— <https://raw.githubusercontent.com/lepoco/wpfui/303f0aefcd59a142bc681415dc4360a34a15f33d/src/Wpf.Ui/Controls/Window/WindowBackdrop.cs>
35. TranslucentTB README / issue #905 / #922 — <https://github.com/TranslucentTB/TranslucentTB>、<https://github.com/TranslucentTB/TranslucentTB/issues/905>、<https://github.com/TranslucentTB/TranslucentTB/issues/922>
36. MicaForEveryone / DWMBlurGlass README（自定义半径需逆向 DWM）— <https://github.com/Maplespe/DWMBlurGlass>

### E. 明确「未找到官方依据」的条目

- Win11 **25H2 (26200)** 关于 DWM 材质/桌面捕获的专门官方说明
- 向日葵 **Oray IDD** 与 DXGI Duplicator 初始化失败的官方说明（仅有 WebRTC 源码对「非官方虚拟适配器」的通用注释）
- `--disable-gpu` 对 Electron/Chromium 桌面捕获的官方影响说明
- DWM 材质在 Desktop Duplication / WGC 截图中「缺失/变黑」的官方说明（仅有 Electron issue 与推断）
- Windows 的「HDR 捕获颜色」官方行为说明（DDA 文档只说明输出格式为 B8G8R8A8_UNORM）
- 「Raycast Windows」的实现路线（未找到权威资料）

---

*本文只做资料核查，不含实测数据；与 cap-probe / dwm-probe 的实测结论交叉验证后再作为最终诊断依据。*
