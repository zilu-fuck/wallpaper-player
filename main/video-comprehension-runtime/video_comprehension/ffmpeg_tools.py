from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any


def run_command(args: list[str], stage: str) -> subprocess.CompletedProcess[str]:
    # 2026-06-20 执行外部命令并捕获输出，任何失败都向上抛出供阶段记录
    try:
        return subprocess.run(args, check=True, capture_output=True, text=True, encoding="utf-8")
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip() if exc.stderr else ""
        raise RuntimeError(f"{stage} 执行失败：{stderr}") from exc


def probe_video(video_path: Path) -> dict[str, Any]:
    # 2026-06-20 使用 FFprobe 读取视频元数据，作为后续阶段的真实基础信息
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(video_path),
        ],
        "ffprobe",
    )
    return json.loads(result.stdout)


def extract_frame(video_path: Path, timestamp: float, image_path: Path) -> None:
    # 2026-06-20 使用 FFmpeg 抽取指定时间关键帧，确保关键帧来自真实视频
    image_path.parent.mkdir(parents=True, exist_ok=True)
    run_command(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{timestamp:.3f}",
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(image_path),
        ],
        "ffmpeg_extract_frame",
    )


def extract_audio(video_path: Path, audio_path: Path) -> None:
    # 2026-06-20 使用 FFmpeg 提取音频，供真实 ASR 接入时复用
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(audio_path),
        ],
        "ffmpeg_extract_audio",
    )
