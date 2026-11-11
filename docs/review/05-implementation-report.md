# 05 · 「启用即持续注入」落地报告

日期：2026-11-11 · 对应目标：用户抱怨「RTA 功能不完善、体验不达预期」，期望「屏幕内容一直在被排队注入上下文，
一旦开启，不需要主动调用工具就能知道在看什么、发生了什么」。

结论：**已实现并在本机真机验证生效**。

## 1. 交付内容

| 文件 | 职责 |
| --- | --- |
| `src/host/live-buffer.js` | 引擎 push 事件的环形活缓冲（cap 64）+ 单调 rev + 稳定 digest 文本（前台 / 活动强度 / 计数 / 时间线 / 静默期新鲜度） |
| `src/host/injector.js` | 文本发布节流（文本相等去重、`minIntervalMs=4000`、`maxPerMinute=8`）+ 图片预算 governor（45s / 10min 6 张 / 在飞 1） |
| `src/host/channel.js` | 宿主能力探测：`systemPrompt.context`（主，order=205，`interpolate:false`）+ `agent/pre-step` prepend（图）→ 自动降级 |
| `src/host/lifecycle.js` | 引擎订阅（start/push/stop/exit）、1Hz tick（beat + 前台窗口采样）、绑定会话过滤、图片消息构造、attach/dispose |
| `src/host/messages.js` | 注入消息形状（`plugin:dsh-rta` / `form:'snapshot'` / `sections:[{name,text}]`）与截图说明文案 |
| `src/engine/engine.js` | 三处 push 载荷补 `win: winMeta(lastForeground)`，注入文本才能写「前台」 |
| `src/host/runtime.js` | `onEngine` / `onBind` 钩子、惰性 `attachLive()`、dispose 顺序 |
| `src/config.js` | 新增 `inject`（含 `inject.image`）配置树与深合并 |
| `src/index.js` | apply 时 `rt.attachLive()`；工具文案 / status 注入统计 |
| `test/live.test.mjs` | 17 个注入面单测（buffer / injector / governor / channel / lifecycle / config） |

## 2. 宿主契约要点（详见 04-host-api-verified.md）

- 文本走 `systemPrompt.context`：宿主每步 assemble，**只在渲染文本变化时**落一条 `runtime-context` 快照，
  自动声明旧快照被取代。插件侧只需保证「同样的屏幕状态渲染出同样的文本」，静止屏幕不会刷消息、不破坏前缀缓存。
- 图片走 `agent/pre-step`：每轮 `step===1` 时追加一条自己的 user 消息（带 attachment ref），
  交付后触发 `notifyDelivery()`，由既有 `image/offload` 预算回收。
- `order` 必须是有限数字；RTA 不在宿主 CONTEXT_ORDERS 表里 → 固定 205。
- `sections` 形状必须是 `{name, text}`（否则宿主降级 opaque）。
- 根 `ctx` 监听器会命中所有 scope（含子代理）→ 用 `agent.session.id === rt.boundSessionId()` 过滤。

## 3. 真机验证证据（2026-11-11 17:48–17:49，dsh-desktop 0.2.2-rc.1）

重载插件后 `rta_status`：

```
RTA running. session=20261111-174851
bound session: session-a3038ba9-23ce-43c1-b583-67095a42bb73
injection: on channel=context+pre-step published=1 last=2026-11-11T09:48:52.207Z screenshots=0
foreground: "RTA毛玻璃效果技术方案排查 — DeepSeek Harness" (DeepSeek Harness.exe)
```

调用 `rta_start` 后的下一步，模型侧 runtime context 里直接出现（**没有任何主动工具调用**）：

```
〔RTA 屏幕感知 · 自动注入，非用户消息〕
前台：未知（采集已启动，等待窗口信息）
状态：最近 1 分钟内有变化
时间线：最近没有显著变化。
需要原始画面：rta_look；更早历史：rta_recall。
```

几秒后文本随前台采样更新（说明「文本变化才发布」按预期工作）：

```
〔RTA 屏幕感知 · 自动注入，非用户消息〕
前台：RTA毛玻璃效果技术方案排查 — DeepSeek Harness [DeepSeek Harness.exe]
状态：最近 1 分钟内有变化
时间线：最近没有显著变化。
```

用户按 `Ctrl+Tab` 退出后，停止态也自动进了上下文（注入通道对 stop 同样生效）：

```
〔RTA 屏幕感知 · 已停止〕
屏幕采集已结束（用户主动停止），之后不再自动更新屏幕状态。
需要时可直接调用 rta_start 重新启用，或 rta_recall 回看历史。
```

会话 manifest 记录 `reason:"exit"`、`frames:708`、`events:2`，与状态吻合。

## 4. 测试

`node test/<file>.test.mjs` 逐文件运行（该环境 `node --test` 会 spawn EPERM）：

```
live 17 + plugin 7 + engine 6 + algo 10 + store 2 = 42 全过
```

## 5. 已知未覆盖 / 下一步

- 图片注入（每轮首步拼图）已有单测与真实 compose 路径，但本轮 turn 的 step 1 早于 `rta_start`，
  真机首次生效需下一轮对话；日志字段 `injection.screenshots` 可直接确认。
- 客户端 UI（悬浮窗头部 / 对话 tab 的注入状态指示）未做。
- OCR / 字幕轨等「读字」能力仍按原计划后置。
