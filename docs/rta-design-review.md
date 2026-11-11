# RTA 设计审查：从「按需拉取」回到「启用即持续注入」

审查对象：`dsh-rta` v0.1.0（本工作区）·
审查依据：`src/` 全量静态阅读 + 宿主 `dsh` 解包源码核实 + 单测实跑 + 拼图基准·
配套材料：`docs/review/01-host-injection-contract.md`（宿主契约）、`02-current-gaps.md`（现状审计）、`03-target-architecture.md`（架构设计稿）

---

## 0. 审查结论

**用户的判断成立：当前设计确实偏离了设计原则，而且是结构性偏离，不是参数没调好。**

一句话概括现状：**RTA 是一条只进不出的采集管线 + 一套纯 pull 的视觉工具**。本地一直在采、在筛、在存，但筛选出的「有信息画面」没有任何一条通道能进入会话——除非模型自己想起来调 `rta_look`。

四条决定性证据：

1. **push 是死信通道。** 引擎三处 `bus.emit('push', …)`（`src/engine/engine.js:391`、`:542`、`:550`），生产代码零订阅；`runtime.ensure()` 只监听 `exit`/`stop`（`src/host/runtime.js:65-68`）。全仓唯一消费者是开发 CLI `bin/rta-run.mjs:41`，只 `console.log`。
2. **「插件启用」不启动采集。** `apply()` 只做三件事：注册 9 个工具、接 image/offload、挂一个「引擎没跑时」的热键轮询（`src/index.js:53-79`）。采集要等 `rta_start`/`rta_look` 或用户按 Ctrl+Alt——「启用后」这个前提本身不存在。
3. **唯一的主动通路是一次性文本 notice。** `summon.notify()` 用 `followup/steer` 推进一句固定 `summonPrompt`（`src/host/summon.js:53-87`），无图、无事件、无帧元数据；文案还是「先去调 `rta_look`」（`src/config.js:32`）——把 push 语义官方定义成了 pull。
4. **工具契约把 pull 写死。** `rta_start` 描述原文：「only the moments you ask for with `rta_look` are sent to you」（`src/tools/spec.js:63-65`）。模型按文档行事，永远走 pull。

宿主侧**可以**实现「启用后持续注入」，但有一个必须说清的边界：**宿主没有「空闲时主动推进上下文」的原语**。所有注入只发生在 turn/step 边界。所以正确的产品语义是：

> 启用后，**模型每一次思考时，屏幕上发生的变化已经在那里**；而不是「屏幕一变就去唤醒模型」。

要「屏幕一变立刻让模型反应」，只能 `followup` 自驱唤醒——烧 token、产生 turn-trigger 噪音，必须单独做预算开关（见 §9 Q4），不能作为自动流的默认行为。

**推荐方案：`systemPrompt.context`（文本感知，每步重算）+ `pre-step` 追加（带图快照，强节流）+ `inject`（排队通知）+ pull 工具兜底。自动流永不唤醒。**

---

## 1. 设计原则

用户原则（m00001）：「RTA 的设计应该是在启用后就不断将数据注入上下文。」

README 自述（`README.md:3`、`:18`）：「看见屏幕 → 本地算法筛选 → 只把有信息的画面交给会话模型 → 图片用完即省略、文字长期保留」「本地永远在采集，但只有通过筛选的画面才进上下文」。

拆解为五条可判定原则：

| # | 原则 | 判定标准 |
| --- | --- | --- |
| P-a | 启用即接管 | 存在明确的「RTA 已启用」生命周期；启用后采集自动运行，无需模型请求 |
| P-b | 持续 | 启用期间持续产生投递；静默期有低成本心跳/状态摘要 |
| P-c | 注入 | 投递内容是**数据**（时间轴、窗口、帧图、圈画），不是「去调工具」的指令 |
| P-d | 有节制 | 投递侧有节流、合并、token 预算、积压坍缩、图片回收；不拖垮上下文与缓存 |
| P-e | 生命周期可见 | start/stop/异常/会话切换在会话里有痕迹，模型知道「眼睛现在是否在看」 |

现状对 P-a、P-b、P-c、P-e **全不成立**，P-d 只做了一半（采集侧限流，无投递侧预算）。

