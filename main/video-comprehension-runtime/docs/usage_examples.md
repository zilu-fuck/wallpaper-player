# 使用示例

本文档提供视频理解管线的完整使用示例。

## 快速开始

### 1. 处理视频

```bash
# 处理单个视频
uv run video-comprehension "path/to/your/video.mp4"
```

处理完成后，输出结果保存在 `outputs/video_<hash>/` 目录。

### 2. 启动 API 服务

```bash
uv run video-comprehension-api
```

### 3. 查看结果

可通过播放器内的视频理解面板查看，也可以通过 API：
- 浏览所有已处理的视频
- 查看视频摘要、时间线、人物列表
- 浏览关键帧图片
- 查看多模态证据数据

## 详细使用流程

### 场景 1：处理视频并查看结果

```bash
# 1. 确保 .env 配置正确
cat .env

# 2. 处理视频
uv run video-comprehension "/path/to/video.mp4"

# 3. 查看输出目录
ls outputs/

# 4. 查看最终结果
cat outputs/video_<hash>/final/result.json
cat outputs/video_<hash>/final/result.md

# 5. 启动 API 或打开播放器查看
uv run video-comprehension-api
```

### 场景 2：使用 API 程序化访问

#### Python 示例

```python
import requests
import json

BASE_URL = "http://127.0.0.1:8000"

# 获取所有任务
def get_all_tasks():
    response = requests.get(f"{BASE_URL}/api/tasks")
    return response.json()["tasks"]

# 获取任务详情
def get_task_detail(task_id):
    response = requests.get(f"{BASE_URL}/api/tasks/{task_id}/result")
    return response.json()

# 获取时间线
def get_timeline(task_id, limit=20, offset=0):
    response = requests.get(
        f"{BASE_URL}/api/tasks/{task_id}/timeline",
        params={"limit": limit, "offset": offset}
    )
    return response.json()

# 获取人物列表
def get_characters(task_id):
    response = requests.get(f"{BASE_URL}/api/tasks/{task_id}/characters")
    return response.json()["characters"]

# 下载关键帧图片
def download_frame(task_id, frame_id, output_path):
    response = requests.get(
        f"{BASE_URL}/api/tasks/{task_id}/frames/{frame_id}/image"
    )
    with open(output_path, "wb") as f:
        f.write(response.content)

# 使用示例
if __name__ == "__main__":
    # 获取第一个任务
    tasks = get_all_tasks()
    if tasks:
        task = tasks[0]
        task_id = task["task_id"]

        print(f"任务: {task['source_video']['original_filename']}")
        print(f"摘要: {task['summary'][:100]}...")

        # 获取详情
        detail = get_task_detail(task_id)
        print(f"\n标签: {', '.join(detail['tags'])}")
        print(f"关键词: {', '.join(detail['keywords'][:10])}")
        print(f"人物数量: {len(detail['characters'])}")
        print(f"时间线段数: {len(detail['timeline'])}")

        # 获取人物
        characters = get_characters(task_id)
        print(f"\n人物列表:")
        for char in characters[:5]:
            print(f"  - {char['name']}: {char['identity_status']}")

        # 获取时间线前10段
        timeline = get_timeline(task_id, limit=10)
        print(f"\n时间线前10段:")
        for seg in timeline['timeline']:
            print(f"  [{seg['start_time']:.2f}s - {seg['end_time']:.2f}s] {seg['title']}")
```

#### JavaScript 示例

```javascript
const BASE_URL = "http://127.0.0.1:8000";

// 获取所有任务
async function getAllTasks() {
  const response = await fetch(`${BASE_URL}/api/tasks`);
  const data = await response.json();
  return data.tasks;
}

// 获取任务详情
async function getTaskDetail(taskId) {
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

// 获取人物列表
async function getCharacters(taskId) {
  const response = await fetch(`${BASE_URL}/api/tasks/${taskId}/characters`);
  const data = await response.json();
  return data.characters;
}

// 使用示例
(async () => {
  // 获取第一个任务
  const tasks = await getAllTasks();
  if (tasks.length > 0) {
    const task = tasks[0];
    const taskId = task.task_id;

    console.log(`任务: ${task.source_video.original_filename}`);
    console.log(`摘要: ${task.summary.substring(0, 100)}...`);

    // 获取详情
    const detail = await getTaskDetail(taskId);
    console.log(`\n标签: ${detail.tags.join(', ')}`);
    console.log(`关键词: ${detail.keywords.slice(0, 10).join(', ')}`);
    console.log(`人物数量: ${detail.characters.length}`);
    console.log(`时间线段数: ${detail.timeline.length}`);

    // 获取人物
    const characters = await getCharacters(taskId);
    console.log(`\n人物列表:`);
    characters.slice(0, 5).forEach(char => {
      console.log(`  - ${char.name}: ${char.identity_status}`);
    });

    // 获取时间线前10段
    const timeline = await getTimeline(taskId, 10);
    console.log(`\n时间线前10段:`);
    timeline.timeline.forEach(seg => {
      console.log(`  [${seg.start_time.toFixed(2)}s - ${seg.end_time.toFixed(2)}s] ${seg.title}`);
    });
  }
})();
```

