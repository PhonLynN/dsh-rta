# 01 · 宿主「持续注入」契约核实

> 路径缩写：`<H>` = `_probe/asar_out/dsh/node_modules/@deepseek-ai/`
> 核实方式：只读宿主解包 bundle（每包一个 `lib/index.js`）。凡标「推断」= 由代码逻辑推出但未运行验证；「[待核实]」= 需执行器或更多包确认。本次 `ops_bash` 因宿主执行器并发故障不可用，结论均来自源码静态核实。

## 结论摘要

1. **宿主具备两条真正的「持续注入」通道，但没有「空闲时主动推进上下文」的原语**：所有注入都发生在 turn/step 边界。`agent.inject()` 不唤醒（`<H>dsh-agent-loop/lib/index.js:564-578`），消息只在「下一次 turn 的 pre-step」被 claim；pre-step 监听器只在已有 turn 内被调用。
2. **Q1（pre-step append-only、不唤醒）**：成立。`dsh-time-context` 的真实路径是 `ctx.on("agent/pre-step", async (payload, next) => { const decision = await next(); ... return {...decision, messages:[...decision.messages, createUserMessage(...)]}; }, {prepend:true})`；只改 `decision.messages`，不调用任何 wake。宿主 `preStep` 的 default 即 `{kind:"enter", messages: claimed}`（`dsh-agent-loop:685-697`）。
3. **Q2（持久化/顺序/每步可见）**：成立且不可撤销。step 首次尝试时把 `decision.messages` 逐条 `session.append("user/message", message, {surfaceOp:"append"})`（`dsh-agent-loop:860-866`），此后每次请求都从完整历史重放 → 注入一条即永久计入后续所有请求、token 与压缩摘要；`runtime-context` 是宿主自用特例。
4. **Q3（source.form 的 snapshot/summary）**：`snapshot` 合法且是 UI 认识的 form；`summary` 只被 `notice` 折叠行使用，不是通用必填；v4 准入只禁 `kind === "plugin"`，运行期 `append` 无 message schema 校验（只有 JSON 可序列化 + surfaceOp 约束）。
5. **Q4（图片注入）**：`{type:"image", attachment:<ref>}` 合法（RTA 工具输出已用同形状，`src/tools/spec.js:40-45`）；ref 来自 `attachments.saveImage({data,mediaType,name})`；注入图片进入 `user/message` 后**可以**被 `image/offload` 命中（该机制只处理 `user/message`/`tool/result`），超限时自动「offload 最旧图片 + retry」。
6. **Q5（idle inject）**：不唤醒、不消费、**无上限堆积**；pending 通过 `agent/inbox/spliced` 持久化并在 resume 后恢复；插件可用 `agent.inbox.replace/remove/clear/prepend/splice` 合并（生产插件 `dsh-agent-instructions` 已在用）；`cancel()` 默认清空 inbox。空闲落盘需显式 `sessions.flush`（`dsh-schedule` 先例）。
7. **额外发现（对 03 目标架构重要）**：宿主还有一条**易失、每步重算、仅变化时落一条消息**的动态文本通道：`ctx.systemPrompt.context({name, order, text})` → 拼成 `runtime-context` 快照（source.kind=`runtime-context`, form=`snapshot`）。`dsh-agent-loop` 把它作为一条 user/message 记录，内容不变则不新增。它只支持文本，但最适合「屏幕状态摘要」的持续感知；`dsh-harness-dev-context`、`dsh-sandbox-policy`、`dsh-subagent` 都在用。
8. 结论：RTA 的「持续注入」应做成 **systemPrompt.context（文本感知，低成本）+ pre-step 追加（带图快照，强节流）** 的组合；`inject` 仅用于「不唤醒的排队通知」并配合 inbox 合并/清理；不要用 followup 自驱唤醒（成本与 UI 噪音，需 wakeBudget，`dsh-tool-jobs:345-357` 已有先例）。

## API 事实表（含证据）