---

## 2. 现状偏差清单（摘要）

完整 15 条含证据见 `docs/review/02-current-gaps.md`。按严重度摘要：

### P0——不补则「持续注入」不可能成立

| # | 偏差 | 关键证据 | 后果 |
| --- | --- | --- | --- |
| D1 | push 无消费者，链路断裂 | `engine.js:391/542/550`；`runtime.js:65-68` | 采集→筛选→拼图全部空转 |
| D2 | 插件启用不启动采集 | `index.js:53-79`；`handlers.js:152-183` | 默认无数据源，`rta_status` 首答 "not running" |
| D3 | 唯一主动注入 = 固定文本 notice | `summon.js:53-87`；`config.js:32` | 最接近注入的能力被降级成一次性提示，内容还是 pull 指令 |
| D4 | push 当刻拿不到像素，且文件未落盘 | `engine.js:391`（`rgb: undefined`）、`:414-422` → `store/writer.js:47-56` | 想接 pump 只能回读 12 帧 ring 或竞态读盘 |
| D5 | start/stop 对会话不可见 | `engine.js:231/256`；`runtime.js:84-92` | 模型永远不知道眼睛在开/关 |
| D6 | image/offload 只挂工具交付 | `index.js:145-161`；`handlers.js:88/264/281` | 注入图只进不出（offload 规划器其实支持 `user/message`，`offload.js:27/95`） |
| D7 | 注入路径零测试 | `test/plugin.test.mjs:121-163` 只测 summon notice | 任何接线改动无法回归 |

### P1——补完 P0 立刻暴露

| # | 偏差 | 证据 |
| --- | --- | --- |
| D8 | 工具文案把 pull 写死，会反向训练模型 | `spec.js:63-65/90-91/102-106`；`handlers.js:104` |
| D9 | 无投递侧节流/合并/预算/水位（唯一限流在采集侧 `select.js:19-31`） | 直接接 pump = 每 0.8–25s 塞一张图 |
| D10 | config 无任何注入旋钮；`engineConfig` 只透传 `capture`+`retentionHours`，`maxEventsInMemory`/`selection` 配置层不可达 | `config.js:12-34/57/75-80`；`engine.js:47/49` |
| D11 | `eventRing` 只有 12 帧（idle≈5min、忙时≈36s），无水位/补发 | `engine.js:49/389-390`；`start()` 会清空 ring `:213` |

### P2——文档与半成品，误导后续实现

D12 summon 一次性语义与「持续」矛盾；D13 README 数字/工具数/重复行/原则自相矛盾（`:5`/`:113` 说 22、19 个测试，实测 24；`:45` 说 8 个工具，实际 9；`:43`/`:79` 重复行；`:18` 原则与 `spec.js:63-65` 冲突）；D14 `engine.test.mjs:183` 订阅不存在的 `'summon'` 事件，`:190` 断言永远为真；D15 `pushNow`/`saveSheet` 有实现无调用点，代码里并存 push 的设计语言与 pull 的实际行为。

### 现状数据流（有问题的两段）

```
采集 → 选择 → eventRing(12帧) → bus.emit('push') → ✗ 无消费者（生产代码 0 订阅）
模型 → rta_look → composeRecent（同步拼图+同步 PNG）→ 工具返回图 → 唯一进上下文的路
Ctrl+Alt(仅 idle) → 一条纯文本 notice「去调 rta_look」→ 模型再 pull
```

**判定：这是 pull-only 设计。** 「持续性」不是靠调大心跳或加定时器能补的，缺的是一整层「投递面」。

---

## 3. 宿主能力边界（决定方案形态）

已核实（见 `01-host-injection-contract.md`，均带 `path:line`）：

### 3.1 四条注入通道的真实语义

