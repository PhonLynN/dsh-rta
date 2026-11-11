# RTA — Real Time Accompaniment

给 DSH 装一双实时的眼睛和一张嘴：**看见屏幕 → 本地算法筛选 → 只把有信息的画面交给会话模型 → 图片用完即省略、文字长期保留**。

当前状态：**「启用即持续注入」+「高清帧通道」+「后台摘要子代理」已落地并真机实测生效**——`rta_start` 之后不需要模型主动调工具，
屏幕状态会以 runtime-context 快照的形式自动进入会话（前台窗口、活动强度、事件时间线），
每轮首步还会附一张**裁窗后的高清帧**（从 2560×1440 原生录像抽帧，按预算缩放）和**后台子代理刚写的摘要**（主会话全程不被唤醒）。
后端层（采集 / 打分 / 选择 / 拼图 / 录像 / 存储 / 工具）全跑通，
73 个离线单测全过（10 算法 + 6 引擎 + 7 插件 + 19 注入面 + 14 高清帧 + 15 摘要子代理 + 2 存储）。
UI/UX（悬浮窗、对话 / 轨迹面板、插件配置页）按计划放在下一阶段。

平台：Windows 10/11（GDI + koffi 调 Win32）。插件侧只依赖 `@deepseek-ai/dsh-tools`（可选）。

---

## 它解决什么问题

- 固定帧率把画面丢给模型：慢、贵、token 爆炸。
- 只按「变化大」筛选：动态壁纸、视频特效、鼠标划过都会被当成信息。
- 图片堆在会话里：历史越长越贵，逐张卸载还会每轮破坏前缀缓存。

RTA 的做法：**本地永远在采集，但只有通过筛选的画面才进上下文；进上下文的是拼图，不是原图；拼图用完由 `image/offload` 一次性省略；文字（时间轴、圈画、台词、笔记）永久保留。**

**默认是「推」不是「拉」**：启用后宿主每步都会重新 assemble 一段 runtime context，RTA 只在
「屏幕状态真的变了」时更新它；文本不变就零消息、零缓存破坏。模型不需要轮询工具就知道用户在看什么。

---

## 持续注入（启用即注入）

`rta_start` 之后，注入器（1Hz）把活缓冲渲染成一段短文本，只有在满足节流时才会发布新文本：

```
〔RTA 屏幕感知 · 自动注入，非用户消息〕
前台：main.js — Visual Studio Code [Code.exe]
状态：最近 1 分钟内有变化
最近 2 分钟：明显变化 ×3 · 持续变化（滚动/播放） ×1
时间线（本地时间）：
- 14:32:10 明显变化（强度 46） → 窗口「Chrome」
- 14:33:02 持续变化（滚动/播放）
需要原始画面：rta_look；更早历史：rta_recall。
```

两条宿主通道（`src/host/channel.js` 自动探测、可降级）：

| 通道 | 用法 | 内容 | 节流 |
| --- | --- | --- | --- |
| 文字（主） | `systemPrompt.context({name:'rta:screen', order:205, interpolate:false, text})` | 上面那段文本；宿主**只在文本变化时**落一条 `runtime-context` 快照并声明旧快照被取代 | 文本相同不发布；`minIntervalMs=4000`；`maxPerMinute=8` |
| 图片 + 摘要（稀缺） | `agent/pre-step` prepend 追加一条 `plugin:dsh-rta` 消息 | 每轮**首步**最多一张裁窗高清帧（按 token 预算反推宽度）＋后台子代理最新摘要（如有）；`rta_start` 当轮附「已启动」告知 | `minIntervalMs=45000`、10 分钟 ≤6 张、在飞 ≤1；摘要由子代理 `intervalMs=45000` 驱动 |

设计约束（`docs/review/03-target-architecture.md`）：只追加尾部不改历史、自动流永不唤醒会话、
单槽替换不排队、文字必带图片稀缺、幂等节流、全部硬封顶。子代理会话会被过滤（只服务绑定会话）。
注入的图同样走 `image/offload` 预算，不会在会话里堆积。

---

## 高清帧通道（HD）

自动注入的图片和 `rta_look` / `rta_recall(images=true)` 默认都走高清路径：

