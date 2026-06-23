from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ALLOWED_ENV_KEYS = {
    "MAX_DURATION_SECONDS",
    "MODEL_STORAGE_DIR",
    "LLM_PROVIDER",
    "LLM_BASE_URL",
    "LLM_NAME",
    "LLM_API_KEY",
    "VLM_PROVIDER",
    "VLM_BASE_URL",
    "VLM_NAME",
    "VLM_API_KEY",
    "VLM_MODEL_PATH",
    "VLM_MODEL_DOWNLOAD_URL",
    "VLM_HF_REPO",
    "VLM_HF_REVISION",
    "VLM_HF_TOKEN",
    "VLM_SERVER_EXECUTABLE",
    "VLM_SERVER_ARGS",
    "VLM_CONCURRENCY",
    "MODE",
}
DEFAULT_OUTPUT_DIR = Path("outputs")
DEFAULT_MODEL_STORAGE_DIR = Path("models")
DEFAULT_OUTPUT_LANGUAGE = "zh-CN"
DEFAULT_FILENAME_TEMPLATE = "{series_name}_S{season_number}E{episode_number}_{episode_title}.{extension}"
DEFAULT_SCENE_THRESHOLD = 27.0
DEFAULT_LLM_TIMEOUT_SECONDS = 120
DEFAULT_LLM_CHAT_COMPLETIONS_PATH = "/chat/completions"
DEFAULT_VLM_TIMEOUT_SECONDS = 120
DEFAULT_VLM_CHAT_COMPLETIONS_PATH = "/v1/chat/completions"
DEFAULT_OCR_ENGINE = "rapidocr_onnxruntime"
DEFAULT_OCR_CONCURRENCY = 4
DEFAULT_ASR_MODEL_SIZE = "tiny"
DEFAULT_ASR_DEVICE = "cpu"
DEFAULT_ASR_COMPUTE_TYPE = "int8"
DEFAULT_YOLO_MODEL = "models/yolo/yolo11n.pt"
MODE_PROFILES: dict[str, dict[str, float]] = {
    "fast": {
        "vlm_representative_min_frames": 8,
        "vlm_representative_min_interval_seconds": 6,
        "vlm_representative_frames_per_minute": 1,
        "vlm_representative_min_coverage_ratio": 0.1,
    },
    "balance": {
        "vlm_representative_min_frames": 8,
        "vlm_representative_min_interval_seconds": 3,
        "vlm_representative_frames_per_minute": 4,
        "vlm_representative_min_coverage_ratio": 0.25,
    },
    "quantity": {
        "vlm_representative_min_frames": 16,
        "vlm_representative_min_interval_seconds": 1,
        "vlm_representative_frames_per_minute": 8,
        "vlm_representative_min_coverage_ratio": 0.5,
    },
}


@dataclass(frozen=True)
class SceneDetectionConfig:
    threshold: float


@dataclass(frozen=True)
class RuntimeConfig:
    mode: str
    scene_detection: SceneDetectionConfig
    max_duration_seconds: float
    model_storage_dir: Path
    llm_base_url: str
    llm_name: str
    llm_timeout_seconds: int
    llm_api_key: str
    llm_chat_completions_path: str
    vlm_base_url: str
    vlm_name: str
    vlm_timeout_seconds: int
    vlm_api_key: str
    vlm_chat_completions_path: str
    vlm_concurrency: int
    vlm_representative_min_frames: int
    vlm_representative_min_interval_seconds: float
    vlm_representative_frames_per_minute: float
    vlm_representative_min_coverage_ratio: float
    ocr_engine: str
    ocr_concurrency: int
    asr_model_size: str
    asr_device: str
    asr_compute_type: str
    yolo_model: str


@dataclass(frozen=True)
class PipelineRequest:
    video_path: Path
    output_dir: Path
    task_id: str | None
    language: str
    filename_template: str
    runtime_config: RuntimeConfig = field(repr=False)


def load_env_file(path: Path) -> dict[str, str]:
    # 2026-06-20 读取 .env 配置文件，保留原始键值用于后续严格校验
    if not path.exists():
        raise FileNotFoundError(f"缺少配置文件：{path}")
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f".env 配置行缺少等号：{raw_line}")
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def validate_env_keys(values: dict[str, str]) -> None:
    # 2026-06-21 校验 .env 只包含公开运行旋钮，避免旧细项继续影响管线行为
    unsupported = sorted(set(values) - ALLOWED_ENV_KEYS)
    if unsupported:
        raise ValueError(f".env 包含不支持的配置：{', '.join(unsupported)}")


def require_env(values: dict[str, str], key: str) -> str:
    # 2026-06-20 读取必需配置项，缺失时立即阻断启动
    value = values.get(key)
    if value is None or value == "":
        raise ValueError(f".env 缺少必需配置：{key}")
    return value


def load_mode_profile(mode: str) -> dict[str, float]:
    # 2026-06-21 根据 MODE 读取内置 VLM 数量策略，避免暴露细粒度帧预算配置
    normalized = mode.lower()
    profile = MODE_PROFILES.get(normalized)
    if profile is None:
        raise ValueError("MODE 只能是 fast、balance 或 quantity")
    return profile


