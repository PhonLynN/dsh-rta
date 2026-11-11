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
- ~~摘要子代理是一次性 activation~~（已被 §5 取代：复用一个常驻 child，并加结算通知过滤器维持零唤醒）。
- 子代理模型路由继承父会话；如需指定 provider 可写 `inject.summarizer.provider`。
- HD 通道在无事件（只有 heartbeat）、录像不可用、jpeg 模式或帧太旧时回退 512px 拼图；`rta_look` 可用 `hd:false` 强制回退。
- ~~每次 activation 新建子会话、长期累积~~（已被 §5 取代：整个 RTA 会话一个 child，stop 时清除）。

## 4. 视频播放真机验证（2026-11-11 18:58–19:03，session `20261111-184556`）

用本地 HTTP 服务 + Edge 静音循环播放一段 2 分钟的真实视频（从旧 RTA 录像 `20261111-180040/seg-000.ts` 裁出的 B 站页面片段，1280×720），模拟「用户正在看视频」：

1. **采集侧**：播放期间 `rta_status` 的 events 从 17 涨到 58，recent 全是 `cut#11959…#12580`；注入文本时间线连续出现「明显变化（强度 20–60）」。对照：只有细小元素移动的 `testsrc2` 测试图几乎不触发 cut（只有 heartbeat），说明 192×108 哨兵对「小面积运动」不敏感，但对真实视频的大面积运动足够。
2. **摘要滚动更新**：`summarizer: on … started=12 errors=0 summary=349ch (65s ago)`；`notes/screen-log.md` 在 18:50:01、18:56:16、19:01:28 三次更新，最后一次准确描述正在播放的画面：「19:01 Edge 里的 127.0.0.1:8971/play.html … 页面中间浮着一个小视频窗口，画面是蓝天绿地蝴蝶的测试视频」。
3. **每轮首步材料真机落盘**：19:00 的新轮次首条 `user/message` 含 `〔RTA 屏幕摘要（后台子代理·刚刚）〕…` + `〔RTA 已启动〕屏幕感知已开启（session 20261111-183919）…` + `〔RTA 高清截图 · 插件注入，非用户消息〕… 1600×900`，并附 `rta-hd-2339-1794393815491.jpg`。
4. **主会话零唤醒 / 零打断**：`_probe/host-contract/verify-injection.mjs session-a3038ba9…` 对比整段 19 分钟长轮前后：`plugin:dsh-rta` 注入消息始终 9 条（全为历史轮次的 notice/snapshot/摘要块），没有新增 followup/steer/queue；同期新增的只有宿主管理的 `runtime-context` 快照（81→87 条，文本变化时被动落盘）。
5. **子代理归属**：本轮新增 7 个子会话（18:50:06、18:56:22、18:58:29、18:59:10、18:59:56、19:00:50、19:01:32）；抽查 `478581f5-af7a-45a1-a216-835b3f50e3da` → `parentSession = session-a3038ba9-23ce-43c1-b583-67095a42bb73`、`delegationDepth=1`、单轮 3 条注入、`rtaCount=0`（注入不泄漏到子会话）。

> 验证用的本地 HTTP 服务与 Edge 窗口在验证结束后已关闭；RTA 继续在 session `20261111-184556` 采集。

## 5. 常驻摘要子代理 + 三触发（2026-11-11 19:28–19:48，session `20261111-194618`）

用户需求（m01622 / m01656）：整个 RTA 会话只用一个摘要子代理，`rta_stop` 时清除；摘要除周期外还要能被密集事件和主 agent 主动命令触发。

### 5.1 实现

- `startActivation({ provider, childId, label:'rta-screen-summary', delivery:'caller', request:{prompt:[{type:'text',text}], parent} })` 预留唯一 continuable child；之后每轮用宿主 symbol 通道 `subagents[Symbol.for('dsh.subagent.deliverPrompt')](parent, childId, [{type:'text',text}], {kind:'user'}, signal, 'queue')` 投递，不再新建子代理。
- 三种触发：周期（45 s，10 分钟 ≤18 次，digest 不变跳过）、密集事件（cut / region / text / manual 或 score ≥18；2.5 s 防抖、12 s 最小间隔）、`rta_summarize` 主动命令（`requestNow` 等 notes mtime 变化后返回，等待上限 25 s）。
- 单轮完成判定：投递前记 `notes/screen-log.md` mtime 作为 baseline，2 s 轮询直到 mtime 增大（不 await activation.result —— 它只在 drain/dispose 时 settle）。
- `rta_stop` / dispose：`interrupt(childId,{kind:'ancestor',agent})` → `drainChildren(agent,[childId])` → 释放 child；`rta_status` 中 `child=none`。

