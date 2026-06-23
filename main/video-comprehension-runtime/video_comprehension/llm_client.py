from __future__ import annotations

import json
import base64
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

ToolHandler = Callable[[dict[str, Any]], dict[str, Any]]
ToolCallObserver = Callable[[int, list[dict[str, Any]]], None]


class LocalLlmClient:
    def __init__(self, base_url: str, model: str, timeout_seconds: int, api_key: str, chat_completions_path: str) -> None:
        # 2026-06-20 初始化 OpenAI 兼容 LLM 客户端，固定使用 UTF-8 JSON 请求
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.api_key = api_key
        self.chat_completions_path = normalize_chat_path(chat_completions_path)

    def chat_json(self, system_prompt: str, user_payload: dict[str, Any]) -> dict[str, Any]:
        # 2026-06-20 请求本地模型生成 JSON，只读取 message.content 避免落盘推理内容
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.chat_completions_url,
            data=data,
            headers=self.request_headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"LLM 请求失败：HTTP {exc.code} {exc.reason}：{body}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"LLM 请求失败：{exc}") from exc
        content = extract_message_content(payload)
        return self.parse_or_repair_json_object(content, "LLM JSON")

    def chat_with_tools_json(
        self,
        system_prompt: str,
        user_payload: dict[str, Any],
        tools: list[dict[str, Any]],
        tool_handlers: dict[str, ToolHandler],
        min_tool_calls: int = 0,
        on_tool_call_round: ToolCallObserver | None = None,
    ) -> dict[str, Any]:
        # 2026-06-21 允许模型调用程序侧证据工具，最终结果仍从普通 JSON 内容读取
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ]
        total_tool_calls = 0
        tool_round_count = 0
        while True:
            payload = self.post_chat_completion(
                {
                    "model": self.model,
                    "messages": messages,
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                    "tools": tools,
                    "tool_choice": "auto",
                },
                "LLM function call",
            )
            message = extract_message(payload)
            tool_calls = message.get("tool_calls")
            if isinstance(tool_calls, list) and tool_calls:
                tool_details = append_tool_results(messages, message, tool_calls, tool_handlers)
                tool_round_count += 1
                total_tool_calls += len(tool_details)
                if on_tool_call_round is not None:
                    on_tool_call_round(tool_round_count, tool_details)
                continue
            if total_tool_calls < min_tool_calls:
                raise RuntimeError(f"LLM 未按要求调用证据工具：已调用 {total_tool_calls} 次，至少需要 {min_tool_calls} 次")
            content = extract_message_content(payload)
            return self.parse_or_repair_json_object(content, "LLM 最终 JSON")

    def post_chat_completion(self, body: dict[str, Any], error_label: str) -> dict[str, Any]:
        # 2026-06-21 发送 OpenAI 兼容 chat 请求并解析 JSON 响应，保留明确错误上下文
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.chat_completions_url,
            data=data,
            headers=self.request_headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body_text = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{error_label} 请求失败：HTTP {exc.code} {exc.reason}：{body_text}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"{error_label} 请求失败：{exc}") from exc

    def parse_or_repair_json_object(self, content: str, error_label: str) -> dict[str, Any]:
        # 2026-06-22 兼容外接模型偶发输出非法 JSON：失败时只请求一次严格 JSON 修复
        try:
            return parse_json_object(content)
        except RuntimeError as exc:
            repaired_payload = self.post_chat_completion(
                {
                    "model": self.model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You repair malformed JSON. Return exactly one valid JSON object in message.content. "
                                "Do not add markdown fences, comments, reasoning, or extra text. "
                                "Preserve the original fields and values as much as possible."
                            ),
                        },
                        {
                            "role": "user",
                            "content": json.dumps(
                                {
                                    "parse_error": str(exc),
                                    "malformed_content": content,
                                },
                                ensure_ascii=False,
                            ),
                        },
                    ],
                    "temperature": 0,
                    "response_format": {"type": "json_object"},
                },
                f"{error_label} 修复",
            )
            repaired_content = extract_message_content(repaired_payload)
            try:
                return parse_json_object(repaired_content)
            except RuntimeError as repair_exc:
                raise RuntimeError(f"{error_label} 解析失败，自动修复也失败：{repair_exc}") from exc

    def chat_image_json(self, system_prompt: str, text_prompt: str, image_path: Path) -> dict[str, Any]:
        # 2026-06-20 请求同一本地模型分析图片，不对视觉输出设置额外 token 上限
        image_url = image_to_data_url(image_path)
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": text_prompt},
                        {"type": "image_url", "image_url": {"url": image_url}},
                    ],
                },
            ],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.chat_completions_url,
            data=data,
            headers=self.request_headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"VLM 请求失败：HTTP {exc.code} {exc.reason}：{body}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"VLM 请求失败：{exc}") from exc
        content = extract_message_content(payload)
        return self.parse_or_repair_json_object(content, "VLM JSON")

    @property
    def chat_completions_url(self) -> str:
        # 2026-06-21 拼接 OpenAI 兼容 chat completions URL，兼容 DeepSeek 无 v1 路径
        return f"{self.base_url}{self.chat_completions_path}"

    @property
    def request_headers(self) -> dict[str, str]:
        # 2026-06-21 构造模型请求头，统一携带 Bearer 鉴权
        return {
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": f"Bearer {self.api_key}",
        }