- **抽帧**：从会话的 2560×1440 原生录像按事件时间戳抽帧（`recorder.extractFrame`，混合 seek，8 秒内约 0.3 s）。
- **裁窗**：按事件的前台窗口 rect（用户圈画时按 bbox）裁剪，padding 6%（圈画 12%）；rect 越界超过 15% 或太小（<32px）时回退整幅。
- **缩图**：候选宽度 1600 / 1440 / 1280 / 1160 / 1024 / 900 / 800 / 720，用 42px token 网格反推预算（`inject.image.hdMaxWidth=1600`）。
- **选帧**：`pickInformativeFrames` 按信息量排序（region 1000 > manual 400 > cut 200 > text 180 > integral 100 > heartbeat 0，加切镜强度与圈选面积），跳过静默帧、同窗口 1.5 s 内去重；`pickSpread` 把时间窗均分成 N 段各取最重要的一帧，长视频不会全挤在开头。

注入图片每轮最多一张（`minIntervalMs=45000`、10 分钟 ≤6、在飞 ≤1）；`rta_look` 默认 `count=2 / maxTokens=1200`（`hd:false` 可回退旧拼图）；`rta_recall(images:true)` 默认 `maxImages=3`，并默认隐藏 15fps 的逐帧索引行。

## 后台摘要子代理

主会话不能被打断，所以摘要不在主会话里做：

- `rta_start` 后，RTA 用 `ctx.subagents.startActivation({provider, childId, delivery:'caller', request:{prompt, parent}})` 预留**整个 RTA 会话唯一的常驻 child**；之后每一轮都通过宿主 symbol 通道 `subagents[Symbol.for('dsh.subagent.deliverPrompt')](parent, childId, …)` 把新 prompt 投给同一个 child，不再新建子代理。`rta_stop` / dispose 时 `interrupt` + `drainChildren` 清除它（用户可在 `rta_status` 的 `summarizer.child` 看到它的 id）。
- 摘要触发有三种：① 周期（`intervalMs=45000`，10 分钟 ≤18 次，digest 不变时跳过）；② 密集事件（cut / 圈画 / 文字变化或强度 ≥18 的帧，2.5 s 防抖、12 s 最小间隔）；③ 主 agent 主动命令 `rta_summarize`（会等子代理写完新摘要再返回，绝不唤醒主会话）。
- 子代理读 digest、必要时 `rta_look(count=1)`，然后 `rta_note({name:'screen-log', text})` 写 2–4 句中文摘要；prompt 会带上上一版摘要保持连续。主会话在每个新回合的 step 1 主动读 `notes/` 下最新的 `screen-log`，把「刚刚 / 约 N 分钟前」的摘要作为一条插件消息附上；`rta_start` 当轮还会附一条「已启动」告知。
- 子代理只被放行只读工具（`rta_look` / `rta_region` / `rta_note`），不能 `rta_start` / `rta_stop`；主会话仍然是唯一绑定会话。
- **零唤醒兜底（宿主缺口）**：continuable child 每轮结束会 settle，下一次投递走 `coldResume()`，而宿主 `coldResume` 没有透传 `delivery:'caller'` → `notifySettlement` 会变成「Background subagent … finished」并 `followup()` 唤醒主会话。RTA 因此在 `manager.notifySettlement` 上装了一个**只针对本插件 childId** 的过滤器（`rta_status` 显示 `guard=on`），并随 child 一起在 stop 时还原；宿主升级后若该方法不在了会自动降级（退回可见的结算通知，但不会崩）。

---

## 目录

