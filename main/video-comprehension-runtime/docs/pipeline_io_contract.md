# 视频理解管线输入输出契约

版本：v1.1
日期：2026-06-20

## 1. 契约目标

本文档定义视频理解管线的输入、运行配置、阶段产物、结构化证据和最终输出格式。管线只接受本地视频文件作为命令行输入，其他运行参数必须来自项目根目录 `.env`。

LLM 的直接输入不是原始视频，而是经过解析、检测、识别、融合后的结构化证据。

## 2. 顶层输入

CLI 只接收一个参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `video_path` | string | 是 | 本地视频文件路径 |

支持的视频扩展名：

- `mp4`
- `mov`
- `mkv`
- `avi`

运行命令：

```text
uv run video-comprehension <video_path>
```

## 3. `.env` 运行配置

项目根目录必须存在 `.env`。字段缺失或无法解析时，管线启动失败。

```env
MAX_DURATION_SECONDS=1800
MODEL_STORAGE_DIR=models
LLM_PROVIDER=api
LLM_BASE_URL=https://api.deepseek.com
LLM_NAME=deepseek-v4-flash
LLM_API_KEY=replace-with-your-llm-api-key
VLM_BASE_URL=http://127.0.0.1:5803
VLM_NAME=Huihui-Qwen3.5-9B-Claude-4.6-Opus-abliterated.Q5_K_M.gguf
VLM_API_KEY=local-placeholder
VLM_CONCURRENCY=4
MODE=balance
```

`MODEL_STORAGE_DIR` 用于配置本地模型权重和缓存目录。`LLM_PROVIDER` 可选，用于播放器设置页标记文本模型来源，允许 `local` 或 `api`。管线实际请求仍由 `LLM_BASE_URL`、`LLM_NAME` 和 `LLM_API_KEY` 决定。`.env` 只允许以上字段，出现其他字段时，管线必须在启动阶段失败。

## 4. 任务目录产物

```text
outputs/
  {task_id}/
    input/
      input_manifest.json
    metadata/
      video_metadata.json
      metadata_cache.json
    scenes/
      scenes.json
      scenes_cache.json
    frames/
      scene_0001_mid.jpg
      keyframes.json
      frames_cache.json
    audio/
      audio.wav
      asr_segments.json
      asr_cache.json
    ocr/
      items/
        scene_0001_mid.json
        scene_0001_mid.cache.json
      ocr_results.json
      ocr_cache.json
    vlm/
      items/
        scene_0001_mid.json
        scene_0001_mid.cache.json
      vlm_frame_selection.json
      vlm_frame_selection_cache.json
      vlm_results.json
      vlm_cache.json
    yolo/
      yolo_results.json
      yolo_model.json
      yolo_cache.json
    evidence/
      evidence.json
      fused_evidence.json
      evidence_cache.json
      fused_evidence_cache.json
    final/
      result.json
      result.md
    logs/
      pipeline_events.jsonl
      errors.json
```

`errors.json` 只在记录结构化错误时出现。

`*_cache.json` 为阶段缓存元数据。缓存命中需要缓存键匹配且产物文件存在。

## 5. 阶段输入输出

### 5.1 视频校验阶段

输出文件：

- `input/input_manifest.json`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `task_id` | string | 任务标识 |
| `video_path` | string | 视频路径 |
| `exists` | boolean | 文件是否存在 |
| `readable` | boolean | 文件是否可读取 |
| `extension` | string | 文件扩展名 |
| `file_size_bytes` | integer | 文件大小 |
| `file_hash` | string | 文件哈希 |
| `created_at` | string | 创建时间 |

### 5.2 元数据阶段

输出文件：

- `metadata/video_metadata.json`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `duration_seconds` | number | 视频时长 |
| `file_path` | string | 视频路径 |
| `original_filename` | string | 原始文件名 |
| `file_hash` | string | 文件哈希 |
| `width` | integer | 视频宽度 |
| `height` | integer | 视频高度 |
| `fps` | number | 帧率 |
| `video_codec` | string | 视频编码 |
| `audio_codec` | string 或 null | 音频编码 |
| `audio_stream_count` | integer | 音频轨数量 |
| `video_stream_count` | integer | 视频轨数量 |
| `format_name` | string | 容器格式 |
| `created_at` | string | 生成时间 |
| `probe_raw` | object | 原始探测结果 |

### 5.3 镜头切分阶段

输出文件：