### 场景 3：批量处理视频

```bash
#!/bin/bash
# 批量处理视频脚本

VIDEO_DIR="/path/to/videos"
LOG_FILE="batch_process.log"

echo "开始批量处理视频..." | tee -a "$LOG_FILE"

for video in "$VIDEO_DIR"/*.mp4; do
    echo "处理: $video" | tee -a "$LOG_FILE"
    uv run video-comprehension "$video" >> "$LOG_FILE" 2>&1

    if [ $? -eq 0 ]; then
        echo "✓ 成功: $video" | tee -a "$LOG_FILE"
    else
        echo "✗ 失败: $video" | tee -a "$LOG_FILE"
    fi
    echo "---" | tee -a "$LOG_FILE"
done

echo "批量处理完成" | tee -a "$LOG_FILE"
```

### 场景 4：导出分析结果

```python
import requests
import json
from pathlib import Path

BASE_URL = "http://127.0.0.1:8000"

def export_task_summary(task_id, output_dir):
    """导出任务摘要信息"""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 获取完整结果
    result = requests.get(f"{BASE_URL}/api/tasks/{task_id}/result").json()

    # 保存完整结果
    with open(output_dir / "full_result.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # 导出摘要
    summary = {
        "task_id": result["task_id"],
        "video": result["source_video"]["original_filename"],
        "duration": result["source_video"]["duration_seconds"],
        "summary": result["summary"],
        "tags": result["tags"],
        "keywords": result["keywords"],
        "character_count": len(result["characters"]),
        "timeline_count": len(result["timeline"]),
    }

    with open(output_dir / "summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    # 导出人物列表
    with open(output_dir / "characters.json", "w", encoding="utf-8") as f:
        json.dump(result["characters"], f, ensure_ascii=False, indent=2)

    # 导出时间线
    with open(output_dir / "timeline.json", "w", encoding="utf-8") as f:
        json.dump(result["timeline"], f, ensure_ascii=False, indent=2)

    # 导出文本格式摘要
    with open(output_dir / "summary.txt", "w", encoding="utf-8") as f:
        f.write(f"视频: {summary['video']}\n")
        f.write(f"时长: {summary['duration']:.2f} 秒\n")
        f.write(f"\n摘要:\n{summary['summary']}\n")
        f.write(f"\n标签: {', '.join(summary['tags'])}\n")
        f.write(f"\n关键词: {', '.join(summary['keywords'])}\n")
        f.write(f"\n人物数量: {summary['character_count']}\n")
        f.write(f"时间线段数: {summary['timeline_count']}\n")

    print(f"导出完成: {output_dir}")

# 使用示例
if __name__ == "__main__":
    tasks = requests.get(f"{BASE_URL}/api/tasks").json()["tasks"]
    for task in tasks:
        export_task_summary(task["task_id"], f"exports/{task['task_id']}")
```

### 场景 5：基于时间范围查询

```python
import requests

BASE_URL = "http://127.0.0.1:8000"

def get_timeline_segments_in_range(task_id, start_time, end_time):
    """获取指定时间范围内的时间线片段"""
    result = requests.get(f"{BASE_URL}/api/tasks/{task_id}/result").json()

    segments = []
    for seg in result["timeline"]:
        # 判断是否有时间重叠
        if seg["start_time"] <= end_time and seg["end_time"] >= start_time:
            segments.append(seg)

    return segments

def get_asr_in_range(task_id, start_time, end_time):
    """获取指定时间范围内的 ASR 分段"""
    asr = requests.get(
        f"{BASE_URL}/api/tasks/{task_id}/asr",
        params={"start_time": start_time, "end_time": end_time}
    ).json()

    return asr["segments"]

def analyze_time_range(task_id, start_time, end_time):
    """分析指定时间范围"""
    print(f"分析时间范围: {start_time:.2f}s - {end_time:.2f}s")

    # 获取时间线片段
    segments = get_timeline_segments_in_range(task_id, start_time, end_time)
    print(f"\n时间线片段数: {len(segments)}")
    for seg in segments:
        print(f"  [{seg['start_time']:.2f}s - {seg['end_time']:.2f}s] {seg['title']}")
        print(f"    {seg['description'][:100]}...")

    # 获取 ASR 分段
    asr_segments = get_asr_in_range(task_id, start_time, end_time)
    print(f"\nASR 分段数: {len(asr_segments)}")
    for seg in asr_segments[:5]:  # 只显示前5条
        print(f"  [{seg['start_time']:.2f}s - {seg['end_time']:.2f}s] {seg['text']}")

# 使用示例：分析视频前60秒
if __name__ == "__main__":
    tasks = requests.get(f"{BASE_URL}/api/tasks").json()["tasks"]
    if tasks:
        task_id = tasks[0]["task_id"]
        analyze_time_range(task_id, 0, 60)
```

