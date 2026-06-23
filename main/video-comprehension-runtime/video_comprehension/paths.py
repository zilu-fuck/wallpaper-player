from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TaskPaths:
    root: Path
    input_dir: Path
    metadata_dir: Path
    scenes_dir: Path
    frames_dir: Path
    audio_dir: Path
    ocr_dir: Path
    vlm_dir: Path
    yolo_dir: Path
    evidence_dir: Path
    final_dir: Path
    logs_dir: Path


def build_task_paths(output_dir: Path, task_id: str) -> TaskPaths:
    # 2026-06-20 创建任务产物目录结构，保证各阶段输出路径稳定
    root = output_dir / task_id
    paths = TaskPaths(
        root=root,
        input_dir=root / "input",
        metadata_dir=root / "metadata",
        scenes_dir=root / "scenes",
        frames_dir=root / "frames",
        audio_dir=root / "audio",
        ocr_dir=root / "ocr",
        vlm_dir=root / "vlm",
        yolo_dir=root / "yolo",
        evidence_dir=root / "evidence",
        final_dir=root / "final",
        logs_dir=root / "logs",
    )
    for directory in (
        paths.input_dir,
        paths.metadata_dir,
        paths.scenes_dir,
        paths.frames_dir,
        paths.audio_dir,
        paths.ocr_dir,
        paths.vlm_dir,
        paths.yolo_dir,
        paths.evidence_dir,
        paths.final_dir,
        paths.logs_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    return paths
