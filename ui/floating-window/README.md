# RTA 悬浮窗（代码实现）

`RTA.pen` 里 `PrC7t`「RTA 悬浮窗」1:1 的代码版：正常状态下就是一个小型悬浮聊天窗口。
所有设计数值（尺寸 / 材质 / 圆角 / 字体 / 图标 / 间距）**逐字取自 pen 导出文件**，没有任何
从截图上目测或猜测的数值。

> **窗口边界**：悬浮窗 = 消息玻璃卡 + 输入卡，共 **420×632** 两个卡片。
> 设计稿里的「Desktop 桌面截图」和「Scrim 蒙层」只是 pen 画布的演示环境，**不属于悬浮窗**，
> 实现里已经去掉；页面背景透明，背后由宿主自己画。
> 相关实现细节：`build_from_pen.py` 只从导出里取两张卡片；`index.html`/`styles.css` 里没有任何
> 桌面截图或蒙层；`assets/` 只剩拼图素材与字体。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | **生成产物**：结构与内联样式来自 pen 的 html-css 导出，勿手改 |
| `build_from_pen.py` | 从 pen 导出重建 `index.html` 的脚本（只取两张卡片，丢弃 Desktop/Scrim） |
| `styles.css` | 只加设计稿无法表达的壳层：透明页面、真实输入框、消息滚动区、拖拽态、收起胶囊 |
| `app.js` | 行为：会话计时、发送、拖拽、收起/展开 |
| `assets/sheet.png` | 设计稿里的拼图素材 |
| `assets/NotoSansSC-VF.ttf` | 设计稿字体 Noto Sans SC（本机 `C:/Windows/Fonts/NotoSansSC-VF.ttf`） |
| `preview.png` / `preview-collapsed.png` | 预览图：窗口叠在一块纯色 `#151517` 色块上——只为静态图里能看清浅色玻璃字；色块不是窗口的一部分，`index.html` 本身背景是透明的 |

## 数值来源（唯一真源）

pen 画布 → Export → html-css 得到
`<pencil 文档目录>/_exports/review/rta-reference.html`，其中包含：

- 卡片圆角的 squircle 连续曲线（`<path d="M54 0l312 0 …">`）与渐变坐标；
- Messages Card：420×520，`linear-gradient(#FFFFFF12 → #FFFFFF08)`、stroke `#FFFFFF1F` 1px、
  `backdrop-filter: blur(20px)`、`box-shadow: 0 6px 20px #0000004D, inset 0 1px 0 #ffffff12`；
- Composer Card：420×98，纯色 `#2c2c2e`、stroke 0.5px、`0 4px 16px #0000004D`；
- 全部间距（16/12/8/5/4/2…）、字号（15/11.5/16/11/13）、字重、行高、字距、图标（lucide
  message-square / chevron-down / minus / plus / arrow-up，均为导出内联 SVG）。

重新生成：

```bash
# 修改 build_from_pen.py 顶部的 REF 路径（指向新的 rta-reference.html）后
python build_from_pen.py
```

## 保真校验

`_probe/ui/verify_design_values.mjs` 用 Chrome DevTools Protocol 同时打开 pen 导出页与实现页，
对 22 个关键节点逐项比较 **计算后样式**（width/height/padding/gap/radius/background/
box-shadow/backdrop-filter/font-size/weight/family/line-height/letter-spacing/color/outline），
并比较卡片 squircle 的 `path d` 与渐变端点：

```
OK: all compared design values match the pen export
```

（唯一被归一化的是继承来的 `font-family` 长列表与同一素材在不同目录的 URL。）

## 交互

- 拖拽：按住 Header 拖动整个窗口（页面内可自由移动）；
- 收起：点右上角 `−` 收起为右下角胶囊（保留会话计时），点胶囊恢复；
- 发送：输入框回车或点发送按钮，追加 user 气泡并模拟一条 AI 回复（演示用）；
- 会话计时：状态胶囊显示「已启用 mm:ss」，每秒刷新。

## 已知边界 / 下一步

1. 玻璃卡片的文字是 `#f9fafb`、卡片底只有 4%–7% 白，设计前提是**背后为深色界面**。
   接进 DSH 后如果宿主是浅色主题，需要给卡片加不透明度或按主题适配——这是实现层面要补的，
   设计稿本身没定义浅色态。
2. 目前是独立可运行的静态原型（`ui/floating-window/`），尚未接入 DSH 插件运行时；
   下一步是把它做成 DSH client UI 浮层（DOM 级覆盖，`backdrop-filter` 才能真的blur宿主内容），
   并把 RTA 引擎的事件流接进来。
3. 设计稿是静态断面：消息滚动、图片具体内容、占位文案不做像素级较真。