| 能力 | 入口/语义 | 证据 |
|---|---|---|
| 注入（不唤醒） | `agent.inject(m)` → `send(m,"next-step",false)` | `dsh-agent-loop:570-578`；`send` 见 `564-569` |
| 下一 turn 排队并按需唤醒 | `followup(m)` → `send(m,"next-turn",true)` | `dsh-agent-loop:570-573` |
| 下一步并唤醒 | `steer(m)` → `send(m,"next-step",true)`；abort 中收到改投 next-turn | `dsh-agent-loop:564-569,574-576` |
| inbox 可见面 | `nextTurn/nextStep/hasPending/clear/claim/append/prepend/replace/remove/splice/locate` 全公开 | `dsh-agent-loop:70-203`（replace 134-139，remove 145-150） |
| claim 语义 | 一次取走**全部** next-step + 至多 1 条 next-turn，逐条 emit `agent/inbox/claimed` | `dsh-agent-loop:103-111` |
| inbox 持久化 | `session.append("agent/inbox/spliced", …)`；resume 重放；同 id 双 pending 抛错 | `dsh-agent-loop:20-56,174-202` |
| pre-step 钩子 | `ctx.on("agent/pre-step", async (payload,next)=>…)`；payload `{messages,turn,step,signal,modelSelection}`；返回 `{kind:"enter",messages}` 或 `{kind:"reject"}` | `dsh-agent-loop:666-713` |
| step 起点 | `const step = phase.step+1` → **step 从 1 开始**；首步 target=next-turn，之后 next-step | `dsh-agent-loop:741-745,298` |
| turn 结束条件 | `turnEnds && inbox.nextStep.length===0` 才停；否则继续 step（pending next-step 会延长 turn） | `dsh-agent-loop:790-797` |
| 状态 | `agent.status==="idle"\|"running"` | `dsh-agent-loop:554-556` |
| 取消 | `cancel(cause,{keepInbox})`；默认清空 inbox | `dsh-agent-loop:579-585` |
| 动态文本上下文 | `ctx.systemPrompt.context({name,order,text})`；text 可为 `(context)=>string`，context 含 `{agent,scope,signal,modelSelection,toolSet}` | `<H>dsh-system-prompt/lib/index.js:281-283,186-192,358-368`；`<H>dsh-agent/lib/index.js:407-412` |
| runtime-context 投影 | `joinContextSections` 拼接；仅在文本变化时产生消息，source `{kind:"runtime-context", form:"snapshot", sections}` | `<H>dsh-system-prompt/lib/index.js:138-141`；`dsh-agent-loop:333-348` |
| 插件持久状态 | `ctx.sessionProjections.register({key,stateVersion,stateSchema,init,apply})` → `stateOf(session)` | `dsh-time-context:202-255` |
| 图片保存 | `attachments.saveImage({data,mediaType,name}) → ref`；`saveImages` 批量校验 | `<H>dsh-attachment/lib/index.js:230-246` |
| 图片省略 | `session.append("image/offload",{targets:[{seq,imageIndexes}]})`，只对 user/message、tool/result | `<H>dsh-compaction-image-offload/lib/index.js:14-44` |
| 落盘 | `ctx.sessions.flush(agent.session)`（idle 注入场景先例） | `<H>dsh-schedule/lib/index.js:2555-2563` |

## 注入消息契约（Q3）

**运行期不校验消息形状**，只要满足 session append 的硬约束：

- `<H>dsh-session/lib/index.js:1524-1546`：`append(type,data)` 先 `snapshotJsonValue(data)`，不可序列化即抛 `session event "<type>" carries non-JSON-serializable data`；随后 `deepFreeze({type,seq,time,data,...})` 并 `validateSessionEventData`。surface 事件必须带 `surfaceOp:"append"`（`dsh-session:298-312`）。
- v4 准入口径（`<H>dsh-session-format-v3-to-v4/lib/index.js:126`）：`kind` 必须是非空字符串且 `kind !== "plugin"`，否则抛 `format v4 message requires a producer-owned source kind`；普通 `user/message` 事件只 `record(data.source)`（`814-818`），不校验 form/summary/sections。
- 第三方 kind 约定仍是 `plugin:<id>`（`v3-to-v4:86-107` 的 `producerKind`）；RTA 现用 `plugin:dsh-rta` 正确。

**UI 侧只对「渲染漂亮」有要求**（不是数据校验）：

- `KNOWN_FORMS = ["instructions","catalog","snapshot","notice","relay","recall"]`（`<H>dsh-client-ui-chat/lib/client.js:9807-9815`）；未知/缺失 form → opaque 正文，不报错。
- `snapshot` 需要 `source.sections` 为非空数组且每项 `{name:非空string, text:string}`（`client.js:5478-5494`），否则该分支退化 opaque。
- `notice` 的折叠摘要读非空 `source.summary`（`client.js:5651-5655`）；正文仍来自 content。
- 结论：RTA 注入消息推荐 `source:{kind:"plugin:dsh-rta", form:"snapshot", sections:[{name,text}]}`；若走「通知」语义用 `form:"notice"` 并必须给 `summary`。`summary` 对 snapshot 非必填。
- 手搓消息时给 `id`（UUID 字符串）与 `role:"user"`；`Object.freeze` 非必须（append 会深快照冻结）。不引入 `@deepseek-ai/dsh-llm` 依赖是安全的（RTA 只把 `dsh-tools` 当 optional peer，`package.json:30-37`）。

