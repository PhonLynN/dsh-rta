# RTA 目标架构：启用即持续注入（03）

状态：设计稿 v1（2026-11-11）· 作者：arch-design · 依据：src/ 静态阅读 + 与本文件同时进行的 01/02 审查
范围：只给目标架构与迁移计划，不改 src/README/test。宿主 API 细节标 **[待核实]** 的，以 `docs/review/01-host-injection-contract.md` 结论为准。

## 0. 一句话与六条硬约束

**一句话**：engine 的 `push` 事件进入 `host/live-buffer` 汇聚成单调递增的 `digest`，`host/injector` 按「每步至多 1 条、只追加、文字必带、图片稀缺」的预算投递给宿主；**pre-step 是主通道**（天然合并、不堆积、不唤醒），`agent.inject` 只作运行中高信号事件的补充，`followup` 只属于用户动作。

| # | 约束 | 理由 |
| --- | --- | --- |
| C1 | 只追加到会话尾部，绝不改写历史条目 | 前缀缓存只为新增 token 付费；改写中段会让其后全部失效 |
| C2 | 自动流永不 wake：不调 `followup`、不调会唤醒 idle agent 的 `inject` | 否则「启用」= 每 25s 自问自答，烧钱且骚扰 |
| C3 | 待投递 digest 单槽替换，不排队 | 屏幕是状态不是队列；旧帧没有投递价值 |
| C4 | 文字必带、图片稀缺且可 offload | 文字 100–260 tokens，图 233–860；图只在用户圈画/开始/低频切镜 |
| C5 | 幂等：`id = rta:<session>:<rev>:<kind>`，交付前比对 `lastDeliveredRev` | pre-step 每步都会触发，重复投递会污染上下文 |
| C6 | 所有上限硬封顶（条/分钟、条/步、text tokens、在飞图数） | 动画/视频/滚动会把事件率打爆 20 倍 |

## 1. 分层与数据流

```
┌───────────────────────────── engine（宿主无关，src/engine/engine.js）─────────────────────────────┐
│ tick() → grab → scorePair → selector.ingest(t) → decision                                        │
│   ├─ store/index.jsonl + frames/../video（全程本地，保留 24h）                                     │
│   └─ bus.emit('push', { id, seq, kind, at, wall, file, width, height, region?, screen?, decision }) │
│        ※ 现状 push 缺 win（前台窗口标题）且 rgb 被剥离 → 见 §2.2                                     │
└───────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                            │ push（每 25s–20/min，五类 kind）
┌───────────────────────────────────────────▼──────────────────────────────────────────────────────┐
│ host/live-buffer.js（新）  ring[cap=64] + 单调 rev + digest(now)                                   │
│   职责：去重 seq、按 120s 窗口生成文字时间轴、统计 counts/静止时长、挂接当前 foreground            │
│   输出：Digest（纯数据，无 IO、无定时器）                                                          │
└───────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                            │ Digest
┌───────────────────────────────────────────▼──────────────────────────────────────────────────────┐
│ host/injector.js（新）  触发 / 节流 / 合并 / 预算 / 投递                                            │
│   pending 单槽（替换不排队）· lastDeliveredRev/at · 每分钟计数 · 每步/每轮计数 · 在飞图数 · 退避    │
│   决策输出：deliver { msg, reason } | hold（不调通道）                                               │
└──────────────┬───────────────────────────────────────────────┬───────────────────────────────────┘
               │ 文字 digest（全部触发）                        │ 图片（start/region/低频 cut）
┌──────────────▼───────────────────┐               ┌───────────▼───────────────────────────────────┐
│ host/channel.js（新，能力探测）    │               │ host/messages.js（新）+ host/service.js          │
│  A. pre-step adapter（主）        │               │  composeRecent() → attachRgb() → attachment ref  │
│  B. agent.inject adapter（后备）  │               └───────────┬───────────────────────────────────┘
│  C. followup/steer（仅用户动作）  │                           │
└──────────────┬───────────────────┘                           │
               └──────────── append-only 尾部 ────────────────► 宿主会话 / 模型上下文
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ host/lifecycle.js（新）  rta_start 宣告+首帧 · 运行期 · rta_stop 总结 · Ctrl+Alt 语义 · 会话绑定   │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ 控制面（保留 pull，兜底）  rta_look / rta_region / rta_recall / rta_status / rta_note / rta_purge   │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

职责边界（谁能碰宿主）：`engine` 与 `live-buffer` 只 import Node 标准库，可 headless 测；`channel` 是唯一 import 宿主会话对象的模块；`injector` 只依赖注入进来的 `deliver` 回调与时钟，可完全单测。

### 1.1 数据形状（P0 契约）

```js
// LiveEvent：live-buffer 从 engine push 收下的最小元数据（不持像素，像素留在 engine.eventRing）
{ seq:1234, kind:'cut', at:1710000000000, wall:1710000000000, score:21.3,
  win:{ title:'engine.js — Code', process:'Code.exe', hwnd:1, rect:{...}, visible:true },
  region?:{ id:1, bbox:{x,y,w,h}, tStart, tEnd }, decision?:{ kind, norm, z, mc, gain } }