| 通道 | wake | 生效时机 | 持久化 | idle 行为 | 适用 |
| --- | --- | --- | --- | --- | --- |
| `ctx.systemPrompt.context({name,order,text})` | 否 | 每次 `assemble()`（每步） | 文本变化时自动落一条 `user/message`（`source.kind='runtime-context'`, `form='snapshot'`） | 不运行、不堆积 | **文本感知主通道** |
| `agent/pre-step` 追加 `decision.messages` | 否 | 当前 turn 的下一次 step | 首次尝试时逐条 append `user/message`（`dsh-agent-loop:860-866`） | 不运行 | **带图快照**（强节流） |
| `agent.inject(m)` | 否 | 下次 turn 首个 pre-step claim | `user/message` | **无上限堆积**（resume 仍在），`sessions.flush` 才落盘 | 低频排队通知 |
| `followup` / `steer` | **是** | 立即起 turn / 下一步 | `user/message` | 自驱唤醒 | **仅用户动作** |

关键事实：

- **没有 idle 推送原语**：`inject` 只是排队，不消费；`pre-step` 只在已有 turn 内运行（`dsh-agent-loop:685-697`）。
- **注入即历史，不可撤回**：`decision.messages` 落盘后每次请求重放，计 token、进压缩摘要；只能撤回未 claim 的 inbox 消息（`inbox.replace/remove/clear` 公开可用）。
- **pending next-step 会延长 turn**：`turnEnds && inbox.nextStep.length===0` 才停（`dsh-agent-loop:790-797`）——每步都 `inject` 会让 turn 停不下来。
- **`systemPrompt.context` 是 cache-safe 文本通道**：`renderContextSections` → `joinContextSections` → `runtimeContext.project()`，文本与 retained 相同则不产生消息（`dsh-agent-loop:333-348/691-696`；`dsh-system-prompt:127-157/281-283`）。**警告：文本里带 `now` 会每步变 → 每步一条消息**，必须量化（见 §5）。
- **消息契约**：运行期不校验 shape，只要 JSON 可序列化 + surface `surfaceOp`（`dsh-session:1524-1546`）；v4 只禁 `source.kind==='plugin'`，第三方用 `plugin:<id>`（RTA 现用的 `plugin:dsh-rta` 正确）；`form:'snapshot'` 合法，`sections:[{name,text}]` 供 UI 分区，`summary` 仅 notice 用（≤120 字符）。
- **图片**：`content:[{type:'image',attachment}]` 合法；`attachments.saveImage({data,mediaType,name})`（RTA 需 `.call`）；注入图进 `user/message` 后**可以**被 `image/offload` 命中；但 offload 的触发是「请求失败 `IMAGE_OFFLOAD_REQUIRED` → 省略最旧 + retry」，**不是每步主动清理**，需要 RTA 自己周期规划。
- **派生影响**：`source.kind !== 'user'` 不进会话标题/activity/turn outline；但**会进压缩摘要**；token 计入 input。
- **RTA 不需要改 `inject:['tools']`**：pre-step payload 自带 `agent`，`exec.agent`/`sessionController.resolveAgent` 软探测已够；注册 `systemPrompt.context` 建议 `ctx.get('systemPrompt', true)` 软探测，失败退化为 pre-step。

### 3.2 结论

「启用即持续注入」在宿主上可落地，但形态是：**turn/step 触发式的「始终最新」**，而非空闲自驱。方案选择因此收敛为：

- 纯 pull（现状）：违反原则，只作兜底；
- 纯 inject 事件流：动画/滚动会把事件率打爆 20 倍，且堵 turn、无上限堆积；
- **pre-step + systemPrompt.context 混合（推荐）**：append-only、每步至多 1 条、idle 零投递、天然合并。

---

## 4. 目标架构

### 4.1 分层

