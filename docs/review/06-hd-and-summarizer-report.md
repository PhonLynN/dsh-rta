# 06 · 高清算法帧通道 + 后台摘要子代理：实现与真机验证报告

日期：2026-11-11（本地）
对应需求：m00761（注入必须是算法判断后真正有信息的高清图像；注入过程中就开始总结）、m00826（主会话不能被打断，启用 RTA 时自动起子智能体持续生成摘要，主 agent 按需取高清原图）、m00963（每次启动 RTA 让主 agent 知晓；每次用户发消息时找子 agent 要刚刚产生的摘要）。

## 1. 交付内容

### 1.1 高清（HD）帧通道

| 文件 | 变更 |
| --- | --- |
| `src/host/hd.js`（新增，~300 行） | 纯算法层：`importance()` 信息量打分（region 1000 > manual 400 > cut 200 > text 180 > integral 100 > heartbeat 0，另加 score 与圈选面积 bonus）；`cropRectFor()` 决定裁剪矩形（region 用 bbox，其余用窗口 rect，兜底前景 rect，<32px 放弃）；`buildVf()` 生成 ffmpeg `crop=w:h:x:y[,scale=w:-2]`（偶数对齐、边界收敛、面积≥85% 回退整幅）；`widthForTokens()` 按 token 预算反推宽度（1600/1440/1280/…/720）；`pickInformativeFrames()` 按信息量挑帧并做同窗口/1.5s 去重；`pickSpread()` 把时间窗均分后每段挑最重要事件（空段用录像帧补位，长视频不会只覆盖开头）；`extractHdFrame()` 调 `engine.frameAt()` 抽原生帧；`makeHdDir()/cleanHdDir()`。 |
| `src/record/ffmpeg.js` | `extractFrame(wallMs, outPath, { quality, vf })`：主路径与两处兜底共用 `-vf <expr>`，保留原有混合 seek。 |
| `src/engine/engine.js` | `frameAt({ wallMs, outPath, vf })` 透传 vf；新增 `regionRing`（cap 24，region 帧不再被 cut 洪水挤出 eventRing）；`composeKind` 对 region 优先用 regionRing。 |
| `src/host/lifecycle.js` | 每轮首步图片通道优先 `hdShot()`：挑 1 张 180s 内的信息量最高帧 → 裁剪到窗口 → 按 `inject.image.hdMaxWidth` 缩图 → 附件；失败回落旧拼图。 |
| `src/tools/handlers.js` | `rta_look` 默认 `count=2`、`maxTokens=1200`，默认 HD（`hd:false` 回退拼图）；`rta_recall` 默认隐藏 15fps 逐帧行、新增 `maxImages`（1–4 默认 3），`images:true` 时用 `pickSpread` 均分窗口挑事件并抽 HD 裁窗图。 |
| `src/host/messages.js` | `buildHdCaption()`：说明 HD 图来自原生录像、已裁窗、类型/强度/尺寸，提示 `rta_note` 记摘要。 |
| `src/config.js` | `inject.image.hd`（默认 true）、`inject.image.hdMaxWidth`（默认 1600）。 |

### 1.2 后台摘要子代理

| 文件 | 变更 |
| --- | --- |
| `src/host/summarizer.js`（新增，~300 行） | `createSummarizer()`：45s 间隔、10 分钟 ≤6 次、180s 超时；`delivery:'caller'` 保证结算消息**不回父会话**（零唤醒）；`request.prompt` 为 content parts、`request.parent` 为绑定 agent、`signal` 为每次 activation 独立 AbortController；prompt 里要求子代理先看 digest、必要时 `rta_look(count=1)`、再用 `rta_note({name:"screen-log"})` 写 2–4 句中文；digest 未变化不重复起子代理；`latestSummary()` 读 notes 下最新 md。 |
| `src/host/lifecycle.js` | `turnMaterialsFor()` 取代旧 `imageMessageFor()`：每轮 step1、绑定会话——① `await summarizer.latestSummary()` 读最新摘要，带「〔RTA 屏幕摘要（后台子代理·刚刚/约 N 分钟前）〕」；② `startNoticePending` 时注入一次「〔RTA 已启动〕…」；③ 一张预算内 HD 截图；1Hz tick 同时驱动 `summarizer.tickOnce()`；`status()` 暴露 summarizer 统计。 |
| `src/host/runtime.js` | `CHILD_READ_TOOLS = {rta_look, rta_region, rta_note}`：绑定会话的子代理（`header.parentSession === bound.sessionId`）可用只读工具，不能 start/stop；api 的 `bound` getter 补回 `agent`（原先只暴露 sessionId，导致摘要器拿不到 parent）。 |
| `src/config.js` | `inject.summarizer = {enabled:true, provider:null, intervalMs:45000, maxPer10Min:6, timeoutMs:180000}`，readRtaConfig 深解析。 |
| `src/tools/spec.js` / `handlers.js` | 工具文案同步 HD/摘要；`rta_status` 增加 `summarizer:…` 诊断行（attached/subagents/ticks/skip/started/errors/inFlight/summary）。 |

### 1.3 测试

新增 `test/hd.test.mjs`（14 条）、`test/summarizer.test.mjs`（10 条）。当前全套 **68 条全绿**：algo 10、engine 6、store 2、plugin 7、live 19、hd 14、summarizer 10。

> 沙箱内 `node --test test/*.test.mjs` 会 `spawn EPERM`（test runner 需要 spawn 子进程），因此逐文件跑 `node test/<name>.test.mjs`。

## 2. 真机验证（2026-11-11 18:39–18:43，session `20261111-183919`）