## 图片注入（Q4）

1. **形状合法**：`content:[{type:"image", attachment:ref}, {type:"text", text}]`。RTA 工具输出已是同形状（`src/tools/spec.js:40-45`）；用户 prompt 的图片准入也换成该形状（`<H>dsh-attachment/lib/index.js:257-281`）。ref 由 `attachments.saveImage` 产生，含 `attachmentId/mediaType/width/height/bytes`（`dsh-compaction-image-offload:97-121` 与 `dsh-llm` 使用）。
2. **saveImage 契约**：RTA 现有调用 `saveImage.call(attachments,{data:png,mediaType:"image/png",name})`（`src/host/service.js:42-51`，注释说明新版内部读 `this.compression`，必须 `.call`）。`attachments` 需软探测（RTA `serviceOf` 已做）。
3. **准入校验不覆盖注入路径**：`maxImagesPerMessage/maxMessageImageBytes/mediaTypes` 只在 `admitPromptContent`（Host prompt）与 `saveImages` 批量校验（`dsh-attachment:230-246`）；`agent.inject`/pre-step 不过该函数（推断），数量/字节上限不会被宿主提前拦，需 RTA 自己节流。
4. **可被 offload 命中**：`image/offload` 投影只接受 `user/message`、`tool/result`（`dsh-compaction-image-offload:14-44`），注入图进入 user/message 后满足；投影把选中 block 标 `offloaded:true`（`55-84`），请求侧换成文本占位（`<H>dsh-llm/lib/index.js:581-585,674-682`），text-only 模型换成 `textOnlyImageText`（`558-560,745-754`）。触发是「请求失败 `IMAGE_OFFLOAD_REQUIRED` → offload 最旧 + retry」（`dsh-compaction-image-offload:141-145`），不是每步主动清理。
5. **成本**：图片 ref 与事件永久留历史；offload 只减少后续请求图片数，不删事件/attachment。持续每步塞图必然抬高 token、压缩压力与 offload 次数。可行策略：只在「画面显著变化 + 间隔达标」时注入 1 张，其余用文本摘要；旧图交给宿主/RTA 自己的 offload plan（`src/host/offload.js` 已有 `planOffloadWithTrigger` 逻辑可复用）。

## 两条（实为四条）通道对比（Q1/Q2/Q5）

| 通道 | 唤醒 | 生效时机 | 持久化形态 | 空闲行为 | 历史增长 | 图片 | 适用 |
|---|---|---|---|---|---|---|---|
| `agent.inject` | 否 | 下次 turn 首个 pre-step claim | `user/message` | 堆积（无上限，resume 仍在） | 每条一条 | 可 | 不紧急的排队通知 |
| `followup`/`steer` | **是** | 立即起 turn / 下一步 | `user/message` | 起新 turn（自驱成本） | 每条一条 | 可 | 召唤、需立即反应 |
| `agent/pre-step` 追加 | 否 | 当前 turn 的下一次 step | `user/message`（首次尝试落盘） | **不运行**（无 turn 无 step） | 每个 step 每条 | 可 | 每步/每轮持续快照（time-context、tmux 范式） |
| `ctx.systemPrompt.context` | 否 | 每次 assemble（每步） | `user/message`（`runtime-context`，**仅变化时**新增） | 不运行 | 变化时一条 | 仅文本 | 低成本持续文本感知 |
| 工具结果 `additionalContexts` | 否 | 工具执行后塞进 next-step inbox | 随 tool/result | 不运行 | 每次工具结果 | 可 | 工具主动附带上下文（`agent-loop:972,976`） |

**并存与顺序**：可以并存（`dsh-agent-instructions:1422-1439,1480-1498` 同时用 inbox 合并 + pre-step 插入；RTA 现有 summon 用 steer/followup）。pre-step 里可 `prepend`（tmux 把快照放在 claimed 之前，`<H>dsh-tmux-context/lib/index.js:2279-2313`）或 `toSpliced` 插到 claimed 之后（agent-instructions）；也可丢弃/替换 `decision.messages`（claimed 已从 inbox 移除，丢弃即消失，需谨慎）。

**Q5 细节**：`inject` 进 `next-step`；idle 时无 `pre-step`，因此不消费、不唤醒；消息经 `agent/inbox/spliced` 持久化（`dsh-agent-loop:20-56`），resume 后仍 pending；无长度上限（schema 仅 `z.array(z.custom())`）。只有在「下个 turn 首步」一次性 claim 并全部落成 `user/message`（可能已过期）。`dsh-schedule` 在 `agent.status==="idle"` 时显式 `sessions.flush` 保证落盘（`<H>dsh-schedule/lib/index.js:2555-2563`）——RTA 若 idle 注入应照做。`cancel` 默认清空 inbox，pending 通知会丢（可传 `{keepInbox:true}`）。

