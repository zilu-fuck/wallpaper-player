from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def write_json(path: Path, data: Any) -> None:
    # 2026-06-20 写入 JSON 产物，统一保证父目录存在并使用 UTF-8
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def read_json(path: Path) -> Any:
    # 2026-06-20 读取 JSON 产物，供阶段之间复用结构化数据
    return json.loads(path.read_text(encoding="utf-8"))
