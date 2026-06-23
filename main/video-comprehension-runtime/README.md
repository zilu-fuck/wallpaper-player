# 视频理解管线

本地视频理解管线，集成场景检测、ASR、VLM、OCR、YOLO 和 LLM 证据推理。

## 功能特性

- **视频处理**：自动镜头切分、关键帧提取
- **多模态分析**：
  - ASR 语音识别（Faster Whisper）
  - OCR 文字识别（RapidOCR）
  - YOLO 物体检测
  - VLM 视觉理解
- **证据融合**：结构化证据聚合
- **LLM 理解**：基于证据的视频内容分析
- **API 服务**：供播放器或脚本读取分析结果

## 系统架构

```
CLI 输入 → 配置加载 → 视频处理管线 → 证据生成 → LLM 理解 → 结果输出
                                                          ↓
                                                    FastAPI 服务/播放器读取
```

## 安装

### 前置要求

- Python >= 3.13
- FFmpeg（系统路径可访问）
- uv 包管理器

### 安装依赖

```bash
uv sync
```

## 配置

在项目根目录创建 `.env` 文件（可参考 `.env.example`）：

```env
# 视频处理
MAX_DURATION_SECONDS=3600
MODEL_STORAGE_DIR=models

# LLM 配置（OpenAI 兼容）
LLM_PROVIDER=local
LLM_BASE_URL=http://localhost:11434/v1
LLM_NAME=qwen2.5:14b
LLM_API_KEY=sk-xxx

# VLM 配置（OpenAI 兼容）
VLM_PROVIDER=local
VLM_BASE_URL=http://localhost:11434/v1
VLM_NAME=qwen2-vl:7b
VLM_API_KEY=sk-xxx
VLM_MODEL_PATH=models/vlm/qwen2-vl.gguf
VLM_MODEL_DOWNLOAD_URL=
VLM_HF_REPO=
VLM_HF_REVISION=main
VLM_HF_TOKEN=
VLM_SERVER_EXECUTABLE=
VLM_SERVER_ARGS=-m "{modelPath}" --host 127.0.0.1 --port {port}
VLM_CONCURRENCY=4

# 运行模式：fast | balance | quantity
MODE=balance
```

`LLM_PROVIDER` 用于播放器设置页记住“本地文本模型”或“外接大模型 API”的选择，可填写 `local` 或 `api`。管线实际请求仍由 `LLM_BASE_URL`、`LLM_NAME` 和 `LLM_API_KEY` 决定；外接 API 时填写对应服务的 OpenAI 兼容地址、模型名和密钥即可。

`MODEL_STORAGE_DIR` 用于存放本地模型权重和缓存，默认是项目内的 `models` 目录。YOLO 权重会解析到该目录下的 `yolo/yolo11n.pt`，faster-whisper 下载缓存会使用该目录下的 `whisper` 子目录。

`VLM_PROVIDER`、`VLM_MODEL_PATH`、`VLM_MODEL_DOWNLOAD_URL`、`VLM_HF_REPO`、`VLM_HF_REVISION`、`VLM_HF_TOKEN`、`VLM_SERVER_EXECUTABLE` 和 `VLM_SERVER_ARGS` 由播放器设置页管理，用于从 Hugging Face 获取模型文件、下载、配置和启动本地 VLM 服务。管线实际调用仍读取 `VLM_BASE_URL`、`VLM_NAME` 和 `VLM_API_KEY`，因此服务程序必须提供 OpenAI 兼容的图片输入接口。

## 使用方法

### 1. 处理视频

```bash
uv run video-comprehension <视频路径>
```

处理完成后，结果保存在 `outputs/video_<hash>/` 目录下。

### 2. 启动 API 服务

```bash
uv run video-comprehension-api
```

API 服务启动在 `http://127.0.0.1:8000`

### 3. 查看结果

播放器会直接读取 `outputs/video_<hash>/final/result.json` 并展示结果。也可以启动 API 服务后通过 HTTP 接口程序化读取。

## 输出产物

### 最终结果

- `final/result.json`：结构化分析结果
  - 视频摘要
  - 时间线（128+ 段）
  - 人物列表
  - 标签、关键词
  - 剧情概述
  - 命名建议
  - 质量信息
  - 证据引用
- `final/result.md`：Markdown 可读报告

### 中间证据

- `input/input_manifest.json`：输入清单
- `metadata/video_metadata.json`：视频元数据
- `scenes/scenes.json`：镜头切分结果
- `frames/`：关键帧图片 + `keyframes.json`
- `audio/`：音频提取 + ASR 分段
- `ocr/`：OCR 文字识别结果
- `yolo/`：物体检测结果
- `vlm/`：VLM 视觉理解结果
- `evidence/`：原始证据 + 融合证据
- `logs/`：运行日志和错误记录

## API 接口

API 文档：访问 `http://127.0.0.1:8000/docs`

### 主要端点

