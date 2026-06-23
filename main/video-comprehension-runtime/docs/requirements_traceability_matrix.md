# 视频理解管线需求追踪矩阵

版本：v1.1
日期：2026-06-20

## 1. 目标

本文档用于确认视频理解管线需求是否被当前实现和输入输出契约覆盖。追踪口径以当前代码为准：CLI 只接收视频路径，运行配置来自 `.env`，阶段失败直接阻断。

## 2. 状态定义

| 状态 | 含义 |
| --- | --- |
| 已覆盖 | 当前契约和实现已有对应字段、产物或校验 |
| 待细化 | 字段位置已明确，但实现规则还需增强 |
| 待决策 | 需要用户确认后才能继续设计 |

## 3. 顶层输入输出追踪

| 需求编号 | 需求项 | 契约落点 | 产物文件 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- | --- |
| IO-001 | 输入本地视频文件 | `video_path` | `input/input_manifest.json` | 校验路径存在、可读取、扩展名合法 | 已覆盖 |
| IO-002 | 支持 MP4、MOV、MKV、AVI | 支持格式列表 | `input/input_manifest.json` | 使用扩展名和 FFprobe 结果校验 | 已覆盖 |
| IO-003 | 公开运行配置来自 `.env` | `.env` 字段表 | `PipelineRequest` | 缺少 `.env`、必需字段或出现不支持字段时失败 | 已覆盖 |
| IO-004 | 生成唯一任务标识 | `task_id` | 所有阶段产物 | 按输入视频自动生成任务标识 | 已覆盖 |
| IO-005 | 记录文件名、大小、哈希、时长、分辨率、帧率、音轨和编码 | `input_manifest`、`video_metadata`、`source_video` | `input/input_manifest.json`、`metadata/video_metadata.json`、`final/result.json` | 校验字段来自文件探测结果 | 已覆盖 |
| IO-006 | 输出 JSON 和 Markdown | `final/result.json`、`final/result.md` | `final/result.json`、`final/result.md` | 校验两个文件都生成且内容同源 | 已覆盖 |
| IO-007 | 输出视频介绍、时间线、人物、标签、关键词、命名和剧情信息 | `summary`、`timeline`、`characters`、`tags`、`keywords`、`naming`、`plot` | `final/result.json` | 校验字段存在、类型正确、关键结论带证据引用 | 已覆盖 |

## 4. 阶段流程追踪

| 需求编号 | 需求项 | 契约落点 | 产物文件 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- | --- |
| PIPE-001 | 视频元数据解析 | 元数据阶段 | `metadata/video_metadata.json` | 使用 FFprobe 读取并校验字段完整性 | 已覆盖 |
| PIPE-002 | PySceneDetect 切镜头 | 镜头切分阶段 | `scenes/scenes.json` | 校验 `scene_id`、时间范围、帧范围和来源 | 已覆盖 |
| PIPE-003 | 切镜失败时阻断任务 | 严格失败策略 | `logs/pipeline_events.jsonl` | 构造异常输入，确认无替代镜头产物 | 已覆盖 |
| PIPE-004 | FFmpeg 按镜头抽关键帧 | 关键帧抽取阶段 | `frames/*.jpg`、`frames/keyframes.json` | 校验关键帧文件存在且时间戳落在镜头范围内 | 已覆盖 |
| PIPE-005 | VLM 分析自适应代表帧 | VLM 代表帧选择和 VLM 阶段 | `vlm/vlm_frame_selection.json`、`vlm/vlm_results.json` | 校验 VLM 只处理 `selected_frame_ids` 且每条结果引用代表帧 | 已覆盖 |
| PIPE-006 | ASR 提取语音 | ASR 阶段 | `audio/audio.wav`、`audio/asr_segments.json` | 校验音频文件和分段文本时间范围 | 已覆盖 |
| PIPE-007 | 无音频时输出空 ASR 证据集合 | ASR 阶段 | `audio/asr_segments.json` | 使用无音频视频校验输出为空数组 | 已覆盖 |
| PIPE-008 | OCR 提取字幕和画面文字 | OCR 阶段 | `ocr/ocr_results.json` | 校验文本、时间戳、区域和来源帧 | 已覆盖 |
| PIPE-009 | YOLO 提取物体 | YOLO 阶段 | `yolo/yolo_results.json` | 校验物体类别、置信度、边界框和来源帧 | 已覆盖 |
| PIPE-010 | 生成结构化证据 JSON | 统一结构化证据 | `evidence/evidence.json` | 校验每条证据包含统一字段 | 已覆盖 |
| PIPE-011 | 证据融合 | 融合证据 | `evidence/fused_evidence.json` | 校验同一时间段多源证据聚合 | 已覆盖 |
| PIPE-012 | LLM 基于证据理解 | LLM 输入契约 | `final/result.json`、`final/result.md` | 校验 LLM 输入只包含元数据和证据 | 已覆盖 |

