# LLM 视频理解管线需求规格说明书

版本：v1.1
日期：2026-06-20

## 1. 目标

建设一套完整的视频理解管线。用户输入单个本地视频文件后，系统通过元数据解析、镜头切分、关键帧抽取、视觉理解、语音识别、画面文字提取、物体检测和结构化证据融合，最终由 LLM 基于证据生成视频介绍、时间线、人物、标签、关键词、归一化文件名、系列名、剧情和剧集信息。

系统目标不是让 LLM 直接读取视频后自由生成结论，而是让各类模型先产生可追溯、可校验、带时间码的结构化证据，再由 LLM 基于证据进行归纳、命名和整理。

## 2. 输入与配置

### 2.1 命令行输入

CLI 只接收一个参数：

```text
uv run video-comprehension <video_path>
```

`video_path` 必须指向本地视频文件。

支持的视频扩展名：

- MP4
- MOV
- MKV
- AVI

### 2.2 运行配置

除视频路径外，公开运行旋钮必须来自项目根目录 `.env`。底层阶段细项由代码内置默认值和 `MODE` 运行策略管理，避免 `.env` 暴露过多低层参数。

`.env` 必须包含：

- `MAX_DURATION_SECONDS`
- `LLM_BASE_URL`
- `LLM_NAME`
- `LLM_API_KEY`
- `VLM_BASE_URL`
- `VLM_NAME`
- `VLM_API_KEY`
- `VLM_CONCURRENCY`
- `MODE`

`.env` 允许包含可选的 `LLM_PROVIDER`，取值为 `local` 或 `api`，用于播放器设置页记住文本模型来源。管线不依赖该字段做分支，实际文本模型请求仍由 `LLM_BASE_URL`、`LLM_NAME` 和 `LLM_API_KEY` 决定。

`.env` 允许包含可选的 `MODEL_STORAGE_DIR`，用于配置本地模型权重和缓存目录。默认播放器会使用子项目 `models` 目录，用户可在设置中改到其他磁盘位置。

`MODE` 只能是 `fast`、`balance` 或 `quantity`。缺少 `.env`、缺少必需字段、出现不支持字段或字段无法解析时，任务必须失败。

## 3. 输出范围

系统最终输出结构化结果，至少包含：

- 视频介绍
- 视频时间线
- 视频人物
- 标签
- 关键词
- 归一化文件名
- 系列名
- 剧集编号
- 剧情摘要
- 证据引用
- 置信度
- 处理日志摘要

输出结果同时支持 JSON 和 Markdown。JSON 用于程序读取，Markdown 用于人工审阅。

## 4. 总体流程

```text
输入视频
  ↓
.env 配置加载
  ↓
视频元数据解析
  ↓
PySceneDetect 切镜头
  ↓
FFmpeg 按镜头抽关键帧
  ↓
ASR 提取语音
  ↓
OCR 提取字幕和画面文字
  ↓
YOLO 提取物体
  ↓
基于 ASR / OCR / YOLO 选择 VLM 自适应代表帧
  ↓
VLM 分析自适应代表帧
  ↓
生成结构化证据 JSON
  ↓
证据融合
  ↓
LLM 基于证据理解
  ↓
输出视频介绍、时间线、人物、标签、关键词、命名信息和剧情信息
```

阶段失败时任务失败，不生成替代证据，不继续执行依赖该阶段产物的后续阶段。

## 5. 功能需求

### 5.1 视频输入与校验

系统应支持用户提交本地视频路径。任务启动后，需要执行以下校验：

- 文件是否存在
- 文件是否可读取
- 文件格式是否可被 FFmpeg 解析
- 视频时长是否有效
- 是否存在视频轨
- 视频时长是否超过 `MAX_DURATION_SECONDS`

缺少音频轨属于输入事实。ASR 阶段应输出空分段，其他视觉相关阶段继续执行。

### 5.2 视频元数据解析

系统应调用 FFprobe 获取视频元数据，元数据需要写入任务基础信息中。

元数据至少包含：

- `file_path`
- `original_filename`
- `file_hash`
- `duration_seconds`
- `width`
- `height`
- `fps`
- `video_codec`
- `audio_codec`
- `audio_stream_count`
- `video_stream_count`
- `format_name`
- `created_at`

### 5.3 镜头切分

系统应使用 PySceneDetect 进行镜头切分，输出镜头列表。

每个镜头至少包含：

- `scene_id`
- `index`
- `start_time`
- `end_time`
- `duration`
- `start_frame`
- `end_frame`
- `detection_source`
- `confidence`

`detection_source` 固定为 `pyscenedetect`。PySceneDetect 报错或返回空镜头列表时，任务必须失败。

### 5.4 关键帧抽取

系统应使用 FFmpeg 按镜头抽取关键帧。

当前抽帧策略：

- 每个镜头抽取一张中点关键帧
- `sample_role` 当前固定为 `mid`
- 每张关键帧记录所属镜头、时间戳、图片路径、尺寸和来源

