# 宿主注入 API 实测核实（04）

**结论一句话**：两条被动通道都成立且都有生产先例——`systemPrompt.context()`（宿主按文本自动去重、自动追加）与 `agent/pre-step`（每步可追加任意 user/message，宿主不校验、不改写、直接进 `deriveMessages()` 送模型）。RTA 只需 `inject:['tools']`，用 `ctx.inject(['systemPrompt'], scope => …)` 软获取 systemPrompt；屏幕快照按 `{kind:'plugin:dsh-rta', form:'snapshot', sections:[{name,text}]}` 构造即可，`form:'snapshot'` 是**闭合枚举内的合法值**，客户端有专门渲染分支。

- 核实方式：只读解包源码 + 生产插件交叉验证（14 个插件在根 ctx 上共 15 处注册 `agent/pre-step`，另有 dsh-agent 在 agent 私有 ctx 注册 1 处）。
- 证据路径前缀下文统一写作 `<H>` = `C:\Users\PhonLynN\dsh_Workspace\dsh-RTA-dev\_probe\asar_out\dsh\node_modules\@deepseek-ai\`
- 未标注 `[未核实]` 的结论均已用 `file:line` + 原文核对。

---

## 0. 六问速览

| # | 问题 | 结论 | 通道可用性 |
|---|---|---|---|
| 1 | 插件怎么拿 `systemPrompt` | `ctx.get('systemPrompt')` 直接可用（返回服务或 `undefined`，不抛）；更规范是 `ctx.inject(['systemPrompt'], scope => …)`（soft 依赖，随插件 fiber 卸载）。`context({name,order,text,interpolate?,required?})`，返回 disposer。`text` **同步**、参数对象含 `agent/scope/signal/modelSelection/toolSet`，**必须返回 string**（`''` = 本次不贡献）。宿主按"渲染后全文相同"去重，内容不变不落新消息 | ✅ 一等公民 |
| 2 | `agent/pre-step` 契约 | `ctx.on('agent/pre-step', handler, {prepend:true})`；payload = `{agent,messages,turn,step,signal,modelSelection}`；必须 `await next()` 恰好一次（不调用=否决整链）；返回 `await next()` 的 decision 再加 `messages`，`kind:'reject'` 是唯一特殊值。**生产实例 15 处（14 个插件）**，全部从 payload 解构 `agent` | ✅ |
| 3 | 消息形状 | `{id,role:'user',content:[{type:'text',text}],source:{…}}` 合法；`id` 任意**唯一**字符串（无 UUID 校验）。pre-step 与 inject/steer **渲染完全一致**（客户端只看 `source`），差异只在投递时机与队列。sections 字段是 **`name`+`text`**（不是 `id`/`title`）。notice 的 `summary` 只要求非空 string | ✅ |
| 4 | idle / running | pre-step 只在 turn 内（`phase.kind!=='running'` 直接抛）；`agent.inject` 传 `wakeup=false` **绝不唤醒**，但 next-step 队列在**下一次任何 step 边界**被全量 claim（含下次 turn 的第 1 步）；"进入 running"的公开钩子 = `agent/status`（`{agent,status}`），**不存在** `agent/turn-start` | ✅ |
| 5 | 全局监听/子代理 | 根 ctx 的 `ctx.on('agent/pre-step')` 会收到**所有** agent（含 subagent）的事件；用 `agent.session.header.parentSession !== undefined \|\| header.origin === 'subagent'` 识别子代理；用 `agent.session.id` 做单会话绑定（`agent.session.header` 可读 delegationDepth） | ⚠️ 必须自己过滤 |
| 6 | 最小实现 | 见 §7（60 行、零依赖、软探测+异常隔离+dispose）；验证见 §8（纯文件+UI，5 分钟） | ✅ |

---

## 1. Q1 — `systemPrompt` 服务与 `context()` 精确契约

### 1.1 怎么安全拿到（`inject:['tools']` 场景）

`ctx.get(name, strict = true)` 是**不需要 inject 声明**的读取口，返回服务实例或 `undefined`，**不会抛**：

`<H>cordis\lib\index.js:1339-1356`
```js
	 * Read a service from the store without the inject requirement.
	get(name, strict = true) {
		const impl = this._getImpl(name);
		...
```
（`_getImpl` 在"未 provide / provider fiber 非 active"时返回 `undefined`。）

所以 `const sp = ctx.get('systemPrompt'); if (sp === undefined) return;` 就是合法的软探测。**注意**：第二参数是 `strict`（是否检查 provider 处于 active），**不是**"注册开关"——01 文档里 `ctx.get('systemPrompt', true)` 的说法只是默认值，没有任何注册副作用。

更规范、也是生产插件用的写法是 `ctx.inject(deps, callback)`，它等价于起一个只在该依赖可用时才加载的嵌套插件（随父 fiber 卸载）：

`<H>cordis\lib\index.js:1672-1678`
```js
	inject(inject, callback) {
		return this.plugin({
			inject,
			apply: callback,
			name: callback.name
		});
	}
```

生产先例（插件自身 `inject` 里没有 systemPrompt，靠 soft inject 拿到并在**每次请求**取当前 session）：

`<H>dsh-sandbox-policy\lib\index.js:146-155`
```js
		ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.context({
				name: "sandbox:policy",
				order: scope.systemPrompt.getContextOrder("SANDBOX_POLICY"),
				text: (context) => {
					const session = context.agent?.session;
					return session === void 0 ? "" : renderPolicyContext(this.resolve({ session }));
				}
			});
		});
```

**结论**：`ctx.get` 可用于"探测能力是否存在"，`ctx.inject` 用于"注册"。两者都不需要在插件 `inject` 数组里声明 `systemPrompt`。

### 1.2 `context()` 签名

`<H>dsh-system-prompt\lib\index.js:281-284`
```js
	context(context) {
		if (!Number.isFinite(context.order)) throw new TypeError(`prompt context "${context.name}" order must be a finite number`);
		return this.layers.effect(this.ctx, (layer) => layer.contexts.insert(context.name, context), { label: "systemPrompt.context()" });
	}
