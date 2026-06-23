# 视频理解管线技术设计

版本：v1.1
日期：2026-06-20

## 1. 设计目标

本文档定义视频理解管线的工程结构、模块职责、执行流程、阶段边界和外部工具接入方式。系统目标是把视频处理、模型分析、证据融合和 LLM 理解分成可验证阶段，并保证任何结论都来自结构化证据。

核心原则：

- CLI 只接收一个本地视频路径
- 运行参数统一来自项目根目录 `.env`
- 不在代码中保留模型地址、模型名称、ASR 参数、YOLO 权重和输出目录的内置配置
- 不提供模型替代路径、模拟数据路径或阶段失败后的继续执行路径
- 任何阶段异常必须显式抛出并写入日志，禁止静默忽略
- LLM 与 VLM 分别使用 `.env` 中的 OpenAI 兼容模型服务配置
- LLM 不直接读取视频、图片或音频，只读取结构化证据

## 2. 总体架构

```text
CLI(video_path)
  ↓
.env 配置加载
  ↓
输入校验
  ↓
FFprobe 元数据解析
  ↓
PySceneDetect 镜头切分
  ↓
FFmpeg 按镜头抽关键帧
  ↓
ASR 语音识别
  ↓
OCR 画面文字提取
  ↓
YOLO 物体检测
  ↓
VLM 自适应代表帧选择
  ↓
VLM 代表帧理解
  ↓
结构化证据 JSON
  ↓
证据融合
  ↓
LLM 基于证据理解
  ↓
result.json / result.md
```

## 3. 运行配置

项目根目录必须存在 `.env`。`.env` 只保留公开运行旋钮，阶段细项由内置默认值和 `MODE` 策略管理：

| 字段 | 说明 |
| --- | --- |
| `MAX_DURATION_SECONDS` | 允许处理的视频时长上限 |
| `MODEL_STORAGE_DIR` | 本地模型权重和缓存目录，默认 `models` |
| `LLM_PROVIDER` | 可选，播放器设置页使用的文本模型来源标记，允许 `local` 或 `api` |
| `LLM_BASE_URL` | LLM OpenAI 兼容模型服务地址 |
| `LLM_NAME` | LLM 模型名称 |
| `LLM_API_KEY` | LLM Bearer 鉴权密钥 |
| `VLM_BASE_URL` | VLM OpenAI 兼容模型服务地址 |
| `VLM_NAME` | VLM 模型名称 |
| `VLM_API_KEY` | VLM Bearer 鉴权密钥 |
| `VLM_CONCURRENCY` | VLM 单帧模型请求并发数 |
| `MODE` | 运行策略，只允许 `fast`、`balance`、`quantity` |

缺少 `.env`、缺少必需字段、出现不支持字段或字段无法解析时，管线直接失败。`LLM_PROVIDER` 仅用于播放器 UI 标记，本身不改变模型请求；实际文本模型请求仍由 `LLM_BASE_URL`、`LLM_NAME` 和 `LLM_API_KEY` 决定。`MODEL_STORAGE_DIR` 影响本地 ASR、OCR、YOLO 等模型权重和缓存位置。输出目录固定为 `outputs`，输出语言固定为 `zh-CN`，任务标识由输入视频自动生成。

## 4. 模块职责

| 模块 | 职责 |
| --- | --- |
| `cli.py` | 解析单个 `video_path` 参数并启动管线 |
| `config.py` | 从 `.env` 加载公开配置并合成运行请求 |
| `pipeline.py` | 编排阶段、构造证据、生成最终结果 |
| `ffmpeg_tools.py` | 调用 FFprobe、FFmpeg 抽音频和抽关键帧 |
| `llm_client.py` | 调用 OpenAI 兼容模型服务 |
| `events.py` | 写入阶段事件、终端进度和结构化错误 |
| `paths.py` | 构造任务产物目录 |
| `json_io.py` | 统一 JSON 读写 |

## 5. 阶段设计

### 5.1 输入校验

输入：

- `video_path`
- `.env` 加载后的任务配置

输出：

- `input/input_manifest.json`

阻断条件：

- 视频文件不存在
- 输入不是文件
- 扩展名不在允许集合内

