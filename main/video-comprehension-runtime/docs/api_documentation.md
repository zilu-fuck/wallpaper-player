# API 文档

视频理解管线 RESTful API 接口文档。

## 基础信息

- **Base URL**: `http://127.0.0.1:8000`
- **版本**: v1.0.0
- **响应格式**: JSON
- **字符编码**: UTF-8

## 通用响应格式

### 成功响应
```json
{
  "data": { ... }
}
```

### 错误响应
```json
{
  "detail": "错误描述"
}
```

HTTP 状态码：
- `200 OK` - 请求成功
- `404 Not Found` - 资源不存在
- `500 Internal Server Error` - 服务器错误

## API 端点

### 1. 获取 API 信息

```http
GET /
```

**响应示例**：
```json
{
  "name": "视频理解管线 API",
  "version": "1.0.0",
  "endpoints": {
    "tasks": "/api/tasks",
    "result": "/api/tasks/{task_id}/result",
    "timeline": "/api/tasks/{task_id}/timeline",
    "characters": "/api/tasks/{task_id}/characters",
    "evidence": "/api/tasks/{task_id}/evidence",
    "frames": "/api/tasks/{task_id}/frames",
    "frame_image": "/api/tasks/{task_id}/frames/{frame_id}/image"
  }
}
```

---

### 2. 任务管理

#### 2.1 获取任务列表

```http
GET /api/tasks
```

**响应示例**：
```json
{
  "tasks": [
    {
      "task_id": "video_b1acbf4a1bf3",
      "source_video": {
        "original_filename": "示例视频.mp4",
        "file_hash": "02ed35f270f988a298467c5806acb339fd6e6fccee3e89377f0906a194b27a8a",
        "duration_seconds": 1376.5,
        "width": 1920,
        "height": 1080,
        "fps": 30.0
      },
      "summary": "视频摘要...",
      "created_at": 1782046697.9013927
    }
  ]
}
```

#### 2.2 获取任务完整结果

```http
GET /api/tasks/{task_id}/result
```

**路径参数**：
- `task_id` (string) - 任务 ID

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "source_video": { ... },
  "summary": "视频摘要",
  "timeline": [ ... ],
  "characters": [ ... ],
  "tags": [ ... ],
  "keywords": [ ... ],
  "plot": "剧情描述",
  "naming": { ... },
  "quality": { ... },
  "evidence_summary": { ... }
}
```

---

### 3. 时间线

#### 3.1 获取时间线

```http
GET /api/tasks/{task_id}/timeline
```

**查询参数**：
- `limit` (integer, 可选) - 返回条数限制
- `offset` (integer, 默认 0) - 偏移量

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "total": 128,
  "offset": 0,
  "limit": 20,
  "timeline": [
    {
      "start_time": 0.0,
      "end_time": 15.066688,
      "title": "0.00s 片段",
      "description": "片段描述",
      "evidence_refs": ["ev_vlm_xxx", "ev_asr_xxx"],
      "vlm_status": "analyzed",
      "nearest_vlm_frame_id": "scene_0001_mid",
      "nearest_vlm_timestamp": 7.533,
      "vlm_selection_reason": "video_start_boundary",
      "confidence": 0.882
    }
  ]
}
```

---

### 4. 人物

#### 4.1 获取人物列表

```http
GET /api/tasks/{task_id}/characters
```

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "characters": [
    {
      "character_id": "char_001",
      "name": "亨利",
      "identity_status": "confirmed_character",
      "description": "主角，穿越到宋朝的波西米亚人",
      "appearance_count": 45,
      "first_appearance_time": 0.0,
      "evidence_refs": ["ev_vlm_xxx"]
    }
  ]
}
```

**人物身份状态**：
- `visible_person` - 可见人物
- `candidate_character` - 候选角色
- `confirmed_character` - 确认角色

---

### 5. 关键帧

#### 5.1 获取关键帧列表

```http
GET /api/tasks/{task_id}/frames
```

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "frames": [
    {
      "frame_id": "scene_0001_mid",
      "scene_id": "scene_0001",
      "timestamp": 7.533,
      "image_path": "outputs/video_b1acbf4a1bf3/frames/scene_0001_mid.jpg",
      "sample_role": "mid",
      "source": "ffmpeg",
      "width": 1920,
      "height": 1080,
      "dedupe_group_id": null
    }
  ]
}
```