## 常见任务

### 查看视频质量信息

```python
import requests

BASE_URL = "http://127.0.0.1:8000"

def show_quality_info(task_id):
    quality = requests.get(f"{BASE_URL}/api/tasks/{task_id}/quality").json()["quality"]

    print("质量信息:")
    print(f"  关键帧总数: {quality['total_keyframes']}")
    print(f"  VLM 分析帧数: {quality['vlm_analyzed_segment_count']}")
    print(f"  ASR 分段数: {quality['asr_segment_count']}")
    print(f"  OCR 检测数: {quality['ocr_detection_count']}")
    print(f"  YOLO 检测数: {quality['yolo_detection_count']}")
    print(f"  是否有音频: {quality['has_audio']}")
    print(f"  音频覆盖率: {quality['audio_coverage_rate']:.2%}")
    print(f"  VLM 覆盖率: {quality['vlm_coverage_rate']:.2%}")
    print(f"  人物检测数: {quality['character_detection_count']}")

# 使用示例
tasks = requests.get(f"{BASE_URL}/api/tasks").json()["tasks"]
if tasks:
    show_quality_info(tasks[0]["task_id"])
```

### 搜索特定内容

```python
import requests

BASE_URL = "http://127.0.0.1:8000"

def search_in_timeline(task_id, keyword):
    """在时间线中搜索关键词"""
    result = requests.get(f"{BASE_URL}/api/tasks/{task_id}/result").json()

    matches = []
    for seg in result["timeline"]:
        if keyword.lower() in seg["description"].lower() or keyword.lower() in seg["title"].lower():
            matches.append(seg)

    return matches

def search_in_characters(task_id, keyword):
    """在人物列表中搜索"""
    result = requests.get(f"{BASE_URL}/api/tasks/{task_id}/result").json()

    matches = []
    for char in result["characters"]:
        if keyword.lower() in char.get("name", "").lower() or \
           keyword.lower() in char.get("description", "").lower():
            matches.append(char)

    return matches

# 使用示例
tasks = requests.get(f"{BASE_URL}/api/tasks").json()["tasks"]
if tasks:
    task_id = tasks[0]["task_id"]

    # 搜索包含"战斗"的时间线片段
    results = search_in_timeline(task_id, "战斗")
    print(f"找到 {len(results)} 个相关片段")
    for seg in results[:3]:
        print(f"  [{seg['start_time']:.2f}s] {seg['title']}")
```

## 性能优化建议

1. **使用分页加载大数据集**
   ```python
   # 分页加载时间线
   page_size = 20
   for page in range(0, total_count, page_size):
       timeline = get_timeline(task_id, limit=page_size, offset=page)
       process_timeline(timeline)
   ```

2. **缓存常用数据**
   ```python
   from functools import lru_cache

   @lru_cache(maxsize=128)
   def get_cached_result(task_id):
       return requests.get(f"{BASE_URL}/api/tasks/{task_id}/result").json()
   ```

3. **批量下载关键帧**
   ```python
   import concurrent.futures

   def download_all_frames(task_id, output_dir):
       frames = requests.get(f"{BASE_URL}/api/tasks/{task_id}/frames").json()["frames"]

       def download_frame(frame):
           response = requests.get(
               f"{BASE_URL}/api/tasks/{task_id}/frames/{frame['frame_id']}/image"
           )
           with open(f"{output_dir}/{frame['frame_id']}.jpg", "wb") as f:
               f.write(response.content)

       with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
           executor.map(download_frame, frames)
   ```

## 故障排查

### API 服务无法访问

```bash
# 检查服务是否运行
curl http://127.0.0.1:8000/

# 查看端口占用
# Windows
netstat -ano | findstr :8000

# Linux/macOS
lsof -i :8000
```

### 前端无法加载数据

1. 打开浏览器开发者工具（F12）
2. 查看 Console 和 Network 标签
3. 确认 API 请求是否成功
4. 检查 CORS 错误

### 视频处理失败

```bash
# 查看日志
cat outputs/video_<hash>/logs/pipeline_events.jsonl

# 检查配置
cat .env

# 测试 FFmpeg
ffmpeg -version
```

## 更多示例

完整代码示例请参考：
- Python 客户端: `examples/python_client.py`
- JavaScript 客户端: `examples/js_client.html`
- 批量处理: `examples/batch_process.sh`

（注：这些示例文件可根据需要创建）