每张关键帧需要记录：

- `frame_id`
- `scene_id`
- `timestamp`
- `image_path`
- `sample_role`
- `source`
- `width`
- `height`
- `dedupe_group_id`

### 5.5 VLM 自适应代表帧分析

系统应将自适应代表帧输入支持图片输入的 OpenAI 兼容 VLM 服务，提取画面语义。VLM 与 LLM 使用独立 `.env` 配置，文本模型不得冒充 VLM。

代表帧选择必须在 ASR、OCR 和 YOLO 产物生成后执行。OCR 和 YOLO 必须覆盖全部关键帧；VLM 只处理 `MODE` 内置策略约束下选出的代表帧，代表帧数量只受关键帧总数限制。

VLM 结果至少包含：

- `description`
- `visible_people`
- `actions`
- `environment`
- `visible_text_hints`
- `objects_hints`
- `mood`
- `confidence`

字段缺失、类型错误或置信度越界时，任务必须失败。VLM 输出不得作为唯一事实来源直接写入最终结论，必须保留对应帧和时间码作为证据引用。

### 5.6 ASR 语音识别

系统应从视频中提取音频，并使用 faster-whisper 执行 ASR。

ASR 结果至少包含：

- `segment_id`
- `start_time`
- `end_time`
- `text`
- `language`
- `speaker_id`
- `confidence`
- `model`

如后续接入说话人分离，ASR 结果应扩展 `speaker_id` 字段。

### 5.7 OCR 文字识别

系统应对关键帧执行 OCR，用于提取字幕、标题、屏幕文字和标牌文字。OCR 当前由同一本地多模态模型完成。

OCR 结果至少包含：

- `ocr_id`
- `frame_id`
- `timestamp`
- `text`
- `bbox`
- `text_type`
- `confidence`
- `model`

`text_type` 只能是 `subtitle`、`title`、`label`、`unknown`。字段缺失、类型错误或置信度越界时，任务必须失败。

### 5.8 YOLO 物体检测

系统应使用 Ultralytics YOLO 对关键帧进行物体检测。

物体检测结果至少包含：

- `detection_id`
- `frame_id`
- `timestamp`
- `class_name`
- `bbox`
- `confidence`
- `model`

YOLO 结果用于补充画面证据，不应替代 VLM 的事件理解能力。

### 5.9 结构化证据生成

系统应将 VLM、ASR、OCR 和 YOLO 统一整理为结构化证据 JSON。

每条证据必须包含：

- `evidence_id`
- `task_id`
- `source_type`
- `time_range`
- `content`
- `confidence`
- `source_ref`
- `model_name`
- `model_version`
- `created_at`

涉及画面区域的证据需要包含 `bbox`。涉及文件资源的证据需要包含 `file_path`。

### 5.10 证据融合

系统应基于时间轴对不同来源的证据进行融合。

融合规则：

- 同一时间段内的 ASR、OCR、VLM 和 YOLO 证据应聚合到统一片段
- 重复文本应合并
- 冲突结论应保留来源，不得静默覆盖
- 低置信度证据应保留置信度，不得主导最终结论
- 最终结论应尽量引用多个来源的证据

### 5.11 LLM 证据理解

LLM 阶段应仅基于结构化证据生成结果。

LLM 需要完成：

- 视频整体介绍
- 时间线整理
- 人物归纳
- 标签生成
- 关键词生成
- 归一化文件名生成
- 系列名推断
- 剧集编号推断
- 剧情摘要生成

LLM 输出需要带置信度和证据引用。字段缺失、类型错误、时间线数量不匹配或 JSON 解析失败时，任务必须失败。

## 6. 数据结构要求

### 6.1 证据 JSON 示例

```json
{
  "task_id": "video_xxx",
  "video": {
    "original_filename": "input.mp4",
    "file_hash": "sha256-value",
    "duration_seconds": 1234.56,
    "width": 1920,
    "height": 1080,
    "fps": 25.0
  },
  "scenes": [],
  "keyframes": [],
  "evidence": [
    {
      "evidence_id": "ev_vlm_xxx",
      "source_type": "vlm",
      "time_range": {
        "start": 4.2,
        "end": 4.2
      },
      "content": {
        "description": "室内场景中，两名人物正在交谈"
      },
      "confidence": 0.82,
      "source_ref": {
        "frame_id": "scene_0001_mid"
      },
      "model_name": "model-name",
      "model_version": "local",
      "created_at": "2026-06-20T00:00:00+08:00"
    }
  ],
  "errors": []
}
```

### 6.2 最终输出 JSON 示例