### 5.2 宿主缺口与兜底（重点）

- 本地 continuable child 每轮结束都会 settle（`watchLocalSettlement`：`whenIdle()` → `settlementState` → `close`）。下一轮投递走 `deliverFollowup` → `coldResume`，而 `coldResume` 调用 `materialize()` 时**没有传 `delivery`**，`activation.delivery` 回落 `'parent'` → `notifySettlement` 生效 → `sendWaking(parent, …, parent.status==='idle' ? 'queue' : 'steer')` → `parent.followup()` 唤醒主会话。
- 实测：上一轮复用版（未加兜底）在 19:37:02 / 19:41:06 各收到一次 `Background subagent 5c6e4681-… finished and will do no further work unless you send it more.` + closing `屏幕摘要已写入。`——每轮都响一次。
- 兜底：`acquireSettlementGuard(subagents)` 在 `ctx.get('subagents').manager` 上包一层 `notifySettlement`，只对**本插件 childId** 直接返回；child 释放 / stop 时还原（`manager.notifySettlement === patched` 才还原，并删除 symbol 键）。宿主升级若方法缺失则 guard=null、自动降级（退回可见通知，不崩）。`rta_status` 显示 `guard=on`。
- 备选（未采用）：每轮新建 child（违背 m01622）、pre-step 过滤结算消息（挡得住模型可见内容，挡不住 idle 唤醒）、改宿主 asar（超出插件边界）。

### 5.3 真机证据（session `20261111-194618`，19:46:18–19:47:52）

1. **单 child 复用**：`C:\Users\PhonLynN\.dsh\sessions\--C-Users-PhonLynN-dsh_Workspace-dsh-RTA-dev--` 下这 95 秒只新增一个子会话 `70eb4a1e-29e1-47a7-95d0-bb380aad7aa9`（19:46:19）。`rta_status`：`child=70eb4a1e(settled) guard=on prompts=2 started=1` → 第二轮 prompt 投给了同一个 child。
2. **周期 / 事件触发**：`prompts=2`（start + interval），`notes/screen-log.md` 206B @19:47:08；注入文本同步出现 `前台：RTA — DeepSeek Harness` 与 cut 时间线。
3. **主动命令**：`rta_summarize` 返回 `RTA fresh summary (trigger=demand …)`：摘要描述用户正在 DSH 的 RTA 会话界面、右侧浮窗显示 heartbeat/cut 记录；`prompts=3 started=1`，仍未新建 child。
4. **零唤醒**：整个 95 秒主会话没有收到任何 `Background subagent … finished` 通知（对比上一版每轮一条）。
5. **stop 清除**：`rta_stop` 后 `rta_status`：`summarizer: … engine=idle child=none prompts=3 started=1`；子会话 `session.v4.jsonl.zstd` 最后写入 19:47:48（stop 于 19:47:52），此后无更新；主会话同样没有收到结算通知。
6. **单测**：`summarizer.test.mjs` 15 条全过（新增「过滤器只吞本 child、其他 child 透传、stop 后还原宿主方法」）；全套 73 条全绿（10 算法 + 6 引擎 + 7 插件 + 19 注入面 + 14 高清帧 + 15 摘要子代理 + 2 存储）。

### 5.4 已知边界

- 兜底依赖宿主私有字段 `subagents.manager` 与 `manager.notifySettlement`，属版本相关实现；宿主升级后需回归 `rta_status` 的 `guard=on` 与主会话通知。
- child 的每轮 activation 仍会 settle/冷启动（宿主语义），但不影响「同一个 child 会话」与零唤醒。
- `rta_summarize` 等待上限 25 s；若子代理路由不可用（policy 不允许）会返回上一版摘要 + `lastError`。

## 6. 多页经过拼图（pages）与并发修复

### 6.1 问题

用户 m02213：「我在某个软件连续切换了多个页面，但是 ai 没法知道我经过了这些页面，它获取也最多能拿 4 张，这太少了。」旧实现有两个结构性原因：

1. 每轮首步只附 **1 张**裁窗 HD 帧，而 HD 帧来自「最后停住」的窗口 → 中间经过的页面全部丢失；回落拼图取的是「最近 N 帧」，同一页的近重复帧会挤掉别的页面。
2. `eventRing` 只有 12 槽且事件不携带窗口元信息 → 即便回捞也无法恢复「经过了哪些页面」。

### 6.2 实现