1. **摘要子代理真的被启动并写出滚动摘要**：
   - `rta_status` → `summarizer: on provider=auto attached=yes subagents=yes engine=running ticks=86 skip=interval started=2 errors=0 summary=90ch (15s ago)`。
   - 子会话目录按 45s 节奏出现（`5efcec91…` 18:39:21、`50272ad8…` 18:40:21），父会话未收到任何新用户消息（`delivery:'caller'`）。
   - `notes/screen-log.md` 内容：`18:40 屏幕仍无显著变化，前台保持 RTA — DeepSeek Harness 窗口，用户未切换应用、也无可读的内容变动。已连续约 1–5 分钟静止，判断为持续停留在该界面。`
2. **HD 帧通道**：打开记事本（最大化）制造一次 cut（18:41:15，强度 12）后，`rta_look(count=1)` 返回 `rta-look-hd-1527-….jpg`：**1600×900、已裁剪到记事本窗口**，标题栏/菜单/格式栏/状态栏文字清晰可读，输出文案为「1 HD frame(s) picked by importance (region > cut > integral), cropped to the window at that moment」。
3. **HD recall**：`rta_recall(18:39:30→18:41:20, images:true, maxImages:2)` → 记录列表默认隐藏 1448 条逐帧行、只留 6 条事件/笔记；附 2 张 HD 图：① 均分窗口抽的录像帧（1600×900，DSH 对话界面文字可读）② cut 事件裁窗帧（1058×1122）。证明「长窗口里按位置采样 + 原生分辨率裁窗」生效。

### 2.1 验证期间修掉的 4 个真 bug

1. `src/host/lifecycle.js` 从未调用 `summarizer.attach()`（自有定时器没挂），1Hz tick 也没驱动 `tickOnce()` → 摘要器永远不动。补 attach + tick 兜底。
2. `runtime` 的 `bound` getter 只返回 `{sessionId}`，`rt.bound.agent` 为 undefined → tick 的 `no-binding` 跳过。补回 `agent`。
3. `subagents.startActivation()` 会同步 `signal.throwIfAborted()` → 必须传 AbortSignal。每次 activation 用独立 `AbortController`，超时/dispose 时 abort。
4. `request.prompt` 必须是 content parts 数组 `[{type:'text',text}]`（宿主直接喂 `createUserMessage`）；传字符串时报 `content.some is not a function`。

## 3. 已知限制 / 待验证

- **每轮首步材料（摘要块 + 「RTA 已启动」告知 + 首张 HD 图）只在下一个用户轮次生效**：已在 19:00 的新轮次真机确认落盘（见 §4.3）。
- 摘要子代理是**一次性 activation**：宿主没有「持续投喂同一个子代理」的公开 API；每次新起一个（带上一版摘要做连续性），间隔 45s，最坏滞后 1–2 分钟。
- 子代理模型路由继承父会话；如需指定 provider 可写 `inject.summarizer.provider`。
- HD 通道在无事件（只有 heartbeat）、录像不可用、jpeg 模式或帧太旧时回退 512px 拼图；`rta_look` 可用 `hd:false` 强制回退。
- 摘要器每次 activation 会创建一个子会话目录（约 1 条用户消息 + 1 次工具调用），长期开启会累积；后续可加「子会话按需清理 / 复用同一 childId 的 continuable 通道」。

## 4. 视频播放真机验证（2026-11-11 18:58–19:03，session `20261111-184556`）

用本地 HTTP 服务 + Edge 静音循环播放一段 2 分钟的真实视频（从旧 RTA 录像 `20261111-180040/seg-000.ts` 裁出的 B 站页面片段，1280×720），模拟「用户正在看视频」：

1. **采集侧**：播放期间 `rta_status` 的 events 从 17 涨到 58，recent 全是 `cut#11959…#12580`；注入文本时间线连续出现「明显变化（强度 20–60）」。对照：只有细小元素移动的 `testsrc2` 测试图几乎不触发 cut（只有 heartbeat），说明 192×108 哨兵对「小面积运动」不敏感，但对真实视频的大面积运动足够。
2. **摘要滚动更新**：`summarizer: on … started=12 errors=0 summary=349ch (65s ago)`；`notes/screen-log.md` 在 18:50:01、18:56:16、19:01:28 三次更新，最后一次准确描述正在播放的画面：「19:01 Edge 里的 127.0.0.1:8971/play.html … 页面中间浮着一个小视频窗口，画面是蓝天绿地蝴蝶的测试视频」。
3. **每轮首步材料真机落盘**：19:00 的新轮次首条 `user/message` 含 `〔RTA 屏幕摘要（后台子代理·刚刚）〕…` + `〔RTA 已启动〕屏幕感知已开启（session 20261111-183919）…` + `〔RTA 高清截图 · 插件注入，非用户消息〕… 1600×900`，并附 `rta-hd-2339-1794393815491.jpg`。
4. **主会话零唤醒 / 零打断**：`_probe/host-contract/verify-injection.mjs session-a3038ba9…` 对比整段 19 分钟长轮前后：`plugin:dsh-rta` 注入消息始终 9 条（全为历史轮次的 notice/snapshot/摘要块），没有新增 followup/steer/queue；同期新增的只有宿主管理的 `runtime-context` 快照（81→87 条，文本变化时被动落盘）。
5. **子代理归属**：本轮新增 7 个子会话（18:50:06、18:56:22、18:58:29、18:59:10、18:59:56、19:00:50、19:01:32）；抽查 `478581f5-af7a-45a1-a216-835b3f50e3da` → `parentSession = session-a3038ba9-23ce-43c1-b583-67095a42bb73`、`delegationDepth=1`、单轮 3 条注入、`rtaCount=0`（注入不泄漏到子会话）。

> 验证用的本地 HTTP 服务与 Edge 窗口在验证结束后已关闭；RTA 继续在 session `20261111-184556` 采集。