```
src/
  capture/win32.js     GDI BitBlt 抓屏 + 前台窗口/光标/按键查询（koffi 绑 user32/gdi32）
  capture/gdi.js       采集 provider（grab / cursor / foreground / keyDown）
  img/png.js           零依赖 PNG 编码（BGRA→RGB，level 3）
  img/scale.js         下采样（box / 四分位采样）、裁剪
  algo/color.js        HSV 变换、帧差分打分、运动补偿 mc、亮度增益
  algo/rolling.js      滑动分位数（z-score、自适应阈值）
  algo/select.js       四闸门选择器：cut / integral / text / heartbeat + 预算
  algo/tiers.js        拼图档位与 token 估算（42px 网格）
  algo/pack.js         拼图合成：贴帧、圈画红框、帧标签
  algo/regions.js      鼠标轨迹圈画 → bbox / 时间区间
  engine/engine.js     主循环：抓取 → 打分 → 选择 → 存档 → 拼图 → 热键/圈画
  store/paths.js       会话目录布局
  store/store.js       manifest / index.jsonl / 保留期 GC / 墓碑
  store/writer*.js     PNG/JPEG 编码写盘 worker（背压保护）
  record/ffmpeg.js     原生分辨率录像轨（gdigrab + H.264 硬编 + 分段 TS，按时间戳抽帧）
  native/gdiplus.js    GDI+ JPEG 编码（基线帧 ~14–23KB/帧，0.6ms）
  native/koffi.js      定位宿主自带的 koffi（不新增依赖）
  native/gdiplus.js    GDI+ JPEG 编码（基线帧 ~14–23KB/帧，0.6ms）
  host/                DSH 宿主胶水：defineTool、offload、service、runtime、
                       live-buffer（环形活缓冲+digest）、injector（节流/预算）、
                       channel（systemPrompt.context + agent/pre-step）、lifecycle、messages、
                       hd（高清抽帧/裁窗/缩图）、summarizer（后台摘要子代理）
  tools/               10 个模型工具（spec + handler）
bin/rta-run.mjs        headless CLI（不开 DSH 也能测采集与算法）
bin/rta-smoke.mjs      真机冒烟：起引擎 → 出真拼图 → 文本回捞
test/                  node --test，零依赖
```

## 算法管线

1. **抓取**：每 tick 一次 GDI `BitBlt` 原图（本机 2560×1440 约 22 ms），JS 下采样到 192×108 做哨兵（约 0.3 ms）；按 `archiveFps` 另存 512px 档案帧。默认 `sentinelHz=15`，一次抓取同时供哨兵和档案，CPU ≈ 0.3–0.4 核。
2. **打分**：HSV 加权差分（色相环形距离、饱和度做权重）+ 亮度增益 + 运动补偿 `mcRatioScore`（±2 邻域匹配，整帧平移≈0）+ 滚动 z-score（窗口 300 帧、直方图分位）。
3. **选择**（四路取并集，互不否决）：
   - `cut`：`score ≥ 12 && z ≥ 3 && mc ≥ 0.2 && 距上次 ≥ 400ms`
   - `integral`：静默期累积变化 ≥ 阈值（正在持续变化但不是切镜）
   - `text`：文字变化（字幕 / OCR）是硬信号，优先触发
   - `heartbeat`：最长 25 s 静默必给一帧保险帧
   - `manual`：用户圈画，最高优先级
   - `maxPerMinute` 预算封顶；先全量打分、再按预算排序取前 N，不做逐帧二元丢弃。
4. **呈现**：拼图按 42px 网格出档：单帧 800×450 = 233 tokens、四格 1050×630 = 392、八格 1260×756 = 560、十二格 1596×924 = 860。圈画区域按 screen→frame→cell 三段映射画红框和 `R{id}` 标签（元数据叠加，不改像素语义）。
5. **时间**：每帧记录复合时间戳 `{wall, mono, videoSec?, win{title,process,rect,playing}}`；`index.jsonl` 保留全量索引，可凭时间戳回捞。
6. **保留**：`endedAt + 24h` 前整场都在；到期只删图片，`index.jsonl`、笔记、圈画坐标、台词、AI 总结永久保留；GC 每小时扫一次，过期整场物理删除并留墓碑。
7. **存储（录像轨，默认）**：15Hz 全量原始帧（2560×1440）由 ffmpeg 硬编成分段 MPEG-TS（H.264 QSV，实测约 0.4–1.4 GB/小时；`-g 30` 2 秒关键帧，`flush_packets=1` 让录制中也能读）；时间轴每个 tick 仍写一行索引，记 `video:true, videoMs`（该时刻在视频里的毫秒）。回看时 `rta_recall(images=true)` 按 `videoMs` 用混合 seek 抽一帧原生 JPEG（8 秒内约 0.3 s，文字清晰可读），再按事件裁到前台窗口、按 token 预算缩图（高清通道默认路径，见上）。切镜/文字变化时额外落一张原生 JPEG 事件帧，圈画裁切图用 PNG 保证文字锐利。切到 `archiveMode:"jpeg"` 则退化为逐帧 512px 图片（14–23KB/帧 + 近重复复用），不需要 ffmpeg，此时高清通道自动退回 512px 拼图。
8. **图片不堆积**：`image/offload` 攒到 `imageTrigger=8` 张才动一次手，一次省略到只剩 `imageKeep=3` 张，30 s 节流 —— 只改会话尾部，不逐张改历史。