#### 5.2 获取关键帧图片

```http
GET /api/tasks/{task_id}/frames/{frame_id}/image
```

**路径参数**：
- `task_id` (string) - 任务 ID
- `frame_id` (string) - 关键帧 ID

**响应**：
- Content-Type: `image/jpeg`
- 返回图片二进制数据

---

### 6. 证据

#### 6.1 获取原始证据

```http
GET /api/tasks/{task_id}/evidence
```

**查询参数**：
- `evidence_id` (string, 可选) - 查询特定证据

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "evidences": [
    {
      "evidence_id": "ev_vlm_8449523a0a",
      "source_type": "vlm",
      "time_range": {
        "start_time": 0.0,
        "end_time": 15.066688
      },
      "content": { ... },
      "confidence": 0.92,
      "model_info": {
        "model_name": "qwen2-vl:7b"
      }
    }
  ]
}
```

#### 6.2 获取融合证据

```http
GET /api/tasks/{task_id}/evidence/fused
```

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "segments": [
    {
      "segment_id": "fused_scene_0001",
      "start_time": 0.0,
      "end_time": 15.066688,
      "scene_ids": ["scene_0001"],
      "evidence_refs": ["ev_vlm_xxx", "ev_asr_xxx"],
      "vlm_status": "analyzed",
      "nearest_vlm_frame_id": "scene_0001_mid",
      "nearest_vlm_timestamp": 7.533
    }
  ]
}
```

---

### 7. 元数据

#### 7.1 获取视频元数据

```http
GET /api/tasks/{task_id}/metadata
```

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "duration_seconds": 1376.5,
  "width": 1920,
  "height": 1080,
  "fps": 30.0,
  "has_audio": true,
  "video_codec": "h264",
  "audio_codec": "aac"
}
```

#### 7.2 获取镜头切分结果

```http
GET /api/tasks/{task_id}/scenes
```

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "scenes": [
    {
      "scene_id": "scene_0001",
      "start_time": 0.0,
      "end_time": 15.066688,
      "duration": 15.066688
    }
  ],
  "detection_source": "pyscenedetect"
}
```

---

### 8. 多模态分析结果

#### 8.1 获取 ASR 结果

```http
GET /api/tasks/{task_id}/asr
```

**查询参数**：
- `start_time` (float, 可选) - 起始时间
- `end_time` (float, 可选) - 结束时间

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "total": 705,
  "filtered": 50,
  "segments": [
    {
      "segment_id": "asr_0001",
      "start_time": 0.0,
      "end_time": 2.5,
      "text": "识别的文本内容",
      "language": "zh",
      "confidence": 0.95
    }
  ]
}
```

#### 8.2 获取 OCR 结果

```http
GET /api/tasks/{task_id}/ocr
```

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "frames": [
    {
      "frame_id": "scene_0001_mid",
      "detections": [
        {
          "text": "检测到的文字",
          "bbox": {
            "x1": 100,
            "y1": 200,
            "x2": 300,
            "y2": 250
          },
          "confidence": 0.89,
          "text_type": "unknown"
        }
      ]
    }
  ]
}
```

#### 8.3 获取 YOLO 结果

```http
GET /api/tasks/{task_id}/yolo
```

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "frames": [
    {
      "frame_id": "scene_0001_mid",
      "detections": [
        {
          "class_name": "person",
          "confidence": 0.95,
          "bbox": {
            "x1": 500,
            "y1": 300,
            "x2": 700,
            "y2": 900
          }
        }
      ]
    }
  ],
  "model_info": {
    "model_name": "yolov8n.pt"
  }
}
```

#### 8.4 获取 VLM 结果

```http
GET /api/tasks/{task_id}/vlm
```

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "frames": [
    {
      "frame_id": "scene_0001_mid",
      "description": "画面描述",
      "visible_people": ["人物1", "人物2"],
      "actions": ["动作描述"],
      "environment": "环境描述",
      "visible_text_hints": "可见文字",
      "objects_hints": "物体描述",
      "mood": "氛围描述",
      "confidence": 0.92
    }
  ]
}
```

#### 8.5 获取 VLM 代表帧选择计划