```

精确字段表：

| 字段 | 类型 | 必填 | 语义 / 证据 |
|---|---|---|---|
| `name` | string | 是 | 段名；同名重复注册抛错，错误文案见 `index.js:205-207`。生产用命名空间风格 `"sandbox:policy"` / `"subagent:delegation"` |
| `order` | **有限 number** | 是 | 非有限数直接 `TypeError`。生产一律 `systemPrompt.getContextOrder("<表名>")`（表见 `index.js:46-54`：WORKING_DIRECTORY 100 / SANDBOX_POLICY 110 / APPROVAL_POLICY 115 / SUBAGENT_DELEGATION 120 / TEAM_IDENTITY 125 / HARNESS_SOURCE 200 / WEB_SURFACE 210）。⚠️ `getContextOrder` 只是查表：`return CONTEXT_ORDERS[name]`（`:272-274`），**表里没有的名字返回 `undefined`** → 直接触发上面的 `TypeError`。RTA 不在表里，所以**必须写字面量**（如 `205`），不要自造名字去查表 |
| `text` | `string \| (context) => string` | 是 | 见 §1.3 |
| `interpolate` | boolean | 否 | 默认 `true` = 解析 `{{var}}`；含 JSON/引号/用户文本时**必须** `false`（生产先例 `<H>dsh-harness-dev-context\lib\index.js:105-110`） |
| `required` | boolean | 否 | `true` 时即使 `suppressRuntimeContext()` 也保留（`index.js:329,334,398,406,411`）。RTA 不需要 |

**返回值 = disposer**：`this.layers.effect(this.ctx, …)` 返回的是 `ctx.effect` 的 disposer（`<H>dsh-scope\lib\index.js:189-217`）。关键是 `this.ctx` 在服务方法里解析为**调用方**的 ctx（`<H>cordis\lib\index.js:125-163` 的 `if (prop === tracker.property) return useSite`），所以**作用域 = 调用方 scope，生命周期 = 调用方 fiber**：插件卸载自动注销，无需手动清理；想提前撤销就调用返回的函数。

### 1.3 `text` 函数：同步、参数对象、返回值

`<H>dsh-system-prompt\lib\index.js:186-192`
```js
function resolveContext(entry, context) {
	return {
		name: entry.name,
		text: typeof entry.text === "function" ? entry.text(context) : entry.text,
		...entry.interpolate !== void 0 ? { interpolate: entry.interpolate } : {}
	};
}
```

- **必须同步**：`resolveContext` 直接 `entry.text(context)`，没有 `await`（`index.js:189`）。返回 Promise 时两种结局都拿不到内容：`interpolate !== false` 会在 `text.indexOf("{{")`（`index.js:161-164`）抛 `text.indexOf is not a function`；`interpolate:false` 则被 `section.text.length > 0` 静默过滤（`index.js:158`，Promise 的 `.length` 是 `undefined`）。所以**必须 `return` 字符串**。
- **必须返回 string**：`undefined/null` 会在 `interpolate`/`.length` 处抛；要"这次不贡献"就返回 `''`，空串会被过滤掉：
  `<H>dsh-system-prompt\lib\index.js:153-157`
  ```js
  	return assembly.contexts.map((context) => ({
  		name: context.name,
  		text: context.interpolate === false ? context.text : interpolate(context, assembly.variables, "context")
  	})).filter((section) => section.text.length > 0);
  ```
- **参数对象字段**（实测有，且不止 01 文档写的四个）：
  - `agent`：当前 agent 对象（`agent.session` → 完整 Session，可拿 `id`/`header`）
  - `scope`：同 `agent`（`assembleContextFor` 返回 `{agent, scope: agent, signal?}`，`<H>dsh-agent\lib\index.js:407-413`）
  - `signal`：AbortSignal
  - `modelSelection`：`{provider, model, …}`
  - `toolSet`：**第一次 assemble 有；`refreshContext` 那次没有**（`<H>dsh-agent-loop\lib\index.js:674-678` 传了 `toolSet`，`:843-846` 没传）。RTA 不要依赖 `toolSet`。
  证据（宿主自己就在用这两个字段）：
  `<H>dsh-agent-loop\lib\index.js:1345-1346`
  ```js
  	ctx.systemPrompt.variable("provider", (context) => context.modelSelection?.provider ?? context.agent?.options.provider);
  	ctx.systemPrompt.variable("model", (context) => context.modelSelection?.model ?? context.agent?.options.model);
  ```
- **调用频次**：每个 step 至少 2 次（`preStep` 的 assemble + `step()` 里 `refreshContext` 重建一次），所以 `text()` 要廉价、幂等、不要有副作用（别在里面发起截图/写盘）。

### 1.4 落盘：只在文本变化时追加，相同则复用

`<H>dsh-agent-loop\lib\index.js:333-348`
```js
	project(current, sections) {
		if (this.retained === void 0 && current.length === 0) return;
		const snapshot = current.length === 0 ? CLEARED : current;
		if (this.retained?.text === snapshot) return;
		return createUserMessage({
			content: [{ type: "text", text: snapshot }],
			source: sections.length === 0 ? { kind: SOURCE } : { kind: SOURCE, form: "snapshot", sections }
		});
	}
```
`retained` 由 `session/event` 事件维护（`:305-326`），启动时扫描最近一条 `source.kind === 'runtime-context'` 的 surface 消息。所以：
- 文本不变 → **不产生任何事件**（不是"复用同一条"，是"什么都不做"）；
- 文本一变 → 追加一条**新的** `user/message`；旧快照仍留在历史里（前缀明确写 "This snapshot supersedes earlier runtime-context snapshots." 提示模型以新为准）；
- 每次变化都新增一条 = **变更频率就是上下文增长速度**。RTA 必须自己做节流（同 turn 内只变一次，或按 `turn`/`step` 门控）。

### 1.5 落的消息长什么样

正文 = 全部 section 用 `\n\n` 拼接，前面加固定前缀：

`<H>dsh-system-prompt\lib\index.js:138-142`
```js
	const body = sections.map((section) => section.text).join("\n\n");
	if (body.length === 0) return "";
	return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`;
```

消息对象（`createUserMessage`，`<H>dsh-llm\lib\index.js:37-42` 会给 `id` 打新 UUID 并 `deepFreeze(structuredClone(...))`）：
```json
{ "id":"<uuid>", "role":"user", "content":[{"type":"text","text":"Current runtime context. …"}],
  "source": { "kind":"runtime-context", "form":"snapshot", "sections":[{"name":"rta:screen","text":"…"}] } }
```
`sections` 里 `name` 就是注册时的 `name`（`index.js:154-156`）。

