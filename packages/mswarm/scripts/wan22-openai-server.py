#!/usr/bin/env python3
"""Loopback-only OpenAI-shaped bridge for stable-diffusion.cpp video jobs."""

from __future__ import annotations

import argparse
import base64
import binascii
import ipaddress
import json
import logging
import math
import secrets
import signal
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from typing import Any


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 11448
DEFAULT_UPSTREAM_BASE_URL = "http://127.0.0.1:11447"
DEFAULT_MODEL_ID = "wan2.2-t2v-a14b-q4-k-m-local"
DIRECT_HTTP_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
ALLOWED_FIELDS = {
    "model",
    "prompt",
    "negative_prompt",
    "n",
    "size",
    "duration_seconds",
    "fps",
    "video_frames",
    "response_format",
    "seed",
    "steps",
    "high_noise_steps",
}
MIME_BY_FORMAT = {
    "webm": "video/webm",
    "webp": "image/webp",
    "avi": "video/x-msvideo",
}


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        message: str,
        *,
        error_type: str = "invalid_request_error",
        param: str | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.error_type = error_type
        self.param = param
        self.code = code


class UpstreamError(Exception):
    pass


@dataclass
class ServerState:
    upstream_base_url: str
    model_id: str
    max_request_bytes: int
    max_output_bytes: int
    max_prompt_chars: int
    max_negative_prompt_chars: int
    allowed_sizes: set[tuple[int, int]]
    min_video_frames: int
    max_video_frames: int
    default_video_frames: int
    min_fps: int
    max_fps: int
    default_fps: int
    default_steps: int
    max_steps: int
    default_high_noise_steps: int
    max_high_noise_steps: int
    poll_interval_seconds: float
    inference_timeout_seconds: float
    request_timeout_seconds: float
    response_formats: set[str]
    shutdown_requested: threading.Event = field(default_factory=threading.Event)
    active_job_lock: threading.Lock = field(default_factory=threading.Lock)
    active_job_id: str | None = None
    inference_slots: threading.BoundedSemaphore = field(
        default_factory=lambda: threading.BoundedSemaphore(1)
    )


class VideoHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def server_bind(self) -> None:
        # Avoid HTTPServer's unnecessary reverse-DNS lookup on loopback.
        TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = int(port)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_text(
    value: Any,
    *,
    field_name: str,
    max_chars: int,
    allow_empty: bool,
) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        qualifier = "a string" if allow_empty else "a non-empty string"
        raise ApiError(
            400,
            f"{field_name} must be {qualifier}",
            param=field_name,
            code=f"invalid_{field_name}",
        )
    if len(value) > max_chars:
        raise ApiError(
            400,
            f"{field_name} exceeds the configured limit",
            param=field_name,
            code=f"{field_name}_limit_exceeded",
        )
    if "\x00" in value:
        raise ApiError(
            400,
            f"{field_name} must not contain a null character",
            param=field_name,
            code=f"invalid_{field_name}",
        )
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise ApiError(
            400,
            f"{field_name} must be valid UTF-8 text",
            param=field_name,
            code=f"invalid_{field_name}",
        ) from error
    return value


