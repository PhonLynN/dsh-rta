# 02 现状差距审计：RTA「启用即持续注入」为何没有发生

> 审计对象：dsh-rta 工作区（`src/` 28 个 JS 文件、`bin/` 4 个 CLI、`test/` 4 个文件、`README.md` 139 行）。
> 方法：全量静态读代码（非抽样）+ 逐文件实跑测试 + 合成帧基准；未修改任何产品代码。
> 本文只描述**现状**与偏差。目标架构见同目录 `03-target-architecture.md`，宿主能力边界见 `01-host-injection-contract.md`。
> 唯一写入：本文件。审计脚本：`_probe/agent-code-audit/bench_compose.mjs`。

## 0. 一页结论

1. **push 是一条死信通道。** 引擎有完整的 `bus.emit('push', …)`（`src/engine/engine.js:391`、`:542`、`:550`），但生产代码里没有任何消费者：`createRuntime().ensure()` 只订阅 `exit` 和 `stop`（`src/host/runtime.js:65-68`）。全仓唯一的 `engine.on('push')` 在开发用 headless CLI `bin/rta-run.mjs:41`，且只 `console.log`。
2. **插件被启用 ≠ 采集启动。** `apply()` 只做三件事：注册 9 个工具、接上 image/offload、挂一个「引擎没跑时」的热键轮询（`src/index.js:53-79`）。采集要等模型调 `rta_start`/`rta_look`，或用户按 Ctrl+Alt（`src/host/runtime.js:74-81`）。「启用后」这个前提本身就不成立。
3. **唯一的主动通路是一条纯文本 notice，且只由热键触发。** `summon.notify()` 把一句固定 `summonPrompt` 用 `agent.followup/steer` 推进会话（`src/host/summon.js:53-62`、`:76-79`；文案 `src/config.js:32`），载荷里没有图、没有事件、没有帧元数据。
4. **即使现在接一个 pump，push 当刻也拿不到像素。** 推送载荷显式 `rgb: undefined`（`src/engine/engine.js:391`），像素只留在 `eventRing`（12 条，`engine.js:49`、`:389-390`），或由 worker 异步落盘——push 发出时只保证「编码任务已投递」，不保证文件已存在（`engine.js:414-422` → `src/store/writer.js:47-56`）。
5. **省略机制挂错了钩子。** `image/offload` 只由工具交付后的 `notifyDelivery()` 驱动（`src/index.js:145-161`；`src/tools/handlers.js:88`、`:264`、`:281`）。若未来图片从注入通道进入 `user/message`，offload 永远不会被触发，图片只进不出。
6. **测试 24 个全过，但注入路径覆盖率为 0。** 没有任何测试涉及 push→inject、start/stop 注入、投递节流/合并、或 `user/message` 注入图被省略。`node --test` 的 24 与 README 的 22/19 都对不上（详见 §7）。

**判定：现状是 pull-only 设计（模型问一次、给一次），与「启用后持续注入」是结构性冲突，不是参数没调好。**

## 1. 端到端数据流（现状）