- `engine/engine.js`：`maxEventsInMemory` 12 → 20；每个事件带 `win{title,process,rect}`；新增 `pageKeyOf(win)=process|title` 与 `composePages({count=8,maxTokens=700,maxAgeMs=120000,minPages=3})`——过滤 heartbeat/integral，按页面归并连续同页只留最后一帧，时间窗内不足 `minPages` 返回 null，否则 `planSheet`+`composeSheet` 出图并返回 `pages:[{seq,kind,wall,title,process}]`。
- `host/messages.js`：`buildPagesCaption()` 生成标题「〔RTA 多页截图 · 插件注入，非用户消息〕」+ 前台 + 「最近经过的 N 个页面」+ 逐行 `1. hh:mm:ss 标题`。
- `host/lifecycle.js`：`screenshotFor` 改为三层——① `composeMontage()`（读 `inject.image.montage*`）多页图（mode=`pages`）；② 单张 HD（`hdShot`）；③ `eventRing` 拼图回落（优先 `composePages`，其次 `composeRecent`）。caption/summary 按 mode 标注，三种来源不混。
- `config.js`：`inject.image` 默认 `maxFrames: 4→8`、`maxSheetTokens: 400→700`，新增 `montage:true, montageMinPages:3, montageFrames:8, montageMaxTokens:700, montageMaxAgeMs:120000`。
- 为什么不是「总要发多页图」：单格只有 315×177，文字不可读；只有最近 2 分钟经过 ≥3 个页面时才用多页图替换大单帧，否则保留可读的 HD 单帧（`montageMinPages` 从 2 收到 3 就是为此）。

### 6.3 并发建 child bug（真机发现）

- 现象：20:15:02 一次 `rta_start` 在 `C:\Users\PhonLynN\.dsh\sessions\--C-Users-PhonLynN-dsh_Workspace-dsh-RTA-dev--` 下建了**两个**子会话（`a01bfba1…`、`262b346e…`），`rta_status` `started=2`。
- 根因：engine `start` tick、`onBind→rebind`、interval tick 并发进入 `ensureChild`，都在 `await startActivation` 窗口里看到 `child===null`，各建一个。
- 修复（`host/summarizer.js`）：`starting` 单飞 promise；`startSeq` 在 `stop()` 自增，晚到的 child 立即 `interrupt`+`drain` 释放；`delivering` 防重复投递；`knownChildren` 集合让 `stop()` 兜底清理所有建过的 child；`tickOnce` 在未投出时回滚 `lastPromptAt/lastDigest/promptWindow`。
- 测试：`summarizer.test.mjs` 19 条（新增「并发 tick 只建一个 child」「stop 期间落地的 child 被 interrupt+drain」）；全套 **78** 条全绿（10 算法 + 7 引擎 + 7 插件 + 19 注入面 + 14 高清帧 + 19 摘要子代理 + 2 存储）。

### 6.4 真机证据（session=20261111-201804）

1. `rta_status`：`summarizer: on … child=c2e99b39 guard=on prompts=1 trigger=start awaiting=1 started=1 errors=0` → 一次 `rta_start` 只建一个 child。
2. 3 分钟内 sessions 目录只新增 `c2e99b39-c749-49d4-a321-06f68754d754`（20:18:05）；`notes/screen-log.md` 379B @20:18:12。
3. 注入 `published=1`，bound 会话不变；此前 bug 遗留的 `a01bfba1…`（最后写 20:16:36）与 `262b346e…`（20:15:12）保持静止（不删用户会话数据；新代码不再产生孤儿）。
4. `rta_stop` 后 child 清理、零结算通知的回归见 §5.3。

### 6.5 已知边界

- 多页图的格子小，读内容仍需 `rta_look` / `rta_recall(images)` 取单页高清帧；`rta_look` 的 `count ≤6` 仍不变。
- 页面身份 = `process|title`：同一浏览器的不同 tab 若标题相同会被合并；`eventRing` 20 条，窗口内切页超过 20 次只保留最近的页面。
- **文档编辑事故**：本次用 PowerShell `Get-Content -Raw | Set-Content -Encoding UTF8` 改 README/本文件导致 UTF-8 中文被 GBK 乱码化，已 `git checkout --` 还原并改用 edit 工具重写；后续中文文件只用 read/edit/write。

§7 切镜判定升级：结构特征 + 滚动/视频运动分类（2026-11-11 晚）
============================================================

用户反馈（m02183 / m02213）：抽取算法「判断不好什么是高密度信息、什么是切镜」；在软件里连续切
多个页面时模型「不知道经过了哪些页面，最多只能拿 4 张」。