def _effective_frame_count(requested: int) -> int:
    return ((requested - 1) // 4) * 4 + 1


def _parse_generation_request(payload: Any, state: ServerState) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ApiError(400, "request body must be a JSON object", code="invalid_json")
    unknown = sorted(set(payload) - ALLOWED_FIELDS)
    if unknown:
        raise ApiError(
            400,
            f"unsupported request parameter: {unknown[0]}",
            param=unknown[0],
            code="unsupported_parameter",
        )
    if payload.get("model") != state.model_id:
        raise ApiError(
            400,
            f"model must be {state.model_id}",
            param="model",
            code="model_not_found",
        )

    prompt = _validate_text(
        payload.get("prompt"),
        field_name="prompt",
        max_chars=state.max_prompt_chars,
        allow_empty=False,
    )
    negative_prompt = _validate_text(
        payload.get("negative_prompt", ""),
        field_name="negative_prompt",
        max_chars=state.max_negative_prompt_chars,
        allow_empty=True,
    )

    n = payload.get("n", 1)
    if not _is_int(n) or n != 1:
        raise ApiError(400, "n must be 1", param="n", code="invalid_n")

    size = payload.get("size", "832x480")
    if not isinstance(size, str) or "x" not in size:
        raise ApiError(400, "size must use WIDTHxHEIGHT", param="size", code="invalid_size")
    try:
        width_text, height_text = size.lower().split("x", 1)
        width, height = int(width_text), int(height_text)
    except ValueError as error:
        raise ApiError(
            400, "size must use WIDTHxHEIGHT", param="size", code="invalid_size"
        ) from error
    if (width, height) not in state.allowed_sizes:
        allowed = ", ".join(f"{w}x{h}" for w, h in sorted(state.allowed_sizes))
        raise ApiError(
            400,
            f"size must be one of {allowed}",
            param="size",
            code="unsupported_size",
        )

    fps = payload.get("fps", state.default_fps)
    if not _is_int(fps) or not state.min_fps <= fps <= state.max_fps:
        raise ApiError(
            400,
            f"fps must be an integer between {state.min_fps} and {state.max_fps}",
            param="fps",
            code="invalid_fps",
        )

    if "duration_seconds" in payload and "video_frames" in payload:
        raise ApiError(
            400,
            "duration_seconds and video_frames are mutually exclusive",
            param="duration_seconds",
            code="ambiguous_duration",
        )
    if "duration_seconds" in payload:
        duration = payload["duration_seconds"]
        if isinstance(duration, bool) or not isinstance(duration, (int, float)):
            raise ApiError(
                400,
                "duration_seconds must be a finite positive number",
                param="duration_seconds",
                code="invalid_duration",
            )
        duration = float(duration)
        if not math.isfinite(duration) or duration <= 0:
            raise ApiError(
                400,
                "duration_seconds must be a finite positive number",
                param="duration_seconds",
                code="invalid_duration",
            )
        requested_frames = math.floor(duration * fps)
    else:
        requested_frames = payload.get("video_frames", state.default_video_frames)
        if not _is_int(requested_frames):
            raise ApiError(
                400,
                "video_frames must be an integer",
                param="video_frames",
                code="invalid_video_frames",
            )
    actual_frames = _effective_frame_count(requested_frames)
    if not state.min_video_frames <= actual_frames <= state.max_video_frames:
        raise ApiError(
            400,
            f"effective video_frames must be between {state.min_video_frames} and {state.max_video_frames}",
            param="video_frames",
            code="video_frames_limit_exceeded",
        )

    response_format = payload.get("response_format", "webm")
    if not isinstance(response_format, str) or response_format not in state.response_formats:
        allowed = ", ".join(sorted(state.response_formats))
        raise ApiError(
            400,
            f"response_format must be one of {allowed}",
            param="response_format",
            code="unsupported_response_format",
        )

    seed = payload.get("seed")
    if seed == -1 or seed is None:
        seed = secrets.randbelow(2**31)
    if not _is_int(seed) or not 0 <= seed <= 2**31 - 1:
        raise ApiError(
            400,
            "seed must be -1 or an integer between 0 and 2147483647",
            param="seed",
            code="invalid_seed",
        )

    steps = payload.get("steps", state.default_steps)
    if not _is_int(steps) or not 1 <= steps <= state.max_steps:
        raise ApiError(
            400,
            f"steps must be an integer between 1 and {state.max_steps}",
            param="steps",
            code="invalid_steps",
        )
    high_noise_steps = payload.get(
        "high_noise_steps", state.default_high_noise_steps
    )
    if (
        not _is_int(high_noise_steps)
        or not 1 <= high_noise_steps <= state.max_high_noise_steps
    ):
        raise ApiError(
            400,
            "high_noise_steps must be an integer between "
            f"1 and {state.max_high_noise_steps}",
            param="high_noise_steps",
            code="invalid_high_noise_steps",
        )

    return {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "width": width,
        "height": height,
        "seed": seed,
        "video_frames": requested_frames,
        "effective_video_frames": actual_frames,
        "fps": fps,
        "response_format": response_format,
        "steps": steps,
        "high_noise_steps": high_noise_steps,
    }


def _bounded_json_request(
    url: str,
    *,
    method: str,
    timeout: float,
    max_bytes: int,
    payload: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    body = None
    headers = {"accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with DIRECT_HTTP_OPENER.open(request, timeout=timeout) as response:
            raw = response.read(max_bytes + 1)
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read(min(max_bytes, 32_768) + 1)
        status = error.code
    except (OSError, TimeoutError) as error:
        raise UpstreamError("stable-diffusion.cpp is unreachable") from error
    if len(raw) > max_bytes:
        raise UpstreamError("stable-diffusion.cpp response exceeds the configured limit")
    try:
        parsed = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UpstreamError("stable-diffusion.cpp returned invalid JSON") from error
    if not isinstance(parsed, dict):
        raise UpstreamError("stable-diffusion.cpp returned an invalid object")
    return status, parsed


def _check_upstream_ready(state: ServerState) -> dict[str, Any]:
    status, payload = _bounded_json_request(
        f"{state.upstream_base_url}/sdcpp/v1/capabilities",
        method="GET",
        timeout=state.request_timeout_seconds,
        max_bytes=1_048_576,
    )
    supported_modes = payload.get("supported_modes")
    formats_by_mode = payload.get("output_formats_by_mode")
    video_formats = formats_by_mode.get("vid_gen") if isinstance(formats_by_mode, dict) else None
    if status != 200 or not isinstance(supported_modes, list) or "vid_gen" not in supported_modes:
        raise UpstreamError("stable-diffusion.cpp does not advertise vid_gen")
    if not isinstance(video_formats, list) or not state.response_formats.issubset(
        {item for item in video_formats if isinstance(item, str)}
    ):
        raise UpstreamError("stable-diffusion.cpp lacks the configured video output format")
    return payload


def _native_request(request: dict[str, Any]) -> dict[str, Any]:
    return {
        "prompt": request["prompt"],
        "negative_prompt": request["negative_prompt"],
        "width": request["width"],
        "height": request["height"],
        "seed": request["seed"],
        "video_frames": request["video_frames"],
        "fps": request["fps"],
        "moe_boundary": 0.875,
        "sample_params": {
            "scheduler": "discrete",
            "sample_method": "euler",
            "sample_steps": request["steps"],
            "flow_shift": 3.0,
            "guidance": {"txt_cfg": 3.5},
        },
        "high_noise_sample_params": {
            "scheduler": "discrete",
            "sample_method": "euler",
            "sample_steps": request["high_noise_steps"],
            "flow_shift": 3.0,
            "guidance": {"txt_cfg": 3.5},
        },
        "output_format": request["response_format"],
        "output_compression": 100,
    }


def _cancel_job(state: ServerState, job_id: str) -> None:
    try:
        _bounded_json_request(
            f"{state.upstream_base_url}/sdcpp/v1/jobs/{urllib.parse.quote(job_id, safe='')}/cancel",
            method="POST",
            timeout=state.request_timeout_seconds,
            max_bytes=65_536,
            payload={},
        )
    except UpstreamError:
        pass


def _set_active_job(state: ServerState, job_id: str) -> None:
    with state.active_job_lock:
        state.active_job_id = job_id


def _clear_active_job(state: ServerState, job_id: str) -> None:
    with state.active_job_lock:
        if state.active_job_id == job_id:
            state.active_job_id = None


def _generate_video(state: ServerState, request: dict[str, Any]) -> dict[str, Any]:
    max_json_bytes = math.ceil(state.max_output_bytes / 3) * 4 + 65_536
    status, submission = _bounded_json_request(
        f"{state.upstream_base_url}/sdcpp/v1/vid_gen",
        method="POST",
        timeout=state.request_timeout_seconds,
        max_bytes=1_048_576,
        payload=_native_request(request),
    )
    if status == 429:
        raise ApiError(
            429,
            "the local video generator queue is full",
            error_type="rate_limit_error",
            code="upstream_queue_saturated",
        )
    if status != 202:
        raise UpstreamError(f"stable-diffusion.cpp rejected video submission ({status})")
    job_id = submission.get("id")
    poll_url = submission.get("poll_url")
    expected_poll_url = f"/sdcpp/v1/jobs/{job_id}" if isinstance(job_id, str) else None
    if (
        not isinstance(job_id, str)
        or not job_id
        or poll_url != expected_poll_url
        or submission.get("kind") != "vid_gen"
    ):
        if isinstance(job_id, str) and job_id:
            _cancel_job(state, job_id)
        raise UpstreamError("stable-diffusion.cpp returned an invalid video job")

    _set_active_job(state, job_id)
    try:
        deadline = time.monotonic() + state.inference_timeout_seconds
        while time.monotonic() < deadline and not state.shutdown_requested.is_set():
            status, job = _bounded_json_request(
                f"{state.upstream_base_url}{poll_url}",
                method="GET",
                timeout=state.request_timeout_seconds,
                max_bytes=max_json_bytes,
            )
            if status != 200:
                raise UpstreamError(f"stable-diffusion.cpp video poll failed ({status})")
            job_status = job.get("status")
            if job_status in ("queued", "generating"):
                state.shutdown_requested.wait(state.poll_interval_seconds)
                continue
            if job_status == "failed":
                error = job.get("error")
                code = error.get("code") if isinstance(error, dict) else None
                raise UpstreamError(
                    f"stable-diffusion.cpp video generation failed ({code or 'generation_failed'})"
                )
            if job_status == "cancelled":
                raise UpstreamError("stable-diffusion.cpp video generation was cancelled")
            if job_status != "completed" or job.get("kind") != "vid_gen":
                raise UpstreamError("stable-diffusion.cpp returned an invalid video job status")
            result = job.get("result")
            if not isinstance(result, dict):
                raise UpstreamError("stable-diffusion.cpp completed without a video result")
            return result
        if state.shutdown_requested.is_set():
            raise ApiError(
                503,
                "video generation cancelled during service shutdown",
                error_type="server_error",
                code="service_shutting_down",
            )
        raise ApiError(
            504,
            "video generation timed out",
            error_type="server_error",
            code="generation_timeout",
        )
    except Exception:
        _cancel_job(state, job_id)
        raise
    finally:
        _clear_active_job(state, job_id)


def _validate_result(
    result: dict[str, Any], request: dict[str, Any], state: ServerState
) -> dict[str, Any]:
    response_format = result.get("output_format")
    mime_type = result.get("mime_type")
    encoded = result.get("b64_json")
    fps = result.get("fps")
    frame_count = result.get("frame_count")
    if response_format != request["response_format"]:
        raise UpstreamError("stable-diffusion.cpp returned the wrong video format")
    if mime_type != MIME_BY_FORMAT.get(response_format):
        raise UpstreamError("stable-diffusion.cpp returned the wrong video MIME type")
    if not isinstance(encoded, str) or not encoded:
        raise UpstreamError("stable-diffusion.cpp returned no encoded video")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise UpstreamError("stable-diffusion.cpp returned invalid video base64") from error
    if not decoded or len(decoded) > state.max_output_bytes:
        raise ApiError(
            413,
            "generated video exceeds the configured output limit",
            error_type="server_error",
            code="output_too_large",
        )
    if response_format == "webm" and not decoded.startswith(b"\x1a\x45\xdf\xa3"):
        raise UpstreamError("stable-diffusion.cpp returned an invalid WebM container")
    if response_format == "webp" and not (
        decoded.startswith(b"RIFF") and decoded[8:12] == b"WEBP"
    ):
        raise UpstreamError("stable-diffusion.cpp returned an invalid WebP container")
    if response_format == "avi" and not (
        decoded.startswith(b"RIFF") and decoded[8:12] == b"AVI "
    ):
        raise UpstreamError("stable-diffusion.cpp returned an invalid AVI container")
    if not _is_int(fps) or fps <= 0 or not _is_int(frame_count) or frame_count <= 0:
        raise UpstreamError("stable-diffusion.cpp returned invalid video metadata")
    if frame_count != request["effective_video_frames"] or fps != request["fps"]:
        raise UpstreamError("stable-diffusion.cpp returned unexpected video dimensions")
    return {
        "b64_video": encoded,
        "mime_type": mime_type,
        "response_format": response_format,
        "fps": fps,
        "frame_count": frame_count,
        "duration_seconds": frame_count / fps,
        "seed": request["seed"],
    }


def _handler_for(state: ServerState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "wan22-openai/1"

        def log_message(self, format_string: str, *args: Any) -> None:
            del format_string, args

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except BrokenPipeError:
                pass

        def _send_error(self, error: ApiError) -> None:
            self._send_json(
                error.status,
                {
                    "error": {
                        "message": error.message,
                        "type": error.error_type,
                        "param": error.param,
                        "code": error.code,
                    }
                },
            )

        def do_GET(self) -> None:
            if self.path == "/healthz":
                try:
                    _check_upstream_ready(state)
                except UpstreamError:
                    self._send_json(
                        503,
                        {"status": "unhealthy", "model": state.model_id},
                    )
                    return
                self._send_json(
                    200,
                    {
                        "status": "ok",
                        "model": state.model_id,
                        "upstream": "stable-diffusion.cpp",
                    },
                )
                return
            if self.path == "/v1/models":
                self._send_json(
                    200,
                    {
                        "object": "list",
                        "data": [
                            {
                                "id": state.model_id,
                                "object": "model",
                                "owned_by": "local",
                            }
                        ],
                    },
                )
                return
            self._send_error(ApiError(404, "not found", error_type="not_found_error"))

        def do_POST(self) -> None:
            if self.path != "/v1/videos/generations":
                self._send_error(ApiError(404, "not found", error_type="not_found_error"))
                return
            try:
                if self.headers.get("transfer-encoding"):
                    raise ApiError(
                        400,
                        "chunked request bodies are not supported",
                        code="unsupported_transfer_encoding",
                    )
                content_type = self.headers.get("content-type", "")
                if content_type.split(";", 1)[0].strip().lower() != "application/json":
                    raise ApiError(
                        400,
                        "content-type must be application/json",
                        code="invalid_content_type",
                    )
                length_header = self.headers.get("content-length")
                if length_header is None:
                    raise ApiError(411, "content-length is required", code="length_required")
                try:
                    content_length = int(length_header)
                except ValueError as error:
                    raise ApiError(
                        400,
                        "content-length is invalid",
                        code="invalid_content_length",
                    ) from error
                if content_length < 1:
                    raise ApiError(400, "request body is empty", code="invalid_json")
                if content_length > state.max_request_bytes:
                    raise ApiError(
                        413,
                        "request body exceeds the configured limit",
                        code="request_too_large",
                    )
                raw = self.rfile.read(content_length)
                if len(raw) != content_length:
                    raise ApiError(400, "request body is incomplete", code="invalid_json")
                try:
                    payload = json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ApiError(400, "request body is invalid JSON", code="invalid_json") from error
                parsed = _parse_generation_request(payload, state)
            except ApiError as error:
                self._send_error(error)
                return

            if not state.inference_slots.acquire(blocking=False):
                self._send_error(
                    ApiError(
                        429,
                        "the local video generator is busy",
                        error_type="rate_limit_error",
                        code="local_concurrency_saturated",
                    )
                )
                return
            started_at = time.monotonic()
            try:
                native_result = _generate_video(state, parsed)
                output = _validate_result(native_result, parsed, state)
                self._send_json(
                    200,
                    {
                        "created": int(time.time()),
                        "model": state.model_id,
                        "data": [output],
                    },
                )
                logging.info(
                    "generation completed frames=%d fps=%d elapsed_ms=%d",
                    output["frame_count"],
                    output["fps"],
                    int((time.monotonic() - started_at) * 1000),
                )
            except ApiError as error:
                self._send_error(error)
            except UpstreamError as error:
                logging.error("generation failed reason=%s", str(error))
                self._send_error(
                    ApiError(
                        502,
                        "video generation failed",
                        error_type="server_error",
                        code="upstream_generation_failed",
                    )
                )
            finally:
                state.inference_slots.release()

    return Handler


def _parse_size(value: str) -> tuple[int, int]:
    try:
        width_text, height_text = value.lower().split("x", 1)
        width, height = int(width_text), int(height_text)
    except ValueError as error:
        raise argparse.ArgumentTypeError("size must use WIDTHxHEIGHT") from error
    if width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("size dimensions must be positive")
    return width, height


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--upstream-base-url", default=DEFAULT_UPSTREAM_BASE_URL)
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--max-request-bytes", type=int, default=131_072)
    parser.add_argument("--max-output-bytes", type=int, default=67_108_864)
    parser.add_argument("--max-prompt-chars", type=int, default=8_192)
    parser.add_argument("--max-negative-prompt-chars", type=int, default=8_192)
    parser.add_argument("--allowed-size", type=_parse_size, action="append")
    parser.add_argument("--min-video-frames", type=int, default=9)
    parser.add_argument("--max-video-frames", type=int, default=81)
    parser.add_argument("--default-video-frames", type=int, default=33)
    parser.add_argument("--min-fps", type=int, default=8)
    parser.add_argument("--max-fps", type=int, default=24)
    parser.add_argument("--default-fps", type=int, default=16)
    parser.add_argument("--default-steps", type=int, default=10)
    parser.add_argument("--max-steps", type=int, default=30)
    parser.add_argument("--default-high-noise-steps", type=int, default=8)
    parser.add_argument("--max-high-noise-steps", type=int, default=30)
    parser.add_argument("--response-format", choices=tuple(MIME_BY_FORMAT), action="append")
    parser.add_argument("--poll-interval-seconds", type=float, default=1.0)
    parser.add_argument("--request-timeout-seconds", type=float, default=10.0)
    parser.add_argument("--inference-timeout-seconds", type=float, default=3_600.0)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        address = ipaddress.ip_address(args.host)
    except ValueError:
        if args.host != "localhost":
            raise SystemExit("--host must be a loopback IP address or localhost")
    else:
        if not address.is_loopback:
            raise SystemExit("--host must resolve to a loopback address")
    if not 1 <= args.port <= 65_535 and args.port != 0:
        raise SystemExit("--port must be 0 or between 1 and 65535")
    upstream = urllib.parse.urlsplit(args.upstream_base_url)
    if (
        upstream.scheme != "http"
        or upstream.hostname not in ("127.0.0.1", "::1", "localhost")
        or upstream.username
        or upstream.password
        or upstream.query
        or upstream.fragment
        or upstream.path not in ("", "/")
    ):
        raise SystemExit("--upstream-base-url must be a loopback HTTP origin")
    allowed_sizes = set(args.allowed_size or [(832, 480)])
    response_formats = set(args.response_format or ["webm"])
    integer_limits = (
        args.max_request_bytes,
        args.max_output_bytes,
        args.max_prompt_chars,
        args.max_negative_prompt_chars,
        args.min_video_frames,
        args.max_video_frames,
        args.default_video_frames,
        args.min_fps,
        args.max_fps,
        args.default_fps,
        args.default_steps,
        args.max_steps,
        args.default_high_noise_steps,
        args.max_high_noise_steps,
    )
    if any(value <= 0 for value in integer_limits):
        raise SystemExit("request and generation limits must be positive")
    if not (
        args.min_video_frames
        <= _effective_frame_count(args.default_video_frames)
        <= args.max_video_frames
    ):
        raise SystemExit("default video frames are outside the configured range")
    if not args.min_fps <= args.default_fps <= args.max_fps:
        raise SystemExit("default FPS is outside the configured range")
    if not 1 <= args.default_steps <= args.max_steps:
        raise SystemExit("default steps are outside the configured range")
    if not 1 <= args.default_high_noise_steps <= args.max_high_noise_steps:
        raise SystemExit("default high-noise steps are outside the configured range")
    for value, name in (
        (args.poll_interval_seconds, "poll interval"),
        (args.request_timeout_seconds, "request timeout"),
        (args.inference_timeout_seconds, "inference timeout"),
    ):
        if not math.isfinite(value) or value <= 0:
            raise SystemExit(f"{name} must be positive")
    if not args.model_id.strip():
        raise SystemExit("--model-id must be non-empty")

    state = ServerState(
        upstream_base_url=args.upstream_base_url.rstrip("/"),
        model_id=args.model_id,
        max_request_bytes=args.max_request_bytes,
        max_output_bytes=args.max_output_bytes,
        max_prompt_chars=args.max_prompt_chars,
        max_negative_prompt_chars=args.max_negative_prompt_chars,
        allowed_sizes=allowed_sizes,
        min_video_frames=args.min_video_frames,
        max_video_frames=args.max_video_frames,
        default_video_frames=args.default_video_frames,
        min_fps=args.min_fps,
        max_fps=args.max_fps,
        default_fps=args.default_fps,
        default_steps=args.default_steps,
        max_steps=args.max_steps,
        default_high_noise_steps=args.default_high_noise_steps,
        max_high_noise_steps=args.max_high_noise_steps,
        poll_interval_seconds=args.poll_interval_seconds,
        inference_timeout_seconds=args.inference_timeout_seconds,
        request_timeout_seconds=args.request_timeout_seconds,
        response_formats=response_formats,
    )
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.info("checking stable-diffusion.cpp video capabilities")
    _check_upstream_ready(state)
    server = VideoHttpServer((args.host, args.port), _handler_for(state))

    def request_shutdown(signum: int, frame: Any) -> None:
        del signum, frame
        state.shutdown_requested.set()

        def stop() -> None:
            with state.active_job_lock:
                active_job_id = state.active_job_id
            if active_job_id:
                _cancel_job(state, active_job_id)
            server.shutdown()

        threading.Thread(target=stop, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    host, port = server.server_address[:2]
    print(
        json.dumps(
            {
                "event": "listening",
                "host": host,
                "port": port,
                "model": state.model_id,
                "upstream": state.upstream_base_url,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
