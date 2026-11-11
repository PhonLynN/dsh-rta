# RTA �?Real Time Accompaniment

�?DSH 装一双实时的眼睛和一张嘴�?*看见屏幕 �?本地算法筛�?�?只把有信息的画面交给会话模型 �?图片用完即省略、文字长期保�?*�?

当前状态：**「启用即持续注入」已落地并在真机实测生效**——`rta_start` 之后不需要模型主动调工具�?
屏幕状态会�?runtime-context 快照的形式自动进入会话（前台窗口、活动强度、事件时间线），
每轮首步还会在预算内附一张拼图。后端层（采�?/ 打分 / 选择 / 拼图 / 录像 / 存储 / 工具）全跑通，
42 个离线单测全过（10 算法 + 6 引擎 + 7 插件 + 17 注入�?+ 2 存储）�?
UI/UX（悬浮窗、对�?/ 轨迹面板、插件配置页）按计划放在下一阶段�?

平台：Windows 10/11（GDI + koffi �?Win32）。插件侧只依�?`@deepseek-ai/dsh-tools`（可选）�?

---

## 它解决什么问�?

- 固定帧率把画面丢给模型：慢、贵、token 爆炸�?
- 只按「变化大」筛选：动态壁纸、视频特效、鼠标划过都会被当成信息�?
- 图片堆在会话里：历史越长越贵，逐张卸载还会每轮破坏前缀缓存�?

RTA 的做法：**本地永远在采集，但只有通过筛选的画面才进上下文；进上下文的是拼图，不是原图；拼图用完�?`image/offload` 一次性省略；文字（时间轴、圈画、台词、笔记）永久保留�?*

**默认是「推」不是「拉�?*：启用后宿主每步都会重新 assemble 一�?runtime context，RTA 只在
「屏幕状态真的变了」时更新它；文本不变就零消息、零缓存破坏。模型不需要轮询工具就知道用户在看什么�?

---

## 持续注入（启用即注入�?

`rta_start` 之后，注入器�?Hz）把活缓冲渲染成一段短文本，只有在满足节流时才会发布新文本�?

```
〔RTA 屏幕感知 · 自动注入，非用户消息�?
前台：main.js �?Visual Studio Code [Code.exe]
状态：最�?1 分钟内有变化
最�?2 分钟：明显变�?×3 · 持续变化（滚�?播放�?×1
时间线（本地时间）：
- 14:32:10 明显变化（强�?46�?�?窗口「Chrome�?
- 14:33:02 持续变化（滚�?播放�?
需要原始画面：rta_look；更早历史：rta_recall�?
```

两条宿主通道（`src/host/channel.js` 自动探测、可降级）：

| 通道 | 用法 | 内容 | 节流 |
| --- | --- | --- | --- |
| 文字（主�?| `systemPrompt.context({name:'rta:screen', order:205, interpolate:false, text})` | 上面那段文本；宿�?*只在文本变化�?*落一�?`runtime-context` 快照并声明旧快照被取�?| 文本相同不发布；`minIntervalMs=4000`；`maxPerMinute=8` |
| 图片（稀缺） | `agent/pre-step` prepend 追加一�?`plugin:dsh-rta` 消息 | 每轮**首步**最多一张拼图（�? 帧、≤400 tokens），带一句说明文�?| `minIntervalMs=45000`�?0 分钟 �? 张、在�?�? |

设计约束（`docs/review/03-target-architecture.md`）：只追加尾部不改历史、自动流永不唤醒会话�?
单槽替换不排队、文字必带图片稀缺、幂等节流、全部硬封顶。子代理会话会被过滤（只服务绑定会话）�?
注入的图同样�?`image/offload` 预算，不会在会话里堆积�?

---

## 目录