```
┌──────────────── engine（宿主无关，保持现状）────────────────┐
│ tick → grab → 哨兵打分 → selector → decision                │
│   ├─ store/index.jsonl + frames/video（本地 24h）           │
│   └─ bus.emit('push', {seq,kind,at,wall,file,width,height,  │
│                        region?,screen?,decision?,win})      │  ← P0 补 win
└──────────────────────────┬─────────────────────────────────┘
                           │ push（25s–20/min，五类 kind）
┌──────────────────────────▼─────────────────────────────────┐
│ host/live-buffer.js（新） ring[64] + 单调 rev + digest()    │
│ 去重 seq、120s 文字时间轴、counts/staticMs、前台窗口         │
└──────────────────────────┬─────────────────────────────────┘
                           │ Digest（纯数据、无 IO）
┌──────────────────────────▼─────────────────────────────────┐
│ host/injector.js（新） 触发/节流/合并/预算/退避              │
│ pending 单槽替换 · lastDeliveredRev · 每步/轮/分钟计数       │
│ 在飞图数 · 通道降级                                          │
└──────────┬───────────────────────────────┬─────────────────┘
           │ 文本 digest（每步）            │ 带图快照（低频）
┌──────────▼──────────────────┐   ┌────────▼─────────────────┐
│ host/channel.js（新）        │   │ host/messages.js（新）    │
│ A systemPrompt.context（主） │   │ build*Message + 契约常量  │
│ B pre-step append（图/快照） │   └────────┬─────────────────┘
│ C inject（排队通知）         │            │
│ D followup/steer（仅用户动作）│            │
└──────────┬──────────────────┘            │
           └──────── append-only 尾部 ─────► 会话/模型上下文
┌────────────────────────────────────────────────────────────┐
│ host/lifecycle.js（新） start 宣告+首帧 · stop 总结 · 热键   │
│ · 会话绑定/切换 · dispose                                    │
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ 控制面（保留 pull 兜底）rta_look/region/recall/status/note/purge │
└────────────────────────────────────────────────────────────┘
```

职责边界：`engine`/`live-buffer` 只 import Node 标准库（可 headless 测）；`channel` 是唯一碰宿主会话对象的模块；`injector` 只依赖注入进来的 `deliver` 回调与时钟（可假时钟单测）。

### 4.2 三层数据面（这是本次审查的核心结论）

| 层 | 内容 | 频率 | 通道 | 目的 |
| --- | --- | --- | --- | --- |
| 感知层 | 屏幕状态文字摘要（时间轴、窗口、变化计数、静止时长） | 每步重算，**内容变化才落消息** | `systemPrompt.context` | 让模型「始终知道屏幕现在大概是什么」 |
| 快照层 | 带图消息（start 首帧、圈画裁切、低频 cut 拼图） | ≤4 图/10min，在飞≤2 | `pre-step` 追加 `form:'snapshot'` | 在关键变化点给视觉证据 |
| 控制层 | pull 工具 | 模型主动 | 工具 | 补看、回捞、长尾 |

`agent.inject` 只用于「不唤醒的排队通知」（stop 总结、非用户触发的 start 宣告）；`followup/steer` 只属于用户动作（召唤/圈画）。**自动流路径代码里禁止出现 `followup`/`steer`**——这条要写成测试断言。

### 4.3 与 03 设计稿的差异（Lead 修订）

1. 03 把 pre-step 当唯一主通道；依据 01 的新发现，**文本改走 `systemPrompt.context`**（每步重算、仅变化时落消息、cache-safe），pre-step 只负责图片/事件快照——两条通道职责分开，避免每步都造一条带时间轴的消息。
2. 03 把 `agent.inject` 作为运行中备通道；**降级为低频通知**，因为 pending next-step 会延长 turn（`agent-loop:790-797`）且 idle 无上限堆积。
3. 明确「宿主无 idle 推送原语」这一产品边界，避免向用户承诺「屏幕一动 AI 就开口」。
4. `systemPrompt.context` 文本必须**量化**：只含「最近事件 wall time / 静止阈值档位」，不含 `now`、不含逐秒变化的 `staticMs` 原始值，否则每步一条消息。
5. 01 已核实 `form:'snapshot'`/`sections` 合法、注入图可被 offload、`inbox.replace` 可用——03 中对应 `[待核实]` 项按 01 结论定稿。
6. offload 需要 RTA 自己接线 + keep 分账（注入图可能挤掉用户上传图）。

---

## 5. 注入策略规格（默认参数）

### 5.1 感知层文字（systemPrompt.context）

- 内容：`RTA screen: <sess>; last change 10:31:02 (cut, "engine.js — Code"); 3 events/60s; static 98s; older: rta_recall(10:28–10:32)`。
- **只有 digest 变化才变文本**；`staticMs` 按 30s 档位取整（"静止"、"静止 >30s"、"静止 >2min"），不出现 `now`。
- 上限：≤6 行 / ≤260 tokens；时间轴窗口 120s；更早交给 `rta_recall`。
- 空窗口（刚启动、无事件）返回空串，不贡献 section。