### 5.2 元数据解析

输入：

- 原始视频
- `input/input_manifest.json`

输出：

- `metadata/video_metadata.json`

阻断条件：

- FFprobe 调用失败
- 视频缺少视频轨
- 时长无效
- 分辨率无效
- 视频时长超过 `.env` 的 `MAX_DURATION_SECONDS`

无音频轨属于输入事实。ASR 阶段会输出空分段，但不会伪造语音证据。

### 5.3 镜头切分

输入：

- 原始视频
- `metadata/video_metadata.json`
- 内置 PySceneDetect 内容切分阈值

输出：

- `scenes/scenes.json`

阻断条件：

- PySceneDetect 调用失败
- PySceneDetect 返回空镜头列表

`detection_source` 固定为 `pyscenedetect`。

### 5.4 关键帧抽取

输入：

- 原始视频
- `scenes/scenes.json`

输出：

- `frames/*.jpg`
- `frames/keyframes.json`

抽帧策略固定为每个镜头抽取一张中点关键帧，`sample_role` 当前固定为 `mid`。这些关键帧全部进入 OCR 和 YOLO，随后由 VLM 代表帧选择阶段决定哪些帧送入 VLM。

所有关键帧 `source` 固定为 `ffmpeg`。

### 5.5 VLM 代表帧选择

输入：

- `frames/keyframes.json`
- `audio/asr_segments.json`
- `ocr/ocr_results.json`
- `yolo/yolo_results.json`
- `.env` 的 `MODE`

输出：

- `vlm/vlm_frame_selection.json`
- `vlm/vlm_frame_selection_cache.json`

选择策略固定为 `adaptive_signal_representative_frames`。管线先从 `MODE` 读取内置代表帧参数，再按视频时长和每分钟帧数计算时长预算，按最低覆盖率计算镜头覆盖预算，取时长预算、覆盖预算和最小帧数三者的最大值，最终只受关键帧总数限制。随后保留视频起止边界帧，并按 OCR 文本量、YOLO 物体量、ASR 覆盖、镜头时长和最小时间间隔选择高信息量代表帧。未被选中的关键帧不会送入 VLM，但会在 `frames` 覆盖项中标记为 `vlm_status=not_analyzed`，并记录最近的已分析 VLM 代表帧。

### 5.6 VLM 分析

输入：

- `vlm/vlm_frame_selection.json`
- 被选中的代表帧图片
- `.env` 的 `VLM_BASE_URL`、`VLM_NAME`、`VLM_API_KEY`、`VLM_CONCURRENCY`

输出：

- `vlm/items/{frame_id}.json`
- `vlm/items/{frame_id}.cache.json`
- `vlm/vlm_results.json`

模型必须返回 JSON 对象，并包含以下字段：

- `description`
- `visible_people`
- `actions`
- `environment`
- `visible_text_hints`
- `objects_hints`
- `mood`
- `confidence`

字段缺失、类型错误或置信度越界时，阶段直接失败。

VLM 按帧并发调用，最大并发数来自 `.env` 的 `VLM_CONCURRENCY`。每个成功帧会先写入 `vlm/items/{frame_id}.json` 和对应缓存元数据，任一帧失败仍会导致阶段失败，但已完成且缓存键匹配的帧不会丢失。

### 5.7 ASR 识别

输入：

- 原始视频
- `metadata/video_metadata.json`
- 内置 ASR 模型规格、设备和计算类型

输出：

- `audio/audio.wav`
- `audio/asr_segments.json`

有音频轨时使用 faster-whisper 识别。无音频轨时写入空数组，表示没有可识别语音输入。

### 5.8 OCR 识别

输入：

- `frames/keyframes.json`
- 关键帧图片
- 内置 OCR 引擎和并发数

输出：

- `ocr/items/{frame_id}.json`
- `ocr/items/{frame_id}.cache.json`
- `ocr/ocr_results.json`

OCR 使用独立引擎 `rapidocr_onnxruntime`，不得复用 VLM 响应或由 VLM 生成 OCR 结果。引擎返回的四点坐标会规范为 `{x1,y1,x2,y2}`，文本类型当前写入 `unknown`。