```
[采集侧 · 30Hz 默认 / 15Hz 实际配置]
  GDI grab ──► 哨兵 192px 打分 ──► selector.ingest ──► decision?
                                     (select.js:28 节流 20/min、800ms 间隔、25s 心跳)
                                         │
                                         ▼ decision 且 frameRgb
                          writeImage('event', 原生分辨率)      ◄── 仅投递编码任务(异步)
                                         │  store/index.jsonl  ← 文字时间轴（可回捞）
                                         ▼
                          eventRing(≤12 帧 512px, engine.js:389) ── 容量不进 config
                                         │
                                         ▼
                       bus.emit('push', {…, rgb: undefined})     engine.js:391/542/550
                                         │
                                   ✗ 无消费者（生产代码 0 个订阅）
                                         │
                                         └── bin/rta-run.mjs:41（开发 CLI，只打印）

[模型 pull 侧 · 唯一真正进入上下文的路]
  模型/用户 ──► rta_look / rta_recall / rta_region（工具调用）
                   │ handlers.look: await rt.start()  ← 顺便把采集开起来
                   ▼
             composeRecent → composeKind（同步拼图） → attachRgb（同步 PNG 编码）
                   ▼
             工具返回值 { text, images[] } → 宿主把 attachments 交给调用方模型
                   ▼ （收到图之后）
             notifyDelivery() → 30s 节流 → planOffload(trigger=8,keep=3)
                   ▼
             session.append('image/offload') → 省略历史图（index.js:145-161）

[主动注入侧 · 唯一存在的通路]
  Ctrl+Alt（仅引擎没跑时） ──► summon.watch 10ms 轮询（summon.js:90-112）
                   ▼
             runtime.idleSummon() = start() + notify()
                   ▼
             agent.followup/steer( 纯文本 notice )  ← 无图、无事件、无 payload
                   ▼
             模型看到「先去调 rta_look」            ← 用户原则在这里被反转为 pull

[生命周期]
  apply → 注册工具 + 热键轮询（无采集、无宣告）
  rta_start / rta_look / Ctrl+Alt → engine.start()（只 emit 'start'，无人订阅，engine.js:231）
  rta_stop / Ctrl+Tab / plugin dispose → engine.stop()（只 emit 'stop'，无人注入，engine.js:256）
```

## 2. 偏差清单（D1–D15，按 P0/P1/P2）

### P0（原则性缺失，不补则「持续注入」不可能成立）

**D1 · push 无消费者，通路上完全断裂**
- 现象：引擎三处 emit `'push'`（`engine.js:391` 决策事件、`:542` 圈画、`:550` pushNow），生产代码零订阅；`runtime.ensure()` 仅 `engine.on('exit'|'stop')`（`runtime.js:65-68`）。
- 违反：P-a「启用即接管」、P-c「数据进上下文」。
- 后果：采集→筛选→拼图这条最贵的链路全部空转；模型不主动问，屏幕上发生什么都不可能进入上下文。
- 备注：`pushNow()`/`saveSheet()` 有实现、有导出（`engine.js:547-552`、`:593-600`），全仓无调用点——设计意图存在，接线缺失。

**D2 · 插件启用不启动采集，没有「已启用」状态**
- 现象：`registerAll()` 只注册工具、wire offload、`watchForSummon()`（`src/index.js:57-67`）；`runtime.ensure()` 是懒建（`runtime.js:57-71`）；`handlers.look()` 里 `await rt.start()` 说明连「看一眼」都要先补启动（`handlers.js:152-183`）。
- 违反：P-a。用户说「RTA 启用后就应该持续注入」，而实现里没有「启用」这个生命周期事件，只有「某次工具调用/热键」。
- 后果：默认状态下没有任何数据源；`rta_status` 首答是 "not running"（`plugin.test.mjs:73-80` 正是这个断言）。

**D3 · 唯一主动注入 = 一条固定文本 notice，只由热键触发**
- 现象：`buildMessage()` 固定 `content:[{type:'text',text:prompt}]`、`source.kind='plugin:dsh-rta'`、`form:'notice'`（`summon.js:53-62`）；`notify()` 无任何载荷参数（`:68-87`）；触发只有 idle 热键轮询（`summon.js:90-112`）与引擎 exit/stop 后的 `watch()`（`runtime.js:67`、`:97`）。
- 违反：P-b「持续」、P-c「数据」。
- 后果：最接近「主动注入」的能力被降级成一次性提示；而且提示内容是「去调 rta_look」（`config.js:32`），等于官方把 push 语义定义成 pull。
- 备注：`summon.js:58-60` 注释说明 V4 会话已支持 producer-owned `plugin:<id>` 消息——文本通道是宿主认可的，缺的是内容与触发。

**D4 · push 载荷剥离像素，且文件尚未落盘**
- 现象：`bus.emit('push', { ...ev, rgb: undefined, decision })`（`engine.js:391`）；`ev.file` 是 `writeImage()` 刚投递给 worker 的路径（`engine.js:414-422`），`writer.write()` 只是 `postMessage`（`writer.js:47-56`），push 发出时文件不保证存在。
- 违反：P-c「可直接消费的数据」。
- 后果：想写 pump 必须再回读 `engine.eventRing`（12 帧、512px）或竞态读盘；payload 里连 `win`（前台窗口标题）都没有——`rec.win` 只写进了磁盘记录（`engine.js:381-382`），没进 `ev`。