- `scenes/scenes.json`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `scene_id` | string | 镜头标识 |
| `index` | integer | 镜头序号 |
| `start_time` | number | 开始时间，单位秒 |
| `end_time` | number | 结束时间，单位秒 |
| `duration` | number | 持续时长，单位秒 |
| `start_frame` | integer | 起始帧 |
| `end_frame` | integer | 结束帧 |
| `detection_source` | string | 固定为 `pyscenedetect` |
| `confidence` | number 或 null | 切分置信信息 |

### 5.4 关键帧抽取阶段

输出文件：

- `frames/*.jpg`
- `frames/keyframes.json`

抽帧策略固定为每个镜头抽取一张中点关键帧，`sample_role` 当前固定为 `mid`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `frame_id` | string | 关键帧标识 |
| `scene_id` | string | 所属镜头 |
| `timestamp` | number | 帧时间，单位秒 |
| `image_path` | string | 图片路径 |
| `sample_role` | string | 当前固定为 `mid` |
| `source` | string | 当前为 `ffmpeg` |
| `width` | integer | 图片宽度 |
| `height` | integer | 图片高度 |
| `dedupe_group_id` | string 或 null | 去重分组标识 |

### 5.5 VLM 阶段

输出文件：

- `vlm/vlm_frame_selection.json`
- `vlm/vlm_frame_selection_cache.json`
- `vlm/items/{frame_id}.json`
- `vlm/items/{frame_id}.cache.json`
- `vlm/vlm_results.json`

VLM 不再默认处理全部关键帧。管线会先完成 ASR、OCR 和 YOLO，再基于镜头边界、OCR 文本量、YOLO 物体量、ASR 覆盖和最小时间间隔选择代表帧。OCR 和 YOLO 仍处理全部关键帧，VLM 只处理 `vlm_frame_selection.selected_frame_ids` 中的代表帧。

`vlm/items/{frame_id}.json` 为单帧结果缓存，`vlm/items/{frame_id}.cache.json` 记录对应缓存键。阶段失败时，已经成功且缓存键匹配的单帧结果会保留，下一次运行可继续复用。

`vlm_frame_selection.json` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `strategy` | string | 固定为 `adaptive_signal_representative_frames` |
| `config` | object | 代表帧选择配置 |
| `total_keyframes` | integer | 全部关键帧数量 |
| `selected_frame_ids` | array | 送入 VLM 的代表帧标识 |
| `frames` | array | 每个关键帧的 VLM 覆盖状态 |

`frames` 中每个条目包含：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `frame_id` | string | 关键帧标识 |
| `scene_id` | string | 所属镜头 |
| `timestamp` | number | 帧时间 |
| `vlm_status` | string | `analyzed` 或 `not_analyzed` |
| `nearest_vlm_frame_id` | string 或 null | 最近的已分析 VLM 代表帧 |
| `nearest_vlm_timestamp` | number 或 null | 最近代表帧时间 |
| `vlm_selection_reason` | string | 选择或未选择原因 |
| `vlm_selection_score` | number | 代表帧选择分数 |
| `vlm_selection_signals` | object | 选择使用的 OCR、YOLO、ASR 和镜头信号 |

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `frame_id` | string | 来源帧 |
| `timestamp` | number | 帧时间 |
| `scene_id` | string | 所属镜头 |
| `description` | string | 画面描述 |
| `visible_people` | array | 可见人物描述 |
| `actions` | array | 动作线索 |
| `environment` | string | 场景环境 |
| `visible_text_hints` | array | 可见文字线索 |
| `objects_hints` | array | 显著物体线索 |
| `mood` | string 或 null | 氛围线索 |
| `confidence` | number | 置信度，范围 0 到 1 |
| `model` | object | 模型信息 |

### 5.6 ASR 阶段

输出文件：

- `audio/audio.wav`
- `audio/asr_segments.json`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `segment_id` | string | 语音分段标识 |
| `start_time` | number | 开始时间 |
| `end_time` | number | 结束时间 |
| `text` | string | 识别文本 |
| `language` | string 或 null | 语言 |
| `speaker_id` | string 或 null | 说话人标识 |
| `confidence` | number 或 null | 置信度 |
| `model` | object | 模型信息 |

无音频轨时，`asr_segments.json` 为 `[]`。

### 5.7 OCR 阶段

输出文件：

- `ocr/items/{frame_id}.json`
- `ocr/items/{frame_id}.cache.json`
- `ocr/ocr_results.json`

`ocr/items/{frame_id}.json` 为单帧结果缓存，`ocr/items/{frame_id}.cache.json` 记录对应缓存键。阶段失败时，已经成功且缓存键匹配的单帧结果会保留，下一次运行可继续复用。