- `GET /api/tasks` - 获取所有任务列表
- `GET /api/tasks/{task_id}/result` - 获取完整分析结果
- `GET /api/tasks/{task_id}/timeline` - 获取时间线（支持分页）
- `GET /api/tasks/{task_id}/characters` - 获取人物列表
- `GET /api/tasks/{task_id}/frames` - 获取关键帧列表
- `GET /api/tasks/{task_id}/frames/{frame_id}/image` - 获取关键帧图片
- `GET /api/tasks/{task_id}/evidence` - 获取原始证据
- `GET /api/tasks/{task_id}/evidence/fused` - 获取融合证据
- `GET /api/tasks/{task_id}/asr` - 获取 ASR 结果
- `GET /api/tasks/{task_id}/ocr` - 获取 OCR 结果
- `GET /api/tasks/{task_id}/yolo` - 获取 YOLO 结果
- `GET /api/tasks/{task_id}/vlm` - 获取 VLM 结果
- `GET /api/tasks/{task_id}/metadata` - 获取视频元数据
- `GET /api/tasks/{task_id}/quality` - 获取质量信息

## 结果展示内容

### 任务列表/API
- 显示所有已处理视频
- 视频基本信息（文件名、时长、分辨率、帧率）
- 摘要预览
- 处理时间

### 任务详情/播放器面板

#### 概览 Tab
- 视频信息
- 视频摘要
- 标签和关键词
- 质量统计（关键帧数、VLM 分析帧数、ASR 分段数、OCR 检测数）

#### 时间线 Tab
- 完整时间线浏览（128+ 段）
- 每段显示：标题、时间范围、描述、VLM 状态、置信度、证据数量

#### 人物 Tab
- 人物列表（9+ 人）
- 人物信息：姓名、身份状态、描述、出现次数、首次出现时间

#### 关键帧 Tab
- 网格式关键帧浏览
- 点击放大查看
- 显示时间戳

#### 证据 Tab
- 融合证据浏览
- 按镜头聚合的多源证据

## 运行模式

通过 `.env` 的 `MODE` 参数控制：

- **fast**：快速模式，少量 VLM 帧
- **balance**：平衡模式，中等 VLM 帧（推荐）
- **quantity**：质量模式，大量 VLM 帧

## 项目结构

```
video-comprehension/
├── video_comprehension/          # 主包
│   ├── cli.py                    # CLI 入口
│   ├── api.py                    # FastAPI 服务
│   ├── pipeline.py               # 管线编排
│   ├── config.py                 # 配置加载
│   ├── llm_client.py             # LLM/VLM 客户端
│   ├── ffmpeg_tools.py           # FFmpeg 工具
│   ├── events.py                 # 事件日志
│   ├── paths.py                  # 路径管理
│   └── json_io.py                # JSON 读写
├── outputs/                      # 输出目录
│   └── video_<hash>/             # 任务产物
├── docs/                         # 文档
├── tests/                        # 测试
├── .env                          # 运行配置（需创建）
├── .env.example                  # 配置示例
├── pyproject.toml                # 项目配置
└── README.md                     # 本文件
```

## 开发

### 运行测试

```bash
uv run pytest
```

### 代码风格

- 使用中文注释
- 函数顶部注释格式：`# YYYY-MM-DD 功能描述`
- 禁止静默忽略错误
- 数据库访问使用语义而非索引

## 技术栈

### 后端
- **FastAPI**：高性能 Web 框架
- **Uvicorn**：ASGI 服务器
- **Faster Whisper**：语音识别
- **RapidOCR**：文字识别
- **Ultralytics YOLO**：物体检测
- **OpenCV**：图像处理
- **PySceneDetect**：场景检测
- **FFmpeg**：视频处理

### 前端
- **Vue.js 3**：响应式框架
- **Tailwind CSS**：样式框架
- **原生 JavaScript**：无构建依赖

## 性能优化

- **阶段缓存**：避免重复计算
- **并发处理**：VLM/OCR 并发调用
- **自适应代表帧选择**：按信息量选择 VLM 帧
- **播放器集成**：由上层播放器读取最终结果并展示

## 故障排查

### API 服务无法启动

检查端口 8000 是否被占用：
```bash
# Windows
netstat -ano | findstr :8000

# Linux/macOS
lsof -i :8000
```

### API 客户端无法连接

1. 确保 API 服务已启动
2. 检查浏览器控制台的 CORS 错误
3. 确认 API 地址为 `http://127.0.0.1:8000`

### 视频处理失败

1. 检查 `.env` 配置是否正确
2. 查看 `outputs/video_<hash>/logs/pipeline_events.jsonl`
3. 确认 FFmpeg 已安装并在系统路径中

### 本地缺少 VLM 模型或服务

本项目不内置 VLM 模型文件。`.env` 中的 `VLM_BASE_URL` 必须指向一个已启动、支持图片输入的 OpenAI 兼容视觉模型服务。

可选方案：
1. 使用 Ollama 或 LM Studio 启动支持图片输入的视觉模型，例如 Qwen2-VL，并把 `VLM_BASE_URL` 改成对应 `/v1` 地址。
2. 使用 llama.cpp 或其他 OpenAI 兼容服务加载本地 GGUF 视觉模型，并监听 `.env` 中配置的端口。
3. 使用远端视觉模型服务，并填写远端 `VLM_BASE_URL`、`VLM_NAME` 和 `VLM_API_KEY`。

## 许可证

本项目仅供学习和研究使用。

## 更新日志

### v1.0.0 (2026-06-22)
- 初始版本
- 完整视频处理管线
- FastAPI 后端服务
- 播放器/API 结果展示
- 多模态证据融合
- LLM 理解生成