### 5.2 快照层图片（pre-step）

| 触发 | 条件 | 载荷 | 硬上限 |
| --- | --- | --- | --- |
| start | `lifecycle.onStart()` | 宣告 + 首帧 1 帧（233 tok） | 1/会话 |
| region | 用户圈画完成 | 裁切图 + bbox + 时间段 | 每次 1 |
| cut | `score>=18` 且距上次图 ≥60s | ≤4 帧拼图（392 tok） | 4/10min，在飞≤2 |
| summon | Ctrl+Alt（用户动作） | 新鲜 digest + 1–2 帧 | 1/按键沿 |

- 图片在 `imageMaxAgeMs=30s` 内未发出则丢图保文字（避免陈旧视觉）。
- 同一步最多 1 条注入消息（`maxPerStep=1`），每轮 ≤4 条，每 10 分钟 ≤16 条；`minIntervalMs=3000`。
- 幂等：`id = rta:<session>:<rev>:<kind>`，投递前比对 `lastDeliveredRev`；`rev` 单调递增。

### 5.3 合并与积压

- `pending` 只有 **1 个槽**：新 digest 到达即替换（rev 更大的赢），不排队——屏幕是状态不是队列。
- 幂等丢弃：`rev <= lastDeliveredRev` 直接丢。
- idle 时**零投递**，只更新 pending；积压坍缩：`now - pending.firstAt > 15s` 只保留最近 3 个事件；`>5min` 只保留 latest + counts，时间轴压到 2 行。
- 下一轮首步由 pre-step 投 pending；无 pre-step（纯 tool 边界）时由首次 `pre-step` 自然带出。

### 5.4 idle / running

| 状态 | 自动流 | 用户召唤 |
| --- | --- | --- |
| running | 每步 ≤1 条快照；文本 context 每步重算；`inject` 仅低频 | `steer` 一条新鲜 digest+图 |
| idle | 零调用、零 wake；pending 单槽替换 | `followup`（唯一 wake 点），正文带最新 digest |

### 5.5 成本核算

| 载荷 | token |
| --- | --- |
| 文字 digest（≤6 行） | 110–260 |
| 1/4/8/12 帧拼图 | 233 / 392 / 560 / 860 |
| offload 占位 | ~20/图 |
| 同步拼图+PNG（1/4/8 帧） | 9.5 / 25.0 / 30.7 ms（15Hz tick 预算 66.7ms） |

- 普通对话 ≈300–800 tok/轮；工具密集封顶 12/min ≈3.1k tok/min（合并后实测约一半）；图片 ≤4/10min ≈1.6k tok/10min。
- **禁止「原地更新」同一条消息**（会让其后的前缀缓存全部失效）；只能 append 新条目。
- 拼图/编码**不得放进 push 回调**：`composeKind` 同步全量重拼 + `encodePng` 同步 deflate，8 帧 ≈30.7ms 会吃掉一个 30Hz tick；必须队列 + ≥1s 去抖 + 异步编码。

---

## 6. 生命周期与「启用」语义

**「启用」= 用户明确手势**（`rta_start` 工具 / Ctrl+Alt 召唤 / 圈画），不是插件加载。插件加载不抓屏（现状如此，隐私上也应保持）；`inject.enabled` 只作 kill-switch。

| 事件 | 行为 | 会话可见性 |
| --- | --- | --- |
| `rta_start` | engine.start → buffer 清空 → 首 digest（首帧最多等 1.2s） | 1 条 notice：session id、节奏参数、**隐私提示「屏幕内容会持续进入上下文」**、首帧图；用户手势触发时 followup，工具触发时 inject |
| 运行期 | `runtime.ensure()` 订阅 `engine.on('push')`；pre-step/context 挂载 | 每步/每事件按 §5 |
| `rta_stop` | flush pending → engine.stop → 汇总 counts | 1 条 notice：总结 + `rta_recall` 指引；不 wake |
| Ctrl+Alt | 未启用：start+召唤；**启用中：不再忽略，改为「现在看一眼」**（running→steer / idle→followup） | 修订 `summon.js:104` 注释与 README |
| 会话切换 | 先 flush 旧绑定 pending；新会话**静默重绑**，不跨会话泄漏 | `bindOnlyOptInSession` 默认 true |
| 重复 start | 幂等，只回状态 | — |
| dispose | flush → 解绑 pre-step/context/inject → engine.stop → 清 buffer | 无悬挂 timer |