**D5 · start/stop 对会话不可见，生命周期没有上下文语义**
- 现象：`start()` 只 `bus.emit('start', status())` 并 return（`engine.js:231-232`）；`stop()` 只 `bus.emit('stop',{…})`（`:256`）；`runtime.start()` 只 `logger.info`（`runtime.js:84-92`）；`handlers.start()` 把结果作为工具返回值给调用方（`handlers.js:92-110`）。没有任何「RTA 已开始/已停止」的消息进入会话。
- 违反：P-e「生命周期可见」。
- 后果：模型永远不知道眼睛正在看；用户重启/掉线/采集异常（`lastError`）也不会被告知。会话里没有任何「这一段屏幕我记录过」的痕迹可供后续推理。

**D6 · image/offload 只挂在工具交付上，注入图不会被省略**
- 现象：`setDeliveryHook()` 的唯一触发点是 `notifyDelivery()`（`src/index.js:146-161`），它只在 handler 交付图片后调用（`handlers.js:88`、`:264`、`:281`）。
- 违反：P-d「有预算」——注入路径没有回收机制。
- 后果：一旦按原则改成持续注入，图片会单调增长。offload 的**规划能力**其实已支持 `user/message`（`offload.js:27`、`:95` 读 `data.message.content`），缺口只在触发接线与水位（详见 §5）。

**D7 · 注入路径零测试覆盖**
- 现象：24 个测试分布在 algo/engine/plugin/store；plugin 仅测「summon 推一条 plugin notice」（`plugin.test.mjs:121-163`）。无 push→inject、无 start/stop 注入、无节流合并、无 `user/message` 图的 offload。
- 违反：工程约束——偏差无法被回归捕获。
- 后果：任何一次「顺手把 push 接到 summon」的改动都不会被测试挡住，也不会被验证。

### P1（能力/参数面缺失，补 P0 后立刻暴露）

**D8 · 工具文案把 pull 写死，会持续反向训练模型**
- 现象：`rta_start` 描述「only the moments you ask for with rta_look are sent to you」（`src/tools/spec.js:63-65`）；`rta_look` 描述「看到什么取决于你要几帧…ask for 1-2 frames」（`:102-106`）；`rta_status` 强调「without sending any image」（`:90-91`）；handler 末行同样写「call rta_look to see the screen」（`handlers.js:104`）。
- 违反：P-a/P-b 的语义前提。
- 后果：模型按文档行事，永远走 pull；注入即使接好也会被工具描述压制。

**D9 · 没有投递侧的节流/合并/预算/积压/水位**
- 现象：唯一「预算」在采集侧 `maxPerMinute=20`、`minSelectGapMs=800`、心跳 25s（`src/algo/select.js:19-31`）——它限制的是**产生事件**，不是**进入上下文**；token 预算 `maxSheetTokens` 只在工具路径用（`handlers.js:152-183`）；没有合并窗口、没有未读队列、没有「已注入到第几条 seq」的水位；`bus.emit` 无监听即丢弃，EventEmitter 不排队。
- 违反：P-d。
- 后果：直接接 pump 会变成「每 800ms～25s 往会话塞一张拼图」，token 与回合数都不可控。

**D10 · config 没有注入旋钮；引擎子集还把可调项裁掉**
- 现象：`DEFAULT_RTA_CONFIG` 只有 capture/retention/imageTrigger/imageKeep/maxSheetTokens/summonPrompt/summonCooldownMs（`src/config.js:12-34`）；数字白名单不含任何 inject/enabled/interval/budget 键（`:57`）；`engineConfig()` 只透传 `capture` + `retentionHours`（`:75-80`），因此 `maxEventsInMemory`、`selection`（引擎里存在，`engine.js:47`、`:49`）**无法从配置修改**。
- 违反：P-a（无法开关）、P-d（无法调预算）。
- 后果：即使实现了 pump，也没有任何用户可见开关；「启用 RTA」在配置层不存在。