### 1.6 会不会进模型上下文 / 压缩

- **进**：`user/message` + `surfaceOp:'append'` 是 surface 事件，`deriveMessages()` 把它算进模型可见历史（`<H>dsh-session\lib\index.js:1681-1696`），`buildRequest` 直接把 `session.deriveMessages()` 当 `messages` 发给 `llm.stream`，**没有任何 source.kind 过滤**（`<H>dsh-agent-loop\lib\index.js:1078,1087`）。
- **压缩**：`dsh-compaction` 只对 `source.kind === 'compact-checkpoint'` 特判（`<H>dsh-compaction\lib\index.js:129`），其余一律按 surface 节点区间处理；`dsh-compaction-basic` 的片段选择直接遍历 `session.surface.nodes`（`:413-431`）并 `surfaceOp:{op:'replace',…}`（`:651`）。**摘要输入也确实包含它们**：
  `<H>dsh-compaction-basic\lib\index.js:695-699`
  ```js
  function buildSummarizationInput(session, shadowedSeqs) {
  	const header = session.requestHeader();
  	const head = systemHead(session, session.surface.nodes[0]);
  	const system = head === void 0 ? null : session.deriveEventMessage(head);
  	const regionMessages = shadowedSeqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter((message) => message !== null);
  ```
  → **注入快照会被计入 token、被原文送进摘要器、被 replace 阴影掉**。这是 RTA 必须节流的第二个理由。

### 1.7 多插件如何排序拼接

`<H>dsh-system-prompt\lib\index.js:398`
```js
			contexts: [...contextByName.values()].filter((entry) => !runtimeContextSuppressed || entry.required === true).sort((a, b) => a.order - b.order).map((entry) => resolveContext(entry, context))
```
只按 `order` 排序（稳定排序 ⇒ 同 order 时按注册/加载顺序），随后 `joinContextSections` 用 `\n\n` 连接。**没有 name 兜底排序**。RTA 取一个不与既有表冲突的 order（如 205，位于 HARNESS_SOURCE 200 与 WEB_SURFACE 210 之间）即可。

### 1.8 生命周期

- 注册即在**全局层**（插件 ctx 无 scope tag ⇒ `scopeOf(ctx) === undefined` ⇒ global layer，`<H>dsh-scope\lib\index.js:189-217`）；
- 全局 ⇒ **所有 agent（含 subagent）的每次 assemble 都会调用你的 `text()`**。要单会话，只能在 `text(context)` 里用 `context.agent?.session.id` 判断，返回 `''`；
- 想只作用于某个 agent，用 `agent.ctx.systemPrompt.context(...)`（`index.js:205-207` 的错误提示明确指路）。

### 1.9 真实会话日志样本（本机实测，非推断）

用 `_probe/host-contract/verify-injection.mjs` 解本机 `session.v4.jsonl.zstd`（多帧 zstd，按 seq 去重）得到的真实事件，可直接当"宿主自己也在这么干"的样板：

```
log        ...\sessions\--C-Users-PhonLynN-dsh_Workspace-dsh-RTA-dev--\session-a3038ba9-...\session.v4.jsonl.zstd
events     460（解出 275 帧）  turns 2（首个 turn=1）
injected   4 = plugin:dsh-rta 0 + runtime-context 1 + 其他 3
  #9  runtime-context form=snapshot order=[working-directory:current → sandbox:policy → approval:policy → team:identity → harness:source → app:web-surface]
  #10 skill-catalog form=catalog
  #11 time-context form=snapshot sections=[time-context]
  #417 time-context form=snapshot sections=[time-context]
```

可以用它验证本报告的四个关键结论：

1. **消息形状**：`runtime-context` 的 `source` 就是 `{kind, form:'snapshot', sections:[{name,text}…]}`，`name` 是注册名（`working-directory:current`、`sandbox:policy`…），与 §1.5 完全一致。
2. **排序**：`order=[100 → 110 → 115 → 125 → 200 → 210]`，正是 `CONTEXT_ORDERS` 的升序（§1.7）。
3. **去重**：该会话跑了 **54 个 step、2 个 turn**，`runtime-context` 只落了 **1 条**（文本没变就不再追加）——§1.4 的"按文本变化去重"是实测事实。
4. **节流先例**：`time-context`（每 turn 追加 snapshot 的生产插件）在 54 个 step 里只注入了 **2 次**（`#11` 在 turn1/step1，`#417` 在 turn2/step50），说明生产实现靠"时间间隔 + 内容不变"双重门控，不是每步都写。RTA 必须照此办理。

另外，一个 `delegationDepth=1` 的子代理会话（`--C-Users-PhonLynN-dsh_Workspace-dsh-RTA-dev--\2c0f928f-...`）里出现了：

```
  #9 runtime-context order=[working-directory:current → sandbox:policy → approval:policy → tool:subagent:depth → tool:subagent_fork:depth → subagent:delegation → harness:source → app:web-surface]
```

即**全局注册的 context 原样出现在子代理会话里**（含 `subagent:delegation`）——这是 §5.1"全局监听会命中子代理"的实证，而不是推断。

---

## 2. Q2 — `agent/pre-step` 契约

### 2.1 注册与 `{prepend:true}`

`<H>cordis\lib\index.js:919-929`（注册表）+ `:903-918`（waterfall）：
```js
		const method = options.prepend ? "unshift" : "push";
```
```js
	 * a listener that does not call `next()` vetoes the rest of the chain, including the built-in behavior
```
即：`prepend:true` = `unshift` = **最外层**，最先执行、`await next()` 后最后加工 decision。生产里所有"追加消息"的插件都用它（`<H>dsh-time-context\lib\index.js:282`、`<H>dsh-agent\lib\index.js:243`）。第三参数也接受布尔简写（`if (typeof options !== "object") options = { prepend: options }`，`:951-959`）。

### 2.2 payload 精确字段