子代理过滤：`agent.session.header.parentSession !== undefined` 或 `delegationDepth>0` 时不注入（只在主会话）。

---

## 7. 迁移计划

### P0——接通主链（1–2 天）

| 文件 | 改动 | 测试 |
| --- | --- | --- |
| 新 `src/host/live-buffer.js` | `append(ev)/digest(now)/noteDelivered(rev)/pending()/reset()`；ring64、rev、120s 时间轴、坍缩 | `test/live-buffer.test.mjs`：ring 上限/rev 单调/窗口/坍缩/去重 |
| 新 `src/host/messages.js` | `buildSnapshot/buildLifecycle/buildSummonMessage`；`SOURCE_KIND`/`FORM` 常量；id 规则 | 消息 shape 断言（role/content/source/≤80 字 summary） |
| 新 `src/host/injector.js` | §5 触发表、pending 单槽、计数、退避、`onStep()` | `test/injector.test.mjs`：假时钟 10 分钟 ≤120 条/≤4 图/0 wake |
| 新 `src/host/channel.js` | 能力探测：context → pre-step → inject → 纯 pull；`deliver()` 统一入口 | 三通道降级测试 |
| 新 `src/host/lifecycle.js` | §6 表：onStart/onStop/onSummon/onSession/dispose | start/stop 消息、重复 start、dispose 无 timer |
| 改 `src/host/runtime.js` | `ensure()` 订阅 push；装配五模块；暴露 buffer/injector；dispose 顺序 | push 真进 buffer |
| 改 `src/engine/engine.js` | push 载荷补 `win`（`:384`）；`pushNow` 同样 | engine 测试补字段断言 |
| 改 `src/config.js` | 增 `inject` 默认值 + 数值/布尔解析 | 坏配置回退默认 |
| 改 `src/tools/handlers.js` | start/stop 接 lifecycle；`look` 优先复用 5s 内 digest | start 文案含「持续注入」 |
| 改 `src/tools/spec.js` | start/stop/look 描述改为「启用后自动持续注入；look 是补看」 | 描述断言（可选） |
| 改 `src/index.js` | `lifecycle.attach()`；`notifyDelivery()` 接 injector `onDelivered`（工具+注入同源 offload）；disposer 顺序 | 注入图 offload 断言 |

**新增配置**（`~/.dsh/rta/config.json` → `inject`）：

```json
{ "inject": {
  "enabled": true, "mode": "auto", "minIntervalMs": 3000, "maxPerMinute": 12,
  "maxPerStep": 1, "maxPerTurn": 4, "maxLines": 8, "maxTextTokens": 400,
  "staleMs": 15000, "idleCollapseMs": 300000, "eventTtlMs": 120000,
  "heartbeatMs": 30000, "bindOnlyOptInSession": true,
  "image": { "enabled": true, "triggers": ["start","region","cut"],
             "minIntervalMs": 60000, "maxPer10Min": 4, "maxInFlight": 2,
             "maxFrames": 4, "maxSheetTokens": 560, "maxAgeMs": 30000,
             "offloadTrigger": 6, "offloadKeep": 2 }
} }
```

### P1——宿主契合与成本（2–4 天）

- `channel.js`：按 01 结论把 `systemPrompt.context` 设为文本主通道，pre-step 设图通道；确认 form/sections/idle 语义；双通道不重复投递。
- `engine.js`：`composeEvents({seqs,maxTokens})` 只拼新事件（现状只能对 `eventRing` 取最后 N）。
- `offload.js`：注入图计量 + keep 分账（避免挤掉用户上传图）；`rta_status` 暴露 rev/已投条数/省略图数。
- 修正 README 三处数字、工具数（9）、重复行、原则与工具文案冲突。