## 5. 结构化证据追踪

| 需求编号 | 需求项 | 契约落点 | 产物文件 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- | --- |
| EVD-001 | 证据包含唯一 `evidence_id` | 单条证据结构 | `evidence/evidence.json` | JSON 字段校验和重复 ID 校验 | 已覆盖 |
| EVD-002 | 证据包含 `task_id` | 单条证据结构 | `evidence/evidence.json` | JSON 字段校验 | 已覆盖 |
| EVD-003 | 证据包含 `source_type` | 单条证据结构 | `evidence/evidence.json` | 校验枚举值合法 | 已覆盖 |
| EVD-004 | 证据包含 `time_range` | 单条证据结构 | `evidence/evidence.json` | 校验开始时间不大于结束时间 | 已覆盖 |
| EVD-005 | 证据包含 `content` | 单条证据结构 | `evidence/evidence.json` | 校验不同来源内容结构 | 已覆盖 |
| EVD-006 | 证据包含 `confidence` | 单条证据结构 | `evidence/evidence.json` | 校验数值范围或空值规则 | 已覆盖 |
| EVD-007 | 证据包含 `source_ref` | 单条证据结构 | `evidence/evidence.json` | 校验引用资源存在 | 已覆盖 |
| EVD-008 | 证据包含模型名称和版本 | `model_name`、`model_version` | `evidence/evidence.json` | 校验模型信息随证据写入 | 已覆盖 |

## 6. 最终结果追踪

| 需求编号 | 需求项 | 契约落点 | 产物文件 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- | --- |
| OUT-001 | 视频整体介绍 | `summary` | `final/result.json`、`final/result.md` | 校验介绍存在且引用融合证据 | 已覆盖 |
| OUT-002 | 视频时间线 | `timeline` | `final/result.json`、`final/result.md` | 校验每个片段包含时间范围、证据引用和 VLM 覆盖状态 | 已覆盖 |
| OUT-003 | 视频人物 | `characters` | `final/result.json` | 校验人物身份状态、出现时间和证据引用 | 已覆盖 |
| OUT-004 | 标签 | `tags` | `final/result.json` | 校验数组存在 | 已覆盖 |
| OUT-005 | 关键词 | `keywords` | `final/result.json` | 校验数组存在 | 已覆盖 |
| OUT-006 | 归一化文件名 | `naming.normalized_filename` | `final/result.json` | 文件名、OCR、ASR 和 LLM 命名建议融合后按模板生成 | 已覆盖 |
| OUT-007 | 系列名 | `naming.series_name` | `final/result.json` | 从文件名、OCR、ASR 和 LLM 命名建议提取 | 已覆盖 |
| OUT-008 | 季集信息 | `naming.season_number`、`naming.episode_number`、`naming.episode_code` | `final/result.json` | 从文件名、OCR、ASR 和 LLM 命名建议提取 | 已覆盖 |
| OUT-009 | 剧情摘要 | `plot` | `final/result.json`、`final/result.md` | 校验摘要只基于时间线和证据 | 已覆盖 |
| OUT-010 | 总体置信度 | `quality.overall_confidence` | `final/result.json` | 校验数值范围 | 已覆盖 |
| OUT-010A | VLM 覆盖率 | `quality.vlm_coverage_rate` | `final/result.json` | 校验 VLM 直接分析片段数和总片段数 | 已覆盖 |
| OUT-011 | 证据引用 | `evidence_refs` | `final/result.json` | 校验引用 ID 存在于证据文件 | 已覆盖 |
| OUT-012 | 最终结果契约校验 | `result.json` 顶层和子结构 | `final/result.json` | 写入前校验字段、类型、置信度和证据引用 | 已覆盖 |