```json
{
  "task_id": "video_xxx",
  "source_video": {
    "original_filename": "input.mp4",
    "file_hash": "sha256-value",
    "duration_seconds": 1234.56,
    "width": 1920,
    "height": 1080,
    "fps": 25.0
  },
  "summary": "视频整体介绍文本",
  "timeline": [
    {
      "start_time": 0.0,
      "end_time": 8.4,
      "title": "片段标题",
      "description": "片段内容描述",
      "evidence_refs": ["ev_vlm_xxx"],
      "confidence": 0.86
    }
  ],
  "characters": [],
  "tags": ["对话", "室内"],
  "keywords": ["主要人物", "场景转换"],
  "naming": {
    "normalized_filename": "input.mp4",
    "series_name": null,
    "season_number": null,
    "episode_number": null,
    "episode_code": null,
    "episode_title": null,
    "extension": "mp4",
    "confidence": 1.0,
    "evidence_refs": []
  },
  "plot": "剧情摘要文本",
  "quality": {
    "overall_confidence": 0.78,
    "has_audio": true,
    "has_ocr_text": true,
    "has_detected_people": false,
    "stage_success_rate": 1.0
  },
  "processing_log_summary": {},
  "evidence_refs": ["ev_vlm_xxx"],
  "errors": []
}
```

## 7. 人物识别边界

人物相关输出需要区分“可见人物”“疑似角色”和“已确认人物”。

- 可见人物：由画面检测或 VLM 描述得到
- 疑似角色：由多次出现、服饰、位置、行为和台词聚合得到
- 已确认人物：由字幕、语音、片头片尾、文件名或人工输入信息明确支撑

没有明确证据时，系统不得将视觉描述直接当作真实姓名。

## 8. 命名与系列推断

归一化文件名应基于系列名、季、集、标题和语言等信息生成。

命名推断来源优先级：

1. 文件名中的明确系列和集数信息
2. OCR 识别到的片头、片尾、标题卡信息
3. ASR 中出现的节目或剧集信息
4. 人工输入信息
5. LLM 基于证据的低置信度推断

归一化文件名遵循内置文件名模板。

当系列名或剧集编号证据不足时，应保留原始文件名主体，并在输出中体现置信度。

## 9. 非功能需求

### 9.1 可追溯性

最终输出中的重要结论必须能追溯到证据 ID。包括视频介绍、时间线、人物、标签、关键词、剧情和命名信息。

### 9.2 阶段产物

系统应支持阶段性产物落盘。每个任务应生成独立输出目录，便于审阅和问题定位。

阶段产物允许严格缓存复用。缓存命中必须同时满足缓存键匹配和产物文件存在，缓存键应包含视频哈希、阶段配置和上游产物哈希。

### 9.3 可配置性

以下配置应通过 `.env` 调整：

- 切镜阈值
- 长视频上限
- 模型服务地址
- 模型名称
- 模型请求超时
- 模型请求并发数
- 模型输出 token 限制
- ASR 模型规格
- ASR 运行设备
- ASR 计算类型
- YOLO 权重
- 输出语言
- 命名模板

### 9.4 错误处理

任何阶段发生错误都必须记录。系统不得静默忽略错误。

错误记录至少包含：

- 阶段名称
- 错误类型
- 错误信息
- 输入资源
- 发生时间
- 是否影响最终输出

阶段失败时任务失败，不生成替代结果。

### 9.5 性能要求

长视频处理需要支持：

- 时长限制
- 阶段日志
- 资源占用限制
- 每镜头单张中点关键帧
- VLM 自适应代表帧
- VLM 和 OCR 单帧缓存
- VLM 和 OCR 并发请求
- 任务产物审阅

## 10. 验收标准

系统完成一次视频处理后，应满足以下标准：

- 能读取视频并生成元数据
- 能生成镜头列表
- 能按镜头生成关键帧
- 能生成 VLM、ASR、OCR 和 YOLO 证据
- 能输出统一结构化证据 JSON
- 能生成最终理解结果 JSON
- 时间线中的每个片段都有时间范围
- 重要结论带有证据引用
- 失败阶段有明确错误记录
- CLI 只接收视频路径
- 运行配置只来自 `.env`
- 模型字段缺失或类型错误时任务失败

## 11. 风险与约束

### 11.1 时间轴对齐风险

ASR、OCR、VLM 和 YOLO 的时间粒度不同，融合时可能出现偏差。系统需要以统一时间轴进行对齐，并保留原始时间信息。

### 11.2 人物归因风险

仅凭画面难以确认真实人物身份。人物输出必须使用置信度和证据引用，不得把弱推断写成确定事实。

### 11.3 LLM 幻觉风险

LLM 可能补充证据中不存在的信息。提示词和输出校验必须限制 LLM 仅基于证据生成内容。

### 11.4 成本与耗时风险

长视频会产生大量帧、音频片段和模型调用。系统需要通过抽帧策略、时长限制和分阶段运行控制成本。

### 11.5 OCR 与 ASR 冲突风险

字幕、画面文字和语音内容可能不一致。系统应保留来源差异，并在融合结果中标记冲突。

## 12. 后续增强方向

- 命名字段接入人工输入信息
- 人脸检测、人物聚类、说话人分离和角色归并
- JSON schema 或 Pydantic 严格校验
- 任务队列
- 审阅界面