## 工具

| 工具 | 作用 |
| --- | --- |
| `rta_start` | 开始一场录制（显式指定时长可稍后加） |
| `rta_stop` | 结束录制，写入 `retainUntil` |
| `rta_status` | 是否在跑、会话 id、最近分数、帧/事件计数 |
| `rta_look` | 拿一张裁窗高清帧（默认，`hd:false` 回退最近变化点拼图），附时间轴文字 |
| `rta_region` | 拿用户圈画区域（可指定 regionId），附 bbox 与起止时间 |
| `rta_recall` | 按时间范围 / 类型回捞历史记录（默认隐藏逐帧索引行），`images=true` 时按窗均分挑 ≤3 个关键时刻附高清帧 |
| `rta_summarize` | 让后台摘要子代理**立刻**更新摘要并返回（`waitMs` 默认 25 s；不唤醒主会话） |
| `rta_note` | 把一句观察写进当前会话的笔记（文字永久保留） |
| `rta_sessions` | 列出历史 RTA 会话与保留期 |
| `rta_purge` | 提前清理已经总结成文字的图片/视频（`keepMinutes` 默认保留 2 分钟，保留 index/notes/annotations；正常保留期仍是 24h） |

## 配置

`~/.dsh/rta/config.json`（不存在时用默认值）：

```json
{
  "capture": {
    "sentinelHz": 15,
    "archiveFps": 15,
    "sentinelWidth": 192,
    "archiveWidth": 512,
    "archiveFormat": "jpeg",
    "archiveMode": "video",
    "videoFps": 15,
    "videoQuality": 26,
    "videoSegmentSeconds": 300,
    "videoEncoder": "auto",
    "dedupeScore": 1.0,
    "dedupeMc": 0.005,
    "windowInfoEveryMs": 1000
  },
  "retentionHours": 24,
  "imageTrigger": 8,
  "imageKeep": 3,
  "maxSheetTokens": 560,
  "inject": {
    "enabled": true,
    "minIntervalMs": 4000,
    "maxPerMinute": 8,
    "maxEvents": 4,
    "maxLines": 12,
    "maxTextTokens": 400,
    "eventTtlMs": 120000,
    "staleMs": 15000,
    "image": {
      "enabled": true,
      "minIntervalMs": 45000,
      "windowMs": 600000,
      "maxPerWindow": 6,
      "maxInFlight": 1,
      "maxFrames": 4,
      "maxSheetTokens": 400,
      "hd": true,
      "hdMaxWidth": 1600
    },
    "summarizer": {
      "enabled": true,
      "provider": null,
      "intervalMs": 45000,
      "maxPer10Min": 18,
      "timeoutMs": 180000,
      "eventEnabled": true,
      "eventMinGapMs": 12000,
      "eventDebounceMs": 2500,
      "eventMinScore": 18,
      "demandWaitMs": 25000
    }
  }
}
```

## 开发 / 自测

```bash
node --test test/*.test.mjs        # 73 个离线测试，不抓屏（宿主/沙箱里 spawn 受限时逐文件跑）
node test/live.test.mjs            # 只跑注入面（live-buffer / injector / channel / lifecycle）
node test/hd.test.mjs              # 只跑高清帧通道（选帧 / 裁剪 / 缩图 / vf 生成）
node test/summarizer.test.mjs      # 只跑后台摘要子代理（prompt / delivery / 节流 / 失败路径）
node bin/rta-run.mjs --seconds=10  # headless：打印 cpu / tickHz / 帧数 / 事件数 / manifest
node bin/rta-smoke.mjs             # 真机冒烟：起引擎 → 出拼图 → 回捞文本
node _probe/cold_e2e.mjs           # 冷启动端到端：假 ctx 跑真实插件入口 + 10 个工具
node bin/rta-sync.mjs              # 把 workspace 源码同步到已安装的插件目录
```