### 7.1 旧实现的问题

- `select` 的 cut 只看 `score`（HSV 加权差分）、`z`（自身基线）、`mc`（±2 邻域运动补偿）。
  视频播放 / 滚动页面同样产生大面积像素变化 → 每秒都在 cut；同一软件内换页（窗口标题不变）
  与视频运动完全无法区分。
- `eventRing` 事件不带窗口元信息、`composeRecent` 只取「最近 N 帧」不做内容去重 →
  注入的拼图常是同一界面的近重复帧。
- 单张 HD 帧只能保留最后停住的窗口，中间经过的页面全部丢失。

### 7.2 新实现

- `algo/color.js` 新增纯函数：`hueHistogram()`（32 段色相按饱和度加权 + 8 段亮度，40 维）、
  `histL1()`、`blockDiffFrac()`（8×8 块亮度差占比，thr 可配）、`pixelChangeFrac()`、
  `rowMeanProfile()`、`estimateRowShift()`（行亮度投影位移 + Pearson 相关 + 对齐后残差比，
  残差比 ≤0.6 表示「变化可被滚动解释」）。
- `engine/engine.js` 哨兵每 tick 顺带计算：`histL1 / bFrac30 / bFrac15 / pixFrac / shiftPx /
  shiftCorr / scrollResid`，连同 `score/mc/meanV` 一起送 `selector.ingest()`；tick 返回值扩展，
  便于 headless CLI 与测试观察。
- `algo/select.js`：`cut` 增加结构闸门——
  ① 非滚动（`scrollLike = shiftPx≥6 && corr≥0.55 && resid≤0.60` 时降级 integral）；
  ② 版面级变化（`bFrac30 ≥ 0.40 || histL1 ≥ 0.20`）；
  ③ 播放退避：最近 1s 有 ≥8 帧被判运动/滚动（视频在播）时，门槛抬到
     `bFrac30 ≥ 0.60 && histL1 ≥ 0.35 && mc ≥ 0.45`，只有真正的整版换页能切。
  不带结构字段的旧调用会自动退回原逻辑（旧测试与外部调用兼容）。
- 多页经过：事件带 `win` 元信息 + 48×27 缩略图；`composePages()` 按
  「窗口身份变化 **或** 缩略图平均绝对差 ≥ `montageVisualDist=0.12`」拆页，
  同一窗口内连续切页也能分格；事件环 12 → 20 条，最长回溯 2 分钟。

### 7.3 真实录像回放对比（`_probe/replay-select.mjs`，192×108、15fps 抽帧、采样步长 3≈200ms）

| 片段（session/时间） | 旧选择器 cut | 新选择器 cut |
| --- | --- | --- |
| B站视频播放 `20261111-180040` 180s/36s（低动态视频） | 10（16.7/min） | **0** |
| B站视频第二段 `20261111-180040` 285s/24s（真实场景切换） | 3 | **3** |
| Edge 本地 mp4 `20261111-184556` 20s/30s | 0 | 0 |
| DSH 思考流式输出 `20261111-180040` 352s/36s | 0 | 0 |
| DSH 静止 `20261111-180040` 0s/30s | 0 | 0 |
| 真实窗口/页面快速切换 `20261111-201804` seg-002 0s/90s | 8（5.3/min） | **7（4.7/min）** |

结论：低动态视频的误报 cut 被清掉（16.7/min → 0），真实场景切换与窗口切换仍被保留
（3→3、8→7），静止/文字流不误报。

### 7.4 测试

- `test/algo.test.mjs` +4：结构特征数值、行位移估计（滚动 vs 换页）、滚动帧不 cut、
  播放退避（中等变化不 cut、强换页仍 cut）→ algo 14 条。
- `test/engine.test.mjs` +1：同一窗口内画面显著不同也拆成不同页面（visualDist 阈值两侧）
  → engine 8 条。
- 全套 **83** 条全绿（14 算法 + 8 引擎 + 7 插件 + 19 注入面 + 14 高清帧 + 19 摘要 + 2 存储）。

### 7.5 边界

- `montageVisualDist=0.12` 是「平均绝对差」，对整页换色/换版式敏感，对同版式文字更新不敏感；
  极端情况（同版式换 tab）靠窗口标题兜底。
- 播放退避依赖 1s 运动计数；幻灯片式「一页停 5 秒以上再换」仍会按页切（符合预期）。
- 多页图单格仍只有 315×177，要读字还得 `rta_look` / `rta_recall(images)`。