OCR 使用内置独立引擎 `rapidocr_onnxruntime` 执行。OCR 不复用 VLM 响应，也不由 VLM 生成文字识别结果。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ocr_id` | string | OCR 结果标识 |
| `frame_id` | string | 来源帧 |
| `timestamp` | number | 时间戳 |
| `text` | string | 识别文本 |
| `bbox` | object 或 null | 画面区域 |
| `text_type` | string | `subtitle`、`title`、`label`、`unknown` |
| `confidence` | number | 置信度，范围 0 到 1 |
| `model` | object | 模型信息 |

### 5.8 YOLO 阶段

输出文件：

- `yolo/yolo_results.json`
- `yolo/yolo_model.json`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `detection_id` | string | 检测结果标识 |
| `frame_id` | string | 来源帧 |
| `timestamp` | number | 时间戳 |
| `class_name` | string | 物体类别 |
| `bbox` | object | 边界框 |
| `confidence` | number | 置信度 |
| `model` | object | 模型信息 |

## 6. 统一结构化证据

输出文件：

- `evidence/evidence.json`

顶层结构：

```json
{
  "task_id": "video_xxx",
  "video": {},
  "stages": [],
  "scenes": [],
  "keyframes": [],
  "evidence": [],
  "errors": []
}
```

单条证据：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `evidence_id` | string | 是 | 证据标识 |
| `task_id` | string | 是 | 任务标识 |
| `source_type` | string | 是 | `vlm`、`asr`、`ocr`、`yolo` |
| `time_range` | object | 是 | 证据对应时间范围 |
| `content` | object | 是 | 证据正文 |
| `confidence` | number 或 null | 是 | 置信度 |
| `source_ref` | object | 是 | 来源资源引用 |
| `model_name` | string 或 null | 是 | 模型名称 |
| `model_version` | string 或 null | 是 | 模型版本 |
| `created_at` | string | 是 | 生成时间 |

## 7. 融合证据

输出文件：

- `evidence/fused_evidence.json`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `segment_id` | string | 是 | 融合片段标识 |
| `start_time` | number | 是 | 开始时间 |
| `end_time` | number | 是 | 结束时间 |
| `scene_ids` | array | 是 | 覆盖的镜头 |
| `evidence_refs` | array | 是 | 引用证据 |
| `asr_text` | string | 否 | 语音文本 |
| `ocr_text` | string | 否 | 画面文字 |
| `visual_summary` | string | 否 | 画面摘要 |
| `objects` | array | 否 | 物体列表 |
| `people_candidates` | array | 否 | 人物候选 |
| `vlm_status` | string | 是 | 该片段是否有 VLM 直接分析 |
| `nearest_vlm_frame_id` | string 或 null | 否 | 最近的已分析 VLM 代表帧 |
| `nearest_vlm_timestamp` | number 或 null | 否 | 最近代表帧时间 |
| `vlm_selection_reason` | string | 是 | VLM 代表帧选择原因 |
| `conflicts` | array | 否 | 冲突记录 |
| `confidence` | number | 是 | 融合置信度 |

## 8. 最终输出

输出文件：

- `final/result.json`
- `final/result.md`

最终 LLM 可通过 function tools 查询程序侧证据上下文。工具只用于读取证据，不承载最终输出字段；最终结果必须由普通 `message.content` 返回 JSON 对象。

`result.json` 顶层结构：

```json
{
  "task_id": "video_xxx",
  "source_video": {},
  "summary": "",
  "timeline": [],
  "characters": [],
  "tags": [],
  "keywords": [],
  "naming": {},
  "plot": "",
  "quality": {},
  "processing_log_summary": {},
  "evidence_refs": [],
  "errors": []
}
```

### 8.1 `source_video`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `original_filename` | string | 是 | 原始文件名 |
| `file_hash` | string | 是 | 文件哈希 |
| `duration_seconds` | number | 是 | 视频时长 |
| `width` | integer | 是 | 视频宽度 |
| `height` | integer | 是 | 视频高度 |
| `fps` | number | 是 | 帧率 |

### 8.2 `timeline`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `start_time` | number | 是 | 开始时间 |
| `end_time` | number | 是 | 结束时间 |
| `title` | string | 是 | 片段标题 |
| `description` | string | 是 | 片段描述 |
| `evidence_refs` | array | 是 | 引用证据 |
| `vlm_status` | string | 是 | `analyzed` 或 `not_analyzed` |
| `nearest_vlm_frame_id` | string 或 null | 否 | 最近的已分析 VLM 代表帧 |
| `nearest_vlm_timestamp` | number 或 null | 否 | 最近代表帧时间 |
| `vlm_selection_reason` | string | 是 | VLM 代表帧选择原因 |
| `confidence` | number | 是 | 置信度 |

### 8.3 `characters`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `character_id` | string | 是 | 人物标识 |
| `name` | string 或 null | 是 | 人物名称，证据不足时为空 |
| `identity_status` | string | 是 | `visible_person`、`candidate_character`、`confirmed_character` |
| `description` | string | 是 | 外观、行为和出现位置 |
| `appearances` | array | 是 | 出现时间段 |
| `evidence_refs` | array | 是 | 引用证据 |
| `confidence` | number | 是 | 置信度 |

### 8.4 `naming`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `normalized_filename` | string | 是 | 归一化文件名 |
| `series_name` | string 或 null | 是 | 系列名 |
| `season_number` | integer 或 null | 是 | 季编号 |
| `episode_number` | integer 或 null | 是 | 集编号 |
| `episode_code` | string 或 null | 是 | 例如 `S01E01` |
| `episode_title` | string 或 null | 是 | 标题 |
| `extension` | string | 是 | 文件扩展名 |
| `confidence` | number | 是 | 命名置信度 |
| `evidence_refs` | array | 是 | 命名证据 |

命名结果融合文件名解析、OCR/ASR 文本证据和 LLM 的 `naming` 建议。系列名、季集和标题证据不足时，`normalized_filename` 保留原始文件名。

### 8.5 `key_moments`

关键节点由程序基于融合证据确定，不由 LLM 自由生成。每条关键节点必须能追溯到已有证据 ID。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `start_time` | number | 是 | 关键节点开始时间 |
| `end_time` | number | 是 | 关键节点结束时间 |
| `title` | string | 是 | 节点标题 |
| `reason` | string | 是 | 入选原因 |
| `score` | number | 是 | 节点评分，范围 0 到 1 |
| `evidence_refs` | array | 是 | 引用证据 |
| `signals` | object | 是 | 评分使用的 VLM、ASR、OCR、物体、人物候选和置信度信号 |

### 8.6 `quality`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `overall_confidence` | number | 是 | 总体置信度 |
| `has_audio` | boolean | 是 | 是否有音频 |
| `has_ocr_text` | boolean | 是 | 是否提取到画面文字 |
| `has_detected_people` | boolean | 是 | 是否检测到人物 |
| `vlm_analyzed_segment_count` | integer | 是 | 有 VLM 直接分析的片段数 |
| `vlm_total_segment_count` | integer | 是 | 总片段数 |
| `vlm_coverage_rate` | number | 是 | VLM 直接分析片段占比 |
| `stage_success_rate` | number | 是 | 阶段成功率 |

### 8.6 `processing_log_summary`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `started_at` | string | 是 | 任务开始时间 |
| `finished_at` | string 或 null | 是 | 任务结束时间 |
| `elapsed_seconds` | number 或 null | 是 | 总耗时 |
| `stage_statuses` | array | 是 | 各阶段状态摘要 |
| `llm` | object | 是 | LLM 服务信息 |
| `vlm` | object | 是 | VLM 服务信息 |
| `ocr` | object | 是 | OCR 服务信息 |
| `asr` | object | 是 | ASR 服务信息 |
| `yolo` | object | 是 | YOLO 服务信息 |
| `error_count` | integer | 是 | 错误数量 |

## 9. 错误与状态契约

阶段事件写入 `logs/pipeline_events.jsonl`，并同步打印到终端，便于观察长任务进度。

| 状态 | 说明 |
| --- | --- |
| `running` | 正在执行 |
| `success` | 执行成功 |
| `error` | 执行失败 |

结构化错误对象：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `error_id` | string | 是 | 错误标识 |
| `stage` | string | 是 | 阶段名称 |
| `severity` | string | 是 | `error` 或 `fatal` |
| `message` | string | 是 | 错误信息 |
| `input_ref` | object | 否 | 相关输入 |
| `created_at` | string | 是 | 发生时间 |
| `recoverable` | boolean | 是 | 当前严格管线中应为 `false` |
| `affects_final_output` | boolean | 是 | 当前严格管线中应为 `true` |

## 10. LLM 输入契约

LLM 阶段只能接收：

- 视频元数据
- `evidence/fused_evidence.json`
- 压缩后的 `evidence/evidence.json`
- 输出语言

提示词必须要求模型：

- 只基于输入证据生成内容
- 不输出推理过程
- 不补充证据外事实
- 返回严格 JSON
- 时间线条目数量与融合片段数量一致

## 11. 契约确认

稳定输入：

- CLI 的 `video_path`
- 项目根目录 `.env`

稳定输出：

- `final/result.json`
- `final/result.md`
- `evidence/evidence.json`
- `evidence/fused_evidence.json`

阶段失败即任务失败，不生成替代结果。