```
src/
  capture/win32.js     GDI BitBlt 抓屏 + 前台窗口/光标/按键查询（koffi �?user32/gdi32�?
  capture/gdi.js       采集 provider（grab / cursor / foreground / keyDown�?
  img/png.js           零依�?PNG 编码（BGRA→RGB，level 3�?
  img/scale.js         下采样（box / 四分位采样）、裁�?
  algo/color.js        HSV 变换、帧差分打分、运动补�?mc、亮度增�?
  algo/rolling.js      滑动分位数（z-score、自适应阈值）
  algo/select.js       四闸门选择器：cut / integral / text / heartbeat + 预算
  algo/tiers.js        拼图档位�?token 估算�?2px 网格�?
  algo/pack.js         拼图合成：贴帧、圈画红框、帧标签
  algo/regions.js      鼠标轨迹圈画 �?bbox / 时间区间
  engine/engine.js     主循环：抓取 �?打分 �?选择 �?存档 �?拼图 �?热键/圈画
  store/paths.js       会话目录布局
  store/store.js       manifest / index.jsonl / 保留�?GC / 墓碑
  store/writer*.js     PNG/JPEG 编码写盘 worker（背压保护）
  record/ffmpeg.js     原生分辨率录像轨（gdigrab + H.264 硬编 + 分段 TS，按时间戳抽帧）
  native/gdiplus.js    GDI+ JPEG 编码（基线帧 ~14�?3KB/帧，0.6ms�?
  native/koffi.js      定位宿主自带�?koffi（不新增依赖�?
  native/gdiplus.js    GDI+ JPEG 编码（基线帧 ~14�?3KB/帧，0.6ms�?
  host/                DSH 宿主胶水：defineTool、offload、service、runtime�?
                       live-buffer（环形活缓冲+digest）、injector（节�?预算）�?
                       channel（systemPrompt.context + agent/pre-step）、lifecycle、messages
  tools/               9 个模型工具（spec + handler�?
bin/rta-run.mjs        headless CLI（不开 DSH 也能测采集与算法�?
bin/rta-smoke.mjs      真机冒烟：起引擎 �?出真拼图 �?文本回捞
test/                  node --test，零依赖
```

## 算法管线

1. **抓取**：每 tick 一�?GDI `BitBlt` 原图（本�?2560×1440 �?22 ms），JS 下采样到 192×108 做哨兵（�?0.3 ms）；�?`archiveFps` 另存 512px 档案帧。默�?`sentinelHz=15`，一次抓取同时供哨兵和档案，CPU �?0.3�?.4 核�?
2. **打分**：HSV 加权差分（色相环形距离、饱和度做权重）+ 亮度增益 + 运动补偿 `mcRatioScore`（�? 邻域匹配，整帧平移≈0�? 滚动 z-score（窗�?300 帧、直方图分位）�?
3. **选择**（四路取并集，互不否决）�?
   - `cut`：`score �?12 && z �?3 && mc �?0.2 && 距上�?�?400ms`
   - `integral`：静默期累积变化 �?阈值（正在持续变化但不是切镜）
   - `text`：文字变化（字幕 / OCR）是硬信号，优先触发
   - `heartbeat`：最�?25 s 静默必给一帧保险帧
   - `manual`：用户圈画，最高优先级
   - `maxPerMinute` 预算封顶；先全量打分、再按预算排序取�?N，不做逐帧二元丢弃�?
4. **呈现**：拼图按 42px 网格出档：单�?800×450 = 233 tokens、四�?1050×630 = 392、八�?1260×756 = 560、十二格 1596×924 = 860。圈画区域按 screen→frame→cell 三段映射画红框和 `R{id}` 标签（元数据叠加，不改像素语义）�?
5. **时间**：每帧记录复合时间戳 `{wall, mono, videoSec?, win{title,process,rect,playing}}`；`index.jsonl` 保留全量索引，可凭时间戳回捞�?
6. **保留**：`endedAt + 24h` 前整场都在；到期只删图片，`index.jsonl`、笔记、圈画坐标、台词、AI 总结永久保留；GC 每小时扫一次，过期整场物理删除并留墓碑�?
7. **存储（录像轨，默认）**�?5Hz 全量原始帧（2560×1440）由 ffmpeg 硬编成分�?MPEG-TS（H.264 QSV，实测约 0.4�?.4 GB/小时；`-g 30` 2 秒关键帧，`flush_packets=1` 让录制中也能读）；时间轴每个 tick 仍写一行索引，�?`video:true, videoMs`（该时刻在视频里的毫秒）。回看时 `rta_recall(images=true)` �?`videoMs` 用混�?seek 抽一帧原�?JPEG�? 秒内�?0.3 s，文字清晰可读）。切�?文字变化时额外落一张原�?JPEG 事件帧，圈画裁切图用 PNG 保证文字锐利。切�?`archiveMode:"jpeg"` 则退化为逐帧 512px 图片�?4�?3KB/�?+ 近重复复用），不需�?ffmpeg�?
8. **图片不堆�?*：`image/offload` 攒到 `imageTrigger=8` 张才动一次手，一次省略到只剩 `imageKeep=3` 张，30 s 节流 —�?只改会话尾部，不逐张改历史�?

## 工具