```http
GET /api/tasks/{task_id}/vlm/selection
```

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "strategy": "adaptive_signal_representative_frames",
  "total_keyframes": 128,
  "selected_frames": 92,
  "budget_params": {
    "mode": "balance",
    "max_frames_per_minute": 4,
    "min_coverage_rate": 0.6,
    "min_frames": 10
  },
  "selected_frame_ids": ["scene_0001_mid", "scene_0003_mid"]
}
```

---

### 9. 质量信息

#### 9.1 获取质量信息

```http
GET /api/tasks/{task_id}/quality
```

**响应示例**：
```json
{
  "task_id": "video_b1acbf4a1bf3",
  "quality": {
    "total_keyframes": 128,
    "vlm_analyzed_segment_count": 92,
    "asr_segment_count": 705,
    "ocr_detection_count": 5086,
    "yolo_detection_count": 386,
    "has_audio": true,
    "audio_coverage_rate": 0.95,
    "vlm_coverage_rate": 0.72,
    "character_detection_count": 9
  }
}
```

---

## 使用示例

### Python

```python
import requests

BASE_URL = "http://127.0.0.1:8000"

# 获取任务列表
response = requests.get(f"{BASE_URL}/api/tasks")
tasks = response.json()["tasks"]

# 获取第一个任务的结果
task_id = tasks[0]["task_id"]
result = requests.get(f"{BASE_URL}/api/tasks/{task_id}/result").json()

# 获取时间线（分页）
timeline = requests.get(
    f"{BASE_URL}/api/tasks/{task_id}/timeline",
    params={"limit": 20, "offset": 0}
).json()

# 下载关键帧图片
frame_id = "scene_0001_mid"
image_data = requests.get(
    f"{BASE_URL}/api/tasks/{task_id}/frames/{frame_id}/image"
).content

with open(f"{frame_id}.jpg", "wb") as f:
    f.write(image_data)
```

### JavaScript

```javascript
const BASE_URL = "http://127.0.0.1:8000";

// 获取任务列表
async function getTasks() {
  const response = await fetch(`${BASE_URL}/api/tasks`);
  const data = await response.json();
  return data.tasks;
}

// 获取任务结果
async function getResult(taskId) {
  const response = await fetch(`${BASE_URL}/api/tasks/${taskId}/result`);
  return await response.json();
}

// 获取时间线
async function getTimeline(taskId, limit = 20, offset = 0) {
  const response = await fetch(
    `${BASE_URL}/api/tasks/${taskId}/timeline?limit=${limit}&offset=${offset}`
  );
  return await response.json();
}

// 获取关键帧图片 URL
function getFrameImageUrl(taskId, frameId) {
  return `${BASE_URL}/api/tasks/${taskId}/frames/${frameId}/image`;
}
```

### curl

```bash
# 获取任务列表
curl http://127.0.0.1:8000/api/tasks

# 获取任务结果
curl http://127.0.0.1:8000/api/tasks/video_b1acbf4a1bf3/result

# 获取时间线（分页）
curl "http://127.0.0.1:8000/api/tasks/video_b1acbf4a1bf3/timeline?limit=20&offset=0"

# 下载关键帧图片
curl -o frame.jpg http://127.0.0.1:8000/api/tasks/video_b1acbf4a1bf3/frames/scene_0001_mid/image
```

## 错误处理

### 404 Not Found

```json
{
  "detail": "文件不存在: outputs/video_xxx/final/result.json"
}
```

### 500 Internal Server Error

```json
{
  "detail": "JSON 解析失败: Expecting value: line 1 column 1 (char 0)"
}
```

## CORS 配置

API 已启用 CORS，允许所有来源访问：

```python
allow_origins=["*"]
allow_credentials=True
allow_methods=["*"]
allow_headers=["*"]
```

生产环境建议限制 `allow_origins` 为特定域名。

## 性能考虑

1. **大数据集分页**：时间线和证据数据量大，建议使用分页参数
2. **图片加载**：关键帧图片使用懒加载，避免一次性加载所有图片
3. **缓存策略**：考虑在客户端缓存已加载的数据

## 更新日志

### v1.0.0 (2026-06-22)
- 初始版本
- 完整 RESTful API
- 支持所有管线产出物访问