发射点：`<H>dsh-agent-loop\lib\index.js:685`
```js
			const decision = await this.dispatch.waterfall("agent/pre-step", {
```
实参（同处 666-713 内）为 `{ messages: claimed, ...position, signal, modelSelection: selection }`，`position = {turn, step}`；`this.dispatch = agentEvents(loopCtx, this)` 会把 `agent` 融进**每个** payload：

`<H>dsh-agent\lib\index.js:358-388`
```js
	const fused = (payload) => ({ ...payload, agent });
```

| 字段 | 值 |
|---|---|
| `agent` | 当前 agent（**一定有**） |
| `messages` | 本步从 inbox claim 到的消息数组（可能是空数组） |
| `turn` / `step` | 从 **1** 开始（`turn = phase.turn + 1`；`step = phase.step + 1`，`<H>dsh-agent-loop\lib\index.js:727,745`） |
| `signal` | AbortSignal（每步一个） |
| `modelSelection` | `{provider, model, …}` |

### 2.3 `next()` 规则

- **必须恰好一次**：`if (called) throw new Error("next() called multiple times")`（`<H>cordis\lib\index.js:903-918`）。
- **不调用 = 否决**：整条链（含宿主内建）都不执行，你的返回值就是最终 decision。生产实例：`<H>dsh-api-session-controller\lib\index.js:3265` 直接 `Promise.resolve({ kind: "reject" })` 否决归档会话。RTA **不要**用这条路（会打断宿主默认行为）。
- 标准写法 = `const decision = await next()` → 判 `reject`/`aborted` → `return {...decision, messages:[...decision.messages, msg]}`（15 处生产注册一致）。

### 2.4 decision 允许的形状

- `kind:'reject'` 是**唯一**被特判的值（`dsh-agent-loop:699`）；其余任何 `kind` 都按 enter 处理。
- decision 的其他字段被原样带到 `step()`：`return { ...decision, assembly, selection, toolSet }`（`:703-708`）。`startsRequestSeries` 会被读（`:849`）；`selection`/`toolSet` 会被解引用（`:787`、`:842`）。
- ⚠️ **绝不能返回自造的 `{kind:'enter', messages:[]}`**：`toolSet`/`assembly`/`selection` 会变成 `undefined`，随后 `decision.toolSet.dispose()`（`:787`）抛 TypeError。唯一安全做法是**基于 `await next()` 的返回值扩展**。
- `decision.messages` 的每一项必须带 `message.source.kind`（`:860` 无条件解引用），否则 TypeError。

### 2.5 追加的消息会被再加工/校验吗

不会。commit 循环（`<H>dsh-agent-loop\lib\index.js:859-866`）对非 `runtime-context` 消息只做一件事：

```js
			if (firstAttempt) for (const message of decision.messages) if (message.source.kind === "runtime-context") {
				...
			} else this.session.append("user/message", message, { surfaceOp: "append" });
```

即 `session.append('user/message', message, {surfaceOp:'append'})`，**没有 schema 校验、没有字段补全、没有 content 重写**（`validateSessionEventData` 只校验 developer/tool-change/request-header/tool-result，`<H>dsh-session\lib\index.js:242-277`）。两个副作用要知道：
1. 你**手写的 `source.kind:'runtime-context'` 消息会被丢弃**，替换成宿主自己 project 出来的那条；
2. 重试（`firstAttempt=false`）时 `decision.messages` 不会重复落盘（幂等）。

### 2.6 payload 里没有 agent 时怎么办

不存在这种情况——`agentEvents` 无条件 fuse `agent`。若真拿不到（例如别的事件），可用 `ctx.get('agents')` 注册表（`AgentRegistry`，`<H>dsh-agent\lib\index.js:438`；生产用法 `<H>dsh-subagent\lib\index.js:1744-1750` 按 `session.header.parentSession` 沿链查找）。**从 `messages` 反推 agent 不可行**，不要这么做。

### 2.7 生产实例（用户要求的那一个 —— 实际有 15 处）

15 处注册全部从 payload 解构 `agent`；其中 14 处在**根 ctx**，dsh-agent 那一处在 agent 私有 ctx（`agentCtx`）：

| 插件 | 位置 | 签名 |
|---|---|---|
| dsh-agent（installModelSelection） | `dsh-agent\lib\index.js:232` | `async ({agent, messages, signal, step, modelSelection}, next)` + `{prepend:true}` |
| dsh-time-context | `dsh-time-context\lib\index.js:249` | `async ({agent, turn, step, signal}, next)` + `{prepend:true}` |
| dsh-tmux-context | `dsh-tmux-context\lib\index.js:2279` | `async ({agent, turn, step, signal}, next)` |
| dsh-agent-instructions | `dsh-agent-instructions\lib\index.js:1480` | `async ({agent, messages, step, signal}, next)` |
| dsh-action-cards | `dsh-action-cards\lib\index.js:394` | `async ({agent, signal}, next)` |
| dsh-plan-mode | `dsh-plan-mode\lib\index.js:168` | `async ({agent, signal}, next)` |
| dsh-compaction-basic | `dsh-compaction-basic\lib\index.js:839` | `async ({agent, signal}, next)` |
| dsh-session-reference | `dsh-session-reference\lib\index.js:458` | `async ({agent, signal, modelSelection}, next)` |
| dsh-tool-skill | `dsh-tool-skill\lib\index.js:896,931` | 两处 |
| dsh-repeat-tool-reminder | `dsh-repeat-tool-reminder\lib\index.js:2266` | `({agent, messages}, next)` |
| dsh-goal-round-driver | `dsh-goal-round-driver\lib\index.js:295` | `async ({agent, messages, signal}, next)` |
| dsh-session-checkpoint-policy | `dsh-session-checkpoint-policy\lib\index.js:72` | `async ({agent}, next)` |
| dsh-experimental-liveshare | `dsh-experimental-liveshare\lib\index.js:7627` | `async ({agent, signal, turn}, next)` |
| dsh-experimental-client-ui-forge | `dsh-experimental-client-ui-forge\lib\index.js:1100` | `async ({agent, step, signal}, next)` |
| dsh-api-session-controller | `dsh-api-session-controller\lib\index.js:3265` | 否决式 `(payload, next)` |

**最适合照抄的模板**是 `dsh-time-context`（它做的就是"每 turn 追加一条 snapshot"，与 RTA 同构）：

