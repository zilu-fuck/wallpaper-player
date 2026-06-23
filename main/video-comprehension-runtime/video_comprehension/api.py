# 2026-06-22 创建 FastAPI 服务，提供视频理解结果的 RESTful API

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles


app = FastAPI(
    title="视频理解管线 API",
    description="提供视频理解结果的查询接口",
    version="1.0.0",
)

# 配置 CORS 允许前端跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 输出目录路径
OUTPUTS_DIR = Path("outputs")


def _load_json(file_path: Path) -> dict[str, Any]:
    """加载 JSON 文件"""
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"文件不存在: {file_path}")
    try:
        with open(file_path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"JSON 解析失败: {e}")


@app.get("/")
async def root():
    """根路径，返回 API 信息"""
    return {
        "name": "视频理解管线 API",
        "version": "1.0.0",
        "endpoints": {
            "tasks": "/api/tasks",
            "result": "/api/tasks/{task_id}/result",
            "timeline": "/api/tasks/{task_id}/timeline",
            "characters": "/api/tasks/{task_id}/characters",
            "evidence": "/api/tasks/{task_id}/evidence",
            "frames": "/api/tasks/{task_id}/frames",
            "frame_image": "/api/tasks/{task_id}/frames/{frame_id}/image",
        },
    }


@app.get("/api/tasks")
async def list_tasks():
    """列出所有已处理的视频任务"""
    if not OUTPUTS_DIR.exists():
        return {"tasks": []}

    tasks = []
    for task_dir in OUTPUTS_DIR.iterdir():
        if task_dir.is_dir() and task_dir.name.startswith("video_"):
            result_file = task_dir / "final" / "result.json"
            if result_file.exists():
                try:
                    result = _load_json(result_file)
                    tasks.append(
                        {
                            "task_id": result["task_id"],
                            "source_video": result["source_video"],
                            "summary": result["summary"],
                            "created_at": task_dir.stat().st_mtime,
                        }
                    )
                except Exception:
                    continue

    # 按创建时间倒序排列
    tasks.sort(key=lambda x: x["created_at"], reverse=True)
    return {"tasks": tasks}


@app.get("/api/tasks/{task_id}/result")
async def get_result(task_id: str):
    """获取任务的完整结果"""
    result_path = OUTPUTS_DIR / task_id / "final" / "result.json"
    return _load_json(result_path)


@app.get("/api/tasks/{task_id}/timeline")
async def get_timeline(task_id: str, limit: int | None = None, offset: int = 0):
    """获取时间线片段，支持分页"""
    result = _load_json(OUTPUTS_DIR / task_id / "final" / "result.json")
    timeline = result.get("timeline", [])

    # 分页处理
    if limit is not None:
        timeline = timeline[offset : offset + limit]

    return {
        "task_id": task_id,
        "total": len(result.get("timeline", [])),
        "offset": offset,
        "limit": limit,
        "timeline": timeline,
    }


@app.get("/api/tasks/{task_id}/characters")
async def get_characters(task_id: str):
    """获取人物列表"""
    result = _load_json(OUTPUTS_DIR / task_id / "final" / "result.json")
    return {
        "task_id": task_id,
        "characters": result.get("characters", []),
    }


@app.get("/api/tasks/{task_id}/evidence")
async def get_evidence(task_id: str, evidence_id: str | None = None):
    """获取证据数据，可通过 evidence_id 查询单条证据"""
    evidence_path = OUTPUTS_DIR / task_id / "evidence" / "evidence.json"
    evidence_data = _load_json(evidence_path)

    if evidence_id:
        # 查找特定证据
        for ev in evidence_data.get("evidences", []):
            if ev.get("evidence_id") == evidence_id:
                return ev
        raise HTTPException(status_code=404, detail=f"证据不存在: {evidence_id}")

    return evidence_data


@app.get("/api/tasks/{task_id}/evidence/fused")
async def get_fused_evidence(task_id: str):
    """获取融合证据"""
    fused_path = OUTPUTS_DIR / task_id / "evidence" / "fused_evidence.json"
    return _load_json(fused_path)


