from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from rapidocr_onnxruntime import RapidOCR
except ImportError:  # pragma: no cover
    RapidOCR = None  # type: ignore[assignment]

from .config import PipelineRequest
from .events import EventLogger, now_iso
from .ffmpeg_tools import extract_audio, extract_frame, probe_video
from .json_io import read_json, write_json
from .llm_client import LocalLlmClient
from .paths import TaskPaths, build_task_paths

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi"}
CHARACTER_IDENTITY_STATUSES = {"visible_person", "candidate_character", "confirmed_character"}
SUPPORTED_OCR_ENGINE = "rapidocr_onnxruntime"
MAX_TOOL_RESULT_LIMIT = 120
KEY_MOMENT_LIMIT = 8
_OCR_THREAD_LOCAL = threading.local()


def run_pipeline(request: PipelineRequest) -> dict[str, Any]:
    # 2026-06-20 编排视频理解管线，所有识别阶段使用真实工具和模型
    video_path = request.video_path.resolve()
    task_id = request.task_id or make_task_id(video_path)
    paths = build_task_paths(request.output_dir, task_id)
    logger = EventLogger(paths.logs_dir / "pipeline_events.jsonl", paths.logs_dir / "errors.json")
    logger.event("pipeline", "running", "任务开始", {"task_id": task_id})

    try:
        manifest = validate_input(video_path, task_id, paths, logger)
        metadata = build_metadata(video_path, manifest, paths, logger)
        enforce_duration_limit(metadata, request, logger)
        scenes = build_scenes(video_path, metadata, request, paths, logger)
        keyframes = sample_keyframes(video_path, scenes, metadata, paths, logger, request)
        asr_segments, ocr_results, yolo_results = run_parallel_signal_stages(video_path, metadata, keyframes, paths, logger, request)
        vlm_plan = select_vlm_representative_frames(keyframes, scenes, asr_segments, ocr_results, yolo_results, paths, logger, request)
        vlm_results = run_vlm(vlm_plan["selected_frames"], paths, logger, request)
        evidence = build_evidence(task_id, metadata, scenes, keyframes, vlm_results, vlm_plan, asr_segments, ocr_results, yolo_results, paths, logger)
        fused = fuse_evidence(task_id, scenes, evidence, paths, logger)
        result = build_final_result(task_id, metadata, fused, evidence, paths, logger, request)
        export_markdown(result, paths)
        logger.event("pipeline", "success", "任务完成", {"result": str(paths.final_dir / "result.json")})
        return result
    except Exception as exc:
        logger.error(
            "pipeline",
            "fatal",
            str(exc),
            recoverable=False,
            affects_final_output=True,
            input_ref={"task_id": task_id, "video_path": str(video_path)},
        )
        raise


def run_parallel_signal_stages(
    video_path: Path,
    metadata: dict[str, Any],
    keyframes: list[dict[str, Any]],
    paths: TaskPaths,
    logger: EventLogger,
    request: PipelineRequest,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    # 2026-06-21 并行运行 ASR OCR YOLO 三个互不依赖的信号阶段，等待全部完成后进入 VLM 选择
    logger.event("signal_stages", "running", "开始并行运行 ASR、OCR、YOLO")
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(run_asr, video_path, metadata, paths, logger, request): "asr",
            executor.submit(run_ocr, keyframes, paths, logger, request): "ocr",
            executor.submit(run_yolo, keyframes, paths, logger, request): "yolo",
        }
        results: dict[str, list[dict[str, Any]]] = {}
        for future in as_completed(futures):
            stage = futures[future]
            results[stage] = future.result()
    logger.event(
        "signal_stages",
        "success",
        "ASR、OCR、YOLO 并行阶段完成",
        {"asr_count": len(results["asr"]), "ocr_count": len(results["ocr"]), "yolo_count": len(results["yolo"])},
    )
    return results["asr"], results["ocr"], results["yolo"]


def make_task_id(video_path: Path) -> str:
    # 2026-06-20 根据视频路径和文件状态生成稳定任务标识
    seed = f"{video_path.name}:{video_path.stat().st_size if video_path.exists() else 0}"
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12]
    return f"video_{digest}"


def file_sha256(path: Path) -> str:
    # 2026-06-20 计算文件 SHA256，作为缓存和证据追踪基础
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_input(video_path: Path, task_id: str, paths: TaskPaths, logger: EventLogger) -> dict[str, Any]:
    # 2026-06-20 校验输入视频路径和格式，阻断无效输入
    logger.event("input_validation", "running", "开始输入校验", {"video_path": str(video_path)})
    if not video_path.exists():
        raise FileNotFoundError(f"视频文件不存在：{video_path}")
    if not video_path.is_file():
        raise ValueError(f"输入不是文件：{video_path}")
    if video_path.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError(f"不支持的视频格式：{video_path.suffix}")
    manifest = {
        "task_id": task_id,
        "video_path": str(video_path),
        "exists": True,
        "readable": True,
        "extension": video_path.suffix.lower().lstrip("."),
        "file_size_bytes": video_path.stat().st_size,
        "file_hash": file_sha256(video_path),
        "created_at": now_iso(),
    }
    write_json(paths.input_dir / "input_manifest.json", manifest)
    logger.event("input_validation", "success", "输入校验完成")
    return manifest


def build_metadata(video_path: Path, manifest: dict[str, Any], paths: TaskPaths, logger: EventLogger) -> dict[str, Any]:
    # 2026-06-20 解析视频元数据，提取后续阶段依赖信息
    logger.event("metadata", "running", "开始解析视频元数据")
    cache_key = build_cache_key("metadata", manifest["file_hash"], {"video_path": manifest["video_path"]}, {})
    cached = read_stage_cache(paths.metadata_dir / "metadata_cache.json", cache_key, [paths.metadata_dir / "video_metadata.json"])
    if cached is not None:
        logger.event("metadata", "success", "复用缓存视频元数据", {"cache_hit": True})
        return read_json(paths.metadata_dir / "video_metadata.json")
    raw = probe_video(video_path)
    streams = raw.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if not video_streams:
        raise ValueError("视频缺少视频轨")
    first_video = video_streams[0]
    duration = float(raw.get("format", {}).get("duration") or first_video.get("duration") or 0)
    if duration <= 0:
        raise ValueError("视频时长无效")
    metadata = {
        "file_path": manifest["video_path"],
        "original_filename": Path(manifest["video_path"]).name,
        "file_hash": manifest["file_hash"],
        "duration_seconds": duration,
        "width": int(first_video.get("width") or 0),
        "height": int(first_video.get("height") or 0),
        "fps": parse_fps(first_video.get("avg_frame_rate") or first_video.get("r_frame_rate")),
        "video_codec": first_video.get("codec_name"),
        "audio_codec": audio_streams[0].get("codec_name") if audio_streams else None,
        "audio_stream_count": len(audio_streams),
        "video_stream_count": len(video_streams),
        "format_name": raw.get("format", {}).get("format_name"),
        "created_at": now_iso(),
        "probe_raw": raw,
    }
    if metadata["width"] <= 0 or metadata["height"] <= 0:
        raise ValueError("视频分辨率无效")
    write_json(paths.metadata_dir / "video_metadata.json", metadata)
    write_stage_cache(paths.metadata_dir / "metadata_cache.json", cache_key, [paths.metadata_dir / "video_metadata.json"])
    logger.event("metadata", "success", "视频元数据解析完成", {"duration_seconds": duration})
    return metadata


def parse_fps(value: str | None) -> float:
    # 2026-06-20 解析 FFprobe 帧率字符串，兼容分数字符串和空值
    if not value or value == "0/0":
        return 0.0
    if "/" in value:
        numerator, denominator = value.split("/", 1)
        den = float(denominator)
        return float(numerator) / den if den else 0.0
    return float(value)


def enforce_duration_limit(metadata: dict[str, Any], request: PipelineRequest, logger: EventLogger) -> None:
    # 2026-06-20 检查视频时长上限，避免模型和抽帧成本失控
    duration = float(metadata["duration_seconds"])
    max_duration = request.runtime_config.max_duration_seconds
    if duration > max_duration:
        raise ValueError(f"视频时长 {duration:.2f}s 超过配置上限 {max_duration:.2f}s")
    logger.event("duration_limit", "success", "视频时长在允许范围内", {"max_duration_seconds": max_duration})


def build_scenes(video_path: Path, metadata: dict[str, Any], request: PipelineRequest, paths: TaskPaths, logger: EventLogger) -> list[dict[str, Any]]:
    # 2026-06-20 使用 PySceneDetect 生成真实镜头列表，失败直接阻断
    logger.event("scene_detection", "running", "开始 PySceneDetect 镜头切分")
    cache_key = build_cache_key("scene_detection", metadata["file_hash"], request.runtime_config.scene_detection.__dict__, {"metadata": stable_hash(metadata)})
    cached = read_stage_cache(paths.scenes_dir / "scenes_cache.json", cache_key, [paths.scenes_dir / "scenes.json"])
    if cached is not None:
        logger.event("scene_detection", "success", "复用缓存镜头列表", {"cache_hit": True})
        return read_json(paths.scenes_dir / "scenes.json")
    scenes = detect_scenes_with_pyscenedetect(video_path, metadata, request)
    if not scenes:
        scenes = build_single_scene_fallback(metadata)
        logger.event("scene_detection", "success", "PySceneDetect 未返回镜头，已按整段视频继续", {"scene_count": 1, "fallback": True})
    else:
        logger.event("scene_detection", "success", "PySceneDetect 镜头切分完成", {"scene_count": len(scenes)})
    write_json(paths.scenes_dir / "scenes.json", scenes)
    write_stage_cache(paths.scenes_dir / "scenes_cache.json", cache_key, [paths.scenes_dir / "scenes.json"])
    return scenes