`<H>dsh-time-context\lib\index.js:249-282`
```js
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		...
		return {
			...decision,
			messages: [...decision.messages, createUserMessage({
				content: [{ type: "text", text }],
				source: { kind: name, form: "snapshot", sections: [{ name, text }] }
			})]
		};
	}, { prepend: true });
```

---

## 3. Q3 — 注入消息的形状

### 3.1 合法性逐字段

| 字段 | 要求 | 证据 |
|---|---|---|
| `id` | **任意唯一字符串**（`createUserMessage` 用 UUID，但 session 层**不校验** user/message 的 id） | `<H>dsh-session\lib\index.js:242-277` 不检查 id；客户端用 `String(event.data.id)` 当节点 key，`<H>dsh-client-ui-chat\lib\client.js:11951-11959` |
| `role` | `'user'`（只能是 user；`developer` 有额外约束） | `<H>dsh-session\lib\index.js:247` |
| `content` | `[{type:'text', text}]`；**不能含 `tool-result` 块** | `<H>dsh-session-format-v3-to-v4\lib\index.js:172-207`（retired syntax） |
| `source.kind` | `'plugin:dsh-rta'` 合法（唯一硬约束是**不能等于 `'plugin'`**，也不能空） | `<H>dsh-session-format-v3-to-v4\lib\index.js:124-127`（`format v4 message requires a producer-owned source kind`）；`:142-152` 只拒绝 `kind === 'plugin'` |
| `source.form` | `'snapshot'` **在闭合枚举内**，且要求 `sections` | `<H>dsh-llm\lib\typert.host.js:327-328` |
| `source.sections` | `[{name, text}]`，**非空数组**，`name` 非空 string、`text` string | `<H>dsh-client-ui-chat\lib\client.js:5478-5494` |
| 其他 source 字段 | 自由（客户端只读 `form/sections/summary/kind`） | 同上 |

`ContextFormed` 权威定义（20+ 包的 `typert.host.js` 同文）：

`<H>dsh-llm\lib\typert.host.js:327-328`
```ts
export type ContextFormed = { readonly form?: never; } | { readonly form: 'instructions'; } | { readonly form: 'catalog'; } | { readonly form: 'snapshot'; readonly sections: readonly ContextSnapshotSection[]; } | { readonly form: 'notice'; readonly summary: string; } | { readonly form: 'relay'; } | { readonly form: 'recall'; };
```

**关键更正**：03 文档 §3 把 sections 写成 `[{id,title}]` —— 错，客户端只认 `name`+`text`，字段不符会降级成 opaque 行（内容不展开但**仍进模型上下文**）。

### 3.2 `id` 的实际要求

- 必填且**全局唯一**（同一 session 内至少唯一）：客户端把它当 chat 节点 key（`client.js:11951-11959`），`inbox.locate` 用它定位待撤回消息；
- **不要求 UUID**；但 RTA 现有 `summon.js` 用 `randomUUID()`，保持不变最省事；
- 不要用"内容哈希"当 id：相同内容注入两次会撞 key（渲染合并），且 `inbox` 定位会命中第一条。

### 3.3 pre-step 追加 vs `agent.inject`/`steer`：渲染无差异

渲染完全由 `source` 决定（客户端 `contextForm`/`contextProducer`/`contextMessage`），**与投递路径无关**：

`<H>dsh-client-ui-chat\lib\client.js:9807-9825`
```js
const KNOWN_FORMS = ["instructions","catalog","snapshot","notice","relay","recall"];
function contextForm(source) {
	const form = readString(asRecord(source), "form");
	return form !== null && KNOWN_FORMS.includes(form) ? form : null;
}
```
`client.js:9831-9856` 的默认分支：`{role:"inject", label: kind}` → 折叠行标签就是你写的 `source.kind`（`plugin:dsh-rta`）。

差异只在**投递语义**：

| 通道 | 何时进历史 | 唤醒 | 去重 | 位置 |
|---|---|---|---|---|
| pre-step 追加 | 本步请求**之前** | 不涉及（已在 turn 内） | 自己做 | 该步 decision 末尾（runtime-context 之后） |
| `agent.inject` | 下一次 step 边界（idle 时=下次 turn 第 1 步） | **否** | 无 | inbox 队列顺序 |
| `agent.steer` | 当前 turn 下一步 | **是** | 无 | 同上 |
| `agent.followup` | 下一 turn 首步 | **是** | 无 | 同上 |

（`<H>dsh-agent-loop\lib\index.js:564-578`、`:97-111`）

### 3.4 snapshot sections 精确字段

`<H>dsh-client-ui-chat\lib\client.js:5478-5494`
```js
function snapshotSections(source) {
	const sections = asRecord(source)?.["sections"];
	...
		const name = item["name"], text = item["text"];
		if (typeof name !== "string" || name === "" || typeof text !== "string") return null;
```
渲染为 `<dl>`：`name` → `<dt>`，`text` → `<dd>`（`:5512-5538`），并在上方显示固定说明 `message.context.snapshot.supersedes`。**建议 1–4 个 section**（如 `screen` / `focus` / `cursor`），每个 section 独立可折叠。

### 3.5 notice 的 `summary`

`<H>dsh-client-ui-chat\lib\client.js:5651-5655`
```js
function noticeSummary(source) {
	const summary = asRecord(source)?.["summary"];
	return typeof summary === "string" && summary !== "" ? summary : null;
}
```
只要求**非空 string**，无长度校验（UI 侧 CSS 截断）。RTA 现有 `NOTICE_SUMMARY` 做法正确；建议 ≤120 字符、单行、不带换行。

### 3.6 JSON 可序列化

`session.append` 会 `snapshotJsonValue(data)`，不可序列化直接抛：

`<H>dsh-session\lib\index.js:1526-1543`（`throw new Error(\`session event "${type}" carries non-JSON-serializable data\`)`）

→ 禁止 `Buffer`/`Uint8Array`/`Map`/函数/循环引用；图片只能走 attachment 引用（普通对象，如 `{kind:'attachment', id}`），或干脆只注入**文字摘要 + 可选 attachment 引用**。消息还会被 `deepFreeze`（`<H>dsh-agent-loop\lib\index.js:1080-1082`），落盘后不要再改对象。

---

## 4. Q4 — idle / running