// Digest：注入载荷的唯一来源（rev 每次 append 递增；同一 rev 只投一次）
{ rev: 42, sessionId:'rta-20261111-1031', windowStart, windowEnd, now,
  counts:{ cut:2, text:1, integral:0, heartbeat:1, region:0, dropped:0 },
  events:[LiveEvent…≤5 最近], latest: LiveEvent|null, foreground: {...}|null,
  timeline:[ '10:31:02 cut  #1841 score=21.3 "engine.js — Code" (Code.exe)', … ≤8 行],
  textTruncated:false, staticMs: 98000, stale:false }

// Delivery：injector 交给 channel 的一条待发消息
{ id:'rta:rta-20261111-1031:42:snapshot', rev:42, form:'snapshot', text, image?:{rgb,width,height,tokens,seqs[]},
  reason:'cut|text|heartbeat|start|summon|stop|idle-first-step' }
```

## 2. 注入策略规格

### 2.1 触发表（默认参数）

| 触发 | 条件（在 digest 上判定） | minIntervalMs | 载荷 | 通道 | 硬上限 |
| --- | --- | --- | --- | --- | --- |
| start | `rta_start` 成功（或热键冷启动） | 0，一次 | 宣告文案 + 首帧拼图（1 帧 233）+ 时间轴 | 用户动作：idle→followup；running→inject | 每会话 1 |
| cut | `kind='cut'` 且 `score>=18`，或最近 60s 有 ≥2 个 cut | 3000 | 文字 digest | pre-step 主 / inject 备 | 12/min |
| text | `kind='text'` | 3000 | 文字 digest（高优先，可抢配额） | 同上 | 12/min |
| integral | `kind='integral'` 且静默事件已积 ≥2 | 5000 | 文字 digest | 同上 | 8/min |
| heartbeat | `staticMs>=30000` 且 agent running | 30000 | 1–2 行「静止/仅前台窗口变化」 | pre-step（不占 inject） | 1/min |
| region | 用户圈画完成（engine `handleRegion` 已 push） | 0 | 裁剪图 + bbox + tStart/tEnd | 用户动作：running→steer，idle→followup | 每次 1 |
| image-due | cut 且 `now-lastImageAt>=60000` 且 attachments 可用 | 60000 | digest 文字 + sheet≤4 帧（392） | inject/pre-step | 4/10min，在飞≤2 |
| idle-first | idle→running 新一轮，且 pending 非空 | 3000 | 最新 digest 1 条 | pre-step（无 pre-step 时首步 inject） | 1/轮 |
| summon | Ctrl+Alt（任意状态） | 1500 | 新鲜 digest + sheet（1–2 帧，233/392） | 用户动作：running→steer，idle→followup | 1 次/按键沿 |
| stop | `rta_stop`/Ctrl+Tab | 0 | 总结文字 + recall 指引（无图） | inject（不 wake）；idle 留 pending | 1 次/会话 |
| idle-hold | agent idle | — | **不投递**，只更新 pending 槽 | 无 | 0 |

合并规则：同一窗口内多个触发只产生 **1 条** delivery（取最高优先级 reason）；`pending` 只有 1 个槽，新 digest 到达即替换旧的（`rev` 更大的赢）。**空闲积压坍缩**：`now-pending.firstAt > 15s` 只保留最近 3 个事件；`> 5min` 只保留 latest + counts，时间轴压到 2 行。**过期丢弃**：时间轴只覆盖最近 120s（更早的交给 `rta_recall`）；图片在 `imageMaxAgeMs=30s` 内没发出去就丢图保文字；`rev<=lastDeliveredRev` 直接丢（幂等）。

### 2.2 现状缺口（P0 必须补）

- `src/engine/engine.js:384-391`：`bus.emit('push', { ...ev, rgb: undefined, decision })` 不含 `win`，digest 拿不到窗口标题 → push 载荷补 `win: winMeta(lastForeground)`（约 3 行）。
- `src/engine/engine.js:560` `composeRecent({count,maxTokens})` 只能取 eventRing 最后 N 个，无法「只拼这一批新事件」→ P1 加 `composeEvents({seqs,maxTokens})`；P0 用 `composeRecent` + seq 去重。
- `src/host/runtime.js` 目前**从不订阅** `engine.on('push')`（只有 exit/stop）→ 这是「启用后无注入」的根因。
- `eventRing` 容量 12（`maxEventsInMemory`）：buffer 只存元数据（cap 64），图片合成超 12 个事件时用最后 12 个并在文字里写明「更早用 rta_recall」。
- 图片省略只挂在工具交付上：`notifyDelivery()`（`src/index.js:145-161`）唯一触发点是 tool handler 出图后（`handlers.js:88/264/281`）；一旦图片从注入通道进入 `user/message`，offload **永远不会被触发**（02-D6）→ P0 必须让 injector 交付后回溯调用同一 hook。
- 同步拼图不能放进 push 回调：`composeKind()` 是全量同步重拼（`engine.js:568-590`），`attachRgb()` 再同步 `encodePng`（`host/service.js:42-51`）；实测 1/4/8 帧 ≈ **9.5 / 25.0 / 30.7 ms**（02 §4.3），15Hz tick 预算只有 66.7ms → injector 只入队，异步合并 ≥1s 后再拼图，避免阻塞抓屏。

## 3. 消息契约

| 字段 | 频率高的持续流（snapshot） | 召唤/生命周期（notice） | 说明 |
| --- | --- | --- | --- |
| `id` | `rta:<session>:<rev>:snapshot` | `rta:<session>:<ts>:notice` | 确定性，供 channel/injector 去重 |
| `role` | `'user'` | `'user'` | 与现有 `src/host/summon.js:54-61` 一致 |
| `content[0]` | `{type:'text', text}` | 同左 | **文字必带** |
| `content[1]?` | `{type:'image', attachment}` | 同左（仅 start/summon） | 仅图片触发时 |
| `source.kind` | `'plugin:dsh-rta'` | 同左 | V4 producer-owned kind，沿用现状 |
| `source.form` | `'snapshot'` **[待核实：是否为合法枚举]** | `'notice'`（现行已用） | 决定 UI 折叠与派生历史呈现 |
| `source.summary` | `'屏幕时间轴 10:31:02–10:32:40（2 个变化点）'` ≤80 字 | `'RTA 已启用，持续看到屏幕'` | 防污染会话标题/摘要 |
| `source.sections` | `[{id:'timeline',title:'屏幕时间轴'},{id:'window'},{id:'counts'}]` | `[{id:'lifecycle'}]` | UI 分区；不解析正文 |

文字模板（控制在 8 行 / ≤400 tokens，英文短句省 token，窗口标题保留原文）：

```
RTA screen timeline 10:31:02→10:32:40 (sess rta-20261111-1031; 2 changes; 98s static)
10:31:02 cut  #1841 score=21.3  "engine.js — Code" (Code.exe)
10:32:40 text #1856 score=9.1   "ChatGPT — reply done"
foreground: "engine.js — Code" (Code.exe)
older: rta_recall(from,to) · circled: rta_region · memory: rta_note
```

### 3.1 inject / steer / followup 使用边界

| 通道 | 唯一允许用途 | 调用时机 | 会 wake 吗 | 失败退化 |
| --- | --- | --- | --- | --- |
| pre-step append | **主通道**：每步最新 digest | agent 正在跑，每个 model step 前 | 否 | 能力探测失败 → 用 agent.inject |
| `agent.inject` | 运行中高信号文字/图（节流后） | `agent.status==='running'` | 契约上不应 wake **[待核实]**；本设计只在 running 调用 | 连续 3 次抛错 → 只走 pre-step |
| `agent.steer` | 用户召唤/圈画时插入 | 仅用户动作 + running | 已醒，无 wake 语义 | 降级 inject |
| `agent.followup` | 用户召唤且 idle、start 宣告且 idle | **仅用户动作** | 是（唯一允许） | 降级为 pending + 日志 |

### 3.2 idle / running 语义

| 状态 | 自动流行为 | 用户召唤 | 下一轮如何看见最新 |
| --- | --- | --- | --- |
| running | pre-step 每步注入 ≤1 条；inject 仅高信号且过 3s 节流 | steer 一条新鲜 digest+图 | 每一步都重算 digest（rev 单调），天然最新 |
| idle | **零调用**；pending 单槽持续替换；无定时器投递 | followup（唯一 wake 点），正文带最新 digest 并提示可直接 `rta_look` | 下一轮首步由 pre-step 投 pending；无 pre-step 时在首次 tool 调用/下一条消息边界投 |

## 4. 生命周期（host/lifecycle.js）

| 事件 | 行为（函数） | 消息/副作用 |
| --- | --- | --- |
| `rta_start`（工具）/热键冷启动 | `lifecycle.onStart()`：engine.start → buffer 清空 → 生成首 digest（首帧最多等 1.2s，拿不到就先发「首帧生成中」） | 1 条 notice：session id、节奏参数、隐私提示（「屏幕内容会持续进入上下文」）、首帧图；idle 由用户动作触发才 followup |
| 运行期 | `runtime.ensure()` 里 `engine.on('push', ev => liveBuffer.append(ev))`；`injector.onStep()` 挂在 pre-step | 每步/每事件按 §2.1 |
| `rta_stop`（工具）/Ctrl+Tab | `lifecycle.onStop()`：flush pending → `engine.stop({reason})` → 汇总 counts/retainUntil | 1 条 notice：总结 + `rta_recall` 指引 + 图片 24h 过期；不 wake（idle 留 pending） |
| Ctrl+Alt 语义修订 | 未启用：start + 召唤（沿用现状）；**启用中：不再被忽略，而是「现在看一眼」**——立即生成 digest+1–2 帧 sheet，running→steer / idle→followup | 修订 `src/host/summon.js:104` 注释与 README 热键段 |
| 会话切换（`session/event`） | `lifecycle.onSession(id)`：先把 pending flush 给旧绑定；新会话默认**静默重绑**，不把旧会话内容发到新会话 | 防跨会话泄漏；`inject.bindOnlyOptInSession=true`（默认）时新会话需用户召唤/调工具才绑定 |
| 重复 start | `engine.state==='running'` 时只回状态，不再宣告 | 幂等 |
| dispose | `lifecycle.dispose()`：flush pending（best-effort）→ 取消 pre-step/inject 订阅 → engine.stop('plugin-dispose') → 清 buffer | 不 wake；无悬挂定时器 |

## 5. 失败降级矩阵

| 故障 | 检测 | 降级 | 用户可见 |
| --- | --- | --- | --- |
| attachments 服务缺失 | `serviceOf(ctx,'attachments')` 返回 null | 只发文字 digest；start/summon 的图省略 | 文案注明「本机无法注入图片，用 rta_look 查看」 |
| agent 拿不到 | `resolveAgent` 为空 / 无 remembered agent | pending 只存不投；等工具调用绑定 | 无报错；`rta_status` 显示 `inject:pending` |
| `inject`/pre-step 抛错 | try/catch + 连续 3 次 | 停用该通道 60s；两侧都挂 → 切纯 pull 并在 status 提示 | `rta_status` 显示 `inject:off(reason)` |
| 引擎卡死（grab 失败/无 tick） | 最近 push 距今 >5s 且 `tickHz` 归零 | 暂停投递；发 1 条「采集暂停，最后画面 10:32」；`lastError` 上报 | status 可见，恢复后自动继续 |
| 图片过期/已被 offload | attachment 不可用 / seq 不在 ring / 文件不存在 | 丢图保文字，文字里给 seq 与 `rta_recall` | 无感 |
| 压缩/标题污染 | P1 验证：form/source.kind 是否进摘要 | summary ≤80 字 + `form:'snapshot'`；最坏改回 `notice` | 待 01 文档结论 |
| 前缀缓存失效 | offload 次数/位置监控 | 注入图配合 `offload trigger=6 keep=2`，只在图片轮后 30s 检查 | 无感 |
| 热键 watcher 不可用 | `createWin32()` 失败 | 只剩自动流 + 工具 | 启动日志 warn |
| 多会话并发工具调用 | 工具 exec 带不同 sessionId | 绑定最近会话；`rta_status` 显示绑定 | — |
| 插件 dispose | apply disposer | flush + 全部解绑 | 会话里留一条结束说明 |

## 6. 成本模型与默认参数

| 载荷 | token 估算 | 出处 |
| --- | --- | --- |
| 文字 digest（6–8 行） | 110–260 | 时间戳+短句；8 行硬上限 |
| 单帧 sheet 800×450 | 233 | `src/algo/tiers.js:17` |
| 4 帧 1050×630 | 392 | 同上 |
| 8 帧 1260×756 | 560 | 同上 |
| 12 帧 1596×924 | 860 | 同上 |
| offload 占位文本 | ~20/图 | 投影替换 |
| 同步拼图+PNG 编码（1/4/8 帧） | 9.5 / 25.0 / 30.7 ms | 02 §4.3 实测（15Hz tick 预算 66.7ms） |

频率折算（默认参数）：普通对话 1–3 条 digest/轮 ≈ 300–800 tokens/轮；工具密集循环封顶 12/min ≈ 3.1k tokens/min（合并后实测应约一半）；图片 ≤4/10min ≈ 1.6k tokens/10min。纯 pull 一次 `rta_look` = 392 图 + ~200 文字，但延迟 = 人类开口或模型自觉。
缓存：append-only 时前缀只到上一条消息，新增部分才计费；**每步改写同一条消息**会让其后全部失效 —— 因此禁止「原地更新」式注入，pre-step 只能追加新条目（digest rev 变了就追加，不变就不发）。

| 方案 | 触发延迟 | 上下文增长 | 前缀缓存 | idle 安全 | 实现成本 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A 纯 pull（现状） | 高（等模型调用） | 最低 | 无额外失效 | 安全 | 零 | 违反原则，只做 fallback |
| B 纯 inject 事件流 | 最低 | 高且不可控（动画/滚动） | 尾追加安全但过于频繁 | 有堆积/wake 风险 | 中 | 否 |
| **C pre-step 混合（推荐）** | 低（≤1 step） | 可控（每步 ≤1 条 + 硬预算） | append-only | 安全（idle 不投递） | 中高 | **采用** |

新增配置 `~/.dsh/rta/config.json` → `inject`（`src/config.js` 增 `DEFAULT_RTA_CONFIG.inject` 与解析循环）：

```json
{ "inject": {
  "enabled": true, "mode": "auto", "minIntervalMs": 3000, "maxPerMinute": 12,
  "maxPerStep": 1, "maxPerTurn": 4, "maxLines": 8, "maxTextTokens": 400,
  "staleMs": 15000, "idleCollapseMs": 300000, "eventTtlMs": 120000,
  "heartbeatMs": 30000, "bindOnlyOptInSession": true,
  "image": { "enabled": true, "triggers": ["start","region","cut"],
             "minIntervalMs": 60000, "maxPer10Min": 4, "maxInFlight": 2,
             "maxFrames": 4, "maxSheetTokens": 560, "maxAgeMs": 30000 }
} }
```

## 7. 迁移计划

| 阶段 | 文件（新增/修改） | 具体改动 | 新增测试 | 验收标准 |
| --- | --- | --- | --- | --- |
| **P0 注入主链（1–2 天）** | 新 `src/host/live-buffer.js` | `createLiveBuffer({capacity=64})`：`append(ev)/digest(now)/noteDelivered(rev)/pending()/reset()`，纯数据 | `test/live-buffer.test.mjs`：ring 上限、rev 单调、120s 窗口、坍缩、去重 | 单测全绿 |
| | 新 `src/host/messages.js` | `buildSnapshotMessage/buildLifecycleMessage/buildSummonMessage/buildSummaryMessage` + `SOURCE_KIND`/`FORM` 常量 | 消息形状断言（role/content/source/≤80 字 summary） | 与现有 summon 契约兼容 |
| | 新 `src/host/injector.js` | `createInjector({config,logger,now,deliver})`：§2.1 触发表、pending 单槽、计数、退避、`onStep()` | `test/injector.test.mjs`：节流/min 上限/合并/幂等/idle 零调用/图片节奏/抛错退避（假时钟） | 10 分钟模拟：≤120 条、≤4 图、0 wake |
| | 新 `src/host/channel.js` | 能力探测：pre-step（主）→ inject（备）→ 纯 pull；`deliver(delivery)` 统一入口 | `test/lifecycle.test.mjs` 覆盖三通道降级 | 缺服务时不抛、只降级 |
| | 新 `src/host/lifecycle.js` | §4 表：onStart/onStop/onSummon/onSession/dispose | start/stop 消息、重复 start、dispose 无 timer | ≤2s 出首条注入 |
| | 改 `src/host/runtime.js` | `ensure()` 订阅 `engine.on('push')`；创建 buffer/injector/lifecycle；暴露 `liveBuffer/injector/bindAgent`；dispose 顺序 | 现有 plugin 测试扩展 | push 事件真的进 buffer |
| | 改 `src/host/summon.js` | `notify()` 只保留用户召唤路径；消息改由 messages.js 构造；修 `:104` 注释 | summon 测试改造 | 自动流路径不再调 followup |
| | 改 `src/engine/engine.js` | push 载荷补 `win`（`:384`）；`pushNow` 同样带 win | engine 测试补字段断言 | digest 有窗口标题 |
| | 改 `src/config.js` | 增 `inject` 默认值 + 数值/布尔解析 | config 测试 | 坏配置回退默认 |
| | 改 `src/tools/handlers.js` | start/stop 调 `lifecycle.onStart/onStop`；`look` 优先复用 buffer digest（5s 内）避免重复图 | handler 测试 | start 返回文案含「持续注入」 |
| | 改 `src/tools/spec.js` | start/stop/look 描述改为「启用后自动持续注入；look 是补看」 | 描述断言（可选） | 模型不再把 pull 当唯一入口 |
| | 改 `src/index.js` | apply 注册后 `lifecycle.attach()`；把 `notifyDelivery()` 接到 injector 的 `onDelivered`（工具与注入同源，注入图也能 offload）；disposer 先 unsubscribe 再 dispose | apply/dispose 测试 + 注入图 offload 断言 | 卸载无残留，注入图会被省略 |
| **P1 宿主契合（2–4 天）** | `src/host/channel.js` | 按 01 文档把 pre-step 设为主通道；确认 form/sections/idle 语义 | pre-step 单测 + 双通道不重复 | 每步 ≤1 条、不重复 |
| | `src/engine/engine.js` | `composeEvents({seqs,maxTokens})` 只拼新事件 | 拼图 seq 断言 | 图不重复、旧图可 recall |
| | `src/host/offload.js` | 统计注入图（现有已扫 user/message）；注入场景 trigger=6/keep=2 | offload 计划测试 | 图片常驻 ≤3、offload ≤1/30s |
| | `src/tools/handlers.js` | `rta_status` 增 injector 指标（rev、已投条数、省下的图数） | status 测试 | 可观测 |
| | `README.md` / `src/tools/spec.js` | 原则段与工具文案对齐实现；热键语义修订 | — | 文档无「仅工具主动调用」表述 |
| **P2 产品化（后续）** | 客户端 UI、按前台应用调频、OCR `noteTextChange` 接入、缓存命中率评估、隐私开关 | — | 长跑 soak | 见开放问题 |

**风险与回滚**：R1 宿主 API 不匹配 → `inject.enabled=false` 时行为等同旧 pull，P0 新模块可整体不装配（`runtime` 里 try/catch 包裹，失败仅日志）；R2 token 爆炸 → 硬上限 + 默认保守 + `rta_status` 可观测，必要时把 `maxPerMinute` 降到 4；R3 wake 风暴 → 测试断言「非用户动作路径不得调 followup/steer」，代码审查 grep；R4 offload 抖动 → 只在图片轮后检查、trigger 抬高；R5 注入被压缩摘要污染 → P1 用 01 文档结论验证，最坏退回 `form:'notice'`。

## 8. 开放问题（按需 01/02 文档闭合）

| # | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| Q1 | `agent.inject(msg)` 在 idle 时是排队还是唤醒？消费点？异常/返回契约？ | 决定 idle 能否完全不投 | [待核实] |
| Q2 | pre-step 挂载点（事件名/hook 返回契约）能否向 messages 追加且不持久化？ | 决定主通道是否成立 | [待核实] |
| Q3 | `source.form` 合法枚举是否含 `'snapshot'`；`sections` 的 schema | 消息契约 | [待核实] |
| Q4 | 注入消息是否进压缩摘要/会话标题/派生历史；能否按 `source.kind` 过滤 | 污染与噪声 | [待核实] |
| Q5 | `image/offload` 能否覆盖注入消息的图；offload 后缓存失效范围 | 图片成本 | [待核实] |
| Q6 | 插件能否在 `inject=['tools']` 下软探测 agents/sessionController 与 agent 状态变更事件 | 绑定与 idle 判定 | [待核实] |
| Q7 | fork/子代理/compaction 后 agent handle 是否失效；是否复制注入历史 | 多会话安全 | [待核实] |
| Q8 | 图片是否该默认进入自动流，还是只保留 start/region、cut 图默认关闭 | 成本 vs 信息密度 | 待用户定 |
| Q9 | 25–30s heartbeat 文字是否构成噪音；静默期是否完全不发 | 体验 | 待用户定 |
| Q10 | 隐私：屏幕内容持续进上下文需要多强的明示（start 文案/配置页/首条 notice） | 合规 | 待用户定 |