@app.get("/api/tasks/{task_id}/frames")
async def get_frames(task_id: str):
    """获取所有关键帧列表"""
    frames_path = OUTPUTS_DIR / task_id / "frames" / "keyframes.json"
    frames_data = _load_json(frames_path)
    return {
        "task_id": task_id,
        "frames": frames_data,
    }


@app.get("/api/tasks/{task_id}/frames/{frame_id}/image")
async def get_frame_image(task_id: str, frame_id: str):
    """获取关键帧图片"""
    # 查找图片路径
    frames_path = OUTPUTS_DIR / task_id / "frames" / "keyframes.json"
    frames_data = _load_json(frames_path)

    for frame in frames_data:
        if frame.get("frame_id") == frame_id:
            # 图片路径格式： outputs\video_xxx\frames\scene_0001_mid.jpg
            image_path = Path(frame.get("image_path", ""))
            if image_path.exists():
                return FileResponse(image_path, media_type="image/jpeg")
            else:
                raise HTTPException(status_code=404, detail="图片文件不存在")

    raise HTTPException(status_code=404, detail=f"关键帧不存在: {frame_id}")


@app.get("/api/tasks/{task_id}/metadata")
async def get_metadata(task_id: str):
    """获取视频元数据"""
    metadata_path = OUTPUTS_DIR / task_id / "metadata" / "video_metadata.json"
    return _load_json(metadata_path)


@app.get("/api/tasks/{task_id}/scenes")
async def get_scenes(task_id: str):
    """获取镜头切分结果"""
    scenes_path = OUTPUTS_DIR / task_id / "scenes" / "scenes.json"
    return _load_json(scenes_path)


@app.get("/api/tasks/{task_id}/asr")
async def get_asr(task_id: str, start_time: float | None = None, end_time: float | None = None):
    """获取 ASR 语音识别结果，可按时间范围过滤"""
    asr_path = OUTPUTS_DIR / task_id / "audio" / "asr_segments.json"
    asr_data = _load_json(asr_path)

    segments = asr_data.get("segments", [])

    # 时间范围过滤
    if start_time is not None or end_time is not None:
        filtered = []
        for seg in segments:
            seg_start = seg.get("start_time", 0)
            seg_end = seg.get("end_time", 0)
            if start_time is not None and seg_end < start_time:
                continue
            if end_time is not None and seg_start > end_time:
                continue
            filtered.append(seg)
        segments = filtered

    return {
        "task_id": task_id,
        "total": len(asr_data.get("segments", [])),
        "filtered": len(segments),
        "segments": segments,
    }


@app.get("/api/tasks/{task_id}/ocr")
async def get_ocr(task_id: str):
    """获取 OCR 文字识别结果"""
    ocr_path = OUTPUTS_DIR / task_id / "ocr" / "ocr_results.json"
    return _load_json(ocr_path)


@app.get("/api/tasks/{task_id}/yolo")
async def get_yolo(task_id: str):
    """获取 YOLO 物体检测结果"""
    yolo_path = OUTPUTS_DIR / task_id / "yolo" / "yolo_results.json"
    return _load_json(yolo_path)


@app.get("/api/tasks/{task_id}/vlm")
async def get_vlm(task_id: str):
    """获取 VLM 视觉理解结果"""
    vlm_path = OUTPUTS_DIR / task_id / "vlm" / "vlm_results.json"
    return _load_json(vlm_path)


@app.get("/api/tasks/{task_id}/vlm/selection")
async def get_vlm_selection(task_id: str):
    """获取 VLM 代表帧选择计划"""
    selection_path = OUTPUTS_DIR / task_id / "vlm" / "vlm_frame_selection.json"
    return _load_json(selection_path)


@app.get("/api/tasks/{task_id}/quality")
async def get_quality(task_id: str):
    """获取质量信息"""
    result = _load_json(OUTPUTS_DIR / task_id / "final" / "result.json")
    return {
        "task_id": task_id,
        "quality": result.get("quality", {}),
    }


def main():
    """API 服务入口"""
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