> 在某些受限环境里 `node --test` 会因 test runner 无法给每个测试文件 spawn 子进程而报
> `spawn EPERM`；这不是测试失败，直接 `node test/<name>.test.mjs` 逐个运行即可。

> 注意：`plugin_manager install_bundle` 用 `file:` 安装时，pnpm 留下的是**安装时刻的
> 硬链接快照**——运行中的 DSH 读的是 `~/.dsh/profiles/<profile>/node_modules/dsh-rta`，
> 不是本工作区。改完 `src/` 后：
> 1. `node bin/rta-sync.mjs` 同步源码；
> 2. 插件页把 dsh-rta 禁用→启用一次（或 `plugin_manager set_bundle`），新模块会被重新
>    import，即生效（本轮实测，无需重启 DSH；只有 koffi 类型注册这类进程级缓存才需要重启）。
>
> 纯 Node 部分（算法/引擎/工具 handler）可以用上面的命令直接验证。

## 已知限制 / 下一步

- 采集目前是 GDI；下一步评估 ffmpeg `ddagrab`/DXGI 降 CPU 与多屏支持（koffi 已就绪，先不引外部依赖）。
- OCR 读字（Windows.Media.Ocr，本地零下载）已做可行性验证，待接入自动管线；字幕 / ASR / 视频秒数识别 / 视觉笔记生成随后（设计已定：字幕轨 > ASR > 硬字幕 OCR；本地只做 OCR 读字，不跑本地小模型）。
- 热键语义：`Ctrl+Alt` 只在**未启用时**召唤并启用（启用后屏幕状态本来就在自动注入，不需要再召唤）、`Shift+Ctrl+Alt` 圈画、`Ctrl+Tab` 退出本次 RTA、`Esc` 取消正在画的圈。退出后注入器会立刻把「已停止」状态写进上下文，模型不会继续以为在录。召唤通过 `ctx.agents` 推 notice 给当前会话（`src/host/summon.js`，source kind 用 `plugin:dsh-rta`），真实按键已实测通过。
- 注入通道依赖宿主能力：有 `systemPrompt.context` 时走文本快照（主通道），有 `agent/pre-step` 时走每轮首步截图；两者都没有时自动降级为纯 pull（只保留 `rta_look`）。实测环境：dsh-desktop 0.2.2-rc.1 → `channel=context+pre-step`。
- 摘要子代理整个 RTA 会话只保留一个常驻 child（`rta_status` 的 `summarizer.child` 可见，`rta_stop` 会 interrupt + drain 清除）。宿主 `coldResume` 不透传 `delivery:'caller'`，所以 RTA 在 `manager.notifySettlement` 上装了只针对本 child 的过滤器（`guard=on`）来维持零唤醒——这是宿主版本相关的私有兜底，宿主升级后若接口变化会自动降级为「会收到可见的结算通知」而不是崩溃。周期 45 s（10 分钟 ≤18 次）、密集事件 / `rta_summarize` 会更快触发；屏幕剧烈变化时摘要仍可能滞后 1–2 分钟。子代理 provider 默认 `spawn`，模型路由继承父会话（宿主 policy 不允许时启动失败，会记进 `rta_status` 的 summarizer.lastError）。
- 高清通道依赖录像轨与窗口 rect：`archiveMode:"jpeg"`、没有 ffmpeg、或事件太旧（帧已不在录像里）时自动退回 512px 拼图；全屏视频等「窗口 rect 不可靠」的场景会退化成整幅缩小（仍比 512px 拼图清晰）。
- 客户端 UI（悬浮窗、对话 / 轨迹 tab、插件配置页）未做，按计划后置。
- 仅 Windows。

## 许可

Apache-2.0。部分宿主胶水与算法结构改编自 [dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)（Copyright 2026 SAOS-3624, Apache-2.0），详见 `NOTICE` 与 `LICENSE`。