def validate_optional_llm_provider(values: dict[str, str]) -> None:
    provider = values.get("LLM_PROVIDER")
    if provider is not None and provider.lower() not in {"local", "api"}:
        raise ValueError("LLM_PROVIDER 只能是 local 或 api")
    vlm_provider = values.get("VLM_PROVIDER")
    if vlm_provider is not None and vlm_provider.lower() not in {"local", "api"}:
        raise ValueError("VLM_PROVIDER 只能是 local 或 api")


def load_request_from_env(video_path: Path, env_path: Path = Path(".env")) -> PipelineRequest:
    # 2026-06-21 从最小 .env 构建管线请求，其余运行细节由内置 profile 管理
    values = load_env_file(env_path)
    validate_env_keys(values)
    validate_optional_llm_provider(values)
    mode = require_env(values, "MODE").lower()
    profile = load_mode_profile(mode)
    model_storage_dir = resolve_config_path(values.get("MODEL_STORAGE_DIR") or str(DEFAULT_MODEL_STORAGE_DIR), env_path.parent)
    model_storage_dir.mkdir(parents=True, exist_ok=True)
    output_dir = resolve_config_path(os.environ.get("VIDEO_COMPREHENSION_OUTPUT_DIR") or str(DEFAULT_OUTPUT_DIR), env_path.parent)
    yolo_model = resolve_model_path(model_storage_dir, DEFAULT_YOLO_MODEL)
    runtime_config = RuntimeConfig(
        mode=mode,
        scene_detection=SceneDetectionConfig(
            threshold=DEFAULT_SCENE_THRESHOLD,
        ),
        max_duration_seconds=float(require_env(values, "MAX_DURATION_SECONDS")),
        model_storage_dir=model_storage_dir,
        llm_base_url=require_env(values, "LLM_BASE_URL"),
        llm_name=require_env(values, "LLM_NAME"),
        llm_timeout_seconds=DEFAULT_LLM_TIMEOUT_SECONDS,
        llm_api_key=require_env(values, "LLM_API_KEY"),
        llm_chat_completions_path=DEFAULT_LLM_CHAT_COMPLETIONS_PATH,
        vlm_base_url=require_env(values, "VLM_BASE_URL"),
        vlm_name=require_env(values, "VLM_NAME"),
        vlm_timeout_seconds=DEFAULT_VLM_TIMEOUT_SECONDS,
        vlm_api_key=require_env(values, "VLM_API_KEY"),
        vlm_chat_completions_path=DEFAULT_VLM_CHAT_COMPLETIONS_PATH,
        vlm_concurrency=int(require_env(values, "VLM_CONCURRENCY")),
        vlm_representative_min_frames=int(profile["vlm_representative_min_frames"]),
        vlm_representative_min_interval_seconds=float(profile["vlm_representative_min_interval_seconds"]),
        vlm_representative_frames_per_minute=float(profile["vlm_representative_frames_per_minute"]),
        vlm_representative_min_coverage_ratio=float(profile["vlm_representative_min_coverage_ratio"]),
        ocr_engine=DEFAULT_OCR_ENGINE,
        ocr_concurrency=DEFAULT_OCR_CONCURRENCY,
        asr_model_size=DEFAULT_ASR_MODEL_SIZE,
        asr_device=DEFAULT_ASR_DEVICE,
        asr_compute_type=DEFAULT_ASR_COMPUTE_TYPE,
        yolo_model=str(yolo_model),
    )
    if runtime_config.max_duration_seconds <= 0:
        raise ValueError("MAX_DURATION_SECONDS 必须大于 0")
    if not str(runtime_config.model_storage_dir).strip():
        raise ValueError("MODEL_STORAGE_DIR 不能为空")
    if runtime_config.vlm_concurrency <= 0:
        raise ValueError("VLM_CONCURRENCY 必须大于 0")
    if runtime_config.vlm_representative_min_frames <= 0:
        raise ValueError("MODE 内置最小代表帧必须大于 0")
    if runtime_config.vlm_representative_min_interval_seconds < 0:
        raise ValueError("MODE 内置代表帧间隔不能小于 0")
    if runtime_config.vlm_representative_frames_per_minute <= 0:
        raise ValueError("MODE 内置每分钟代表帧必须大于 0")
    if not 0 < runtime_config.vlm_representative_min_coverage_ratio <= 1:
        raise ValueError("MODE 内置覆盖率必须大于 0 且不超过 1")
    return PipelineRequest(
        video_path=video_path,
        output_dir=output_dir,
        task_id=None,
        language=DEFAULT_OUTPUT_LANGUAGE,
        filename_template=DEFAULT_FILENAME_TEMPLATE,
        runtime_config=runtime_config,
    )


def resolve_model_path(model_storage_dir: Path, model_path: str) -> Path:
    path = Path(model_path)
    if path.is_absolute():
        return path
    parts = path.parts
    if parts and parts[0] == DEFAULT_MODEL_STORAGE_DIR.name:
        return model_storage_dir.joinpath(*parts[1:])
    return model_storage_dir / path


def resolve_config_path(value: str, base_dir: Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else base_dir / path