| 工具 | 作用 |
| --- | --- |
| `rta_start` | 开始一场录制（显式指定时长可稍后加�?|
| `rta_stop` | 结束录制，写�?`retainUntil` |
| `rta_status` | 是否在跑、会�?id、最近分数、帧/事件计数 |
| `rta_look` | 拿最�?`count` 个变化点拼成一张图，附时间轴文�?|
| `rta_region` | 拿用户圈画区域（可指�?regionId），�?bbox 与起止时�?|
| `rta_recall` | 按时间范�?/ 类型回捞历史记录，`images=true` 时最多附 3 张旧�?|
| `rta_note` | 把一句观察写进当前会话的笔记（文字永久保留） |
| `rta_sessions` | 列出历史 RTA 会话与保留期 |
| `rta_purge` | 提前清理已经总结成文字的图片/视频（`keepMinutes` 默认保留 2 分钟，保�?index/notes/annotations；正常保留期仍是 24h�?|

## 配置

`~/.dsh/rta/config.json`（不存在时用默认值）�?

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
      "maxSheetTokens": 400
    }
  }
}
```

## 开�?/ 自测

```bash
node --test test/*.test.mjs        # 42 个离线测试，不抓屏（宿主/沙箱�?spawn 受限时逐文件跑�?
node test/live.test.mjs            # 只跑注入面（live-buffer / injector / channel / lifecycle�?
node bin/rta-run.mjs --seconds=10  # headless：打�?cpu / tickHz / 帧数 / 事件�?/ manifest
node bin/rta-smoke.mjs             # 真机冒烟：起引擎 �?出拼�?�?回捞文本
node _probe/cold_e2e.mjs           # 冷启动端到端：假 ctx 跑真实插件入�?+ 9 个工�?
node bin/rta-sync.mjs              # �?workspace 源码同步到已安装的插件目�?
```

> 在某些受限环境里 `node --test` 会因 test runner 无法给每个测试文�?spawn 子进程而报
> `spawn EPERM`；这不是测试失败，直�?`node test/<name>.test.mjs` 逐个运行即可�?

> 注意：`plugin_manager install_bundle` �?`file:` 安装时，pnpm 留下的是**安装时刻�?
> 硬链接快�?*——运行中�?DSH 读的�?`~/.dsh/profiles/<profile>/node_modules/dsh-rta`�?
> 不是本工作区。改�?`src/` 后：
> 1. `node bin/rta-sync.mjs` 同步源码�?
> 2. 插件页把 dsh-rta 禁用→启用一次（�?`plugin_manager set_bundle`），新模块会被重�?
>    import，即生效（本轮实测，无需重启 DSH；只�?koffi 类型注册这类进程级缓存才需要重启）�?
>
> �?Node 部分（算�?引擎/工具 handler）可以用上面的命令直接验证�?

## 已知限制 / 下一�?

- 采集目前�?GDI；下一步评�?ffmpeg `ddagrab`/DXGI �?CPU 与多屏支持（koffi 已就绪，先不引外部依赖）�?
- OCR 读字（Windows.Media.Ocr，本地零下载）已做可行性验证，待接入自动管线；字幕 / ASR / 视频秒数识别 / 视觉笔记生成随后（设计已定：字幕�?> ASR > 硬字�?OCR；本地只�?OCR 读字，不跑本地小模型）�?
- 热键语义：`Ctrl+Alt` 只在**未启用时**召唤并启用（启用后屏幕状态本来就在自动注入，不需要再召唤）、`Shift+Ctrl+Alt` 圈画、`Ctrl+Tab` 退出本�?RTA、`Esc` 取消正在画的圈。退出后注入器会立刻把「已停止」状态写进上下文，模型不会继续以为在录。召唤通过 `ctx.agents` �?notice 给当前会话（`src/host/summon.js`，source kind �?`plugin:dsh-rta`），真实按键已实测通过�?
- 注入通道依赖宿主能力：有 `systemPrompt.context` 时走文本快照（主通道），�?`agent/pre-step` 时走每轮首步截图；两者都没有时自动降级为�?pull（只保留 `rta_look`）。实测环境：dsh-desktop 0.2.2-rc.1 �?`channel=context+pre-step`�?
- 客户�?UI（悬浮窗、对�?/ 轨迹 tab、插件配置页）未做，按计划后置�?
- �?Windows�?

## 许可

Apache-2.0。部分宿主胶水与算法结构改编�?[dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)（Copyright 2026 SAOS-3624, Apache-2.0），详见 `NOTICE` �?`LICENSE`�?