def build_single_scene_fallback(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    duration = max(0.001, float(metadata.get("duration_seconds") or 0))
    fps = float(metadata.get("fps") or 0)
    return [
        {
            "scene_id": "scene_0001",
            "index": 1,
            "start_time": 0.0,
            "end_time": duration,
            "duration": round(duration, 3),
            "start_frame": 0,
            "end_frame": int(duration * fps) if fps > 0 else 0,
            "detection_source": "full_video_fallback",
            "confidence": None,
        }
    ]


def detect_scenes_with_pyscenedetect(video_path: Path, metadata: dict[str, Any], request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-20 调用 PySceneDetect 生成真实镜头列表，保持输出字段与契约一致
    from scenedetect import ContentDetector, detect

    scene_pairs = detect(str(video_path), ContentDetector(threshold=request.runtime_config.scene_detection.threshold))
    fps = float(metadata.get("fps") or 0)
    scenes = []
    for index, pair in enumerate(scene_pairs):
        start_timecode, end_timecode = pair
        start = float(start_timecode.get_seconds())
        end = float(end_timecode.get_seconds())
        scenes.append(
            {
                "scene_id": f"scene_{index + 1:04d}",
                "index": index + 1,
                "start_time": start,
                "end_time": end,
                "duration": round(end - start, 3),
                "start_frame": int(start_timecode.get_frames()) if hasattr(start_timecode, "get_frames") else int(start * fps),
                "end_frame": int(end_timecode.get_frames()) if hasattr(end_timecode, "get_frames") else int(end * fps),
                "detection_source": "pyscenedetect",
                "confidence": None,
            }
        )
    return scenes


def sample_keyframes(video_path: Path, scenes: list[dict[str, Any]], metadata: dict[str, Any], paths: TaskPaths, logger: EventLogger, request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-20 按镜头中点抽取单张代表帧，控制真实模型处理成本
    logger.event("frame_sampling", "running", "开始抽取关键帧")
    cache_key = build_cache_key(
        "frame_sampling",
        metadata["file_hash"],
        {"strategy": "scene_midpoint_only"},
        {"metadata": stable_hash(metadata), "scenes": stable_hash(scenes)},
    )
    cached = read_stage_cache(paths.frames_dir / "frames_cache.json", cache_key, [paths.frames_dir / "keyframes.json"])
    if cached is not None:
        keyframes = read_json(paths.frames_dir / "keyframes.json")
        if all(Path(item["image_path"]).exists() for item in keyframes):
            logger.event("frame_sampling", "success", "复用缓存关键帧", {"cache_hit": True, "keyframe_count": len(keyframes)})
            return keyframes
    keyframes: list[dict[str, Any]] = []
    for scene in scenes:
        sample = plan_frame_samples(scene, metadata, request)[0]
        frame_id = f"{scene['scene_id']}_mid"
        image_path = paths.frames_dir / f"{frame_id}.jpg"
        extract_frame(video_path, float(sample["timestamp"]), image_path)
        keyframes.append(
            {
                "frame_id": frame_id,
                "scene_id": scene["scene_id"],
                "timestamp": round(float(sample["timestamp"]), 3),
                "image_path": str(image_path),
                "sample_role": sample["sample_role"],
                "source": "ffmpeg",
                "width": metadata["width"],
                "height": metadata["height"],
                "dedupe_group_id": None,
            }
        )
    write_json(paths.frames_dir / "keyframes.json", keyframes)
    write_stage_cache(paths.frames_dir / "frames_cache.json", cache_key, [paths.frames_dir / "keyframes.json", *[Path(item["image_path"]) for item in keyframes]])
    logger.event("frame_sampling", "success", "关键帧抽取完成", {"keyframe_count": len(keyframes)})
    return keyframes


def plan_frame_samples(scene: dict[str, Any], metadata: dict[str, Any], request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-20 为每个镜头规划单张中点代表帧，避免短视频抽帧量失控
    start = float(scene["start_time"])
    end = float(scene["end_time"])
    return unique_frame_samples([{"sample_role": "mid", "timestamp": midpoint(start, end)}], metadata)


def midpoint(start: float, end: float) -> float:
    # 2026-06-20 计算镜头中点时间，统一短镜头和普通镜头的中间帧逻辑
    return (start + end) / 2


def unique_frame_samples(samples: list[dict[str, Any]], metadata: dict[str, Any]) -> list[dict[str, Any]]:
    # 2026-06-20 去重并裁剪抽帧时间点，避免短镜头边界帧重复或越界
    seen: set[float] = set()
    unique: list[dict[str, Any]] = []
    for sample in samples:
        timestamp = clamp_frame_timestamp(float(sample["timestamp"]), metadata)
        key = round(timestamp, 3)
        if key in seen:
            continue
        seen.add(key)
        unique.append({"sample_role": sample["sample_role"], "timestamp": timestamp})
    return sorted(unique, key=lambda item: float(item["timestamp"]))


def clamp_frame_timestamp(timestamp: float, metadata: dict[str, Any]) -> float:
    # 2026-06-20 将抽帧时间限制在视频有效范围内，避免 FFmpeg 在末尾取不到帧
    duration = max(0.0, float(metadata["duration_seconds"]))
    upper_bound = max(0.0, duration - 0.05)
    return min(max(0.0, timestamp), upper_bound)


def stable_hash(value: Any) -> str:
    # 2026-06-20 对结构化值生成稳定哈希，用于缓存键和上游变更判断
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def file_state_hash(path: Path) -> str:
    # 2026-06-20 生成文件状态哈希，避免缓存复用到已变化的关键帧文件
    resolved = path.resolve()
    if not resolved.exists():
        return "missing"
    stat = resolved.stat()
    seed = f"{resolved}:{stat.st_size}:{stat.st_mtime_ns}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


def frame_files_hash(keyframes: list[dict[str, Any]]) -> str:
    # 2026-06-20 汇总关键帧文件状态哈希，用于视觉模型阶段缓存判断
    states = [file_state_hash(Path(item["image_path"])) for item in keyframes]
    return stable_hash(states)


def frame_item_cache_key(stage: str, frame: dict[str, Any], request: PipelineRequest) -> str:
    # 2026-06-21 生成单帧模型缓存键，避免模型或图片变化后复用旧结果
    config: dict[str, Any]
    if stage == "ocr":
        config = {"ocr_engine": request.runtime_config.ocr_engine}
    elif stage == "vlm":
        config = {"vlm_base_url": request.runtime_config.vlm_base_url, "vlm_name": request.runtime_config.vlm_name}
    else:
        config = {}
    return stable_hash(
        {
            "stage": stage,
            "frame_id": frame["frame_id"],
            "scene_id": frame["scene_id"],
            "timestamp": frame["timestamp"],
            "image_state": file_state_hash(Path(frame["image_path"])),
            "config": config,
        }
    )


def read_valid_frame_item_cache(item_path: Path, meta_path: Path, cache_key: str, expected_type: type, field_name: str) -> Any | None:
    # 2026-06-21 读取带缓存键校验的单帧结果，缓存不匹配时视为待处理
    if not item_path.exists() or not meta_path.exists():
        return None
    meta = read_json(meta_path)
    if not isinstance(meta, dict) or meta.get("cache_key") != cache_key:
        return None
    cached = read_json(item_path)
    if not isinstance(cached, expected_type):
        raise TypeError(f"{field_name} 单帧缓存类型错误：{item_path}")
    return cached


def write_frame_item_cache(item_path: Path, meta_path: Path, cache_key: str, payload: Any) -> None:
    # 2026-06-21 写入单帧模型结果和缓存键元数据，保证失败续跑仍遵循严格缓存
    write_json(item_path, payload)
    write_json(meta_path, {"cache_key": cache_key, "created_at": now_iso()})


def build_cache_key(stage: str, video_hash: str, config: dict[str, Any], upstream: dict[str, Any]) -> str:
    # 2026-06-20 构造阶段缓存键，包含视频哈希、阶段配置和上游产物哈希
    payload = {
        "stage": stage,
        "video_hash": video_hash,
        "config": config,
        "upstream": upstream,
    }
    return stable_hash(payload)


def read_stage_cache(cache_path: Path, cache_key: str, outputs: list[Path]) -> dict[str, Any] | None:
    # 2026-06-20 读取阶段缓存元数据，只有缓存键和产物都匹配时才允许复用
    if not cache_path.exists():
        return None
    payload = read_json(cache_path)
    if not isinstance(payload, dict) or payload.get("cache_key") != cache_key:
        return None
    if not all(path.exists() for path in outputs):
        return None
    return payload


def write_stage_cache(cache_path: Path, cache_key: str, outputs: list[Path]) -> None:
    # 2026-06-20 写入阶段缓存元数据，只记录当前阶段的可验证产物
    payload = {
        "cache_key": cache_key,
        "outputs": [str(path) for path in outputs],
        "created_at": now_iso(),
    }
    write_json(cache_path, payload)


def run_asr(video_path: Path, metadata: dict[str, Any], paths: TaskPaths, logger: EventLogger, request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-20 使用 faster-whisper 转写音频，无音频时写入空分段
    logger.event("asr", "running", "开始 ASR 阶段")
    cache_key = build_cache_key(
        "asr",
        metadata["file_hash"],
        {"model_size": request.runtime_config.asr_model_size, "device": request.runtime_config.asr_device, "compute_type": request.runtime_config.asr_compute_type},
        {"metadata": stable_hash(metadata)},
    )
    cached = read_stage_cache(paths.audio_dir / "asr_cache.json", cache_key, [paths.audio_dir / "asr_segments.json"])
    if cached is not None:
        logger.event("asr", "success", "复用缓存 ASR 结果", {"cache_hit": True})
        return read_json(paths.audio_dir / "asr_segments.json")
    if int(metadata.get("audio_stream_count") or 0) <= 0:
        segments: list[dict[str, Any]] = []
        write_json(paths.audio_dir / "asr_segments.json", segments)
        write_stage_cache(paths.audio_dir / "asr_cache.json", cache_key, [paths.audio_dir / "asr_segments.json"])
        logger.event("asr", "success", "视频无音频轨，ASR 输出空分段")
        return segments
    audio_path = paths.audio_dir / "audio.wav"
    extract_audio(video_path, audio_path)
    segments = run_real_asr(audio_path, request)
    write_json(paths.audio_dir / "asr_segments.json", segments)
    write_stage_cache(paths.audio_dir / "asr_cache.json", cache_key, [paths.audio_dir / "audio.wav", paths.audio_dir / "asr_segments.json"])
    logger.event("asr", "success", "真实 ASR 转写完成", {"segment_count": len(segments)})
    return segments


def run_real_asr(audio_path: Path, request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-20 使用 faster-whisper 识别音频，输出契约格式 ASR 分段
    from faster_whisper import WhisperModel

    whisper_dir = request.runtime_config.model_storage_dir / "whisper"
    whisper_dir.mkdir(parents=True, exist_ok=True)
    model = WhisperModel(
        request.runtime_config.asr_model_size,
        device=request.runtime_config.asr_device,
        compute_type=request.runtime_config.asr_compute_type,
        download_root=str(whisper_dir),
    )
    segments_iter, info = model.transcribe(str(audio_path), beam_size=1)
    segments = []
    for index, segment in enumerate(segments_iter):
        text = segment.text.strip()
        if not text:
            continue
        segments.append(
            {
                "segment_id": f"asr_{index + 1:04d}",
                "start_time": float(segment.start),
                "end_time": float(segment.end),
                "text": text,
                "language": getattr(info, "language", None),
                "speaker_id": None,
                "confidence": None,
                "model": {"name": f"faster-whisper-{request.runtime_config.asr_model_size}", "version": "local"},
            }
        )
    return segments


def run_vlm(keyframes: list[dict[str, Any]], paths: TaskPaths, logger: EventLogger, request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-20 使用同一本地多模态模型分析关键帧
    cache_key = build_cache_key(
        "vlm",
        stable_hash(keyframes),
        {
            "base_url": request.runtime_config.vlm_base_url,
            "model": request.runtime_config.vlm_name,
            "concurrency": request.runtime_config.vlm_concurrency,
            "selection": vlm_selection_config(request),
            "selected_frame_ids": [frame["frame_id"] for frame in keyframes],
        },
        {"frames": frame_files_hash(keyframes)},
    )
    cached = read_stage_cache(paths.vlm_dir / "vlm_cache.json", cache_key, [paths.vlm_dir / "vlm_results.json"])
    if cached is not None:
        logger.event("vlm", "success", "复用缓存 VLM 结果", {"cache_hit": True})
        return read_json(paths.vlm_dir / "vlm_results.json")
    results = run_real_vlm(keyframes, paths, logger, request)
    write_json(paths.vlm_dir / "vlm_results.json", results)
    write_stage_cache(paths.vlm_dir / "vlm_cache.json", cache_key, [paths.vlm_dir / "vlm_results.json"])
    logger.event("vlm", "success", "真实 VLM 分析完成", {"result_count": len(results)})
    return results


def run_real_vlm(keyframes: list[dict[str, Any]], paths: TaskPaths, logger: EventLogger, request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-20 并发调用本地模型服务分析关键帧，并逐帧落盘避免失败后整批重跑
    system_prompt = (
        "You are a visual evidence extractor for a video pipeline. "
        "Return strict JSON only. Do not include reasoning. "
        "All user-visible string values must be written in Simplified Chinese (zh-CN). "
        "Use the image only. If uncertain, use empty arrays or null. "
        "Do not return markdown, nested objects, bounding boxes, or extra keys."
    )
    item_dir = paths.vlm_dir / "items"
    item_dir.mkdir(parents=True, exist_ok=True)
    results_by_frame: dict[str, dict[str, Any]] = {}
    pending_frames: list[dict[str, Any]] = []
    for frame in keyframes:
        item_path = item_dir / f"{frame['frame_id']}.json"
        meta_path = item_dir / f"{frame['frame_id']}.cache.json"
        item_cache_key = frame_item_cache_key("vlm", frame, request)
        cached = read_valid_frame_item_cache(item_path, meta_path, item_cache_key, dict, "VLM")
        if cached is not None:
            results_by_frame[frame["frame_id"]] = cached
            continue
        pending_frames.append(frame)
    if pending_frames:
        logger.event("vlm", "running", "开始逐帧 VLM 分析", {"pending_count": len(pending_frames), "cached_count": len(results_by_frame), "concurrency": request.runtime_config.vlm_concurrency})
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=request.runtime_config.vlm_concurrency) as executor:
        futures = {executor.submit(run_single_vlm_frame, frame, request, system_prompt): frame for frame in pending_frames}
        for completed_count, future in enumerate(as_completed(futures), start=1):
            frame = futures[future]
            try:
                result = future.result()
            except Exception as exc:
                message = f"{frame['frame_id']}：{exc}"
                errors.append(message)
                logger.event("vlm", "error", "VLM 帧失败", {"frame_id": frame["frame_id"], "error": str(exc), "completed": completed_count, "pending_total": len(pending_frames)})
                continue
            item_path = item_dir / f"{frame['frame_id']}.json"
            meta_path = item_dir / f"{frame['frame_id']}.cache.json"
            write_frame_item_cache(item_path, meta_path, frame_item_cache_key("vlm", frame, request), result)
            results_by_frame[frame["frame_id"]] = result
            logger.event("vlm", "running", "VLM 帧完成", {"frame_id": frame["frame_id"], "completed": completed_count, "pending_total": len(pending_frames)})
    if errors:
        raise RuntimeError("VLM 阶段存在失败帧：" + "；".join(errors))
    return [results_by_frame[frame["frame_id"]] for frame in keyframes]


def run_single_vlm_frame(frame: dict[str, Any], request: PipelineRequest, system_prompt: str) -> dict[str, Any]:
    # 2026-06-20 处理单张关键帧 VLM 请求，返回契约化帧结果
    client = build_vlm_client(request)
    payload = client.chat_image_json(
        system_prompt,
        (
            "请用简体中文分析这张关键帧，并返回 JSON，字段包括："
            "description, visible_people, actions, environment, "
            "visible_text_hints, objects_hints, mood, confidence。"
            "description 和 environment 必须是中文字符串。"
            "visible_people、actions、visible_text_hints、objects_hints 必须是中文字符串数组。"
            "mood 必须是中文字符串或 null。confidence 必须是 0 到 1 的数字。"
        ),
        Path(frame["image_path"]),
    )
    return normalize_vlm_payload(frame, payload, request.runtime_config.vlm_name)


def normalize_vlm_payload(frame: dict[str, Any], payload: dict[str, Any], model_name: str) -> dict[str, Any]:
    # 2026-06-20 规范化真实 VLM 返回字段，避免模型字段漂移破坏后续证据结构
    require_payload_keys(payload, ["description", "visible_people", "actions", "environment", "visible_text_hints", "objects_hints", "mood", "confidence"], "VLM")
    return {
        "frame_id": frame["frame_id"],
        "timestamp": frame["timestamp"],
        "scene_id": frame["scene_id"],
        "description": require_text(payload["description"], "VLM.description"),
        "visible_people": require_text_list(payload["visible_people"], "VLM.visible_people"),
        "actions": require_text_list(payload["actions"], "VLM.actions"),
        "environment": require_text_or_list(payload["environment"], "VLM.environment"),
        "visible_text_hints": require_text_list(payload["visible_text_hints"], "VLM.visible_text_hints"),
        "objects_hints": require_text_list(payload["objects_hints"], "VLM.objects_hints"),
        "mood": require_optional_string(payload["mood"], "VLM.mood"),
        "confidence": normalize_confidence(payload.get("confidence")),
        "model": {"name": model_name, "version": "local"},
    }


def normalize_confidence(value: Any) -> float:
    # 2026-06-20 规范化模型置信度，兼容真实模型返回小数或百分制
    if isinstance(value, str):
        stripped = value.strip()
        level_confidence = {
            "高": 0.85,
            "较高": 0.75,
            "中": 0.5,
            "中等": 0.5,
            "一般": 0.5,
            "低": 0.25,
            "较低": 0.25,
            "high": 0.85,
            "medium": 0.5,
            "moderate": 0.5,
            "low": 0.25,
            "unknown": 0.0,
            "未知": 0.0,
        }
        normalized = stripped.lower()
        if normalized in level_confidence:
            return level_confidence[normalized]
        number_match = re.search(r"[-+]?\d+(?:\.\d+)?", stripped)
        if number_match and stripped != number_match.group(0):
            stripped = number_match.group(0) + ("%" if "%" in stripped else "")
        is_percent = stripped.endswith("%")
        raw_number = stripped[:-1].strip() if is_percent else stripped
    else:
        is_percent = False
        raw_number = value
    try:
        number = float(raw_number)
    except (TypeError, ValueError):
        raise TypeError(f"模型置信度必须是数字、百分数字符串或高/中/低等级，当前值：{value!r}") from None
    if is_percent or number > 1:
        if not 0 <= number <= 100:
            raise ValueError("模型百分制置信度必须在 0 到 100 之间")
        return round(number / 100, 4)
    if not 0 <= number <= 1:
        raise ValueError("模型置信度必须在 0 到 1 之间")
    return number


def require_payload_keys(payload: dict[str, Any], keys: list[str], stage: str) -> None:
    # 2026-06-20 校验模型响应必需字段，禁止缺字段结果进入证据层
    for key in keys:
        if key not in payload:
            raise ValueError(f"{stage} 响应缺少字段：{key}")


def require_string(value: Any, field_name: str) -> str:
    # 2026-06-20 校验模型响应字符串字段，字段类型错误时立即失败
    if not isinstance(value, str):
        raise TypeError(f"{field_name} 必须是字符串")
    return value


def require_text(value: Any, field_name: str) -> str:
    # 2026-06-20 将同字段文本响应规范为字符串，兼容模型返回对象但不改变输出契约
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, dict):
        parts = [str(item).strip() for item in value.values() if item is not None and str(item).strip()]
        if parts:
            return "，".join(parts)
    raise TypeError(f"{field_name} 必须是字符串")


def require_optional_string(value: Any, field_name: str) -> str | None:
    # 2026-06-20 校验模型响应可空字符串字段，禁止异常类型被静默置空
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{field_name} 必须是字符串或 null")
    return value


def require_text_or_list(value: Any, field_name: str) -> str:
    # 2026-06-20 校验模型响应文本字段，允许字符串或字符串数组并保持严格类型
    if isinstance(value, str) and value.strip():
        return value
    if isinstance(value, list):
        items = [text for text in (stringify_text_item(item) for item in value) if text]
        if items:
            return "，".join(items)
    if isinstance(value, dict):
        return require_text(value, field_name)
    raise TypeError(f"{field_name} 必须是字符串或字符串数组")


def require_text_list(value: Any, field_name: str) -> list[str]:
    # 2026-06-20 将模型数组字段规范为字符串数组，保持证据契约稳定
    if not isinstance(value, list):
        raise TypeError(f"{field_name} 必须是数组")
    items = [text for text in (stringify_text_item(item) for item in value) if text]
    return items


def stringify_text_item(value: Any) -> str | None:
    # 2026-06-20 提取模型数组项中的可读文本，避免对象项破坏字符串数组契约
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        for key in ("text", "name", "object", "action", "role", "description", "type"):
            item = value.get(key)
            if isinstance(item, str) and item.strip():
                return item.strip()
        parts = [str(item).strip() for item in value.values() if item is not None and str(item).strip()]
        return "，".join(parts) if parts else None
    return str(value).strip() if value is not None and str(value).strip() else None


def require_optional_bbox(value: Any, field_name: str) -> dict[str, Any] | None:
    # 2026-06-20 规范化 OCR 区域字段，允许未知区域为 null 并兼容四元坐标数组
    if value is None:
        return None
    if isinstance(value, str) and value.strip().lower() in {"", "null", "none", "unknown", "not available", "n/a"}:
        return None
    if isinstance(value, list):
        if not value:
            return None
        if len(value) == 4 and all(isinstance(item, (int, float)) for item in value):
            return {"x1": float(value[0]), "y1": float(value[1]), "x2": float(value[2]), "y2": float(value[3])}
        raise TypeError(f"{field_name} 数组必须是四元数字坐标")
    if isinstance(value, dict):
        if not value:
            return None
        return value
    raise TypeError(f"{field_name} 必须是对象、四元数字数组或 null")


def run_ocr(keyframes: list[dict[str, Any]], paths: TaskPaths, logger: EventLogger, request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-21 使用独立 OCR 引擎提取关键帧文字，禁止复用 VLM 结果冒充 OCR
    cache_key = build_cache_key(
        "ocr",
        stable_hash(keyframes),
        {"engine": request.runtime_config.ocr_engine, "concurrency": request.runtime_config.ocr_concurrency},
        {"frames": frame_files_hash(keyframes)},
    )
    cached = read_stage_cache(paths.ocr_dir / "ocr_cache.json", cache_key, [paths.ocr_dir / "ocr_results.json"])
    if cached is not None:
        logger.event("ocr", "success", "复用缓存 OCR 结果", {"cache_hit": True})
        return read_json(paths.ocr_dir / "ocr_results.json")
    results = run_real_ocr(keyframes, paths, logger, request)
    write_json(paths.ocr_dir / "ocr_results.json", results)
    write_stage_cache(paths.ocr_dir / "ocr_cache.json", cache_key, [paths.ocr_dir / "ocr_results.json"])
    logger.event("ocr", "success", "真实 OCR 分析完成", {"result_count": len(results)})
    return results


def run_real_ocr(keyframes: list[dict[str, Any]], paths: TaskPaths, logger: EventLogger, request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-21 并发调用独立 OCR 引擎提取文字，并逐帧落盘避免失败后整批重跑
    if request.runtime_config.ocr_engine != SUPPORTED_OCR_ENGINE:
        raise ValueError(f"OCR 引擎仅支持 {SUPPORTED_OCR_ENGINE}，当前为 {request.runtime_config.ocr_engine}")
    if RapidOCR is None:
        raise RuntimeError("缺少 rapidocr-onnxruntime 依赖，无法运行独立 OCR")
    item_dir = paths.ocr_dir / "items"
    item_dir.mkdir(parents=True, exist_ok=True)
    results_by_frame: dict[str, list[dict[str, Any]]] = {}
    pending_frames: list[tuple[int, dict[str, Any]]] = []
    for frame_index, frame in enumerate(keyframes):
        item_path = item_dir / f"{frame['frame_id']}.json"
        meta_path = item_dir / f"{frame['frame_id']}.cache.json"
        item_cache_key = frame_item_cache_key("ocr", frame, request)
        cached = read_valid_frame_item_cache(item_path, meta_path, item_cache_key, list, "OCR")
        if cached is not None:
            results_by_frame[frame["frame_id"]] = cached
            continue
        pending_frames.append((frame_index, frame))
    if pending_frames:
        logger.event("ocr", "running", "开始逐帧 OCR 分析", {"pending_count": len(pending_frames), "cached_count": len(results_by_frame), "engine": request.runtime_config.ocr_engine, "concurrency": request.runtime_config.ocr_concurrency})
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=request.runtime_config.ocr_concurrency) as executor:
        futures = {executor.submit(run_single_ocr_frame, frame_index, frame, request): frame for frame_index, frame in pending_frames}
        for completed_count, future in enumerate(as_completed(futures), start=1):
            frame = futures[future]
            try:
                frame_results = future.result()
            except Exception as exc:
                message = f"{frame['frame_id']}：{exc}"
                errors.append(message)
                logger.event("ocr", "error", "OCR 帧失败", {"frame_id": frame["frame_id"], "error": str(exc), "completed": completed_count, "pending_total": len(pending_frames)})
                continue
            item_path = item_dir / f"{frame['frame_id']}.json"
            meta_path = item_dir / f"{frame['frame_id']}.cache.json"
            write_frame_item_cache(item_path, meta_path, frame_item_cache_key("ocr", frame, request), frame_results)
            results_by_frame[frame["frame_id"]] = frame_results
            logger.event("ocr", "running", "OCR 帧完成", {"frame_id": frame["frame_id"], "completed": completed_count, "pending_total": len(pending_frames)})
    if errors:
        raise RuntimeError("OCR 阶段存在失败帧：" + "；".join(errors))
    results: list[dict[str, Any]] = []
    for frame in keyframes:
        results.extend(results_by_frame[frame["frame_id"]])
    return results


def run_single_ocr_frame(frame_index: int, frame: dict[str, Any], request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-21 处理单张关键帧 OCR 请求，使用独立 RapidOCR 引擎返回契约化文字结果
    engine = get_ocr_engine()
    raw_items, _elapsed = engine(str(Path(frame["image_path"])))
    items = raw_items or []
    if not isinstance(items, list):
        raise TypeError("OCR 引擎返回结果必须是数组")
    results: list[dict[str, Any]] = []
    for item_index, item in enumerate(items):
        box, text, confidence = normalize_rapidocr_item(item)
        if not text:
            continue
        results.append(
            {
                "ocr_id": f"ocr_{frame_index + 1:04d}_{item_index + 1:02d}",
                "frame_id": frame["frame_id"],
                "timestamp": frame["timestamp"],
                "text": text,
                "bbox": box,
                "text_type": "unknown",
                "confidence": confidence,
                "model": {"name": request.runtime_config.ocr_engine, "version": "local"},
            }
        )
    return results


def get_ocr_engine() -> Any:
    # 2026-06-21 在线程内懒加载并复用 OCR 引擎，避免每帧重复初始化模型
    if RapidOCR is None:
        raise RuntimeError("缺少 rapidocr-onnxruntime 依赖，无法运行独立 OCR")
    engine = getattr(_OCR_THREAD_LOCAL, "engine", None)
    if engine is None:
        engine = RapidOCR()
        _OCR_THREAD_LOCAL.engine = engine
    return engine


def normalize_rapidocr_item(item: Any) -> tuple[dict[str, float] | None, str, float]:
    # 2026-06-21 规范化 RapidOCR 单条结果，保持 OCR 输出契约稳定
    if not isinstance(item, list) or len(item) < 3:
        raise TypeError("OCR 引擎结果项必须包含坐标、文本和置信度")
    box = normalize_rapidocr_bbox(item[0])
    text = require_string(item[1], "OCR.items.text").strip()
    confidence = normalize_optional_confidence(item[2])
    return box, text, confidence


def normalize_rapidocr_bbox(value: Any) -> dict[str, float] | None:
    # 2026-06-21 将 RapidOCR 四点坐标转换为边界框，坐标缺失时返回 null
    if value is None:
        return None
    if not isinstance(value, list) or not value:
        raise TypeError("OCR 坐标必须是四点数组")
    points: list[tuple[float, float]] = []
    for point in value:
        if not isinstance(point, list) or len(point) < 2:
            raise TypeError("OCR 坐标点必须包含 x 和 y")
        x = float(point[0])
        y = float(point[1])
        points.append((x, y))
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return {"x1": min(xs), "y1": min(ys), "x2": max(xs), "y2": max(ys)}


def normalize_ocr_text_type(value: Any) -> str:
    # 2026-06-20 校验 OCR 文本类型，避免模型返回任意分类污染契约
    if value in {"subtitle", "title", "label", "unknown"}:
        return value
    raise ValueError("OCR 文本类型必须是 subtitle、title、label 或 unknown")


def normalize_optional_confidence(value: Any) -> float:
    # 2026-06-21 规范化可缺省置信度，缺失时按未知置信写入 0
    if value is None:
        return 0.0
    return normalize_confidence(value)


def run_yolo(keyframes: list[dict[str, Any]], paths: TaskPaths, logger: EventLogger, request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-20 使用 Ultralytics YOLO 检测关键帧物体
    cache_key = build_cache_key(
        "yolo",
        stable_hash(keyframes),
        {"model": request.runtime_config.yolo_model},
        {"frames": frame_files_hash(keyframes)},
    )
    cached = read_stage_cache(paths.yolo_dir / "yolo_cache.json", cache_key, [paths.yolo_dir / "yolo_results.json", paths.yolo_dir / "yolo_model.json"])
    if cached is not None:
        logger.event("yolo", "success", "复用缓存 YOLO 结果", {"cache_hit": True})
        return read_json(paths.yolo_dir / "yolo_results.json")
    results = run_real_yolo(keyframes, request)
    write_json(paths.yolo_dir / "yolo_results.json", results)
    write_json(paths.yolo_dir / "yolo_model.json", {"name": request.runtime_config.yolo_model, "version": "ultralytics"})
    write_stage_cache(paths.yolo_dir / "yolo_cache.json", cache_key, [paths.yolo_dir / "yolo_results.json", paths.yolo_dir / "yolo_model.json"])
    logger.event("yolo", "success", "真实 YOLO 检测完成", {"result_count": len(results)})
    return results


def run_real_yolo(keyframes: list[dict[str, Any]], request: PipelineRequest) -> list[dict[str, Any]]:
    # 2026-06-20 使用 Ultralytics YOLO 检测关键帧物体，输出契约格式结果
    from ultralytics import YOLO

    model = YOLO(request.runtime_config.yolo_model)
    detections: list[dict[str, Any]] = []
    for frame in keyframes:
        results = model.predict(source=frame["image_path"], verbose=False)
        for result in results:
            names = result.names or {}
            boxes = result.boxes
            if boxes is None:
                continue
            for index, box in enumerate(boxes):
                cls_id = int(box.cls[0].item()) if box.cls is not None else -1
                confidence = float(box.conf[0].item()) if box.conf is not None else 0.0
                xyxy = box.xyxy[0].tolist()
                detections.append(
                    {
                        "detection_id": f"det_{frame['frame_id']}_{index + 1:03d}",
                        "frame_id": frame["frame_id"],
                        "timestamp": frame["timestamp"],
                        "class_name": str(names.get(cls_id, cls_id)),
                        "bbox": {
                            "x1": float(xyxy[0]),
                            "y1": float(xyxy[1]),
                            "x2": float(xyxy[2]),
                            "y2": float(xyxy[3]),
                        },
                        "confidence": confidence,
                        "model": {"name": request.runtime_config.yolo_model, "version": "ultralytics"},
                    }
                )
    return detections


def select_vlm_representative_frames(
    keyframes: list[dict[str, Any]],
    scenes: list[dict[str, Any]],
    asr_segments: list[dict[str, Any]],
    ocr_results: list[dict[str, Any]],
    yolo_results: list[dict[str, Any]],
    paths: TaskPaths,
    logger: EventLogger,
    request: PipelineRequest,
) -> dict[str, Any]:
    # 2026-06-21 选择自适应 VLM 代表帧并写入选择计划
    logger.event("vlm_frame_selection", "running", "开始选择 VLM 代表帧")
    plan_path = paths.vlm_dir / "vlm_frame_selection.json"
    cache_key = build_cache_key(
        "vlm_frame_selection",
        stable_hash(keyframes),
        vlm_selection_config(request),
        {
            "scenes": stable_hash(scenes),
            "asr": stable_hash(asr_segments),
            "ocr": stable_hash(ocr_results),
            "yolo": stable_hash(yolo_results),
        },
    )
    cached = read_stage_cache(paths.vlm_dir / "vlm_frame_selection_cache.json", cache_key, [plan_path])
    if cached is not None:
        plan = attach_selected_vlm_frames(read_json(plan_path), keyframes)
        logger.event(
            "vlm_frame_selection",
            "success",
            "复用缓存 VLM 代表帧计划",
            {"cache_hit": True, "selected_count": len(plan["selected_frame_ids"]), "total_keyframes": len(keyframes)},
        )
        return plan
    plan = plan_vlm_representative_frames(keyframes, scenes, asr_segments, ocr_results, yolo_results, request)
    write_json(plan_path, strip_runtime_frames_from_vlm_plan(plan))
    write_stage_cache(paths.vlm_dir / "vlm_frame_selection_cache.json", cache_key, [plan_path])
    logger.event(
        "vlm_frame_selection",
        "success",
        "VLM 代表帧选择完成",
        {"selected_count": len(plan["selected_frame_ids"]), "total_keyframes": len(keyframes)},
    )
    return plan


def vlm_selection_config(request: PipelineRequest) -> dict[str, Any]:
    # 2026-06-21 提取 VLM 代表帧选择配置用于缓存键和产物追踪
    return {
        "min_frames": request.runtime_config.vlm_representative_min_frames,
        "min_interval_seconds": request.runtime_config.vlm_representative_min_interval_seconds,
        "frames_per_minute": request.runtime_config.vlm_representative_frames_per_minute,
        "min_coverage_ratio": request.runtime_config.vlm_representative_min_coverage_ratio,
    }


def plan_vlm_representative_frames(
    keyframes: list[dict[str, Any]],
    scenes: list[dict[str, Any]],
    asr_segments: list[dict[str, Any]],
    ocr_results: list[dict[str, Any]],
    yolo_results: list[dict[str, Any]],
    request: PipelineRequest,
) -> dict[str, Any]:
    # 2026-06-21 基于 OCR YOLO ASR 和时间覆盖生成 VLM 代表帧计划
    scored_frames = score_vlm_candidate_frames(keyframes, scenes, asr_segments, ocr_results, yolo_results)
    selected_reasons = choose_vlm_representative_frame_ids(scored_frames, request)
    selected_frame_ids = [frame["frame_id"] for frame in keyframes if frame["frame_id"] in selected_reasons]
    selected_frames = [frame for frame in keyframes if frame["frame_id"] in selected_reasons]
    frame_items = build_vlm_selection_frame_items(scored_frames, selected_reasons)
    return {
        "strategy": "adaptive_signal_representative_frames",
        "config": vlm_selection_config(request),
        "total_keyframes": len(keyframes),
        "selected_frame_ids": selected_frame_ids,
        "frames": frame_items,
        "selected_frames": selected_frames,
    }


def score_vlm_candidate_frames(
    keyframes: list[dict[str, Any]],
    scenes: list[dict[str, Any]],
    asr_segments: list[dict[str, Any]],
    ocr_results: list[dict[str, Any]],
    yolo_results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    # 2026-06-21 为每个关键帧计算跨模态信息量分数
    scenes_by_id = {scene["scene_id"]: scene for scene in scenes}
    ocr_by_frame = group_items_by_field(ocr_results, "frame_id")
    yolo_by_frame = group_items_by_field(yolo_results, "frame_id")
    scored: list[dict[str, Any]] = []
    for frame in keyframes:
        scene = scenes_by_id.get(frame["scene_id"], {})
        frame_ocr = ocr_by_frame.get(frame["frame_id"], [])
        frame_yolo = yolo_by_frame.get(frame["frame_id"], [])
        scene_asr = collect_scene_asr_segments(scene, asr_segments)
        signals = build_vlm_frame_signals(scene, frame_ocr, frame_yolo, scene_asr)
        scored.append(
            {
                "frame": frame,
                "frame_id": frame["frame_id"],
                "scene_id": frame["scene_id"],
                "timestamp": float(frame["timestamp"]),
                "score": score_vlm_signals(signals),
                "signals": signals,
            }
        )
    return scored


def group_items_by_field(items: list[dict[str, Any]], field_name: str) -> dict[str, list[dict[str, Any]]]:
    # 2026-06-21 按字段聚合模型结果以便代表帧选择读取信号
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        key = item.get(field_name)
        if isinstance(key, str):
            grouped.setdefault(key, []).append(item)
    return grouped


def collect_scene_asr_segments(scene: dict[str, Any], asr_segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # 2026-06-21 收集与镜头时间范围相交的 ASR 分段
    if not scene:
        return []
    start = float(scene["start_time"])
    end = float(scene["end_time"])
    return [
        segment
        for segment in asr_segments
        if ranges_overlap(start, end, float(segment["start_time"]), float(segment["end_time"]))
    ]


def build_vlm_frame_signals(
    scene: dict[str, Any],
    ocr_items: list[dict[str, Any]],
    yolo_items: list[dict[str, Any]],
    asr_segments: list[dict[str, Any]],
) -> dict[str, Any]:
    # 2026-06-21 汇总单帧周边的文本物体语音和镜头时长信号
    ocr_text_length = sum(len(str(item.get("text") or "")) for item in ocr_items)
    yolo_classes = [str(item.get("class_name") or "") for item in yolo_items if str(item.get("class_name") or "")]
    asr_text_length = sum(len(str(segment.get("text") or "")) for segment in asr_segments)
    return {
        "scene_duration": round(float(scene.get("duration") or 0.0), 3) if scene else 0.0,
        "ocr_item_count": len(ocr_items),
        "ocr_text_length": ocr_text_length,
        "yolo_detection_count": len(yolo_items),
        "yolo_unique_object_count": len(set(yolo_classes)),
        "asr_segment_count": len(asr_segments),
        "asr_text_length": asr_text_length,
    }


def score_vlm_signals(signals: dict[str, Any]) -> float:
    # 2026-06-21 将多源信号压缩为代表帧排序分数
    score = 0.0
    score += min(float(signals["ocr_text_length"]) / 80.0, 2.0)
    score += min(float(signals["yolo_detection_count"]) / 4.0, 2.0)
    score += min(float(signals["yolo_unique_object_count"]) / 3.0, 1.0)
    score += min(float(signals["asr_text_length"]) / 120.0, 1.5)
    score += min(float(signals["scene_duration"]) / 20.0, 1.0)
    return round(score, 4)


def choose_vlm_representative_frame_ids(scored_frames: list[dict[str, Any]], request: PipelineRequest) -> dict[str, str]:
    # 2026-06-21 在配置预算内选择起止边界和高信息量代表帧
    if not scored_frames:
        return {}
    max_count = calculate_vlm_selection_budget(scored_frames, request)
    min_count = min(len(scored_frames), request.runtime_config.vlm_representative_min_frames)
    min_interval = request.runtime_config.vlm_representative_min_interval_seconds
    selected: dict[str, str] = {}
    selected_timestamps: dict[str, float] = {}

    add_vlm_selection(scored_frames[0], "video_start_boundary", selected, selected_timestamps, max_count)
    add_vlm_selection(scored_frames[-1], "video_end_boundary", selected, selected_timestamps, max_count)

    ranked = sorted(scored_frames, key=lambda item: (-float(item["score"]), float(item["timestamp"]), item["frame_id"]))
    for candidate in ranked:
        if len(selected) >= max_count:
            break
        if candidate["frame_id"] in selected:
            continue
        if not respects_vlm_min_interval(candidate, selected_timestamps, min_interval):
            continue
        add_vlm_selection(candidate, dominant_vlm_selection_reason(candidate["signals"]), selected, selected_timestamps, max_count)

    for candidate in ranked:
        if len(selected) >= min_count:
            break
        if candidate["frame_id"] in selected:
            continue
        add_vlm_selection(candidate, "min_frame_floor", selected, selected_timestamps, max_count)
    return selected


def calculate_vlm_selection_budget(scored_frames: list[dict[str, Any]], request: PipelineRequest) -> int:
    # 2026-06-21 按视频时长和镜头覆盖率计算 VLM 代表帧预算，只受关键帧总数限制
    if not scored_frames:
        return 0
    duration_seconds = max(float(item["timestamp"]) for item in scored_frames)
    duration_minutes = max(duration_seconds / 60.0, 1.0)
    time_budget = math.ceil(duration_minutes * request.runtime_config.vlm_representative_frames_per_minute)
    coverage_budget = math.ceil(len(scored_frames) * request.runtime_config.vlm_representative_min_coverage_ratio)
    bounded_budget = max(request.runtime_config.vlm_representative_min_frames, time_budget, coverage_budget)
    return min(len(scored_frames), bounded_budget)


def add_vlm_selection(
    candidate: dict[str, Any],
    reason: str,
    selected: dict[str, str],
    selected_timestamps: dict[str, float],
    max_count: int,
) -> None:
    # 2026-06-21 记录一个已选 VLM 代表帧和选择原因
    if len(selected) >= max_count:
        return
    frame_id = candidate["frame_id"]
    selected[frame_id] = reason
    selected_timestamps[frame_id] = float(candidate["timestamp"])


def respects_vlm_min_interval(candidate: dict[str, Any], selected_timestamps: dict[str, float], min_interval: float) -> bool:
    # 2026-06-21 判断候选帧是否满足已选代表帧的最小时间间隔
    if min_interval <= 0:
        return True
    timestamp = float(candidate["timestamp"])
    return all(abs(timestamp - selected_time) >= min_interval for selected_time in selected_timestamps.values())


def dominant_vlm_selection_reason(signals: dict[str, Any]) -> str:
    # 2026-06-21 根据最强信号给出代表帧选择原因
    weighted = {
        "high_ocr_text": float(signals["ocr_text_length"]) / 80.0,
        "high_object_density": float(signals["yolo_detection_count"]) / 4.0,
        "speech_overlap": float(signals["asr_text_length"]) / 120.0,
        "long_scene": float(signals["scene_duration"]) / 20.0,
    }
    return max(weighted.items(), key=lambda item: item[1])[0]


def build_vlm_selection_frame_items(scored_frames: list[dict[str, Any]], selected_reasons: dict[str, str]) -> list[dict[str, Any]]:
    # 2026-06-21 为每个关键帧生成 VLM 覆盖状态
    selected_frames = [item for item in scored_frames if item["frame_id"] in selected_reasons]
    items: list[dict[str, Any]] = []
    for item in scored_frames:
        nearest = nearest_selected_vlm_frame(item, selected_frames)
        selected = item["frame_id"] in selected_reasons
        items.append(
            {
                "frame_id": item["frame_id"],
                "scene_id": item["scene_id"],
                "timestamp": item["timestamp"],
                "vlm_status": "analyzed" if selected else "not_analyzed",
                "nearest_vlm_frame_id": nearest["frame_id"] if nearest else None,
                "nearest_vlm_timestamp": nearest["timestamp"] if nearest else None,
                "vlm_selection_reason": selected_reasons.get(item["frame_id"], "not_selected_by_adaptive_budget"),
                "vlm_selection_score": item["score"],
                "vlm_selection_signals": item["signals"],
            }
        )
    return items


def nearest_selected_vlm_frame(item: dict[str, Any], selected_frames: list[dict[str, Any]]) -> dict[str, Any] | None:
    # 2026-06-21 查找距离当前帧最近的已分析 VLM 代表帧
    if not selected_frames:
        return None
    timestamp = float(item["timestamp"])
    return min(selected_frames, key=lambda selected: abs(float(selected["timestamp"]) - timestamp))


def strip_runtime_frames_from_vlm_plan(plan: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 移除运行期完整帧对象后写入代表帧计划文件
    return {key: value for key, value in plan.items() if key != "selected_frames"}


def attach_selected_vlm_frames(plan: dict[str, Any], keyframes: list[dict[str, Any]]) -> dict[str, Any]:
    # 2026-06-21 从当前关键帧列表恢复代表帧计划中的运行期帧对象
    selected_ids = plan.get("selected_frame_ids")
    if not isinstance(selected_ids, list):
        raise TypeError("VLM 代表帧计划缺少 selected_frame_ids")
    by_id = {frame["frame_id"]: frame for frame in keyframes}
    selected_frames = []
    for frame_id in selected_ids:
        if not isinstance(frame_id, str) or frame_id not in by_id:
            raise ValueError(f"VLM 代表帧计划引用不存在的关键帧：{frame_id}")
        selected_frames.append(by_id[frame_id])
    restored = dict(plan)
    restored["selected_frames"] = selected_frames
    return restored


def build_evidence(
    task_id: str,
    metadata: dict[str, Any],
    scenes: list[dict[str, Any]],
    keyframes: list[dict[str, Any]],
    vlm_results: list[dict[str, Any]],
    vlm_plan: dict[str, Any],
    asr_segments: list[dict[str, Any]],
    ocr_results: list[dict[str, Any]],
    yolo_results: list[dict[str, Any]],
    paths: TaskPaths,
    logger: EventLogger,
) -> dict[str, Any]:
    # 2026-06-20 汇总各真实阶段产物为统一证据 JSON，保证 LLM 只消费结构化证据
    logger.event("evidence_building", "running", "开始构建结构化证据")
    cache_key = build_cache_key(
        "evidence_building",
        metadata["file_hash"],
        {},
        {
            "metadata": stable_hash(metadata),
            "scenes": stable_hash(scenes),
            "keyframes": stable_hash(keyframes),
            "vlm": stable_hash(vlm_results),
            "vlm_plan": stable_hash(strip_runtime_frames_from_vlm_plan(vlm_plan)),
            "asr": stable_hash(asr_segments),
            "ocr": stable_hash(ocr_results),
            "yolo": stable_hash(yolo_results),
        },
    )
    cached = read_stage_cache(paths.evidence_dir / "evidence_cache.json", cache_key, [paths.evidence_dir / "evidence.json"])
    if cached is not None:
        payload = read_json(paths.evidence_dir / "evidence.json")
        validate_evidence_payload(payload)
        logger.event("evidence_building", "success", "复用缓存结构化证据", {"cache_hit": True})
        return payload
    evidence_items: list[dict[str, Any]] = []
    for result in vlm_results:
        evidence_items.append(make_evidence(task_id, "vlm", result["timestamp"], result["timestamp"], result, result["confidence"], {"scene_id": result["scene_id"], "frame_id": result["frame_id"]}, result["model"]))
    for segment in asr_segments:
        evidence_items.append(make_evidence(task_id, "asr", segment["start_time"], segment["end_time"], {"text": segment["text"], "language": segment["language"], "speaker_id": segment["speaker_id"]}, segment["confidence"], {"segment_id": segment["segment_id"]}, segment["model"]))
    for result in ocr_results:
        if result["text"]:
            evidence_items.append(make_evidence(task_id, "ocr", result["timestamp"], result["timestamp"], result, result["confidence"], {"frame_id": result["frame_id"], "bbox": result["bbox"]}, result["model"]))
    for result in yolo_results:
        evidence_items.append(make_evidence(task_id, "yolo", result["timestamp"], result["timestamp"], result, result["confidence"], {"frame_id": result["frame_id"], "bbox": result["bbox"]}, result["model"]))
    payload = {
        "task_id": task_id,
        "video": {
            "original_filename": metadata["original_filename"],
            "file_hash": metadata["file_hash"],
            "duration_seconds": metadata["duration_seconds"],
            "width": metadata["width"],
            "height": metadata["height"],
            "fps": metadata["fps"],
        },
        "stages": [],
        "scenes": scenes,
        "keyframes": enrich_keyframes_with_vlm_coverage(keyframes, vlm_plan),
        "vlm_frame_selection": strip_runtime_frames_from_vlm_plan(vlm_plan),
        "evidence": evidence_items,
        "errors": [],
    }
    validate_evidence_payload(payload)
    write_json(paths.evidence_dir / "evidence.json", payload)
    write_stage_cache(paths.evidence_dir / "evidence_cache.json", cache_key, [paths.evidence_dir / "evidence.json"])
    logger.event("evidence_building", "success", "结构化证据生成完成", {"evidence_count": len(evidence_items)})
    return payload


def enrich_keyframes_with_vlm_coverage(keyframes: list[dict[str, Any]], vlm_plan: dict[str, Any]) -> list[dict[str, Any]]:
    # 2026-06-21 将 VLM 代表帧覆盖状态写回关键帧清单
    coverage_by_frame = {item["frame_id"]: item for item in vlm_plan.get("frames", []) if isinstance(item, dict) and isinstance(item.get("frame_id"), str)}
    enriched: list[dict[str, Any]] = []
    for frame in keyframes:
        coverage = coverage_by_frame.get(frame["frame_id"])
        if coverage is None:
            raise ValueError(f"VLM 代表帧计划缺少关键帧覆盖状态：{frame['frame_id']}")
        item = dict(frame)
        for key in ("vlm_status", "nearest_vlm_frame_id", "nearest_vlm_timestamp", "vlm_selection_reason", "vlm_selection_score", "vlm_selection_signals"):
            item[key] = coverage[key]
        enriched.append(item)
    return enriched


def make_evidence(
    task_id: str,
    source_type: str,
    start: float,
    end: float,
    content: dict[str, Any],
    confidence: float | None,
    source_ref: dict[str, Any],
    model: dict[str, Any],
) -> dict[str, Any]:
    # 2026-06-20 构造单条标准证据，统一来源、时间、内容和模型字段
    evidence_seed = stable_hash(
        {
            "task_id": task_id,
            "source_type": source_type,
            "start": start,
            "end": end,
            "source_ref": source_ref,
            "content": content,
        }
    )
    evidence_id = f"ev_{source_type}_{hashlib.sha256(evidence_seed.encode('utf-8')).hexdigest()[:10]}"
    return {
        "evidence_id": evidence_id,
        "task_id": task_id,
        "source_type": source_type,
        "time_range": {"start": start, "end": end},
        "content": content,
        "confidence": confidence,
        "source_ref": source_ref,
        "model_name": model.get("name"),
        "model_version": model.get("version"),
        "created_at": now_iso(),
    }


def validate_evidence_payload(payload: dict[str, Any]) -> None:
    # 2026-06-20 校验证据文件顶层结构和证据数组，防止坏证据进入融合与 LLM
    for key, expected_type in {
        "task_id": str,
        "video": dict,
        "stages": list,
        "scenes": list,
        "keyframes": list,
        "vlm_frame_selection": dict,
        "evidence": list,
        "errors": list,
    }.items():
        require_object_field(payload, key, expected_type, "evidence")
    validate_vlm_frame_selection(payload["vlm_frame_selection"], payload["keyframes"])
    seen_ids: set[str] = set()
    for index, item in enumerate(payload["evidence"]):
        validate_evidence_item(item, seen_ids, index)


def validate_vlm_frame_selection(selection: dict[str, Any], keyframes: list[Any]) -> None:
    # 2026-06-21 校验 VLM 代表帧选择计划和关键帧覆盖状态
    require_object_field(selection, "strategy", str, "vlm_frame_selection")
    require_object_field(selection, "config", dict, "vlm_frame_selection")
    require_object_field(selection, "total_keyframes", int, "vlm_frame_selection")
    require_object_field(selection, "selected_frame_ids", list, "vlm_frame_selection")
    require_object_field(selection, "frames", list, "vlm_frame_selection")
    if selection["total_keyframes"] != len(keyframes):
        raise ValueError("vlm_frame_selection.total_keyframes 与 keyframes 数量不一致")
    selected_ids = {frame_id for frame_id in selection["selected_frame_ids"] if isinstance(frame_id, str)}
    if len(selected_ids) != len(selection["selected_frame_ids"]):
        raise TypeError("vlm_frame_selection.selected_frame_ids 必须只包含字符串")
    keyframe_ids = {item["frame_id"] for item in keyframes if isinstance(item, dict) and isinstance(item.get("frame_id"), str)}
    if not selected_ids.issubset(keyframe_ids):
        missing = sorted(selected_ids - keyframe_ids)
        raise ValueError(f"vlm_frame_selection 引用了不存在的关键帧：{missing}")
    coverage_ids: set[str] = set()
    for index, item in enumerate(selection["frames"]):
        validate_vlm_selection_frame_item(item, index)
        coverage_ids.add(item["frame_id"])
    if coverage_ids != keyframe_ids:
        raise ValueError("vlm_frame_selection.frames 未覆盖全部关键帧")


def validate_vlm_selection_frame_item(item: Any, index: int) -> None:
    # 2026-06-21 校验单个关键帧的 VLM 覆盖状态
    if not isinstance(item, dict):
        raise TypeError(f"vlm_frame_selection.frames[{index}] 必须是对象")
    for key in ("frame_id", "scene_id", "vlm_status", "vlm_selection_reason"):
        require_object_field(item, key, str, f"vlm_frame_selection.frames[{index}]")
    if item["vlm_status"] not in {"analyzed", "not_analyzed"}:
        raise ValueError(f"vlm_frame_selection.frames[{index}].vlm_status 非法：{item['vlm_status']}")
    for key in ("timestamp", "vlm_selection_score"):
        if key not in item or not isinstance(item[key], (int, float)):
            raise TypeError(f"vlm_frame_selection.frames[{index}].{key} 必须是数字")
    if item.get("nearest_vlm_frame_id") is not None and not isinstance(item["nearest_vlm_frame_id"], str):
        raise TypeError(f"vlm_frame_selection.frames[{index}].nearest_vlm_frame_id 必须是字符串或 null")
    if item.get("nearest_vlm_timestamp") is not None and not isinstance(item["nearest_vlm_timestamp"], (int, float)):
        raise TypeError(f"vlm_frame_selection.frames[{index}].nearest_vlm_timestamp 必须是数字或 null")
    require_object_field(item, "vlm_selection_signals", dict, f"vlm_frame_selection.frames[{index}]")


def validate_evidence_item(item: Any, seen_ids: set[str], index: int) -> None:
    # 2026-06-20 校验单条证据字段、时间范围和唯一标识
    if not isinstance(item, dict):
        raise TypeError(f"evidence[{index}] 必须是对象")
    for key in ("evidence_id", "task_id", "source_type", "created_at"):
        require_object_field(item, key, str, f"evidence[{index}]")
    if item["evidence_id"] in seen_ids:
        raise ValueError(f"evidence[{index}] 证据标识重复：{item['evidence_id']}")
    seen_ids.add(item["evidence_id"])
    if item["source_type"] not in {"vlm", "asr", "ocr", "yolo"}:
        raise ValueError(f"evidence[{index}].source_type 非法：{item['source_type']}")
    require_object_field(item, "time_range", dict, f"evidence[{index}]")
    require_object_field(item, "content", dict, f"evidence[{index}]")
    require_object_field(item, "source_ref", dict, f"evidence[{index}]")
    validate_evidence_time_range(item["time_range"], f"evidence[{index}].time_range")
    if item.get("confidence") is not None:
        normalize_confidence(item["confidence"])
    if item.get("model_name") is not None and not isinstance(item["model_name"], str):
        raise TypeError(f"evidence[{index}].model_name 必须是字符串或 null")
    if item.get("model_version") is not None and not isinstance(item["model_version"], str):
        raise TypeError(f"evidence[{index}].model_version 必须是字符串或 null")


def validate_evidence_time_range(time_range: dict[str, Any], field_name: str) -> None:
    # 2026-06-20 校验证据时间范围，确保融合阶段可按时间对齐
    for key in ("start", "end"):
        if key not in time_range or not isinstance(time_range[key], (int, float)):
            raise TypeError(f"{field_name}.{key} 必须是数字")
    if float(time_range["start"]) > float(time_range["end"]):
        raise ValueError(f"{field_name} 开始时间不能晚于结束时间")


def fuse_evidence(task_id: str, scenes: list[dict[str, Any]], evidence: dict[str, Any], paths: TaskPaths, logger: EventLogger) -> dict[str, Any]:
    # 2026-06-20 按镜头时间范围融合证据，形成 LLM 直接输入的片段列表
    logger.event("evidence_fusion", "running", "开始融合证据")
    cache_key = build_cache_key("evidence_fusion", evidence["video"]["file_hash"], {}, {"scenes": stable_hash(scenes), "evidence": stable_hash(evidence)})
    cached = read_stage_cache(paths.evidence_dir / "fused_evidence_cache.json", cache_key, [paths.evidence_dir / "fused_evidence.json"])
    if cached is not None:
        logger.event("evidence_fusion", "success", "复用缓存融合证据", {"cache_hit": True})
        return read_json(paths.evidence_dir / "fused_evidence.json")
    segments = []
    for scene in scenes:
        refs = [
            item["evidence_id"]
            for item in evidence["evidence"]
            if ranges_overlap(scene["start_time"], scene["end_time"], item["time_range"]["start"], item["time_range"]["end"])
        ]
        vlm_coverage = scene_vlm_coverage(scene, evidence["keyframes"])
        segments.append(
            {
                "segment_id": f"fused_{scene['scene_id']}",
                "start_time": scene["start_time"],
                "end_time": scene["end_time"],
                "scene_ids": [scene["scene_id"]],
                "evidence_refs": refs,
                "vlm_status": vlm_coverage["vlm_status"],
                "nearest_vlm_frame_id": vlm_coverage["nearest_vlm_frame_id"],
                "nearest_vlm_timestamp": vlm_coverage["nearest_vlm_timestamp"],
                "vlm_selection_reason": vlm_coverage["vlm_selection_reason"],
                "asr_text": collect_asr_text(evidence["evidence"], refs),
                "ocr_text": collect_ocr_text(evidence["evidence"], refs),
                "visual_summary": collect_visual_summary(evidence["evidence"], refs),
                "objects": collect_objects(evidence["evidence"], refs),
                "people_candidates": collect_people_candidates(evidence["evidence"], refs),
                "conflicts": [],
                "confidence": average_confidence(evidence["evidence"], refs),
            }
        )
    payload = {"task_id": task_id, "segments": segments}
    write_json(paths.evidence_dir / "fused_evidence.json", payload)
    write_stage_cache(paths.evidence_dir / "fused_evidence_cache.json", cache_key, [paths.evidence_dir / "fused_evidence.json"])
    logger.event("evidence_fusion", "success", "证据融合完成", {"segment_count": len(segments)})
    return payload


def scene_vlm_coverage(scene: dict[str, Any], keyframes: list[dict[str, Any]]) -> dict[str, Any]:
    # 2026-06-21 计算单个镜头的 VLM 直接分析状态和最近代表帧
    scene_frames = [frame for frame in keyframes if frame.get("scene_id") == scene["scene_id"]]
    analyzed_frames = [frame for frame in scene_frames if frame.get("vlm_status") == "analyzed"]
    midpoint_time = midpoint(float(scene["start_time"]), float(scene["end_time"]))
    if analyzed_frames:
        frame = nearest_frame_by_timestamp(analyzed_frames, midpoint_time)
        return {
            "vlm_status": "analyzed",
            "nearest_vlm_frame_id": frame["frame_id"],
            "nearest_vlm_timestamp": frame["timestamp"],
            "vlm_selection_reason": frame["vlm_selection_reason"],
        }
    if scene_frames:
        frame = nearest_frame_by_timestamp(scene_frames, midpoint_time)
        return {
            "vlm_status": "not_analyzed",
            "nearest_vlm_frame_id": frame["nearest_vlm_frame_id"],
            "nearest_vlm_timestamp": frame["nearest_vlm_timestamp"],
            "vlm_selection_reason": frame["vlm_selection_reason"],
        }
    return {
        "vlm_status": "not_analyzed",
        "nearest_vlm_frame_id": nearest_vlm_frame_for_time(keyframes, midpoint_time),
        "nearest_vlm_timestamp": nearest_vlm_timestamp_for_time(keyframes, midpoint_time),
        "vlm_selection_reason": "scene_has_no_keyframe",
    }


def nearest_frame_by_timestamp(frames: list[dict[str, Any]], timestamp: float) -> dict[str, Any]:
    # 2026-06-21 按时间找出最接近目标时间的关键帧
    if not frames:
        raise ValueError("nearest_frame_by_timestamp 需要至少一个关键帧")
    return min(frames, key=lambda frame: abs(float(frame["timestamp"]) - timestamp))


def nearest_vlm_frame_for_time(keyframes: list[dict[str, Any]], timestamp: float) -> str | None:
    # 2026-06-21 在全局关键帧中查找最接近目标时间的已分析 VLM 帧标识
    analyzed = [frame for frame in keyframes if frame.get("vlm_status") == "analyzed"]
    if not analyzed:
        return None
    return nearest_frame_by_timestamp(analyzed, timestamp)["frame_id"]


def nearest_vlm_timestamp_for_time(keyframes: list[dict[str, Any]], timestamp: float) -> float | None:
    # 2026-06-21 在全局关键帧中查找最接近目标时间的已分析 VLM 帧时间
    analyzed = [frame for frame in keyframes if frame.get("vlm_status") == "analyzed"]
    if not analyzed:
        return None
    return float(nearest_frame_by_timestamp(analyzed, timestamp)["timestamp"])


def ranges_overlap(start_a: float, end_a: float, start_b: float, end_b: float) -> bool:
    # 2026-06-20 判断两个时间范围是否相交，用于镜头和证据对齐
    return start_a <= end_b and start_b <= end_a


def collect_asr_text(evidence_items: list[dict[str, Any]], refs: list[str]) -> str:
    # 2026-06-20 汇总指定证据引用中的 ASR 文本
    return " ".join(item["content"].get("text", "") for item in evidence_items if item["evidence_id"] in refs and item["source_type"] == "asr").strip()


def collect_ocr_text(evidence_items: list[dict[str, Any]], refs: list[str]) -> str:
    # 2026-06-20 汇总指定证据引用中的 OCR 文本
    return " ".join(item["content"].get("text", "") for item in evidence_items if item["evidence_id"] in refs and item["source_type"] == "ocr").strip()


def collect_visual_summary(evidence_items: list[dict[str, Any]], refs: list[str]) -> str:
    # 2026-06-20 汇总指定证据引用中的视觉摘要
    summaries = [item["content"].get("description", "") for item in evidence_items if item["evidence_id"] in refs and item["source_type"] == "vlm"]
    return " ".join(summary for summary in summaries if summary).strip()


def collect_objects(evidence_items: list[dict[str, Any]], refs: list[str]) -> list[str]:
    # 2026-06-20 汇总指定证据引用中的物体类别
    objects = []
    for item in evidence_items:
        if item["evidence_id"] in refs and item["source_type"] == "yolo":
            objects.append(item["content"].get("class_name", ""))
    return [item for item in objects if item]


def collect_people_candidates(evidence_items: list[dict[str, Any]], refs: list[str]) -> list[Any]:
    # 2026-06-20 汇总指定证据引用中的人物候选
    people = []
    for item in evidence_items:
        if item["evidence_id"] in refs and item["source_type"] == "vlm":
            people.extend(item["content"].get("visible_people", []))
    return people


def average_confidence(evidence_items: list[dict[str, Any]], refs: list[str]) -> float:
    # 2026-06-20 计算融合片段的平均置信度，缺失置信度时忽略
    values = [
        float(item["confidence"])
        for item in evidence_items
        if item["evidence_id"] in refs and isinstance(item.get("confidence"), (int, float))
    ]
    return round(sum(values) / len(values), 4) if values else 0.0


def build_key_moments(segments: list[dict[str, Any]], limit: int = KEY_MOMENT_LIMIT) -> list[dict[str, Any]]:
    # 2026-06-22 基于融合证据生成关键节点候选，避免让模型无证据判断看点
    scored = []
    for segment in segments:
        signals = key_moment_signals(segment)
        score = calculate_key_moment_score(signals)
        if score < 0.28 or not segment.get("evidence_refs"):
            continue
        scored.append((score, segment, signals))

    selected = sorted(scored, key=lambda item: (-item[0], float(item[1]["start_time"])))[:limit]
    return [
        {
            "start_time": segment["start_time"],
            "end_time": segment["end_time"],
            "title": build_key_moment_title(segment, signals),
            "reason": build_key_moment_reason(signals),
            "score": round(score, 4),
            "evidence_refs": segment["evidence_refs"],
            "signals": signals,
        }
        for score, segment, signals in sorted(selected, key=lambda item: float(item[1]["start_time"]))
    ]


def key_moment_signals(segment: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-22 提取关键节点评分信号，保留可解释原因供前端展示
    asr_length = len(str(segment.get("asr_text") or "").strip())
    ocr_length = len(str(segment.get("ocr_text") or "").strip())
    visual_length = len(str(segment.get("visual_summary") or "").strip())
    object_count = len(unique_limited_strings(segment.get("objects", []), 20))
    people_count = len(unique_limited_strings(segment.get("people_candidates", []), 20))
    duration = max(0.0, float(segment["end_time"]) - float(segment["start_time"]))
    confidence = normalize_confidence(segment.get("confidence", 0.0))
    reason = str(segment.get("vlm_selection_reason") or "")
    return {
        "vlm_analyzed": segment.get("vlm_status") == "analyzed",
        "asr_length": asr_length,
        "ocr_length": ocr_length,
        "visual_length": visual_length,
        "object_count": object_count,
        "people_count": people_count,
        "duration_seconds": round(duration, 3),
        "confidence": confidence,
        "boundary_frame": reason in {"video_start_boundary", "video_end_boundary"},
        "high_signal_frame": reason in {"high_ocr_text", "high_object_density", "speech_overlap", "long_scene"},
    }


def calculate_key_moment_score(signals: dict[str, Any]) -> float:
    # 2026-06-22 将多模态信号压成稳定分数，用于筛出值得优先查看的时间点
    score = 0.0
    score += 0.18 if signals["vlm_analyzed"] else 0.0
    score += min(float(signals["visual_length"]) / 180.0, 1.0) * 0.14
    score += min(float(signals["asr_length"]) / 160.0, 1.0) * 0.18
    score += min(float(signals["ocr_length"]) / 100.0, 1.0) * 0.16
    score += min(float(signals["object_count"]) / 5.0, 1.0) * 0.1
    score += min(float(signals["people_count"]) / 2.0, 1.0) * 0.1
    score += float(signals["confidence"]) * 0.08
    score += 0.04 if signals["boundary_frame"] else 0.0
    score += 0.08 if signals["high_signal_frame"] else 0.0
    # 过短片段通常不适合单独观看，长片段保留但不额外奖励
    if float(signals["duration_seconds"]) < 1.0:
        score *= 0.75
    return min(round(score, 4), 1.0)


def build_key_moment_title(segment: dict[str, Any], signals: dict[str, Any]) -> str:
    # 2026-06-22 生成关键节点短标题，优先使用现有时间线标题和主要信号
    if signals["people_count"]:
        prefix = "人物节点"
    elif signals["ocr_length"]:
        prefix = "文字节点"
    elif signals["asr_length"]:
        prefix = "语音节点"
    elif signals["object_count"]:
        prefix = "画面节点"
    else:
        prefix = "关键节点"
    return f"{prefix} {float(segment['start_time']):.2f}s"


def build_key_moment_reason(signals: dict[str, Any]) -> str:
    # 2026-06-22 汇总关键节点入选原因，便于人工判断是否值得查看
    reasons = []
    if signals["vlm_analyzed"]:
        reasons.append("已由 VLM 直接分析")
    if signals["asr_length"]:
        reasons.append("包含语音文本")
    if signals["ocr_length"]:
        reasons.append("包含画面文字")
    if signals["people_count"]:
        reasons.append("出现人物候选")
    if signals["object_count"]:
        reasons.append("检测到物体")
    if signals["boundary_frame"]:
        reasons.append("位于视频边界")
    if signals["high_signal_frame"]:
        reasons.append("代表帧信息量较高")
    return "；".join(reasons) or "融合证据置信度较高"


def build_final_result(
    task_id: str,
    metadata: dict[str, Any],
    fused: dict[str, Any],
    evidence: dict[str, Any],
    paths: TaskPaths,
    logger: EventLogger,
    request: PipelineRequest,
) -> dict[str, Any]:
    # 2026-06-20 使用真实 LLM 生成最终结果，LLM 失败或缺字段时直接阻断
    logger.event("llm_reasoning", "running", "开始生成最终结果")
    llm_payload = run_real_llm(metadata, fused, evidence, request, logger)
    validate_llm_payload(llm_payload)
    timeline = merge_timeline(fused["segments"], llm_payload["timeline"])
    key_moments = build_key_moments(fused["segments"])
    evidence_refs = [item["evidence_id"] for item in evidence["evidence"]]
    result = {
        "task_id": task_id,
        "source_video": {
            "original_filename": metadata["original_filename"],
            "file_hash": metadata["file_hash"],
            "duration_seconds": metadata["duration_seconds"],
            "width": metadata["width"],
            "height": metadata["height"],
            "fps": metadata["fps"],
        },
        "summary": truncate_text(llm_payload["summary"], 800),
        "timeline": timeline,
        "key_moments": key_moments,
        "characters": normalize_llm_characters(llm_payload["characters"], evidence_refs),
        "tags": normalize_llm_string_list(llm_payload["tags"], 12, 40),
        "keywords": normalize_llm_string_list(llm_payload["keywords"], 16, 40),
        "naming": build_naming(metadata, evidence, llm_payload.get("naming"), request),
        "plot": truncate_text(llm_payload["plot"], 1000),
        "quality": {
            "overall_confidence": average_result_confidence(timeline),
            "has_audio": int(metadata.get("audio_stream_count") or 0) > 0,
            "has_ocr_text": any(item["source_type"] == "ocr" for item in evidence["evidence"]),
            "has_detected_people": any(item["content"].get("visible_people") for item in evidence["evidence"] if item["source_type"] == "vlm"),
            **build_vlm_quality_summary(fused["segments"]),
            "stage_success_rate": 1.0,
        },
        "processing_log_summary": build_processing_log_summary(paths, request),
        "evidence_refs": evidence_refs,
        "errors": [],
    }
    validate_final_result(result, evidence)
    write_json(paths.final_dir / "result.json", result)
    logger.event("llm_reasoning", "success", "最终结果写入完成")
    return result


def build_vlm_quality_summary(segments: list[dict[str, Any]]) -> dict[str, Any]:
    # 2026-06-21 汇总 VLM 代表帧对最终片段的直接覆盖情况
    total_count = len(segments)
    analyzed_count = sum(1 for segment in segments if segment.get("vlm_status") == "analyzed")
    coverage_rate = round(analyzed_count / total_count, 4) if total_count else 0.0
    return {
        "vlm_analyzed_segment_count": analyzed_count,
        "vlm_total_segment_count": total_count,
        "vlm_coverage_rate": coverage_rate,
    }


def run_real_llm(
    metadata: dict[str, Any],
    fused: dict[str, Any],
    evidence: dict[str, Any],
    request: PipelineRequest,
    logger: EventLogger | None = None,
) -> dict[str, Any]:
    # 2026-06-21 调用真实 LLM 通过只读工具查询证据，最终结果仍由普通 JSON 内容承载
    client = build_llm_client(request)
    system_prompt = (
        "You are a video understanding result generator. "
        "Use only structured evidence returned by tools or listed in the request. "
        "You must call evidence tools before the final answer. "
        "Tools are read-only evidence queries; tools must never output final fields. "
        "Return the final answer only as a JSON object in message.content. "
        "All user-visible string values must be written in Simplified Chinese (zh-CN), including summary, timeline titles, timeline descriptions, character descriptions, tags, keywords, plot, and naming fields. "
        "Required top-level keys are summary, timeline, characters, tags, keywords, plot, and naming. "
        "The naming field must be an object, never a string or array. "
        "If naming evidence is uncertain, return naming as an empty object. "
        "Allowed naming keys are series_name, season_number, episode_number, episode_title, confidence, and evidence_refs. "
        "Do not include reasoning. Do not invent identities or facts not supported by evidence. "
        "Set timeline to an empty array because the pipeline will build timeline entries from evidence segments. "
        "Character identity_status must be visible_person, candidate_character, or confirmed_character. "
        "Keep output concise. Set every character appearances field to an empty array. "
        "Recommended tool sequence: get_video_metadata, get_evidence_overview, get_fused_segments, "
        "get_vlm_evidence, get_asr_evidence, get_ocr_evidence, get_yolo_evidence, get_naming_candidates."
    )
    tool_manifest = [tool["function"]["name"] for tool in evidence_query_tools()]
    payload = {
        "task": "Query read-only evidence tools, then produce final video understanding JSON.",
        "video_hint": {
            "original_filename": metadata["original_filename"],
            "duration_seconds": metadata["duration_seconds"],
        },
        "segment_count": len(fused["segments"]),
        "evidence_refs": compact_evidence_refs_for_llm(evidence),
        "output_language": request.language,
        "available_tools": tool_manifest,
        "final_output_contract": {
            "summary": "string",
            "timeline": "empty array",
            "characters": "array",
            "tags": "array of strings",
            "keywords": "array of strings",
            "plot": "string",
            "naming": "object",
        },
    }

    def log_tool_round(round_number: int, tool_calls: list[dict[str, Any]]) -> None:
        # 2026-06-21 记录 LLM 实际调用的证据工具细节，方便判断模型为何继续查证
        if logger is not None:
            tool_names = [item["name"] for item in tool_calls]
            logger.event(
                "llm_tool_call",
                "success",
                "LLM 调用证据工具",
                {"round": round_number, "tool_names": tool_names, "tool_count": len(tool_names), "tool_calls": tool_calls},
            )

    return client.chat_with_tools_json(
        system_prompt,
        payload,
        evidence_query_tools(),
        build_evidence_tool_handlers(metadata, fused, evidence),
        min_tool_calls=1,
        on_tool_call_round=log_tool_round,
    )


def build_llm_client(request: PipelineRequest) -> LocalLlmClient:
    # 2026-06-21 根据 .env 构造 LLM 客户端，DeepSeek 等文本模型只负责最终理解
    return LocalLlmClient(
        request.runtime_config.llm_base_url,
        request.runtime_config.llm_name,
        request.runtime_config.llm_timeout_seconds,
        request.runtime_config.llm_api_key,
        request.runtime_config.llm_chat_completions_path,
    )


def build_vlm_client(request: PipelineRequest) -> LocalLlmClient:
    # 2026-06-21 根据 .env 构造 VLM 客户端，必须指向支持 image_url 的模型服务
    return LocalLlmClient(
        request.runtime_config.vlm_base_url,
        request.runtime_config.vlm_name,
        request.runtime_config.vlm_timeout_seconds,
        request.runtime_config.vlm_api_key,
        request.runtime_config.vlm_chat_completions_path,
    )


def evidence_query_tools() -> list[dict[str, Any]]:
    # 2026-06-21 定义十个只读证据查询工具，工具不承载最终输出字段
    return [
        make_function_tool("get_video_metadata", "Read basic video metadata and original filename", empty_tool_schema()),
        make_function_tool("get_evidence_overview", "Read evidence counts, coverage, and high level source summary", empty_tool_schema()),
        make_function_tool("get_fused_segments", "Read compact fused evidence segments by optional time range", fused_segments_tool_schema()),
        make_function_tool("get_vlm_evidence", "Read compact visual language model evidence", source_limit_tool_schema()),
        make_function_tool("get_asr_evidence", "Read compact speech transcription evidence", source_limit_tool_schema()),
        make_function_tool("get_ocr_evidence", "Read compact independent OCR evidence", source_limit_tool_schema()),
        make_function_tool("get_yolo_evidence", "Read compact object detection evidence", source_limit_tool_schema()),
        make_function_tool("search_evidence_text", "Search ASR/OCR/VLM evidence text by keyword", text_search_tool_schema()),
        make_function_tool("get_naming_candidates", "Read filename and text-derived naming candidates", empty_tool_schema()),
        make_function_tool("get_evidence_by_ids", "Read compact evidence items by evidence ids", evidence_by_ids_tool_schema()),
    ]


def make_function_tool(name: str, description: str, parameters_schema: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 生成 OpenAI 兼容 function tool 定义，避免十工具结构重复拼装
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters_schema,
        },
    }


def empty_tool_schema() -> dict[str, Any]:
    # 2026-06-21 定义无参数工具 schema，用于读取视频元数据
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {},
    }


def fused_segments_tool_schema() -> dict[str, Any]:
    # 2026-06-21 定义按时间范围读取融合证据片段的工具参数
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "start_time": {"type": ["number", "null"]},
            "end_time": {"type": ["number", "null"]},
            "limit": {"type": ["integer", "null"], "minimum": 1, "maximum": MAX_TOOL_RESULT_LIMIT},
        },
    }


def source_limit_tool_schema() -> dict[str, Any]:
    # 2026-06-21 定义按数量读取指定来源证据的工具参数
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "limit": {"type": ["integer", "null"], "minimum": 1, "maximum": MAX_TOOL_RESULT_LIMIT},
        },
    }


def text_search_tool_schema() -> dict[str, Any]:
    # 2026-06-21 定义文本证据关键词搜索工具参数
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["query"],
        "properties": {
            "query": {"type": "string"},
            "limit": {"type": ["integer", "null"], "minimum": 1, "maximum": MAX_TOOL_RESULT_LIMIT},
        },
    }


def evidence_by_ids_tool_schema() -> dict[str, Any]:
    # 2026-06-21 定义按证据 ID 读取证据摘要的工具参数
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["evidence_ids"],
        "properties": {
            "evidence_ids": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
        },
    }


def build_evidence_tool_handlers(metadata: dict[str, Any], fused: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 绑定程序侧证据查询工具处理器，工具只返回证据上下文不生成结论
    return {
        "get_video_metadata": lambda arguments: query_video_metadata(metadata),
        "get_evidence_overview": lambda arguments: query_evidence_overview(fused, evidence),
        "get_fused_segments": lambda arguments: query_fused_segments(fused, arguments),
        "get_vlm_evidence": lambda arguments: query_evidence_by_source(evidence, "vlm", arguments),
        "get_asr_evidence": lambda arguments: query_evidence_by_source(evidence, "asr", arguments),
        "get_ocr_evidence": lambda arguments: query_evidence_by_source(evidence, "ocr", arguments),
        "get_yolo_evidence": lambda arguments: query_evidence_by_source(evidence, "yolo", arguments),
        "search_evidence_text": lambda arguments: query_evidence_text(evidence, arguments),
        "get_naming_candidates": lambda arguments: query_naming_candidates(evidence),
        "get_evidence_by_ids": lambda arguments: query_evidence_by_ids(evidence, arguments),
    }


def query_video_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 返回视频元数据的紧凑视图，供 LLM 校对文件名和时长
    return {
        "original_filename": metadata["original_filename"],
        "file_hash": metadata["file_hash"],
        "duration_seconds": metadata["duration_seconds"],
        "width": metadata["width"],
        "height": metadata["height"],
        "fps": metadata["fps"],
    }


def query_evidence_overview(fused: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 返回证据总览和 VLM 覆盖率，让 LLM 先判断信息密度
    counts = compact_evidence_refs_for_llm(evidence)["source_counts"]
    return {
        "source_counts": counts,
        "segment_count": len(fused["segments"]),
        "vlm_quality": build_vlm_quality_summary(fused["segments"]),
        "time_range": {
            "start": fused["segments"][0]["start_time"] if fused["segments"] else None,
            "end": fused["segments"][-1]["end_time"] if fused["segments"] else None,
        },
    }


def query_fused_segments(fused: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 按可选时间范围返回融合片段，限制数量避免工具结果过大
    start_time = arguments.get("start_time")
    end_time = arguments.get("end_time")
    limit = normalize_tool_limit(arguments.get("limit"), 12)
    segments = []
    for segment in fused["segments"]:
        if isinstance(start_time, (int, float)) and segment["end_time"] < float(start_time):
            continue
        if isinstance(end_time, (int, float)) and segment["start_time"] > float(end_time):
            continue
        segments.append(segment)
        if len(segments) >= limit:
            break
    return {"segments": compact_segments_for_llm(segments)}


def query_evidence_by_source(evidence: dict[str, Any], source_type: str, arguments: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 按证据来源返回紧凑证据项，供 LLM 精查某一类模型结果
    limit = normalize_tool_limit(arguments.get("limit"), 20)
    items = [compact_evidence_item(item) for item in evidence["evidence"] if item["source_type"] == source_type]
    return {"evidence": items[:limit]}


def query_evidence_text(evidence: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 在文本类证据中执行关键词搜索，减少 LLM 为找名称读取全量 OCR
    query = arguments.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query 必须是非空字符串")
    needle = query.casefold().strip()
    limit = normalize_tool_limit(arguments.get("limit"), 20)
    matches: list[dict[str, Any]] = []
    for item in evidence["evidence"]:
        text = evidence_item_search_text(item)
        if needle in text.casefold():
            matches.append(compact_evidence_item(item))
        if len(matches) >= limit:
            break
    return {"matches": matches}


def query_naming_candidates(evidence: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 返回从 OCR 和 ASR 文本抽取的命名候选，帮助 LLM 判断系列和剧集信息
    candidates = collect_naming_text_candidates(evidence)
    evidence_refs = candidates.get("evidence_refs", [])
    compact_refs = evidence_refs[:24] if isinstance(evidence_refs, list) else []
    return {
        "series_name": candidates.get("series_name"),
        "season_number": candidates.get("season_number"),
        "episode_number": candidates.get("episode_number"),
        "episode_title": candidates.get("episode_title"),
        "evidence_ref_count": len(evidence_refs) if isinstance(evidence_refs, list) else 0,
        "evidence_refs": compact_refs,
    }


def query_evidence_by_ids(evidence: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 按证据 ID 返回紧凑证据项，供 LLM 复核指定引用
    evidence_ids = arguments.get("evidence_ids")
    if not isinstance(evidence_ids, list):
        raise TypeError("evidence_ids 必须是数组")
    wanted_ids = {item for item in evidence_ids if isinstance(item, str)}
    items = [compact_evidence_item(item) for item in evidence["evidence"] if item["evidence_id"] in wanted_ids]
    return {"evidence": items}


def compact_evidence_item(item: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 压缩单条证据内容，保留来源、时间、置信度和关键文本
    content = item["content"]
    compact_content: dict[str, Any] = {}
    for key in ("text", "description", "class_name", "visible_people", "actions", "environment", "visible_text_hints", "objects_hints", "mood"):
        if key in content:
            value = content[key]
            compact_content[key] = truncate_text(value, 180) if isinstance(value, str) else unique_limited_strings(value, 8) if isinstance(value, list) else value
    return {
        "evidence_id": item["evidence_id"],
        "source_type": item["source_type"],
        "time_range": item["time_range"],
        "confidence": item["confidence"],
        "content": compact_content,
    }


def normalize_tool_limit(value: Any, default: int) -> int:
    # 2026-06-21 规范化工具查询返回数量，允许长视频一次读取足量证据但保留总上限
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return min(value, MAX_TOOL_RESULT_LIMIT)
    return min(default, MAX_TOOL_RESULT_LIMIT)


def evidence_item_search_text(item: dict[str, Any]) -> str:
    # 2026-06-21 汇总单条证据可搜索文本，覆盖 ASR OCR 和 VLM 描述字段
    content = item["content"]
    parts: list[str] = []
    for key in ("text", "description", "class_name", "environment", "mood"):
        value = content.get(key)
        if isinstance(value, str):
            parts.append(value)
    for key in ("visible_people", "actions", "visible_text_hints", "objects_hints"):
        value = content.get(key)
        if isinstance(value, list):
            parts.extend(stringify_text_item(item) for item in value)
    return " ".join(part for part in parts if part)


def normalize_llm_characters(characters: Any, available_evidence_refs: list[str]) -> list[dict[str, Any]]:
    # 2026-06-21 规范化 LLM 人物输出，避免格式漂移阻断最终结果
    if not isinstance(characters, list):
        return []
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(characters):
        if not isinstance(item, dict):
            continue
        identity_status = item.get("identity_status") if item.get("identity_status") in CHARACTER_IDENTITY_STATUSES else "candidate_character"
        refs = [ref for ref in item.get("evidence_refs", []) if isinstance(ref, str) and ref in available_evidence_refs]
        normalized.append(
            {
                "character_id": str(item.get("character_id") or f"char_{index + 1:03d}"),
                "name": item.get("name") if isinstance(item.get("name"), str) else None,
                "identity_status": identity_status,
                "description": truncate_text(str(item.get("description") or ""), 300),
                "appearances": normalize_character_appearances(item.get("appearances"), available_evidence_refs),
                "evidence_refs": refs,
                "confidence": normalize_optional_confidence(item.get("confidence")),
            }
        )
    return normalized


def normalize_character_appearances(appearances: Any, available_evidence_refs: list[str]) -> list[dict[str, Any]]:
    # 2026-06-21 规范化人物出现时间段，只保留对象形态且证据引用有效的条目
    if not isinstance(appearances, list):
        return []
    normalized: list[dict[str, Any]] = []
    for appearance in appearances:
        if not isinstance(appearance, dict):
            continue
        start = appearance.get("start_time")
        end = appearance.get("end_time")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or float(start) > float(end):
            continue
        refs = [ref for ref in appearance.get("evidence_refs", []) if isinstance(ref, str) and ref in available_evidence_refs]
        normalized.append({"start_time": float(start), "end_time": float(end), "evidence_refs": refs})
    return normalized


def normalize_llm_string_list(values: Any, max_items: int = 50, max_length: int = 120) -> list[str]:
    # 2026-06-21 规范化 LLM 标签和关键词，过滤非字符串项并限制输出长度
    if not isinstance(values, list):
        return []
    result: list[str] = []
    for value in values:
        text = stringify_text_item(value)
        if text and text not in result:
            result.append(truncate_text(text, max_length))
        if len(result) >= max_items:
            break
    return result


def compact_segments_for_llm(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # 2026-06-21 压缩融合片段输入，避免最终 LLM 请求超过本地服务上下文限制
    return [
        {
            "segment_id": segment["segment_id"],
            "start_time": segment["start_time"],
            "end_time": segment["end_time"],
            "evidence_refs": segment["evidence_refs"][:12],
            "vlm_status": segment["vlm_status"],
            "nearest_vlm_frame_id": segment["nearest_vlm_frame_id"],
            "nearest_vlm_timestamp": segment["nearest_vlm_timestamp"],
            "vlm_selection_reason": segment["vlm_selection_reason"],
            "asr_text": truncate_text(segment.get("asr_text", ""), 220),
            "ocr_text": truncate_text(segment.get("ocr_text", ""), 220),
            "visual_summary": truncate_text(segment.get("visual_summary", ""), 220),
            "objects": unique_limited_strings(segment.get("objects", []), 10),
            "people_candidates": unique_limited_strings(segment.get("people_candidates", []), 6),
            "confidence": segment["confidence"],
        }
        for segment in segments
    ]


def compact_evidence_refs_for_llm(evidence: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 汇总证据引用索引，让 LLM 能引用证据但不接收完整证据全集
    counts: dict[str, int] = {}
    for item in evidence["evidence"]:
        counts[item["source_type"]] = counts.get(item["source_type"], 0) + 1
    return {"task_id": evidence["task_id"], "source_counts": counts}


def truncate_text(value: Any, limit: int) -> str:
    # 2026-06-21 截断长文本字段，控制最终理解阶段请求体大小
    if not isinstance(value, str):
        return ""
    stripped = value.strip()
    return stripped if len(stripped) <= limit else stripped[:limit]


def unique_limited_strings(values: Any, limit: int) -> list[str]:
    # 2026-06-21 提取去重后的短字符串列表，避免对象和长数组撑爆 LLM 输入
    if not isinstance(values, list):
        return []
    result: list[str] = []
    for value in values:
        text = stringify_text_item(value)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def validate_llm_payload(payload: dict[str, Any]) -> None:
    # 2026-06-20 校验 LLM 最终结果字段，缺字段或类型错误直接失败
    required = {
        "summary": str,
        "timeline": list,
        "characters": list,
        "tags": list,
        "keywords": list,
        "plot": str,
    }
    for key, expected_type in required.items():
        if key not in payload:
            raise ValueError(f"LLM 结果缺少字段：{key}")
        if not isinstance(payload[key], expected_type):
            raise TypeError(f"LLM 字段类型错误：{key}")
    if "naming" in payload and not isinstance(payload["naming"], dict):
        raise TypeError("LLM 字段类型错误：naming")


def merge_timeline(segments: list[dict[str, Any]], llm_timeline: list[Any]) -> list[dict[str, Any]]:
    # 2026-06-20 合并 LLM 时间线文本和融合证据时间范围，数量不匹配时使用证据片段兜底
    if len(llm_timeline) != len(segments):
        return [build_evidence_timeline_item(segment) for segment in segments]
    timeline = []
    for segment, item in zip(segments, llm_timeline, strict=True):
        if not isinstance(item, dict):
            raise TypeError("LLM 时间线条目必须是对象")
        for key in ("title", "description", "confidence"):
            if key not in item:
                raise ValueError(f"LLM 时间线条目缺少字段：{key}")
        timeline.append(
            {
                "start_time": segment["start_time"],
                "end_time": segment["end_time"],
                "title": str(item["title"]),
                "description": str(item["description"]),
                "evidence_refs": segment["evidence_refs"],
                "vlm_status": segment["vlm_status"],
                "nearest_vlm_frame_id": segment["nearest_vlm_frame_id"],
                "nearest_vlm_timestamp": segment["nearest_vlm_timestamp"],
                "vlm_selection_reason": segment["vlm_selection_reason"],
                "confidence": normalize_confidence(item["confidence"]),
            }
        )
    return timeline


def build_evidence_timeline_item(segment: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 基于融合证据生成基础时间线项，保证最终输出覆盖所有片段
    description_parts = [
        truncate_text(segment.get("visual_summary", ""), 180),
        truncate_text(segment.get("asr_text", ""), 120),
        truncate_text(segment.get("ocr_text", ""), 120),
    ]
    description = "；".join(part for part in description_parts if part) or "该片段缺少可读文本描述，仅保留结构化证据引用"
    return {
        "start_time": segment["start_time"],
        "end_time": segment["end_time"],
        "title": f"{segment['start_time']:.2f}s 片段",
        "description": description,
        "evidence_refs": segment["evidence_refs"],
        "vlm_status": segment["vlm_status"],
        "nearest_vlm_frame_id": segment["nearest_vlm_frame_id"],
        "nearest_vlm_timestamp": segment["nearest_vlm_timestamp"],
        "vlm_selection_reason": segment["vlm_selection_reason"],
        "confidence": normalize_confidence(segment["confidence"]),
    }


def average_result_confidence(timeline: list[dict[str, Any]]) -> float:
    # 2026-06-20 根据时间线置信度计算最终结果总体置信度
    if not timeline:
        return 0.0
    return round(sum(float(item["confidence"]) for item in timeline) / len(timeline), 4)


def build_naming(metadata: dict[str, Any], evidence: dict[str, Any], llm_naming: Any, request: PipelineRequest) -> dict[str, Any]:
    # 2026-06-20 融合文件名、文本证据和 LLM 命名建议，生成可追踪命名结果
    original_filename = metadata["original_filename"]
    parsed = parse_filename_naming(original_filename)
    text_candidates = collect_naming_text_candidates(evidence)
    llm_fields = llm_naming if isinstance(llm_naming, dict) else {}
    evidence_ids = {item["evidence_id"] for item in evidence["evidence"]}

    series_name = first_non_empty(parsed.get("series_name"), text_candidates.get("series_name"), llm_fields.get("series_name"))
    season_number = first_int(parsed.get("season_number"), text_candidates.get("season_number"), llm_fields.get("season_number"))
    episode_number = first_int(parsed.get("episode_number"), text_candidates.get("episode_number"), llm_fields.get("episode_number"))
    episode_title = first_non_empty(parsed.get("episode_title"), text_candidates.get("episode_title"), llm_fields.get("episode_title"))
    extension = Path(original_filename).suffix.lower().lstrip(".")
    episode_code = build_episode_code(season_number, episode_number)
    evidence_refs = filter_existing_evidence_refs(merge_evidence_refs(text_candidates.get("evidence_refs", []), llm_fields.get("evidence_refs", [])), evidence_ids)
    confidence = naming_confidence(parsed, text_candidates, llm_fields)
    normalized_filename = render_filename(request.filename_template, original_filename, extension, series_name, season_number, episode_number, episode_code, episode_title)
    return {
        "normalized_filename": normalized_filename,
        "series_name": series_name,
        "season_number": season_number,
        "episode_number": episode_number,
        "episode_code": episode_code,
        "episode_title": episode_title,
        "extension": extension,
        "confidence": confidence,
        "evidence_refs": evidence_refs,
    }


def parse_filename_naming(filename: str) -> dict[str, Any]:
    # 2026-06-20 从文件名解析系列名、季集编号和标题，作为命名结果的第一证据来源
    stem = Path(filename).stem
    normalized = re.sub(r"[\._]+", " ", stem).strip()
    patterns = [
        re.compile(r"^(?P<series>.+?)[\s\-]*[Ss](?P<season>\d{1,2})[Ee](?P<episode>\d{1,3})(?:[\s\-_]+(?P<title>.+))?$"),
        re.compile(r"^(?P<series>.+?)[\s\-]*第(?P<season>\d{1,2})季[\s\-]*第(?P<episode>\d{1,3})集(?:[\s\-_]+(?P<title>.+))?$"),
        re.compile(r"^(?P<series>.+?)[\s\-]*第(?P<episode>\d{1,3})集(?:[\s\-_]+(?P<title>.+))?$"),
    ]
    for pattern in patterns:
        match = pattern.match(normalized)
        if match:
            groups = match.groupdict()
            return {
                "series_name": clean_title(groups.get("series")),
                "season_number": int(groups["season"]) if groups.get("season") else None,
                "episode_number": int(groups["episode"]) if groups.get("episode") else None,
                "episode_title": clean_title(groups.get("title")),
            }
    return {
        "series_name": None,
        "season_number": None,
        "episode_number": None,
        "episode_title": clean_title(normalized) if normalized else None,
    }


def collect_naming_text_candidates(evidence: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-20 从 OCR 和 ASR 证据文本中提取命名候选和证据引用
    joined_texts: list[str] = []
    refs: list[str] = []
    for item in evidence["evidence"]:
        if item["source_type"] not in {"ocr", "asr"}:
            continue
        text = item["content"].get("text")
        if isinstance(text, str) and text.strip():
            joined_texts.append(text.strip())
            refs.append(item["evidence_id"])
    text = " ".join(joined_texts)
    parsed = parse_filename_naming(text) if text else {}
    parsed["evidence_refs"] = refs
    return parsed


def clean_title(value: Any) -> str | None:
    # 2026-06-20 清理命名文本中的分隔符和多余空白，避免生成不稳定文件名
    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"\s+", " ", value).strip(" -_")
    return cleaned or None


def first_non_empty(*values: Any) -> str | None:
    # 2026-06-20 按优先级选择第一个非空字符串，保持命名来源顺序稳定
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def first_int(*values: Any) -> int | None:
    # 2026-06-20 按优先级选择第一个有效整数，用于季集编号合并
    for value in values:
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())
    return None


def build_episode_code(season_number: int | None, episode_number: int | None) -> str | None:
    # 2026-06-20 生成标准季集编码，缺少季或集时保持为空
    if season_number is None or episode_number is None:
        return None
    return f"S{season_number:02d}E{episode_number:02d}"


def merge_evidence_refs(*groups: Any) -> list[str]:
    # 2026-06-20 合并命名证据引用并去重，避免重复引用干扰人工审阅
    refs: list[str] = []
    for group in groups:
        if not isinstance(group, list):
            continue
        for item in group:
            if isinstance(item, str) and item not in refs:
                refs.append(item)
    return refs


def filter_existing_evidence_refs(refs: list[str], evidence_ids: set[str]) -> list[str]:
    # 2026-06-21 过滤 LLM 命名建议中的不存在证据引用，保证最终命名可追溯
    return [ref for ref in refs if ref in evidence_ids]


def naming_confidence(parsed: dict[str, Any], text_candidates: dict[str, Any], llm_fields: dict[str, Any]) -> float:
    # 2026-06-20 根据命名字段来源计算置信度，文件名和证据文本优先于模型建议
    score = 0.25
    if parsed.get("series_name"):
        score += 0.2
    if parsed.get("episode_number"):
        score += 0.2
    if parsed.get("season_number"):
        score += 0.1
    if text_candidates.get("evidence_refs"):
        score += 0.15
    if llm_fields.get("confidence") is not None:
        score += normalize_confidence(llm_fields["confidence"]) * 0.1
    return round(min(score, 1.0), 4)


def render_filename(
    template: str,
    original_filename: str,
    extension: str,
    series_name: str | None,
    season_number: int | None,
    episode_number: int | None,
    episode_code: str | None,
    episode_title: str | None,
) -> str:
    # 2026-06-20 使用配置模板渲染归一化文件名，信息不足时回到原始文件名
    if not series_name or season_number is None or episode_number is None:
        return original_filename
    values = {
        "series_name": safe_filename_part(series_name),
        "season_number": f"{season_number:02d}",
        "episode_number": f"{episode_number:02d}",
        "episode_code": episode_code or "",
        "episode_title": safe_filename_part(episode_title or f"EP{episode_number:02d}"),
        "extension": extension,
    }
    rendered = template.format(**values)
    return safe_filename(rendered)


def safe_filename_part(value: str) -> str:
    # 2026-06-20 清理文件名片段中的非法字符，避免输出不可落盘名称
    cleaned = re.sub(r'[<>:"/\\|?*]+', "_", value).strip()
    return cleaned or "unknown"


def safe_filename(value: str) -> str:
    # 2026-06-20 清理完整文件名中的非法字符并压缩空白
    cleaned = re.sub(r'[<>:"/\\|?*]+', "_", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def validate_final_result(result: dict[str, Any], evidence: dict[str, Any]) -> None:
    # 2026-06-20 校验最终结果结构和证据引用，防止不合约结果落盘
    required = {
        "task_id": str,
        "source_video": dict,
        "summary": str,
        "timeline": list,
        "characters": list,
        "tags": list,
        "keywords": list,
        "naming": dict,
        "plot": str,
        "quality": dict,
        "processing_log_summary": dict,
        "evidence_refs": list,
        "errors": list,
    }
    for key, expected_type in required.items():
        require_object_field(result, key, expected_type, "result")
    evidence_ids = {item["evidence_id"] for item in evidence["evidence"]}
    validate_source_video(result["source_video"])
    validate_timeline(result["timeline"], evidence_ids)
    validate_key_moments(result["key_moments"], evidence_ids)
    validate_characters(result["characters"], evidence_ids)
    validate_string_list(result["tags"], "result.tags")
    validate_string_list(result["keywords"], "result.keywords")
    validate_naming_result(result["naming"], evidence_ids)
    validate_quality(result["quality"])
    validate_evidence_refs(result["evidence_refs"], evidence_ids, "result.evidence_refs")


def require_object_field(payload: dict[str, Any], key: str, expected_type: type, object_name: str) -> None:
    # 2026-06-20 校验对象必需字段和类型，给出明确字段路径
    if key not in payload:
        raise ValueError(f"{object_name} 缺少字段：{key}")
    if not isinstance(payload[key], expected_type):
        raise TypeError(f"{object_name}.{key} 类型错误")


def validate_source_video(source_video: dict[str, Any]) -> None:
    # 2026-06-20 校验最终结果中的源视频元数据字段
    for key in ("original_filename", "file_hash"):
        require_object_field(source_video, key, str, "source_video")
    for key in ("duration_seconds", "fps"):
        if key not in source_video or not isinstance(source_video[key], (int, float)):
            raise TypeError(f"source_video.{key} 必须是数字")
    for key in ("width", "height"):
        require_object_field(source_video, key, int, "source_video")


def validate_timeline(timeline: list[Any], evidence_ids: set[str]) -> None:
    # 2026-06-20 校验时间线条目结构、时间范围和证据引用
    for index, item in enumerate(timeline):
        if not isinstance(item, dict):
            raise TypeError(f"timeline[{index}] 必须是对象")
        for key in ("start_time", "end_time", "confidence"):
            if key not in item or not isinstance(item[key], (int, float)):
                raise TypeError(f"timeline[{index}].{key} 必须是数字")
        if float(item["start_time"]) > float(item["end_time"]):
            raise ValueError(f"timeline[{index}] 开始时间不能晚于结束时间")
        for key in ("title", "description"):
            require_object_field(item, key, str, f"timeline[{index}]")
        validate_timeline_vlm_coverage(item, f"timeline[{index}]")
        require_object_field(item, "evidence_refs", list, f"timeline[{index}]")
        validate_evidence_refs(item["evidence_refs"], evidence_ids, f"timeline[{index}].evidence_refs")
        normalize_confidence(item["confidence"])


def validate_key_moments(key_moments: list[Any], evidence_ids: set[str]) -> None:
    # 2026-06-22 校验关键节点结构，确保看点时间和证据引用可追溯
    for index, item in enumerate(key_moments):
        if not isinstance(item, dict):
            raise TypeError(f"key_moments[{index}] 必须是对象")
        for key in ("start_time", "end_time", "score"):
            if key not in item or not isinstance(item[key], (int, float)):
                raise TypeError(f"key_moments[{index}].{key} 必须是数字")
        if float(item["start_time"]) > float(item["end_time"]):
            raise ValueError(f"key_moments[{index}] 开始时间不能晚于结束时间")
        for key in ("title", "reason"):
            require_object_field(item, key, str, f"key_moments[{index}]")
        normalize_confidence(item["score"])
        require_object_field(item, "evidence_refs", list, f"key_moments[{index}]")
        validate_evidence_refs(item["evidence_refs"], evidence_ids, f"key_moments[{index}].evidence_refs")
        require_object_field(item, "signals", dict, f"key_moments[{index}]")


def validate_timeline_vlm_coverage(item: dict[str, Any], field_name: str) -> None:
    # 2026-06-21 校验最终时间线中的 VLM 代表帧覆盖字段
    require_object_field(item, "vlm_status", str, field_name)
    if item["vlm_status"] not in {"analyzed", "not_analyzed"}:
        raise ValueError(f"{field_name}.vlm_status 非法：{item['vlm_status']}")
    if item.get("nearest_vlm_frame_id") is not None and not isinstance(item["nearest_vlm_frame_id"], str):
        raise TypeError(f"{field_name}.nearest_vlm_frame_id 必须是字符串或 null")
    if item.get("nearest_vlm_timestamp") is not None and not isinstance(item["nearest_vlm_timestamp"], (int, float)):
        raise TypeError(f"{field_name}.nearest_vlm_timestamp 必须是数字或 null")
    require_object_field(item, "vlm_selection_reason", str, field_name)


def validate_characters(characters: list[Any], evidence_ids: set[str]) -> None:
    # 2026-06-20 校验人物条目结构，确保人物结论保留证据和置信度
    for index, item in enumerate(characters):
        if not isinstance(item, dict):
            raise TypeError(f"characters[{index}] 必须是对象")
        for key in ("character_id", "identity_status", "description"):
            require_object_field(item, key, str, f"characters[{index}]")
        if item["identity_status"] not in CHARACTER_IDENTITY_STATUSES:
            raise ValueError(f"characters[{index}].identity_status 非法：{item['identity_status']}")
        if item.get("name") is not None and not isinstance(item["name"], str):
            raise TypeError(f"characters[{index}].name 必须是字符串或 null")
        require_object_field(item, "appearances", list, f"characters[{index}]")
        require_object_field(item, "evidence_refs", list, f"characters[{index}]")
        if "confidence" not in item:
            raise ValueError(f"characters[{index}] 缺少字段：confidence")
        normalize_confidence(item["confidence"])
        validate_character_appearances(item["appearances"], evidence_ids, f"characters[{index}].appearances")
        validate_evidence_refs(item["evidence_refs"], evidence_ids, f"characters[{index}].evidence_refs")


def validate_character_appearances(appearances: list[Any], evidence_ids: set[str], field_name: str) -> None:
    # 2026-06-20 校验人物出现时间段，保证人物结果可按时间追踪
    for index, appearance in enumerate(appearances):
        if not isinstance(appearance, dict):
            raise TypeError(f"{field_name}[{index}] 必须是对象")
        for key in ("start_time", "end_time"):
            if key not in appearance or not isinstance(appearance[key], (int, float)):
                raise TypeError(f"{field_name}[{index}].{key} 必须是数字")
        if float(appearance["start_time"]) > float(appearance["end_time"]):
            raise ValueError(f"{field_name}[{index}] 开始时间不能晚于结束时间")
        if "evidence_refs" in appearance:
            if not isinstance(appearance["evidence_refs"], list):
                raise TypeError(f"{field_name}[{index}].evidence_refs 必须是数组")
            validate_evidence_refs(appearance["evidence_refs"], evidence_ids, f"{field_name}[{index}].evidence_refs")


def validate_string_list(values: list[Any], field_name: str) -> None:
    # 2026-06-20 校验字符串数组字段，防止标签和关键词混入复杂对象
    if not all(isinstance(item, str) for item in values):
        raise TypeError(f"{field_name} 必须是字符串数组")


def validate_naming_result(naming: dict[str, Any], evidence_ids: set[str]) -> None:
    # 2026-06-20 校验命名结果字段和证据引用
    require_object_field(naming, "normalized_filename", str, "naming")
    require_object_field(naming, "extension", str, "naming")
    require_object_field(naming, "evidence_refs", list, "naming")
    if naming.get("series_name") is not None and not isinstance(naming["series_name"], str):
        raise TypeError("naming.series_name 必须是字符串或 null")
    for key in ("season_number", "episode_number"):
        if naming.get(key) is not None and not isinstance(naming[key], int):
            raise TypeError(f"naming.{key} 必须是整数或 null")
    for key in ("episode_code", "episode_title"):
        if naming.get(key) is not None and not isinstance(naming[key], str):
            raise TypeError(f"naming.{key} 必须是字符串或 null")
    normalize_confidence(naming.get("confidence"))
    validate_evidence_refs(naming["evidence_refs"], evidence_ids, "naming.evidence_refs")


def validate_quality(quality: dict[str, Any]) -> None:
    # 2026-06-20 校验质量摘要字段，确保最终结果可用于筛选和排序
    for key in ("overall_confidence", "stage_success_rate", "vlm_coverage_rate"):
        if key not in quality:
            raise ValueError(f"quality 缺少字段：{key}")
        normalize_confidence(quality[key])
    for key in ("has_audio", "has_ocr_text", "has_detected_people"):
        require_object_field(quality, key, bool, "quality")
    for key in ("vlm_analyzed_segment_count", "vlm_total_segment_count"):
        require_object_field(quality, key, int, "quality")


def validate_evidence_refs(refs: list[Any], evidence_ids: set[str], field_name: str) -> None:
    # 2026-06-20 校验证据引用存在于证据文件，保证最终结论可追溯
    for ref in refs:
        if not isinstance(ref, str):
            raise TypeError(f"{field_name} 必须只包含字符串")
        if ref not in evidence_ids:
            raise ValueError(f"{field_name} 引用了不存在的证据：{ref}")


def build_processing_log_summary(paths: TaskPaths, request: PipelineRequest) -> dict[str, Any]:
    # 2026-06-20 汇总阶段日志状态，写入最终结果方便人工审阅
    events_path = paths.logs_dir / "pipeline_events.jsonl"
    events = read_current_run_events(events_path)
    stage_statuses = [{"stage": event["stage"], "status": event["status"]} for event in events]
    created_times = [event["created_at"] for event in events]
    finished_at = now_iso()
    return {
        "started_at": created_times[0] if created_times else None,
        "finished_at": finished_at,
        "elapsed_seconds": calculate_elapsed_seconds(created_times[0], finished_at) if created_times else None,
        "stage_statuses": stage_statuses,
        "llm": {"base_url": request.runtime_config.llm_base_url, "model": request.runtime_config.llm_name},
        "vlm": {"base_url": request.runtime_config.vlm_base_url, "model": request.runtime_config.vlm_name},
        "ocr": build_ocr_log_summary(paths, request),
        "asr": build_asr_log_summary(paths, request),
        "yolo": build_yolo_log_summary(paths, request),
        "error_count": 0,
    }


def read_current_run_events(events_path: Path) -> list[dict[str, Any]]:
    # 2026-06-21 读取当前管线运行的事件，避免同任务失败续跑污染本次耗时
    if not events_path.exists():
        return []
    events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    last_start_index = 0
    for index, event in enumerate(events):
        if event.get("stage") == "pipeline" and event.get("status") == "running":
            last_start_index = index
    return events[last_start_index:]


def calculate_elapsed_seconds(started_at: str, finished_at: str) -> float:
    # 2026-06-21 根据带时区时间戳计算本次管线耗时，避免最终结果缺少首跑耗时口径
    start = datetime.fromisoformat(started_at)
    finish = datetime.fromisoformat(finished_at)
    return round((finish - start).total_seconds(), 3)


def build_ocr_log_summary(paths: TaskPaths, request: PipelineRequest) -> dict[str, Any]:
    # 2026-06-20 汇总 OCR 实际使用状态
    ocr_path = paths.ocr_dir / "ocr_results.json"
    result_count = len(read_json(ocr_path)) if ocr_path.exists() else 0
    return {"result_count": result_count, "engine": request.runtime_config.ocr_engine}


def build_asr_log_summary(paths: TaskPaths, request: PipelineRequest) -> dict[str, Any]:
    # 2026-06-20 汇总 ASR 实际使用状态
    asr_path = paths.audio_dir / "asr_segments.json"
    segment_count = len(read_json(asr_path)) if asr_path.exists() else 0
    return {
        "segment_count": segment_count,
        "model": f"faster-whisper-{request.runtime_config.asr_model_size}",
        "device": request.runtime_config.asr_device,
        "compute_type": request.runtime_config.asr_compute_type,
    }


def build_yolo_log_summary(paths: TaskPaths, request: PipelineRequest) -> dict[str, Any]:
    # 2026-06-20 汇总 YOLO 实际使用状态
    yolo_path = paths.yolo_dir / "yolo_results.json"
    detection_count = len(read_json(yolo_path)) if yolo_path.exists() else 0
    return {"detection_count": detection_count, "model": request.runtime_config.yolo_model}


def export_markdown(result: dict[str, Any], paths: TaskPaths) -> None:
    # 2026-06-22 导出正式 Markdown 结果，补充关键节点并保持与 result.json 同源
    lines = [
        f"# {result['source_video']['original_filename']}",
        "",
        "## 视频介绍",
        "",
        result["summary"],
        "",
        "## 时间线",
        "",
    ]
    for item in result["timeline"]:
        lines.append(f"- {item['start_time']:.2f}s - {item['end_time']:.2f}s：{item['title']}：{item['description']}")

    lines.extend(["", "## 关键节点", ""])
    if result["key_moments"]:
        for item in result["key_moments"]:
            lines.append(f"- {item['start_time']:.2f}s - {item['end_time']:.2f}s：{item['title']}：{item['reason']}（评分：{item['score']}）")
    else:
        lines.append("- 暂无高置信关键节点")

    lines.extend(["", "## 人物", ""])
    if result["characters"]:
        for character in result["characters"]:
            name = character.get("name") or character.get("character_id") or "未命名人物"
            description = character.get("description") or ""
            confidence = character.get("confidence")
            lines.append(f"- {name}：{description}（置信度：{confidence}）")
    else:
        lines.append("- 无明确人物证据")

    naming = result["naming"]
    lines.extend(
        [
            "",
            "## 命名",
            "",
            f"- 文件名：{naming['normalized_filename']}",
            f"- 系列名：{naming['series_name'] or ''}",
            f"- 剧集：{naming['episode_code'] or ''}",
            f"- 标题：{naming['episode_title'] or ''}",
            f"- 置信度：{naming['confidence']}",
            "",
            "## 剧情",
            "",
            result["plot"],
            "",
            "## 标签",
            "",
            "、".join(result["tags"]),
            "",
            "## 关键词",
            "",
            "、".join(result["keywords"]),
        ]
    )
    paths.final_dir.mkdir(parents=True, exist_ok=True)
    (paths.final_dir / "result.md").write_text("\n".join(lines), encoding="utf-8")