## 7. 非功能需求追踪

| 需求编号 | 需求项 | 契约落点 | 产物文件 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- | --- |
| NFR-001 | 重要结论可追溯 | `evidence_refs` | `evidence/evidence.json`、`final/result.json` | 校验引用 ID 可反查证据 | 已覆盖 |
| NFR-002 | 阶段产物落盘 | 任务目录产物 | `outputs/{task_id}/` | 校验阶段文件存在 | 已覆盖 |
| NFR-003 | 切镜、模型和输出语言可配置 | `.env` | `PipelineRequest` | 校验配置生效 | 已覆盖 |
| NFR-004 | 错误不得静默忽略 | 阶段异常和事件日志 | `logs/pipeline_events.jsonl` | 注入阶段错误并校验异常抛出 | 已覆盖 |
| NFR-005 | 禁止替代路径 | 严格失败策略 | 阶段产物 | 阶段异常时不生成替代结果 | 已覆盖 |
| NFR-006 | 长视频资源限制 | `MAX_DURATION_SECONDS` | 元数据阶段 | 超过限制时失败 | 已覆盖 |
| NFR-007 | 阶段缓存复用 | `*_cache.json` | 各阶段产物目录 | 缓存键匹配且产物存在时复用，不匹配时重新执行 | 已覆盖 |
| NFR-008 | 控制关键帧模型调用量 | 每镜头单张中点关键帧和自适应 VLM 代表帧 | `frames/keyframes.json`、`vlm/vlm_frame_selection.json` | 校验 OCR/YOLO 覆盖全部关键帧，VLM 只处理代表帧 | 已覆盖 |
| NFR-009 | VLM 和 OCR 支持失败后续跑 | 单帧缓存 | `vlm/items/{frame_id}.json`、`ocr/items/{frame_id}.json` | 单帧失败时已完成帧先落盘，阶段仍失败 | 已覆盖 |
| NFR-010 | VLM 和 OCR 支持并发请求 | `VLM_CONCURRENCY` 和内置 OCR 并发 | `PipelineRequest` | 校验 VLM 并发随 `.env` 加载，OCR 使用内置并发 | 已覆盖 |
| NFR-011 | VLM 代表帧选择策略可切换 | `MODE` | `PipelineRequest` | 校验 `fast`、`balance`、`quantity` 三档策略影响代表帧预算 | 已覆盖 |

## 8. 验收追踪

| 验收编号 | 验收项 | 契约检查点 | 验收方式 | 状态 |
| --- | --- | --- | --- | --- |
| ACC-001 | 能读取视频并生成元数据 | `input_manifest`、`video_metadata` | 使用样例视频执行元数据阶段 | 已覆盖 |
| ACC-002 | 能生成镜头列表 | `scenes/scenes.json` | 校验镜头数组非空 | 已覆盖 |
| ACC-003 | 能按镜头生成关键帧 | `frames/keyframes.json`、`frames/*.jpg` | 校验图片文件存在 | 已覆盖 |
| ACC-004 | 能生成 VLM、ASR、OCR 和 YOLO 证据 | 各模型阶段产物、`evidence.json` | 使用真实模型输出校验证据统一化 | 已覆盖 |
| ACC-005 | 能输出统一结构化证据 JSON | `evidence/evidence.json` | JSON 字段校验 | 已覆盖 |
| ACC-006 | 能生成最终理解结果 JSON | `final/result.json` | JSON 字段校验 | 已覆盖 |
| ACC-007 | 时间线每个片段都有时间范围 | `timeline.start_time`、`timeline.end_time` | 校验字段和时间顺序 | 已覆盖 |
| ACC-008 | 重要结论带证据引用 | `evidence_refs` | 校验引用完整性 | 已覆盖 |
| ACC-009 | 失败阶段阻断任务 | 阶段异常 | 注入错误并校验任务失败 | 已覆盖 |
| ACC-010 | CLI 只保留视频路径参数 | `cli.py` | `uv run video-comprehension --help` | 已覆盖 |

## 9. 当前结论

当前契约覆盖核心视频理解流程、真实模型接入、统一证据、最终结果和严格失败策略。

后续可继续增强：

- 人物聚类和角色归并
- JSON schema 或 Pydantic 严格校验
- 任务队列和审阅界面