## 渲染与派生影响（次要/部分[待核实]）

- **Chat**：`source.kind !== "user"` 的 user/message 渲染为「上下文注入」折叠行，label 取 `source.kind`（默认 `plugin:dsh-rta`），`snapshot` 展开显示 sections，`notice` 折叠行带 summary（`client.js:5747-5812,9831-9856`）。默认折叠；未被 claim 的 next-turn 消息会渲染成 turn-trigger notice（waking）。
- **会话标题**：只取 `source.kind === "user"` 的 user/message（`<H>dsh-session-title/lib/index.js:90-98,387-394`）→ 注入消息不参与标题；纯注入会话在首个用户输入前无标题（推断）。
- **活动/输入派生**：`api-session/activity`、`lastPromptAt`、turn outline、sdk `input` 标志均只认 `source.kind === "user"`（`dsh-api-session-controller:3843,2655`；`dsh-session-turn-outline:98`；`dsh-sdk-jsonrpc-server:48`）→ 注入不伪造「用户说过话」。
- **压缩**：`buildSummarizationInput` 取被压缩区间内**所有** surface 消息（含注入 user/message），不按 source 过滤（`<H>dsh-compaction-basic/lib/index.js:695-703`）；摘要输出禁图（`370-372`）。注入内容会进 checkpoint 摘要，放大压缩成本。
- **token**：`estimateMessage = estimateContent(content)+4`，图片按结构计价；压力=`inputTokens+cacheRead+cacheWrite`（`<H>dsh-token-meter/lib/index.js:73-75,327-331,368`）。每步注入必然抬高 input 与上下文压力；systemPrompt.context 路径仅文本变化时新增（缓存友好，`dsh-sandbox-policy:53-56` 注释称其为 cache-safe snapshot）。
- **[待核实]** `runtime-context` 多条快照是否在请求投影/UI 中被隐藏；需读 `dsh-session-projection` 与请求装配路径。

## 先例对照表

| 插件 | 通道 | 唤醒/节流 | 关键做法 | 证据 |
|---|---|---|---|---|
| dsh-time-context | pre-step 追加 | 10min 节流；任意 step | sessionProjections 存 lastInjectionTime；snapshot+sections | `<H>dsh-time-context/lib/index.js:202-282` |
| dsh-tmux-context | pre-step 追加 | 仅 step===1；状态不变不注入；可选时间下限 | 状态串存 projection；无 shell 时 no-op | `<H>dsh-tmux-context/lib/index.js:2263-2313` |
| dsh-tool-jobs | inject + followup | wakeBudget，人类输入重置 | 空闲有限次唤醒，超预算退化 inject | `<H>dsh-tool-jobs/lib/index.js:262-264,345-357` |
| dsh-agent-instructions | inbox + pre-step | 合并去重、插到 claimed 后 | `inbox.remove/replace/prepend` | `<H>dsh-agent-instructions/lib/index.js:1422-1439,1480-1498` |
| dsh-schedule | inject | idle 时 flush | 通知不唤醒 | `<H>dsh-schedule/lib/index.js:2555-2563` |
| dsh-harness-dev-context | systemPrompt.context | 每步 assemble；值变才落消息 | projection 保留 admitted 值 | `<H>dsh-harness-dev-context/lib/index.js:17-21,105-109` |
| dsh-sandbox-policy | systemPrompt.context | cache-safe snapshot | 不重写稳定 system prompt | `<H>dsh-sandbox-policy/lib/index.js:53-56` |
| dsh-compaction-image-offload | image/offload 投影 | 请求失败时自动 retry | 只动 user/message、tool/result | `<H>dsh-compaction-image-offload/lib/index.js:14-44,141-145` |
| RTA 现状 | 工具 pull + summon steer/followup | cooldown 1.5s | 无任何每步/持续注入通道 | `src/host/summon.js`；`src/index.js:20-21` |

## 对 RTA 的可行性结论与硬约束

**可行性**
1. 「RTA 启用后持续把数据注入上下文」在宿主侧**可实现**，但只能是「turn/step 触发式」：
   - 文本感知：`ctx.systemPrompt.context({name:"rta:screen", order, text:(context)=>…})`，注册时软探测 `ctx.get("systemPrompt", true)`（或声明 inject，见风险）；返回空串即不贡献。宿主自动做「变化才落消息 + 超期快照自我声明 supersede」，无需 RTA 自己造消息。
   - 带图快照：`agent/pre-step` 里 `await next()` 后追加一条手搓消息/createUserMessage，`source.form:"snapshot"` + `sections`，图片走 `attachments.saveImage`。用 sessionProjections 存「上次注入时间/画面指纹」做节流（tmux 范式）。
