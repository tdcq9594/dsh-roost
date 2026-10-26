# TTS 与翻唱：现成方案调研

> 结论先说：**TTS 值得集成，翻唱不该塞进插件。**

---

## 一、TTS：能直接集成

### 候选方案

| 方案 | 类型 | 中文效果 | 依赖 | 许可 |
|---|---|---|---|---|
| **edge-tts** | Python 包 | 好（微软 Edge 的朗读接口） | 只要 Python | MIT / GPL 混合，实际是逆向封装 |
| Windows SAPI | 系统内置 | 机械 | 零依赖 | 系统自带 |
| **GPT-SoVITS** | 开源模型 | 很好，可克隆音色 | 要 PyTorch，建议 GPU | MIT |
| **ChatTTS** | 开源模型 | 好，对话感强 | 要 PyTorch | AGPL |
| **CosyVoice**（阿里） | 开源模型 | 很好，可克隆 | 要 PyTorch | Apache-2.0 |
| Azure Speech / 火山 / 阿里云 | 云服务 | 很好 | API Key + 花钱 | 商业 |

### Aurabot 怎么做的（可直接照搬）

`src/voice/tts.js` 的注释写得很直白：

```
首选：edge-tts（微软在线朗读，音色好），装在插件自己的 Python 虚拟环境里，不污染系统
兜底：Windows 自带的中文语音（System.Speech / Huihui），什么都不装也能用
管线：文字 → TTS → 文件路径。任何一步失败就退回发文字。
```

具体做法：
1. 建一个私有 venv（`~/Aurabot/pyenv`），`pip install edge-tts`
2. `spawn` 调 `python -m edge_tts --text ... --voice zh-CN-XiaoxiaoNeural --write-media out.mp3`
3. 拿 mp3 → `buildWav` 包装 → 发出去

**这个方案我们完全可以照做**，而且我们有优势：DSH 插件能直接 spawn 进程。

### 我们该怎么集成（比 Aurabot 更省事）

Aurabot 用 **Python 的 edge-tts**（要建 venv、pip install、spawn 进程）。
查下来发现 **npm 上有纯 Node 的实现**，对我们更合适——不用 Python、不用 venv：

| 包 | 版本 | 依赖 | 说明 |
|---|---|---|---|
| **`@andresaya/edge-tts`** | 1.9.1 | `ws`, `commander` | **首选**，活跃维护，直接 WebSocket 连微软 |
| `msedge-tts` | 2.1.1 | `ws`, `axios` 等 | 备选，依赖多一点 |
| `edge-tts`（Python） | — | Python | Aurabot 用的这个，要 venv |

用法大概是：

```js
import { EdgeTTS } from '@andresaya/edge-tts'
const tts = new EdgeTTS()
await tts.synthesize('你好呀', 'zh-CN-XiaoxiaoNeural')
await tts.toFile('./out.mp3')
```

**代价**：多一个 npm 依赖（`ws`）。换来的是「装上就能用」，不用管 Python 环境。
真装不上再退回 Python 版或 Windows SAPI。

### 管线

```
文字 → @andresaya/edge-tts → mp3 → msg.replyVoice(mp3)
              ↓ 失败
        Windows SAPI → wav → replyVoice
              ↓ 也失败
        退回发文字（不能让用户什么都收不到）
```

**要先验证一件事**：官方 QQ 的语音消息到底吃不吃 mp3。
框架的 `replyVoice` 是按 `fileType=3` 上传的，但官方文档说语音要 silk。
真机测一下就知道——如果只吃 silk，中间加一步 `mp3 → silk` 转换
（有 `silk-v3-decoder` / `pilk` 这类工具）。

**工作量**：一个 `tts.js`（~120 行）+ 一个配置项（音色、开关）。

---

## 二、翻唱：不该塞进插件

### Aurabot 的管线有多重

看它的文件就知道：

```
src/song/studio.js                     45 KB   ← 整个翻唱流程
src/song/netease.js                     4 KB   ← 网易云下载伴奏
src/song/separator/                    模型    ← BS-RoFormer 人声分离（几百 MB）
src/song/fetch_file.py                  4 KB
src/song/zip.js                         2 KB
test/song.test.js                      11 KB
```

管线是：**下载原曲 → 人声分离（BS-RoFormer）→ RVC 换声 → 混音 → 输出**。

每一步都要模型：
- **BS-RoFormer**：人声/伴奏分离，模型几百 MB，跑一次几十秒
- **RVC**：音色转换，模型几十到几百 MB，**基本要 GPU**
- 还要 ffmpeg

### 为什么不该塞进 DSH 插件

1. **体积**：几个 GB 的模型，塞进一个 npm 包不现实
2. **算力**：RVC 在 CPU 上跑一首歌要几分钟到十几分钟，插件进程会被拖死
3. **依赖**：Python + PyTorch + ffmpeg + CUDA，装起来能劝退 90% 的人
4. **它不是「聊天」**：聊天是毫秒级的事，翻唱是分钟级的批处理

### 该怎么做

**做成独立服务，插件只调 HTTP。**

现成的、能直接用的：

| 项目 | 干什么 |
|---|---|
| [RVC-Project/Retrieval-based-Voice-Conversion-WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) | RVC 换声，自带 WebUI 和 API |
| [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) | 人声分离，效果最好的 GUI 方案 |
| [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | 音色克隆（TTS 和翻唱都能用） |

它们都是本地跑、有 API 的。所以我们的集成方式是：

```
DSH 插件 → HTTP → 本地 RVC 服务（用户自己跑）
         ← 音频文件 ←
```

插件里只写「调接口 + 发文件」，几十行。**模型和算力留在服务里**。

### 结论

| | 做不做 | 方式 |
|---|---|---|
| **TTS** | ✅ 做 | 插件内集成 edge-tts + SAPI 兜底 |
| **翻唱** | ⏸ 不做进插件 | 留一个「翻唱服务地址」配置，用户自己跑 RVC |

---

## 三、其他几个（顺手记一下）

| 功能 | 参考 | 我们怎么做 |
|---|---|---|
| **消息合并** | Aurabot `merge.*` 四档时间参数 | 照抄思路，加在 ai-chat 的 `handle()` 前 |
| **图片理解** | Aurabot 把图转 base64 当 image 块 | payload 传图，dsh-roost 构造 image 块 |
| **人格库** | Aurabot `personas[]` + `current` | 配置里放数组，按群覆盖 |
| **表情包库** | Aurabot `stickers.match(query)` | 目录 + 索引，把清单写进提示词 |
| **主动搭话** | Aurabot `speakUp` | 定时任务 + ai-chat 暴露主动发消息接口 |
