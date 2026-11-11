# RTA — Real Time Accompaniment

给 DSH 装一双实时的眼睛和一张嘴：**看见屏幕 → 本地算法筛选 → 只把有信息的画面交给会话模型 → 图片用完即省略、文字长期保留**。

当前状态：**后端层（采集 / 打分 / 选择 / 拼图 / 录像 / 存储 / 工具）已跑通**，22 个单测（10 算法 + 5 引擎 + 6 插件）全过，headless 引擎可独立运行。
UI/UX（悬浮窗、对话 / 轨迹面板、插件配置页）按计划放在下一阶段。

平台：Windows 10/11（GDI + koffi 调 Win32）。插件侧只依赖 `@deepseek-ai/dsh-tools`（可选）。

---

## 它解决什么问题

- 固定帧率把画面丢给模型：慢、贵、token 爆炸。
- 只按「变化大」筛选：动态壁纸、视频特效、鼠标划过都会被当成信息。
- 图片堆在会话里：历史越长越贵，逐张卸载还会每轮破坏前缀缓存。

RTA 的做法：**本地永远在采集，但只有通过筛选的画面才进上下文；进上下文的是拼图，不是原图；拼图用完由 `image/offload` 一次性省略；文字（时间轴、圈画、台词、笔记）永久保留。**

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
  host/                DSH 宿主胶水：defineTool、offload、service、runtime
  tools/               8 个模型工具（spec + handler）
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
7. **存储（录像轨，默认）**：15Hz 全量原始帧（2560×1440）由 ffmpeg 硬编成分段 MPEG-TS（H.264 QSV，实测约 0.4–1.4 GB/小时；`-g 30` 2 秒关键帧，`flush_packets=1` 让录制中也能读）；时间轴每个 tick 仍写一行索引，记 `video:true, videoMs`（该时刻在视频里的毫秒）。回看时 `rta_recall(images=true)` 按 `videoMs` 用混合 seek 抽一帧原生 JPEG（8 秒内约 0.3 s，文字清晰可读）。切镜/文字变化时额外落一张原生 JPEG 事件帧，圈画裁切图用 PNG 保证文字锐利。切到 `archiveMode:"jpeg"` 则退化为逐帧 512px 图片（14–23KB/帧 + 近重复复用），不需要 ffmpeg。
8. **图片不堆积**：`image/offload` 攒到 `imageTrigger=8` 张才动一次手，一次省略到只剩 `imageKeep=3` 张，30 s 节流 —— 只改会话尾部，不逐张改历史。

## 工具

| 工具 | 作用 |
| --- | --- |
| `rta_start` | 开始一场录制（显式指定时长可稍后加） |
| `rta_stop` | 结束录制，写入 `retainUntil` |
| `rta_status` | 是否在跑、会话 id、最近分数、帧/事件计数 |
| `rta_look` | 拿最近 `count` 个变化点拼成一张图，附时间轴文字 |
| `rta_region` | 拿用户圈画区域（可指定 regionId），附 bbox 与起止时间 |
| `rta_recall` | 按时间范围 / 类型回捞历史记录，`images=true` 时最多附 3 张旧图 |
| `rta_note` | 把一句观察写进当前会话的笔记（文字永久保留） |
| `rta_sessions` | 列出历史 RTA 会话与保留期 || `rta_sessions` | 列出历史 RTA 会话与保留期 |
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
  "maxSheetTokens": 560
}
```

## 开发 / 自测

```bash
node --test test/*.test.mjs        # 19 个离线测试，不抓屏
node bin/rta-run.mjs --seconds=10  # headless：打印 cpu / tickHz / 帧数 / 事件数 / manifest
node bin/rta-smoke.mjs             # 真机冒烟：起引擎 → 出拼图 → 回捞文本
node _probe/cold_e2e.mjs           # 冷启动端到端：假 ctx 跑真实插件入口 + 8 个工具
node bin/rta-sync.mjs              # 把 workspace 源码同步到已安装的插件目录
```

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
- 热键语义：`Ctrl+Alt` 召唤一次并持续启用（未启用时生效，启用中不重复召唤）、`Shift+Ctrl+Alt` 圈画、`Ctrl+Tab` 退出本次 RTA、`Esc` 取消正在画的圈。召唤通过 `ctx.agents` 推 notice 给当前会话（`src/host/summon.js`，source kind 用 `plugin:dsh-rta`），真实按键已实测通过。
- 客户端 UI（悬浮窗、对话 / 轨迹 tab、插件配置页）未做，按计划后置。
- 仅 Windows。

## 许可

Apache-2.0。部分宿主胶水与算法结构改编自 [dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)（Copyright 2026 SAOS-3624, Apache-2.0），详见 `NOTICE` 与 `LICENSE`。