**D11 · 内存窗口太短，且没有投递水位/补发**
- 现象：`eventRing` 容量 12（`engine.js:49`、`:389-390`），载体是 512px 小图（`archiveWidth`，`engine.js:153`）；`start()` 会清空两个 ring（`:213`）；归档 ring 24 条（`:50`）。
- 时间窗：idle 心跳 25s → 12 帧 ≈ 5 分钟；忙时 20/min → 12 帧 ≈ 36 秒。
- 违反：P-b「持续」的连续性。
- 后果：pump 若消费不及时，超窗事件永久丢失且无法知道丢了什么（没有 seq 水位/去重表）。

### P2（文档与半成品，会误导后续实现）

**D12 · summon 的一次性语义与「持续」相互矛盾**
- 现象：`notify()` 有 1500ms 冷却（`src/config.js:33`、`summon.js:70`），且只发一条固定文本（`summon.js:53-62`）；引擎运行中按 Ctrl+Alt 是**显式无操作**（`engine.js:446-447` 注释；`summon.js:104` 的 `!shift` 分支只在 idle watcher 里）。
- 违反：P-a。
- 后果：用户按热键得到的只是「开始录制 + 一句提示」；没有任何「之后持续给」的承诺被兑现。

**D13 · README 与实际不符（数字、工具数、重复行、原则自相矛盾）**
- 22 vs 19 vs 实际 24：`README.md:5`（并写成 10 算法 + 5 引擎 + 6 插件 = 21）、`:113`（19 个离线测试）；实测 24 = 10 algo + 6 engine + 6 plugin + 2 store（§7）。
- 工具数：`README.md:45` 写「8 个模型工具」，`spec.js:48-58` 与注册测试（`plugin.test.mjs:53-55`）都是 9 个。
- 重复行：`README.md:79`（`rta_sessions` 行重复）、`:43`（`native/gdiplus.js` 重复）。
- 原则与文案冲突：`:18` 说「通过筛选的画面才进上下文」，`spec.js:63-65` 说「只有你调 rta_look 才发给你」——两者不可能同时成立。
- 后果：读者无法从 README 判断当前到底是 push 还是 pull。

**D14 · 不存在的 `summon` 事件被测试与 probe 当成真路径**
- 现象：`test/engine.test.mjs:183` 订阅 `engine.on('summon', …)`，但 `bus.emit` 列表中没有 `'summon'`（`engine.js` 全部 emit：`start/stop/draw-start/draw-end/draw-cancel/exit/push`），断言 `summons.length===0`（`:190`）永远为真；`_probe/summon_e2e.mjs:6` 注释也假设「引擎在跑：Ctrl+Alt → engine 'summon' 事件」。
- 后果：制造「已覆盖/已验证」的假象，且暗示实现曾计划把 summon 做成引擎事件。