1. **pre-step 只在 turn 内**：非 running 直接抛错
   `<H>dsh-agent-loop\lib\index.js:666-670`
   ```js
   		if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": pre-step outside running phase`);
   ```
   而 turn 只由 `wakeDriver` 启动；`inject` 不唤醒（见下）。
2. **`agent.inject` 不唤醒，但下次首步必被 claim**：`send(message,target,wakeup)` 里 `if (wakeup) this.wakeDriver(...)`，`inject` 传 `false`（`:564-578`）；而 `claim()` **每个 step 边界都全量清空 next-step 队列**（`:97-111`），所以 idle 期注入的消息会在下一个 turn 的第 1 步被取走。
3. **"进入 running"的公开钩子 = `agent/status`**：
   `<H>dsh-agent-loop\lib\index.js:557-563`
   ```js
   	setPhase(next) {
   		const previousStatus = this.status;
   		this.phase = next;
   		const status = this.status;
   		if (status !== previousStatus) this.dispatch.emit("agent/status", { status });
   	}
   ```
   payload fuse 了 `agent`，所以根 ctx 上 `ctx.on('agent/status', ({agent, status}) => …)` 能收到每次 idle↔running 切换（**只在变化时发**）。生产消费者：`<H>dsh-acp\lib\index.js:1087`、`<H>dsh-api-session-controller\lib\index.js:2057/3836`、`<H>dsh-goal-round-driver\lib\index.js:223`、`<H>dsh-compaction-basic\lib\index.js:853`、`<H>dsh-sdk-jsonrpc-server\lib\index.js:72/432`、`<H>dsh-experimental-agent-team\lib\index.js:1477`。
4. **不存在 `agent/turn-start` / `agent/start`**：全包 grep 无命中；loop 里全部 `"agent/…"` 发射点只有 `agent/inbox/claimed`(106)、`agent/inbox/discarded`(199)、`agent/inbox/inserted`(200)、`agent/status`(562)、`agent/error`(644)、`agent/pre-step`(685)、`agent/turn-stopping`(791)、`agent/assistant-stream`(873)、`agent/request-error`(929)、`agent/request`(994)。要"每 turn 一次"，就在 pre-step 里用 `step === 1` 判断。

---

## 5. Q5 — 语义风险

### 5.1 全局 pre-step 会命中 subagent

`<H>dsh-scope\lib\index.js:327-338`
```js
	const tag = scopeOf(ctx);
	if (tag === void 0) return true;
```
→ 无 tag（插件根 ctx）的监听器对**所有 scope** 返回 true；而 agent 事件的 carrier 是 `scopeTarget(agent, agent)`（`<H>dsh-agent\lib\index.js:346-348`），子代理是**另一个 scope**。所以根 ctx 的 pre-step 监听器**确实会收到 subagent 的 turn**。（这也是为什么 15 处生产注册都自己判 `agent`。）实证：§1.9 里那个 `delegationDepth=1` 的子代理会话，其 runtime-context 里就带着父级全局注册的 `working-directory:current`/`sandbox:policy`/`team:identity` 等 section。

### 5.2 如何识别 subagent

```js
const { parentSession, origin, delegationDepth } = agent.session.header
const isSub = parentSession !== undefined || origin === 'subagent' || (delegationDepth ?? 0) > 0
```
证据：
- `<H>dsh-subagent\lib\index.js:347-357` — `childSessionMeta(...)` 返回 `{ parentSession: parentHeader.id, isSeeded, origin: "subagent", delegationDepth: childDepth }`
- `<H>dsh-subagent\lib\index.js:2543-2556` — 宿主自己就是这么判的：`const { parentSession, origin } = agent.session.header; if (parentSession === void 0 || origin !== "subagent") continue;`
- `delegationDepthOf(agent)` 见 `:112-115`（`Math.max(agent.session.header.delegationDepth ?? 0, agent.options.subagentDepth ?? 0)`）

### 5.3 context 里识别当前 session

`text(context)` 内可直接读 `context.agent?.session.id` / `.header`（生产先例 `<H>dsh-sandbox-policy\lib\index.js:151`），因此**单会话绑定的推荐实现是"全局注册 + text 内返回 `''` 过滤"**，而不是按 agent 注册。

### 5.4 其他坑

- 你的 `text()` 每个 step 至少被调 2 次（pre-step 的 `assemble()` 1 次 + `step()` 里 `refreshContext()` 每次请求尝试 1 次，重试再加），且**所有 agent 都在调**（含 subagent）→ 里面只做内存读，不做 IO。
- pre-step 里 `await` 之外的异步副作用要 `void`，否则会拖慢每一步。
- RTA 现有 `service.js` 的 `serviceOf`（`ctx.get(...)` + try/catch 属性读）与本报告结论一致，可继续用。

---

## 6. Q1/Q3 与 01/03 文档的差异（需更正）

| 文档说法 | 实测 |
|---|---|
| 03 §3：`sections:[{id:'timeline', title:'…'}]` | ❌ 必须 `{name, text}`；否则降级 opaque（`client.js:5478-5494`） |
| 03 §3：`form:'snapshot'` 标"待核实" | ✅ 合法，闭合枚举成员（`typert.host.js:327-328`） |
| 01：`text` 可以是 async / 返回 Promise | ❌ 同步调用（`index.js:189` 无 await）：`interpolate:true` 时在 `text.indexOf("{{")` 抛 `text.indexOf is not a function`，`interpolate:false` 时被 `text.length > 0` 静默丢弃（`index.js:158,161-164`） |
| 01：`ctx.get('systemPrompt', true)` 可注册 context | ❌ 第二参是 `strict`；注册必须调 `.context(...)`（`cordis:1339-1356`） |
| 01：每个 turn 落一条 runtime-context | ⚠️ 实际是"**文本变化**才落一条"，同文本复用（`dsh-agent-loop:333-348`） |
| 01/03：注入会累积多条快照 | ✅ 确实累积（每次变化一条），旧的不删除，只靠正文前缀声明"以最新为准" |

---

## 7. Q6 — 最小可用实现（60 行，ESM，零依赖）

```js
// rta-passive.js — 「启用即持续」注入。放进 RTA 插件，由 apply() 调用。
import { randomUUID } from 'node:crypto'