OCR 按帧并发调用，最大并发数来自内置配置。每个成功帧会先写入 `ocr/items/{frame_id}.json` 和对应缓存元数据，任一帧失败仍会导致阶段失败，但已完成且缓存键匹配的帧不会丢失。

### 5.9 YOLO 检测

输入：

- `frames/keyframes.json`
- 关键帧图片
- 内置 YOLO 权重路径

输出：

- `yolo/yolo_results.json`
- `yolo/yolo_model.json`

YOLO 结果只作为物体证据，不直接生成剧情、人物身份或系列信息。

### 5.9 证据标准化

输入：

- 元数据
- 镜头列表
- 关键帧列表
- VLM 结果
- ASR 结果
- OCR 结果
- YOLO 结果

输出：

- `evidence/evidence.json`

要求：

- 每条证据包含 `evidence_id`
- 每条证据包含时间范围
- 每条证据包含来源引用
- 每条证据包含模型或工具信息
- 证据置信度来自上游真实结果
- 写入 `evidence.json` 前校验证据结构、时间范围、来源类型和证据 ID 唯一性

### 5.10 证据融合

输入：

- `evidence/evidence.json`

输出：

- `evidence/fused_evidence.json`

融合逻辑按镜头时间范围聚合多源证据，保留 ASR 文本、OCR 文本、画面摘要、物体列表和人物候选。

### 5.11 LLM 结果生成

输入：

- 视频元数据
- 融合证据
- 结构化证据摘要
- `.env` 的输出语言与模型配置

输出：

- 最终结构化结果对象

LLM 最终理解阶段使用 OpenAI 兼容 function call。function tools 只用于向程序查询证据上下文，例如读取视频元数据、读取融合片段、按来源读取证据、按证据 ID 读取证据。工具不得承载最终输出字段。

最终结果必须由普通 `message.content` 返回 JSON 对象，并包含：

- `summary`
- `timeline`
- `characters`
- `tags`
- `keywords`
- `plot`
- `naming`

字段缺失、类型错误、工具调用参数无法解析、请求未注册工具或最终 JSON 无法解析时，阶段直接失败。`timeline` 参数应为空数组，最终时间线由融合证据生成。

命名结果会融合文件名解析、OCR/ASR 文本证据和 LLM 的 `naming` 建议；证据不足时保留原始文件名。
最终结果写入前会校验顶层字段、时间线、人物、命名、质量摘要和证据引用。人物身份状态必须属于 `visible_person`、`candidate_character`、`confirmed_character`。

### 5.12 结果导出

输入：

- 最终结构化结果对象

输出：

- `final/result.json`
- `final/result.md`

JSON 与 Markdown 必须来自同一份结果对象。

## 6. 错误处理策略

管线只区分成功和失败。阶段失败时：

- 异常向上传递
- 阶段日志写入 `logs/pipeline_events.jsonl`，并同步打印到终端
- 结构化错误可写入 `logs/errors.json`
- 不生成伪造证据
- 不生成替代模型结果
- 不继续执行依赖该阶段产物的后续阶段

无音频轨不是阶段错误，而是输入元数据事实。对应 ASR 输出为空数组。

## 7. 阶段缓存策略

阶段缓存只用于严格复用已验证产物，不作为失败后的替代路径。缓存命中必须同时满足：

- 阶段缓存键一致
- 相关产物文件存在
- 缓存键包含视频哈希、阶段配置和上游产物哈希

当前写入的缓存元数据包括：

- `metadata/metadata_cache.json`
- `scenes/scenes_cache.json`
- `frames/frames_cache.json`
- `audio/asr_cache.json`
- `vlm/vlm_cache.json`
- `ocr/ocr_cache.json`
- `yolo/yolo_cache.json`
- `evidence/evidence_cache.json`
- `evidence/fused_evidence_cache.json`

缓存不命中时阶段正常重新执行。缓存文件损坏、缓存键不匹配或产物缺失时不得复用。

## 8. 当前入口

```text
uv run video-comprehension <video_path>
```

除 `<video_path>` 外，所有运行配置均来自 `.env`。