### P2——产品化（后续）

客户端 UI（悬浮窗/面板/配置页）、按前台应用调频、OCR 文本变化接入、前缀缓存命中率评估、隐私开关、可选「主动提醒」（带 wakeBudget）。

**回滚**：`inject.enabled=false` 时行为等同旧 pull，P0 新模块整体不装配（`runtime` 内 try/catch，失败仅日志）。

---

## 8. 测试与验证

- **基线**：逐文件实跑 **24/24 pass**（algo 10 + engine 6 + plugin 6 + store 2）。`node --test test/*.test.mjs` 在本沙箱因 test runner 内部 `spawn` 被拒（`EPERM errno -4048`）不可用，属执行环境限制，非测试失败。
- **必须新增的测试矩阵**：push→buffer→digest；injector 假时钟节流/合并/幂等/预算；idle 零投递；start/stop 生命周期消息；注入图进入 `user/message` 后被 offload 规划命中；「非用户动作路径不得调用 followup/steer」的静态断言；重复 start 幂等；会话切换不泄漏。
- **验收标准**：启用后 ≤2s 出现首条注入；10 分钟模拟 ≤120 条消息、≤4 张图、0 次 wake；模型在任一步都能读到最新屏幕摘要；`rta_status` 可观测投递水位。

---

## 9. 风险与开放问题

| # | 风险/问题 | 影响 | 处置 |
| --- | --- | --- | --- |
| R1 | 宿主契约仍有 5 项未运行验证（`ctx.get` 注册 context 的 scope、runtime-context 多条是否被请求投影折叠、subagent 是否同样触发 pre-step、provider 图片预算、headless attachments） | 决定主通道是否成立 | 先做最小插件冒烟；失败退化 pre-step/pull |
| R2 | token 线性增长与压缩污染（注入进摘要、图片永久占历史） | 成本 | 硬上限 + 默认保守 + summary≤80 字 + offload + status 可观测 |
| R3 | turn 被延长（pending next-step 非空） | 回合停不下来 | 自动流只走 pre-step；inject 仅低频通知 |
| R4 | offload 抖动/keep 分账 | 用户图被省略或反之 | 图片轮后 30s 检查、trigger 抬高、分账 |
| R5 | 前缀缓存失效 | 成本 | append-only；禁止原地更新；context 文本量化 |
| Q1 | 插件加载是否自动开始采集 | 隐私 | 建议不自动；保持显式手势 |
| Q2 | 图片默认是否进自动流，还是只保留 start/region | 成本 vs 信息密度 | 建议首版只 start/region，cut 图默认关 |
| Q3 | 25–30s heartbeat 文字是否算噪音 | 体验 | 建议 first 版只发「静止 >2min」一次 |
| Q4 | 是否提供「屏幕变化主动提醒」（followup 唤醒） | 成本/打扰 | P2 可选，带 wakeBudget + 默认关 |
| Q5 | 隐私明示强度（start 文案/配置页/首条 notice） | 合规 | start 首条 notice 必带「屏幕内容会持续进入上下文」 |

---

## 10. 产物索引

| 文档 | 内容 |
| --- | --- |
| [`docs/review/01-host-injection-contract.md`](review/01-host-injection-contract.md) | 宿主注入契约：四条通道、消息契约、图片、offload、渲染与派生影响、先例对照（125 行） |
| [`docs/review/02-current-gaps.md`](review/02-current-gaps.md) | 现状审计：D1–D15、数据流图、push 载荷与 pump 断点、拼图实测、测试矩阵、README 核对（318 行） |
| [`docs/review/03-target-architecture.md`](review/03-target-architecture.md) | 目标架构设计稿：分层、触发表、消息契约、生命周期、降级矩阵、P0/P1/P2 迁移（246 行） |
| `_probe/agent-code-audit/bench_compose.mjs` | 拼图 + PNG 编码同步成本基准（1/4/8 帧 = 9.5/25.0/30.7ms） |

复现命令：

```bash
for f in test/*.test.mjs; do node "$f"; done      # 24/24 pass（node --test 在沙箱内受 spawn 限制）
node _probe/agent-code-audit/bench_compose.mjs    # 拼图成本
```