**D15 · 半成品接口悬空，注释泄露未完成的设计意图**
- 现象：`pushNow`/`saveSheet` 无调用点（`engine.js:547-552`、`:593-600`）；`runtime.js:130` 注释写「工具调用时把调用方 agent 记下来（召唤/**主动推送**要用）」；`select.js:6` 写「这里只决定**主动推送**」；`handlers.js:103` 仍把 Ctrl+Alt 称为 "summon & keep RTA on"。
- 后果：代码里同时存在 push 语义的「设计语言」与 pull 语义的「实际行为」，后续实现者容易以为只差接线。

## 3. 原则 → 现状 → 判定

| 原则（用户表述） | 拆解 | 现状（file:line） | 判定 |
| --- | --- | --- | --- |
| RTA 启用后持续注入 | 启用即有数据源 | apply 只注册工具；采集靠工具/热键（`index.js:53-79`；`runtime.js:74-81`） | ✗ 无「启用」概念 |
| 同上 | 无需模型请求 | 生产代码零 push 订阅（`runtime.js:65-68`；`bin/rta-run.mjs:41`） | ✗ 完全依赖 pull |
| 注入的是数据 | 图片/事件可用 | push 剥像素（`engine.js:391`）；文本 notice 无图（`summon.js:53-62`） | ✗ 载荷不足以注入 |
| 持续但有节制 | 节流/合并/预算 | 只有采集侧 governor（`select.js:28-29`）；无投递预算 | ✗ 缺一半 |
| 生命周期可感知 | start/stop 宣告 | 只 emit 本地事件（`engine.js:231`、`:256`），无人订阅/注入 | ✗ 会话不可见 |
| 关闭即停 | 停止后不再注入 | stop 可停采集（`engine.js:235-258`），但从未有注入 | △ 无意义地成立 |
| 图片用完即省 | offload 覆盖全通道 | offload 只挂在工具交付（`index.js:146-161`；`handlers.js:88`） | ✗ 注入通道未接 |

## 4. 引擎 push 载荷与 pump 可行性

### 4.1 载荷精确字段（`engine.js:384-391`，region 事件在 `:532-542`，pushNow 在 `:547-552`）

| 字段 | 决策事件 | region 事件 | pushNow | 说明 |
| --- | --- | --- | --- | --- |
| `id`/`seq` | ✓ | ✓ | ✓（末条） | 磁盘 index 的 seq，可作水位键 |
| `kind` | `cut/integral/text/heartbeat` | `region` | 原 kind + decision.kind='manual' | 事件类型 |
| `at`/`wall` | ✓（同一时间） | ✓ | ✓ | 毫秒时间戳 |
| `file` | 原生分辨率 event 图路径 | 裁切 PNG 路径 | 原事件路径 | 可能尚未落盘（D4） |
| `rgb` | **undefined** | **undefined** | **undefined** | 像素被显式剥掉 |
| `width`/`height` | 512 档（`archiveW/H`） | 裁切尺寸 | 原宽度 | 与 file 的原生尺寸不一致 |
| `regionIds` | `[]` | `[id]` | 跟随 | — |
| `region` | — | `{id,bbox,tStart,tEnd}` | 跟随 | 只有 region 事件有 |
| `screen` | — | `{x,y,w,h}` | 跟随 | 坐标映射用 |
| `decision` | `{kind,norm,z,mc,…}` | `{kind:'region'}` | `{kind:'manual',reason}` | selector 原始判定（`select.js:96`） |
| `win`（前台窗口） | **缺失** | **缺失** | **缺失** | 只在磁盘记录里（`engine.js:381`） |

### 4.2 pump 的三个硬断点

1. **没有消费者**：EventEmitter 无监听即丢弃，且无「已送达水位」；`eventRing` 只保留最近 12 条像素，没有待发送队列（`engine.js:389-391`）。
2. **push 时无像素**：消费方要么读 `engine.eventRing`（`engine.js:684` 暴露 getter，元素含 `rgb`），要么等文件落盘——但 `writeImage` 只投递编码任务（`engine.js:414-422`；`writer.js:47-56`）。
3. **同步拼图/编码成本高**：`composeKind()` 是同步全量重拼（`engine.js:568-590`），`attachRgb` 再同步 `encodePng`（`src/host/service.js:42-51`）。若在 push 回调里直接做，会阻塞抓屏 tick。

### 4.3 实测同步成本（`_probe/agent-code-audit/bench_compose.mjs`，合成 512×288 帧，Node v24.18.0）

| 帧数 → 档位 | composeSheet | encodePng(level 3) | 同步合计 | RGB 内存 |
| --- | --- | --- | --- | --- |
| 1 → single 800×450（233 tok） | 2.44 ms | 7.08 ms | **≈9.5 ms** | 1.03 MiB |
| 4 → quad 1050×630（392 tok） | 5.19 ms | 19.78 ms | **≈25.0 ms** | 1.89 MiB |
| 8 → octet 1260×756（560 tok） | 4.72 ms | 26.03 ms | **≈30.7 ms** | 2.73 MiB |

参考：15Hz 的 tick 预算是 66.7ms；30Hz 是 33.3ms。**8 帧拼图会吃掉一个 30Hz tick 的全部预算**，且 `encodePng` 是主线程同步 deflate。结论：pump 必须与采集循环解耦（队列 + 去抖/合并 + 异步编码），不能在 push 回调里同步拼图。

### 4.4 可行性判断

- 数据源够用：`eventRing` 里的 512px 帧可以直接喂 `composeSheet`（`engine.js:575-582`），token 估算也有现成的 `planSheet`（`src/algo/tiers.js:32-55`）。
- 缺的不是拼图能力，而是：**投递状态机**（水位/未读/合并窗口）、**token 预算**（按会话累计而非单张）、**异步化**（worker 编码）、**触发时机**（何时允许打断模型）。
- 这些属于目标架构，见 `03-target-architecture.md`；本文只给约束：不要把同步 compose 塞进 `bus.emit` 回调；不要假设 push 时文件已落盘。

## 5. offload 对注入的适配性

**已具备（可直接复用）：**
- `IMAGE_CARRYING = {'user/message','tool/result'}`（`src/host/offload.js:27`）——注入图若走 `user/message` 天然在覆盖范围内。
- 规划器从 `data.message.content ?? data.content` 读图（`offload.js:95`），按 depth-first 编号（`:30-47`），并用 `replaySurface` 处理 append/replace（`:50-67`）、`alreadyOffloaded` 去重（`:70-82`）。
- 应用端 `session.append('image/offload', {targets})` + `sessions.flush`（`offload.js:137-151`），是宿主认可的唯一省略写法。

**缺口：**
1. **触发点只有工具交付**：`setDeliveryHook` 的回调由 `notifyDelivery()` 触发（`index.js:146-161`），而 `notifyDelivery` 只在 handler 里调用（`handlers.js:88`、`:264`、`:281`）。注入路径必须自己调用它，或改成事件驱动，否则 offload 永不运行。
2. **keep 是全局的**：规划器把所有 `user/message` + `tool/result` 的图放进同一个 LRU（`offload.js:93-106`），保留最新 `keep=3` 张。持续注入会让 RTA 帧挤进这个队列——既可能省略用户自己上传的图，也可能被用户的图挤掉。需要把「注入图」与「用户图」分账，或明确接受统一 LRU。
3. **无注入侧计量**：现在没有「本会话已注入多少帧/多少 token」的计数，`planOffload` 只按张数不按字节预算（`offload.js:107-108` 只统计 bytes，不用来决策）。

## 6. config 与生命周期

### 6.1 配置面（`src/config.js`）

| 键 | 默认值 | 消费方 | 备注 |
| --- | --- | --- | --- |
| `capture.*`（13 项） | 见 `config.js:13-27` | 引擎（`config.js:75-80`） | 唯一完整可配的子集 |
| `retentionHours` | 24 | 引擎 | — |
| `imageTrigger` / `imageKeep` | 8 / 3 | offload（`index.js:111-114`） | 只对工具交付生效 |
| `maxSheetTokens` | 560 | `rta_look` 默认（`handlers.js:152-183`） | 不进引擎 |
| `summonPrompt` | 固定中文提示（`config.js:32`） | summon（`runtime.js:45`） | 内容仍是「去调 rta_look」 |
| `summonCooldownMs` | 1500 | summon | — |
| **注入相关** | **不存在** | — | 无 enabled/inject/interval/merge/budget/mode 任何键 |
| `maxEventsInMemory` / `selection` | 12 / `{}` | 引擎硬编码（`engine.js:47`、`:49`） | **配置层不可达**（`config.js:57`、`:75-80`） |

### 6.2 生命周期现状

| 阶段 | 现在的行为 | 对上下文可见？ |
| --- | --- | --- |
| 插件 apply/启用 | 注册 9 工具、wire offload、`watchForSummon()`、logger.info（`index.js:53-79`） | ✗ |
| 会话创建/切换 | 只记 `lastSessionId`（`index.js:101-104`；`runtime.js:52-54`） | ✗ |
| 采集 start | `rta_start`/`rta_look`/Ctrl+Alt（idle）→ 只 emit 'start'（`engine.js:231`） | ✗ |
| 采集中的事件 | push（无消费者）、写盘/index（`engine.js:370-392`） | ✗ |
| 采集 stop | `rta_stop`/Ctrl+Tab/dispose → emit 'stop'（`engine.js:256`） | ✗ |
| 插件 dispose | `engine.stop(reason:'plugin-dispose')`（`runtime.js:106-116`） | ✗ |

### 6.3 目标会话绑定缺口

pump 需要知道「注入给谁」。现在 `agent` 只在工具被调用时被记住（`src/tools/index.js:36-38` → `summon.js:35-41`），`lastSessionId` 只在 `session/event` 时更新（`index.js:101-104`）。冷启动后、用户没调用过任何 RTA 工具时，runtime 没有 agent 可推——`summon` 会返回 `{ok:false,reason:'no-agent'}`（`summon.js:72-73`，`plugin.test.mjs:154-158` 已覆盖）。持续注入必须解决「当前会话」的解析时机，可能依赖宿主的 session/agent 服务（见 §9）。

## 7. 测试与 README 事实核查

### 7.1 实跑结果（Node v24.18.0）

- `node --test test/*.test.mjs`：在本沙箱内失败——test runner 为每个文件 `spawn` 子进程，被沙箱拒绝（`EPERM: spawn`，`errno -4048`）。**不是测试失败，是执行环境限制。**
- 逐文件直接跑（`node test/<file>.test.mjs`，node:test 在进程内执行）：**24 个测试全部通过，0 失败**。

| 文件 | 测试数 | 结果 | 耗时 |
| --- | --- | --- | --- |
| `test/algo.test.mjs` | 10 | ✔ 10 pass | 24.2 ms |
| `test/engine.test.mjs` | 6 | ✔ 6 pass | 677.9 ms |
| `test/plugin.test.mjs` | 6 | ✔ 6 pass | 22.1 ms |
| `test/store.test.mjs` | 2 | ✔ 2 pass | 32.9 ms |
| **合计** | **24** | **24 pass / 0 fail** | — |

### 7.2 覆盖矩阵

| 路径 | 有测试？ | 证据 |
| --- | --- | --- |
| 采集→打分→选择→落盘/index | ✓ | `engine.test.mjs:64-142` |
| 热键：圈画 / 退出 / Esc | ✓ | `engine.test.mjs:144-219` |
| 原生分辨率 event 帧 | ✓ | `engine.test.mjs:222-246` |
| 拼图/token 档位/打包 | ✓ | `algo.test.mjs:96-133` |
| offload 规划（tool/result） | ✓ | `plugin.test.mjs:82-106` |
| summon 纯文本 notice | ✓ | `plugin.test.mjs:121-163` |
| **push → 注入** | **✗** | 无 |
| **start/stop 注入宣告** | **✗** | 无 |
| **投递节流/合并/水位/预算** | **✗** | 无 |
| **注入图进入 user/message 后被 offload** | **✗** | 无 |
| **引擎 `summon` 事件** | **✗（假覆盖）** | `engine.test.mjs:183` 订阅不存在的事件 |

### 7.3 README 事实核对

| README 说法 | 实际 | 结论 |
| --- | --- | --- |
| `:5` 22 个单测（10 算法 + 5 引擎 + 6 插件）全过 | 24 个：10 + 6 + 6 + 2；且 10+5+6=21 ≠ 22 | ✗ 数字与拆分都错 |
| `:113` 19 个离线测试 | 24 | ✗ |
| `:45` 8 个模型工具 | 9（`spec.js:48-58`；`plugin.test.mjs:53` 断言 9） | ✗ |
| `:79` 表格行 | `rta_sessions` 重复两次 | ✗ |
| `:43` 目录说明 | `native/gdiplus.js` 重复 | ✗ |
| `:18` 只有通过筛选的画面才进上下文 | 只有 `rta_look` 主动要才进（`spec.js:63-65`） | ✗ 原则与实现冲突 |
| `:133` Ctrl+Alt 召唤一次并持续启用 | idle：启动采集 + 一条文本；running：无操作（`engine.js:446-447`） | △ 表述掩盖了「运行中无通路」 |

## 8. 复用资产清单（改造成注入通道时可直接用）

| 资产 | 位置 | 可复用部分 | 缺口/改造点 |
| --- | --- | --- | --- |
| 事件总线 + push | `engine.js:384-391`、`:673-685` | 触发点、seq/kind/时间、`on/off` | 载荷补 `rgb`/`win`/缩略图，或定义「从 eventRing 取」的契约 |
| `eventRing` | `engine.js:389-390`、`:684` | 12 帧 512px 带像素，可直接拼图 | 容量不可配（D10/D11），无投递水位 |
| `composeKind` / `composeRecent` | `engine.js:560-590` | 过滤、取最近 N、拼图、轻量 frames 索引 | 同步成本高（§4.3），需异步化 |
| 拼图与 token 档位 | `algo/pack.js:119-158`、`algo/tiers.js:16-55` | 纯 JS 拼图；42px 网格 token 估算 | 无（可直接复用） |
| PNG 编码 worker | `store/writer.js:10-72` | 异步写盘、背压 64 帧 | 只写文件，不返回可注入字节；可另建编码任务 |
| 附件服务 | `host/service.js:42-61` | `attachments.saveImage` 产出 image block | 不写会话；需宿主注入接口（§9） |
| offload 规划/应用 | `host/offload.js:27-151` | 支持 user/message、replaySurface、targets 分组 | 触发点、keep 分账（§5） |
| summon 文本通道 | `host/summon.js:53-87` | 已证明 plugin notice 可推进会话（V4 source 约定，`:58-60`） | 只支持 text；需确认 image block 是否合法 |
| session 绑定 | `index.js:101-104`；`runtime.js:52-54`；`tools/index.js:36-38` | `session/event` 与 agent 记忆 | 冷启动无 agent；需宿主 session 解析 |
| 测试脚手架 | `test/engine.test.mjs` 的 `fakeSource/startEngine`；`_probe/cold_e2e.mjs`（假 ctx 跑真实 apply） | 可复用来写注入路径测试 | 缺 pump 的假宿主（agent/session） |
| 热键注入 probe | `_probe/summon_e2e.mjs:27-54` | 用 `keybd_event` 真按键驱动 | 路径 2 假设的 engine 'summon' 事件不存在（D14） |

## 9. 待 host-contract 核实（交由 `01-host-injection-contract.md`，本文不展开）

1. **图片能否作为插件消息注入**：`agent.followup/steer` 的 `content` 是否接受 `{type:'image',attachment}`；还是必须走 `session.append('user/message', …)` 之类的事件级 API（现在只有 `image/offload` 一种 append 先例，`offload.js:141`）。
2. **注入的回合语义**：`running` 时 `steer` 是否打断当前回合；`idle` 时 `followup` 是否会启动一个新回合；能否保证「不打断用户正在进行的操作」。
3. **投递时机信号**：是否有「模型空闲/回合结束/用户停顿」可订阅的钩子（现在只有 `session/event`，`index.js:101`；以及 `ctx.on`）。
4. **token 计量**：插件能否读到当前会话上下文占用/预算，用于注入节流（现在完全没有数据源）。
5. **`image/offload` 的 target 合法性**：注入产生的 `user/message` 图，其 `seq` 是否可被插件自己创建的 offload targets 引用；宿主的 attachments-gc 是否与插件规划冲突。

## 附录：审计证据与可复现命令

- 全量静态证据：`src/` 28 个 JS 文件、`bin/` 4 个、`test/` 4 个、`README.md`；关键行已逐条标注。
- 测试：`for f in test/*.test.mjs; do node "$f"; done`（本沙箱下 `node --test` 因 spawn EPERM 不可用；逐文件跑 24/24 pass）。
- 基准：`node _probe/agent-code-audit/bench_compose.mjs`（1/4/8 帧 compose + encode 的 ms 值，见 §4.3）。
- 未改动产品代码；`src/`、`test/`、`README.md` 保持原样。