export const KIND = 'plugin:dsh-rta'
const seen = new Map()                                  // sessionId -> 上次注入正文
let readScreen = () => null                             // 引擎注入：sid => string | null
export function setScreenReader(fn) { readScreen = typeof fn === 'function' ? fn : () => null }

export function installPassive(ctx, config = {}) {
  const bound = config.sessionId                        // 可选单会话绑定
  const disposers = []

  const eligible = (agent) => {
    if (agent === undefined || config.passiveInject === false) return false
    const h = agent.session.header
    if (h.parentSession !== undefined || h.origin === 'subagent' || (h.delegationDepth ?? 0) > 0) return false
    return bound === undefined || agent.session.id === bound
  }
  const grab = (sid) => {
    try { const t = readScreen(sid); return typeof t === 'string' && t !== '' ? t : null } catch { return null }
  }

  // ① 主通道：pre-step 追加（自己做判重）
  disposers.push(ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()                        // 恰好一次
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (!eligible(agent)) return decision
    try {
      ctx.fiber.assertActive()
      const sid = agent.session.id
      const text = grab(sid)
      if (text === null || seen.get(sid) === text) return decision
      seen.set(sid, text)
      return { ...decision, messages: [...decision.messages, {
        id: randomUUID(), role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: KIND, form: 'snapshot', sections: [{ name: 'screen', text }] }
      }] }
    } catch (error) {
      ctx.logger?.warn?.(`[rta] pre-step inject skipped: ${error?.message ?? error}`)
      return decision                                    // 任何异常都不影响 turn
    }
  }, { prepend: true }))

  // ② 可选通道：交给宿主按文本去重（不改写 system prompt）
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'rta:screen',
      order: 205,                                        // HARNESS_SOURCE(200) 之后
      interpolate: false,                                // 屏幕文本可能含 {{ }}
      text: (context) => {
        const s = context.agent?.session
        if (s === undefined || (bound !== undefined && s.id !== bound)) return ''
        return grab(s.id) ?? ''                          // '' = 本次不贡献
      }
    })
  })

  ctx.effect(() => () => { for (const d of disposers) d(); seen.clear() })
}
```

要点：
- `ctx.on(...)` 与 `ctx.inject(...)` 的注册都归插件 fiber 所有，卸载自动清理；`ctx.effect` 那段只是额外清 `seen` 缓存（幂等，重复 dispose 无害）。
- 两个通道**可以同时开**：② 负责"稳定的最新快照"（宿主去重），① 负责"事件驱动的一次性推送"。二者同时产出会让同一段文本进历史两次，**RTA 应二选一**；推荐 ②（更简单、异常面更小），只有需要"精确到某一步/某一次截图"时才用 ①。
- `ctx.fiber.assertActive()` 在长 `await` 后调用，避免插件已卸载还写事件（生产先例 `dsh-time-context:251`）。

---

## 8. 5 分钟验证方案（不需要宿主调试器）

准备：把 `readScreen` 接到真实截图管线，并在注入文本开头加一枚一次性 nonce（如 `RTA-7f3a91`），便于肉眼比对。

1. **产生一次注入**（30 s）：RTA 设置里开启被动注入 → 新开一个会话 → 发一句"你好"。
2. **UI 证据**（30 s）：该轮出现一条折叠的注入行，标签为 `plugin:dsh-rta`；展开后先看到"该快照取代更早的快照"说明，下面 `<dt>screen</dt><dd>RTA-7f3a91 …</dd>`。若显示为不可展开的 opaque 行 → `sections` 字段名写错了（见 §3.4）。
3. **落盘证据**（1 min）：会话日志 `session.v4.jsonl.zstd` 是**多帧拼接**的 zstd（Node 自带的 `zstdDecompressSync` 只解第一帧，直接解会只看到 1 条事件）。用现成探针（零依赖，已写好）：
   ```powershell
   cd C:\Users\PhonLynN\dsh_Workspace\dsh-RTA-dev
   node _probe\host-contract\verify-injection.mjs                 # 最近改动的会话
   node _probe\host-contract\verify-injection.mjs session-xxxx    # 指定会话
   node _probe\host-contract\verify-injection.mjs session-xxxx --json
   ```
   期望：`plugin:dsh-rta 1`，且每条都是 `form=snapshot surfaceOp=append sections=[screen:NNNB]`，末尾打印 `OK: 形状符合 04 报告 §3 契约`；`runtime-context` 那几行会展示 `order=[…]`，可核对排序。
   （该脚本按 `28 B5 2F FD` 逐帧解 + 按 `seq` 去重，能解出 460+ 事件 / 275 帧的真实日志；seq 有缺口时会 WARN。）
4. **去重反证**（1 min）：屏幕不动，连发 3 条消息 → 上一步计数**不增加**（说明 `seen`/宿主去重生效）；改屏幕内容后再发 1 条 → 计数 +1。
5. **进模型的证据**（1 min）：问模型"我刚注入的 nonce 是什么？只回答 nonce"。答出 `RTA-7f3a91` 即证明文本进了 `deriveMessages()` 并到达请求（对应 `<H>dsh-agent-loop\lib\index.js:1078`）。
6. **子代理隔离**（1 min）：让模型跑一个 subagent 任务 → 子会话日志里 `plugin:dsh-rta` 计数应为 0（§5.2 的过滤生效）。

判定：1–3 通过 = 通道打通；4 通过 = 不会刷爆上下文；5 通过 = 真的进模型；6 通过 = 不会污染子代理。

---

## 9. 证据表（速查）

| 结论 | 位置 |
|---|---|
| `ctx.get` 免 inject、返回 undefined 不抛 | `<H>cordis\lib\index.js:1339-1356` |
| `ctx.inject` = 嵌套插件（soft 依赖） | `<H>cordis\lib\index.js:1666-1678` |
| waterfall 外层优先、`next()` 只能一次、不调用=否决 | `<H>cordis\lib\index.js:896-929` |
| `prepend` → `unshift` | `<H>cordis\lib\index.js:919-929` |
| `context()` 签名 + order 校验 + disposer | `<H>dsh-system-prompt\lib\index.js:281-284` |
| `text` 同步调用、返回对象只留 name/text/interpolate | `<H>dsh-system-prompt\lib\index.js:186-192` |
| 空串被过滤 | `<H>dsh-system-prompt\lib\index.js:153-157` |
| 快照正文前缀 + `\n\n` 拼接 | `<H>dsh-system-prompt\lib\index.js:138-142` |
| order 排序（无 name 兜底） | `<H>dsh-system-prompt\lib\index.js:398` |
| 同名重复注册报错 | `<H>dsh-system-prompt\lib\index.js:205-207` |
| 文本相同则不落事件 | `<H>dsh-agent-loop\lib\index.js:333-348` |
| pre-step payload（messages/turn/step/signal/modelSelection） | `<H>dsh-agent-loop\lib\index.js:674-685` |
| turn/step 从 1 开始 | `<H>dsh-agent-loop\lib\index.js:727,745` |
| `kind:'reject'` 唯一特判 | `<H>dsh-agent-loop\lib\index.js:699` |
| commit 循环无校验、runtime-context 被替换 | `<H>dsh-agent-loop\lib\index.js:859-866` |
| `decision.messages[i].source.kind` 被无条件解引用 | `<H>dsh-agent-loop\lib\index.js:860` |
| 请求消息 = `session.deriveMessages()`，无 kind 过滤 | `<H>dsh-agent-loop\lib\index.js:1078,1087` |
| `send/inject` 的 wakeup 语义 | `<H>dsh-agent-loop\lib\index.js:564-578` |
| `claim` 每步清空 next-step | `<H>dsh-agent-loop\lib\index.js:97-111` |
| `status` 与 `agent/status` 发射 | `<H>dsh-agent-loop\lib\index.js:554-563` |
| 所有 agent 事件 fuse `agent` | `<H>dsh-agent\lib\index.js:358-388` |
| 无 tag 监听器收全部 scope | `<H>dsh-scope\lib\index.js:327-338` |
| ContextFormed 闭合枚举 | `<H>dsh-llm\lib\typert.host.js:327-328,496` |
| createUserMessage 覆盖 id 并冻结 | `<H>dsh-llm\lib\index.js:37-42` |
| sections 必须是 `{name,text}` 非空 | `<H>dsh-client-ui-chat\lib\client.js:5478-5494` |
| notice summary 非空 string | `<H>dsh-client-ui-chat\lib\client.js:5651-5655` |
| 未知 form → opaque 不抛 | `<H>dsh-client-ui-chat\lib\client.js:9807-9825` |
| 折叠行标签 = `source.kind` | `<H>dsh-client-ui-chat\lib\client.js:9831-9856` |
| 节点 key = `String(data.id)` | `<H>dsh-client-ui-chat\lib\client.js:11951-11959` |
| surface 校验不查 id/content/source | `<H>dsh-session\lib\index.js:242-277` |
| 非 JSON 序列化抛错 | `<H>dsh-session\lib\index.js:1526-1543` |
| v4 禁止 `kind:'plugin'` | `<H>dsh-session-format-v3-to-v4\lib\index.js:124-127,142-152` |
| 子代理 header 字段 | `<H>dsh-subagent\lib\index.js:347-357,2543-2556` |
| 生产 soft-inject + 取 session | `<H>dsh-sandbox-policy\lib\index.js:146-155` |
| 生产 runtime-context 理由 | `<H>dsh-sandbox-policy\lib\index.js:45-56` |
| 生产 turn 级 snapshot 注入模板 | `<H>dsh-time-context\lib\index.js:249-282` |
| 压缩按 surface 节点区间处理 | `<H>dsh-compaction-basic\lib\index.js:413-431,651`；`<H>dsh-compaction\lib\index.js:129` |
| 摘要输入 = 区间内每个 surface 节点的 derived message | `<H>dsh-compaction-basic\lib\index.js:695-699` |
| 真实会话样本（runtime-context 形状/排序/去重/节流） | `_probe/host-contract/verify-injection.mjs` 输出，见 §1.9 |

---

## 10. 未核实清单

1. `[未核实]` **`agent/status` 是否在 maintenance（压缩）阶段也发 running**：`get status` 把 maintenance 映射为 idle，但 `setPhase(maintenance)` 会先算 previousStatus → 从 idle 进 maintenance 不发事件。若 RTA 想"维护期不注入"，以 pre-step 是否触发为准更稳。
2. `[未核实]` **多客户端/多窗口下 `session/event` 的广播边界**：RTA 现有 `summon.js` 依赖 `ctx.on('session/event')` 记 lastSessionId；本报告未验证多会话并发时该事件是否带 session 标识（建议在 handler 里用 `event.session`/`session.id` 二次确认）。
3. `[未核实]` **`source.sections` 的条数/长度上限**：客户端只校验类型，未见长度限制；服务端 session 只校验 JSON 可序列化。实际 token 压力由 `deepFreeze`+`deriveMessages` 直接体现，建议 RTA 自限（如 ≤4 section、总 ≤2 KB）。
4. `[未核实]` **attachment 引用在 `form:'snapshot'` 里的渲染**：客户端 SnapshotBody 只渲染 `text`，图片引用即使合法也不会显示缩略图；只能写文字（如 `![screen](attachment:…)` 或路径），渲染效果未验证。
5. `[未核实]` **`session/snapshot` 类事件在 UI 的展示边界**（本报告未涉及）：注入消息在对话流里是独立行，是否会被"合并折叠"未验证；影响的是观感不是契约。

---

## 11. 落地建议（给 lead）

1. **默认用 `systemPrompt.context`**（`name:'rta:screen'`, `order:205`, `interpolate:false`），文本由 RTA 在**截图落盘时**更新一份"当前快照字符串"，`text()` 只读内存 → 宿主自动去重，改动最小。
2. **需要"每次截图都留痕"时**再开 `agent/pre-step`（`{prepend:true}`），并复用 §7 的 `seen` 判重 + 子代理过滤 + `ctx.fiber.assertActive()`。
3. 两条通道都要在 `text()`/handler 内做 `session.id` 绑定过滤，否则会污染所有会话与子代理。
4. 消息一律手写普通对象（`randomUUID()` + `{name,text}` sections），**不要**为了 `createUserMessage` 引入 `@deepseek-ai/dsh-llm` 依赖（RTA 的依赖面越窄越好）。
