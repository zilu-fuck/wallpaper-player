from __future__ import annotations

import argparse
import os
from pathlib import Path

from .config import load_request_from_env
from .pipeline import run_pipeline


def build_parser() -> argparse.ArgumentParser:
    # 2026-06-20 创建命令行参数解析器，只接收视频路径，其他配置由 .env 提供
    parser = argparse.ArgumentParser(description="运行视频理解管线")
    parser.add_argument("video_path", help="本地视频文件路径")
    return parser


def main() -> None:
    # 2026-06-20 CLI 入口，从 .env 加载配置后执行管线
    args = build_parser().parse_args()
    env_path = Path(os.environ.get("VIDEO_COMPREHENSION_ENV") or ".env")
    result = run_pipeline(load_request_from_env(Path(args.video_path), env_path=env_path))
    print(f"任务完成：{result['task_id']}")