2. **RTA 不需要 `inject:['agents']`**：pre-step payload 直接给 `agent`；工具执行上下文 `exec.agent` 已用（`src/tools/index.js:37`）；`sessionController.resolveAgent` 软探测已够（`src/host/runtime.js:31-41`）。保持 `inject:['tools']` 不破坏 headless/缺服务场景（`src/index.js:8` 注释）。**但**若要注册 systemPrompt.context，需 `ctx.get("systemPrompt")` 软探测或加 `inject:["systemPrompt"]`——后者会让插件在无 system-prompt 服务的部署上卡加载（违反 RTA 现有目标），推荐软探测，失败则退化为 pre-step。
3. **子代理过滤**：`agent.session.header.parentSession !== undefined` 或 `header.delegationDepth > 0` 的是子代理会话（`<H>dsh-subagent/lib/index.js:353-356,112-115`）→ 全局注册的 systemPrompt.context 与 pre-step 监听都会覆盖它们，RTA 应只在主会话注入（或按需白名单）。

**硬约束/风险**
- **不能凭空唤醒**：pre-step 不跑在 idle；RTA「屏幕一变就推给模型」若要模型立即反应，只能 followup/steer，会自驱烧 token 并产生 turn-trigger 噪音；应默认「下次模型思考时看到最新状态」，仅召唤用 followup（现状）。
- **注入即历史**：pre-step/inject 的消息一旦落盘不可撤回；只能撤回未 claim 的 inbox 消息（`replace/remove`）。每步注入让 token 线性增长，必须「变化 + 间隔 + 上限」三重节流。
- **waterfall 礼仪**：pre-step 监听器必须 `await next()`，否则 veto 整条链（cordis `waterfall` 语义，`<H>cordis/lib/index.js:893-918`）；`next()` 只能调一次；要判 `decision.kind==="reject"`、`signal.aborted`，建议 `ctx.fiber.assertActive()`（time-context/tmux 均如此）。
- **消息合法底线**：JSON 可序列化、`id` 唯一、`source.kind` 非空且 != `"plugin"`、surface 事件带 `surfaceOp`；UI 想要漂亮就给 `form:"snapshot"`+`sections[{name,text}]`（或 `notice`+`summary`）。
- **图片**：必须在 `user/message`/`tool/result` 才能被 offload 命中；attachments 需软探测；saveImage 必须 `.call`；图片永久计入历史。
- **inbox 语义**：idle inject 会无限堆积且 resume 后仍在；启动时应对自己 kind 的 pending 做清理/合并（`inbox.replace/remove/clear`），idle 时 `flush`；`cancel` 默认清空 inbox（RTA 召唤消息可能被取消丢掉，可接受但需知晓）。
- **turn 延长**：turn 已收尾但 `inbox.nextStep` 非空会继续 step（`dsh-agent-loop:790-797`）——持续 inject 会阻止 turn 正常结束，必须避免每步都 inject。

## 未核实清单（影响/补齐方式）

1. `ctx.get("systemPrompt", true)` 能否在未声明 inject 时安全注册 context；`systemPrompt.context` 的 scope 归属（全局 vs 调用者 ctx）。影响：决定是否需改 RTA `inject` 声明。→ 跑最小插件 / 读 cordis scoped service 实现。
2. `runtime-context` 历史多条快照是否在请求装配/UI 中被折叠或隐藏。影响：systemPrompt.context 的真实 token 成本。→ 读 `dsh-session-projection`、`dsh-llm` 请求装配与 `client-ui-chat` 对 `runtime-context` 的分支。
3. pre-step 是否对 subagent turn 同样触发（推断：是，root 监听全局）。影响：需过滤。→ 跑两个 agent 观察。
4. 图片注入在 provider/供应商侧的实际图片预算与失败码路径（是否与 prompt 图片同待遇）。影响：注入图数量策略。→ 需执行器跑一次真实请求。
5. `attachments.saveImage` 在 daemon/headless 是否可用、压缩行为；服务缺失时的降级。影响：图片注入是否要 feature flag。→ 在目标 profile 实测。
6. `source.kind` 在轨迹导出/搜索索引的兼容性（目前只核实 chat 折叠行与标题/activity）。影响：观感与小问题。→ 读 trajectory/log-export 分支。
