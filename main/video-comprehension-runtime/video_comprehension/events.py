from __future__ import annotations

import json
import sys
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def ensure_utf8_stdout() -> None:
    # 2026-06-21 将终端输出切到 UTF-8，避免 Windows 控制台进度中文乱码
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")


def now_iso() -> str:
    # 2026-06-20 生成带时区的 ISO 时间，统一阶段日志和产物时间字段
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


@dataclass
class EventLogger:
    events_path: Path
    errors_path: Path
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    def __post_init__(self) -> None:
        # 2026-06-20 初始化日志文件目录，避免阶段写日志时目录缺失
        ensure_utf8_stdout()
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        self.errors_path.parent.mkdir(parents=True, exist_ok=True)

    def event(self, stage: str, status: str, message: str, extra: dict[str, Any] | None = None) -> None:
        # 2026-06-20 记录阶段事件，形成可追踪的 JSONL 执行日志
        payload = {
            "created_at": now_iso(),
            "stage": stage,
            "status": status,
            "message": message,
            "extra": extra or {},
        }
        with self._lock:
            with self.events_path.open("a", encoding="utf-8") as file:
                file.write(json.dumps(payload, ensure_ascii=False) + "\n")
            print(format_console_event(payload), flush=True)

    def error(
        self,
        stage: str,
        severity: str,
        message: str,
        recoverable: bool,
        affects_final_output: bool,
        input_ref: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        # 2026-06-20 记录结构化错误，禁止阶段异常被静默吞掉
        error_payload = {
            "error_id": f"err_{stage}_{int(datetime.now().timestamp())}",
            "stage": stage,
            "severity": severity,
            "message": message,
            "input_ref": input_ref or {},
            "created_at": now_iso(),
            "recoverable": recoverable,
            "affects_final_output": affects_final_output,
        }
        with self._lock:
            existing: list[dict[str, Any]] = []
            if self.errors_path.exists():
                existing = json.loads(self.errors_path.read_text(encoding="utf-8"))
            existing.append(error_payload)
            self.errors_path.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
        self.event(stage, "error", message, {"severity": severity, "recoverable": recoverable})
        return error_payload


def format_console_event(payload: dict[str, Any]) -> str:
    # 2026-06-21 格式化阶段事件为终端进度行，便于长任务实时观察
    stage = payload["stage"]
    status = payload["status"]
    message = payload["message"]
    extra = payload.get("extra") or {}
    suffix = f" {json.dumps(extra, ensure_ascii=False)}" if extra else ""
    return f"[{payload['created_at']}] {stage} {status}: {message}{suffix}"