def extract_message(payload: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 从 OpenAI 兼容响应中提取 message 对象，供内容解析和工具调用共用
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError("LLM 响应缺少 choices")
    message = choices[0].get("message") or {}
    if not isinstance(message, dict):
        raise RuntimeError("LLM 响应 message 格式错误")
    return message


def normalize_chat_path(path: str) -> str:
    # 2026-06-21 规范化 chat completions 路径，避免配置缺少前导斜杠
    stripped = path.strip()
    if not stripped:
        raise ValueError("CHAT_COMPLETIONS_PATH 不能为空")
    return stripped if stripped.startswith("/") else f"/{stripped}"


def append_tool_results(
    messages: list[dict[str, Any]],
    assistant_message: dict[str, Any],
    tool_calls: list[Any],
    tool_handlers: dict[str, ToolHandler],
) -> list[dict[str, Any]]:
    # 2026-06-21 执行模型请求的程序侧工具并把工具结果追加回对话
    normalized_calls = [normalize_tool_call(index, tool_call) for index, tool_call in enumerate(tool_calls)]
    assistant_with_ids = dict(assistant_message)
    assistant_with_ids["tool_calls"] = [tool_call for tool_call, _, _ in normalized_calls]
    messages.append(assistant_with_ids)
    tool_details: list[dict[str, Any]] = []
    for tool_call, name, arguments in normalized_calls:
        handler = tool_handlers.get(name)
        if handler is None:
            raise RuntimeError(f"LLM 请求了未注册工具：{name}")
        result = handler(arguments)
        result_json = json.dumps(result, ensure_ascii=False)
        tool_details.append(
            {
                "name": name,
                "arguments": compact_tool_arguments(arguments),
                "result": summarize_tool_result(result, result_json),
            }
        )
        messages.append(
            {
                "role": "tool",
                "tool_call_id": tool_call["id"],
                "name": name,
                "content": result_json,
            }
        )
    return tool_details


def compact_tool_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 压缩工具参数日志，保留诊断信息但避免写入过长内容
    compacted: dict[str, Any] = {}
    for key, value in arguments.items():
        if isinstance(value, str):
            compacted[key] = value[:120]
        elif isinstance(value, list):
            compacted[key] = value[:20]
        else:
            compacted[key] = value
    return compacted


def summarize_tool_result(result: dict[str, Any], result_json: str) -> dict[str, Any]:
    # 2026-06-21 汇总工具返回规模，判断模型继续查证是否因为结果不足
    summary: dict[str, Any] = {
        "char_count": len(result_json),
        "keys": list(result.keys())[:20],
    }
    counts: dict[str, int] = {}
    for key, value in result.items():
        if isinstance(value, list):
            counts[key] = len(value)
        elif isinstance(value, dict):
            counts[f"{key}_keys"] = len(value)
    if counts:
        summary["counts"] = counts
    if isinstance(result.get("source_counts"), dict):
        summary["source_counts"] = result["source_counts"]
    return summary


def normalize_tool_call(index: int, tool_call: Any) -> tuple[dict[str, Any], str, dict[str, Any]]:
    # 2026-06-21 规范化模型返回的 tool call，补齐本地服务可能省略的调用 ID
    if not isinstance(tool_call, dict):
        raise RuntimeError("LLM function call 格式错误")
    normalized = dict(tool_call)
    if not isinstance(normalized.get("id"), str) or not normalized["id"]:
        normalized["id"] = f"call_{index + 1}"
    function = normalized.get("function")
    if not isinstance(function, dict):
        raise RuntimeError("LLM function call 缺少 function")
    name = function.get("name")
    if not isinstance(name, str) or not name:
        raise RuntimeError("LLM function call 缺少工具名")
    return normalized, name, parse_tool_arguments(function)


def parse_tool_arguments(function: dict[str, Any]) -> dict[str, Any]:
    # 2026-06-21 解析单个 function call 的 arguments，要求顶层为 JSON 对象
    arguments = function.get("arguments")
    if not isinstance(arguments, str) or not arguments.strip():
        raise RuntimeError("LLM function call 缺少 arguments")
    try:
        parsed = json.loads(arguments)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"LLM function call arguments 解析失败：{exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("LLM function call arguments 顶层不是对象")
    return parsed


def extract_message_content(payload: dict[str, Any]) -> str:
    # 2026-06-20 从 OpenAI 兼容响应中提取最终内容，不使用 reasoning_content
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError("LLM 响应缺少 choices")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("LLM 响应缺少 message.content")
    return content.strip()


def parse_json_object(content: str) -> dict[str, Any]:
    # 2026-06-20 解析模型返回 JSON，兼容被代码块包裹的对象文本
    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise RuntimeError("LLM 返回内容不是 JSON 对象")
    try:
        parsed = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"LLM 返回 JSON 解析失败：{exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("LLM 返回 JSON 顶层不是对象")
    return parsed


def image_to_data_url(image_path: Path) -> str:
    # 2026-06-20 将关键帧图片转为 data URL，供本地多模态 chat 接口读取
    suffix = image_path.suffix.lower()
    mime = "image/png" if suffix == ".png" else "image/jpeg"
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"
