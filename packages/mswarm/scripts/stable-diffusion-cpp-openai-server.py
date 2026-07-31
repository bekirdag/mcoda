#!/usr/bin/env python3
"""Loopback-only OpenAI image bridge for stable-diffusion.cpp."""

from __future__ import annotations

import argparse
import base64
import binascii
import ipaddress
import json
import logging
import math
import re
import secrets
import signal
import socket
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from typing import Any


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 11449
DEFAULT_UPSTREAM_BASE_URL = "http://127.0.0.1:11445"
DEFAULT_MODEL_ID = "sd-cpp-local"
DEFAULT_CLIENT_READ_TIMEOUT_SECONDS = 10.0
DEFAULT_MAX_HANDLER_THREADS = 8
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
ALLOWED_FIELDS = {
    "model",
    "prompt",
    "negative_prompt",
    "n",
    "size",
    "response_format",
    "seed",
    "steps",
}
RESERVED_CONTROL_TAG = re.compile(r"<\s*/?\s*sd_cpp_extra_args\b", re.IGNORECASE)
MODEL_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: Any,
        status: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> None:
        del request, file_pointer, status, message, headers, new_url
        return None


DIRECT_HTTP_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    NoRedirectHandler(),
)
OVERLOAD_BODY = json.dumps(
    {
        "error": {
            "message": "the image bridge has too many active clients",
            "type": "server_error",
            "param": None,
            "code": "server_busy",
        }
    },
    separators=(",", ":"),
).encode("utf-8")
OVERLOAD_RESPONSE = (
    b"HTTP/1.1 503 Service Unavailable\r\n"
    b"content-type: application/json\r\n"
    + f"content-length: {len(OVERLOAD_BODY)}\r\n".encode("ascii")
    + b"cache-control: no-store\r\n"
    b"x-content-type-options: nosniff\r\n"
    b"connection: close\r\n"
    b"\r\n"
    + OVERLOAD_BODY
)


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


class UpstreamTimeout(UpstreamError):
    pass


@dataclass
class ServerState:
    upstream_base_url: str
    model_id: str
    upstream_model_id: str
    max_request_bytes: int
    max_output_bytes: int
    max_prompt_chars: int
    max_negative_prompt_chars: int
    min_width: int
    max_width: int
    min_height: int
    max_height: int
    max_pixels: int
    default_size: tuple[int, int]
    default_steps: int
    max_steps: int
    request_timeout_seconds: float
    inference_timeout_seconds: float
    shutdown_requested: threading.Event = field(default_factory=threading.Event)
    inference_slots: threading.BoundedSemaphore = field(
        default_factory=lambda: threading.BoundedSemaphore(1)
    )


class ImageHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(
        self,
        server_address: tuple[str, int],
        request_handler_class: type[BaseHTTPRequestHandler],
        *,
        client_read_timeout_seconds: float = DEFAULT_CLIENT_READ_TIMEOUT_SECONDS,
        max_handler_threads: int = DEFAULT_MAX_HANDLER_THREADS,
        bind_and_activate: bool = True,
    ) -> None:
        self.client_read_timeout_seconds = client_read_timeout_seconds
        self.max_handler_threads = max_handler_threads
        self._handler_slots = threading.BoundedSemaphore(max_handler_threads)
        super().__init__(server_address, request_handler_class, bind_and_activate)

    def server_bind(self) -> None:
        # HTTPServer otherwise performs an unnecessary reverse-DNS lookup.
        TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = int(port)

    def get_request(self) -> tuple[socket.socket, Any]:
        request, client_address = super().get_request()
        request.settimeout(self.client_read_timeout_seconds)
        return request, client_address

    def process_request(self, request: socket.socket, client_address: Any) -> None:
        if not self._handler_slots.acquire(blocking=False):
            try:
                request.settimeout(min(self.client_read_timeout_seconds, 0.1))
                request.sendall(OVERLOAD_RESPONSE)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._handler_slots.release()
            raise

    def process_request_thread(
        self, request: socket.socket, client_address: Any
    ) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._handler_slots.release()


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _contains_reserved_control_tag(value: str) -> bool:
    return RESERVED_CONTROL_TAG.search(value) is not None


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
    if _contains_reserved_control_tag(value):
        raise ApiError(
            400,
            f"{field_name} contains the reserved stable-diffusion.cpp control tag",
            param=field_name,
            code="reserved_control_tag",
        )
    return value


def _parse_size_text(value: Any, *, field_name: str = "size") -> tuple[int, int]:
    if not isinstance(value, str):
        raise ApiError(
            400,
            "size must use WIDTHxHEIGHT",
            param=field_name,
            code="invalid_size",
        )
    match = re.fullmatch(r"([1-9][0-9]*)x([1-9][0-9]*)", value)
    if match is None:
        raise ApiError(
            400,
            "size must use WIDTHxHEIGHT",
            param=field_name,
            code="invalid_size",
        )
    return int(match.group(1)), int(match.group(2))


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

    default_width, default_height = state.default_size
    width, height = _parse_size_text(
        payload.get("size", f"{default_width}x{default_height}")
    )
    if width < state.min_width or height < state.min_height:
        raise ApiError(
            400,
            "size is below the configured minimum",
            param="size",
            code="unsupported_size",
        )
    if (
        width > state.max_width
        or height > state.max_height
        or width * height > state.max_pixels
    ):
        raise ApiError(
            400,
            "size exceeds the configured limit",
            param="size",
            code="unsupported_size",
        )

    response_format = payload.get("response_format", "b64_json")
    if response_format != "b64_json":
        raise ApiError(
            400,
            "response_format must be b64_json",
            param="response_format",
            code="unsupported_response_format",
        )

    seed = payload.get("seed")
    if seed is None or seed == -1:
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

    return {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "n": 1,
        "width": width,
        "height": height,
        "response_format": "b64_json",
        "seed": seed,
        "steps": steps,
    }


def _controlled_prompt(request: dict[str, Any]) -> str:
    controlled_args = {
        "negative_prompt": request["negative_prompt"],
        "seed": request["seed"],
        "sample_params": {"sample_steps": request["steps"]},
    }
    serialized = json.dumps(
        controlled_args,
        ensure_ascii=True,
        separators=(",", ":"),
    )
    return (
        f"{request['prompt']}\n"
        f"<sd_cpp_extra_args>{serialized}</sd_cpp_extra_args>"
    )


def _is_timeout_error(error: BaseException) -> bool:
    if isinstance(error, (TimeoutError, socket.timeout)):
        return True
    if isinstance(error, urllib.error.URLError):
        return isinstance(error.reason, (TimeoutError, socket.timeout))
    return False


def _bounded_json_request(
    url: str,
    *,
    method: str,
    timeout: float | None,
    max_bytes: int,
    payload: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    body = None
    headers = {"accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    content_type = ""
    try:
        with DIRECT_HTTP_OPENER.open(request, timeout=timeout) as response:
            raw = response.read(max_bytes + 1)
            status = response.status
            content_type = response.headers.get_content_type()
            if response.geturl() != url:
                raise UpstreamError("stable-diffusion.cpp changed the upstream URL")
    except urllib.error.HTTPError as error:
        if 300 <= error.code < 400:
            error.close()
            raise UpstreamError("stable-diffusion.cpp redirects are forbidden") from error
        raw = error.read(max_bytes + 1)
        status = error.code
        content_type = error.headers.get_content_type()
    except (OSError, urllib.error.URLError) as error:
        if _is_timeout_error(error):
            raise UpstreamTimeout("stable-diffusion.cpp request timed out") from error
        raise UpstreamError("stable-diffusion.cpp is unreachable") from error
    if len(raw) > max_bytes:
        raise UpstreamError("stable-diffusion.cpp response exceeds the configured limit")
    if content_type != "application/json":
        raise UpstreamError("stable-diffusion.cpp returned the wrong content type")
    try:
        parsed = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UpstreamError("stable-diffusion.cpp returned invalid JSON") from error
    if not isinstance(parsed, dict):
        raise UpstreamError("stable-diffusion.cpp returned an invalid object")
    return status, parsed


def _check_upstream_model(state: ServerState) -> None:
    status, payload = _bounded_json_request(
        f"{state.upstream_base_url}/v1/models",
        method="GET",
        timeout=state.request_timeout_seconds,
        max_bytes=1_048_576,
    )
    data = payload.get("data")
    if (
        status != 200
        or ("object" in payload and payload.get("object") != "list")
        or not isinstance(data, list)
        or len(data) != 1
        or not isinstance(data[0], dict)
        or data[0].get("id") != state.upstream_model_id
        or data[0].get("object") != "model"
    ):
        raise UpstreamError("stable-diffusion.cpp model catalog does not match")


def _native_request(request: dict[str, Any]) -> dict[str, Any]:
    return {
        "prompt": _controlled_prompt(request),
        "n": 1,
        "size": f"{request['width']}x{request['height']}",
        "output_format": "png",
    }


def _generate_image(state: ServerState, request: dict[str, Any]) -> dict[str, Any]:
    max_json_bytes = math.ceil(state.max_output_bytes / 3) * 4 + 131_072
    status, payload = _bounded_json_request(
        f"{state.upstream_base_url}/v1/images/generations",
        method="POST",
        # The handler enforces the client-facing generation deadline. This
        # transport remains open so the sole inference slot is held until the
        # native server has actually completed and replied.
        timeout=None,
        max_bytes=max_json_bytes,
        payload=_native_request(request),
    )
    if status == 429:
        raise ApiError(
            429,
            "the local image generator queue is full",
            error_type="rate_limit_error",
            code="upstream_queue_saturated",
        )
    if status != 200:
        raise UpstreamError(f"stable-diffusion.cpp rejected image generation ({status})")
    return payload


def _validate_png(
    decoded: bytes,
    *,
    expected_width: int,
    expected_height: int,
) -> None:
    if not decoded.startswith(PNG_SIGNATURE):
        raise UpstreamError("stable-diffusion.cpp returned an invalid PNG signature")
    offset = len(PNG_SIGNATURE)
    chunk_count = 0
    seen_ihdr = False
    seen_idat = False
    seen_iend = False
    seen_plte = False
    idat_ended = False
    idat_parts: list[bytes] = []
    bit_depth = 0
    color_type = -1
    interlace_method = -1
    while offset < len(decoded):
        if offset + 12 > len(decoded):
            raise UpstreamError("stable-diffusion.cpp returned a truncated PNG")
        chunk_count += 1
        if chunk_count > 4_096:
            raise UpstreamError("stable-diffusion.cpp returned too many PNG chunks")
        chunk_length = struct.unpack(">I", decoded[offset : offset + 4])[0]
        chunk_type = decoded[offset + 4 : offset + 8]
        if chunk_length > 0x7FFFFFFF or any(
            not (65 <= byte <= 90 or 97 <= byte <= 122) for byte in chunk_type
        ):
            raise UpstreamError("stable-diffusion.cpp returned an invalid PNG chunk")
        chunk_end = offset + 12 + chunk_length
        if chunk_end > len(decoded):
            raise UpstreamError("stable-diffusion.cpp returned a truncated PNG")
        chunk_data = decoded[offset + 8 : offset + 8 + chunk_length]
        expected_crc = struct.unpack(">I", decoded[chunk_end - 4 : chunk_end])[0]
        actual_crc = zlib.crc32(chunk_data, zlib.crc32(chunk_type)) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise UpstreamError("stable-diffusion.cpp returned an invalid PNG checksum")
        if not seen_ihdr:
            if chunk_type != b"IHDR" or chunk_length != 13:
                raise UpstreamError("stable-diffusion.cpp returned an invalid PNG header")
            width, height = struct.unpack(">II", chunk_data[:8])
            if width != expected_width or height != expected_height:
                raise UpstreamError("stable-diffusion.cpp returned unexpected image dimensions")
            if width <= 0 or height <= 0:
                raise UpstreamError("stable-diffusion.cpp returned invalid image dimensions")
            bit_depth = chunk_data[8]
            color_type = chunk_data[9]
            compression_method = chunk_data[10]
            filter_method = chunk_data[11]
            interlace_method = chunk_data[12]
            valid_depths = {
                0: {1, 2, 4, 8, 16},
                2: {8, 16},
                3: {1, 2, 4, 8},
                4: {8, 16},
                6: {8, 16},
            }
            if color_type not in valid_depths or bit_depth not in valid_depths[color_type]:
                raise UpstreamError("stable-diffusion.cpp returned an invalid PNG color mode")
            if compression_method != 0 or filter_method != 0:
                raise UpstreamError("stable-diffusion.cpp returned unsupported PNG methods")
            if interlace_method not in (0, 1):
                raise UpstreamError("stable-diffusion.cpp returned invalid PNG interlacing")
            seen_ihdr = True
        elif chunk_type == b"IHDR":
            raise UpstreamError("stable-diffusion.cpp returned duplicate PNG headers")
        elif not seen_ihdr:
            raise UpstreamError("stable-diffusion.cpp returned an invalid PNG header")
        if chunk_type == b"PLTE":
            if seen_idat or seen_plte or chunk_length < 3 or chunk_length > 768 or chunk_length % 3:
                raise UpstreamError("stable-diffusion.cpp returned an invalid PNG palette")
            if color_type in (0, 4):
                raise UpstreamError("stable-diffusion.cpp returned a forbidden PNG palette")
            if color_type == 3 and chunk_length // 3 > 2**bit_depth:
                raise UpstreamError("stable-diffusion.cpp returned an oversized PNG palette")
            seen_plte = True
        if chunk_type == b"IDAT":
            if idat_ended or (color_type == 3 and not seen_plte):
                raise UpstreamError("stable-diffusion.cpp returned invalid PNG image data")
            seen_idat = True
            idat_parts.append(chunk_data)
        elif seen_idat:
            idat_ended = True
        if chunk_type == b"IEND":
            if chunk_length != 0 or chunk_end != len(decoded):
                raise UpstreamError("stable-diffusion.cpp returned an invalid PNG terminator")
            seen_iend = True
        elif chunk_type not in (b"IHDR", b"PLTE", b"IDAT") and chunk_type[0] & 0x20 == 0:
            raise UpstreamError("stable-diffusion.cpp returned an unknown critical PNG chunk")
        offset = chunk_end
    if not seen_ihdr or not seen_idat or not seen_iend:
        raise UpstreamError("stable-diffusion.cpp returned an incomplete PNG")

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    bits_per_pixel = channels * bit_depth
    passes = [(0, 0, 1, 1)]
    if interlace_method == 1:
        passes = [
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        ]
    scanline_layout: list[tuple[int, int]] = []
    expected_scanline_bytes = 0
    for start_x, start_y, step_x, step_y in passes:
        pass_width = max(0, (expected_width - start_x + step_x - 1) // step_x)
        pass_height = max(0, (expected_height - start_y + step_y - 1) // step_y)
        if pass_width == 0 or pass_height == 0:
            continue
        row_bytes = (pass_width * bits_per_pixel + 7) // 8
        scanline_layout.append((pass_height, row_bytes))
        expected_scanline_bytes += pass_height * (row_bytes + 1)

    decompressor = zlib.decompressobj()
    try:
        scanlines = decompressor.decompress(
            b"".join(idat_parts), expected_scanline_bytes + 1
        )
    except zlib.error as error:
        raise UpstreamError("stable-diffusion.cpp returned invalid PNG compression") from error
    if (
        len(scanlines) != expected_scanline_bytes
        or not decompressor.eof
        or decompressor.unconsumed_tail
        or decompressor.unused_data
    ):
        raise UpstreamError("stable-diffusion.cpp returned invalid PNG scanlines")
    scanline_offset = 0
    for pass_height, row_bytes in scanline_layout:
        for _ in range(pass_height):
            if scanlines[scanline_offset] > 4:
                raise UpstreamError("stable-diffusion.cpp returned an invalid PNG filter")
            scanline_offset += row_bytes + 1


def _validate_generation_result(
    payload: dict[str, Any],
    request: dict[str, Any],
    state: ServerState,
) -> dict[str, Any]:
    created = payload.get("created")
    data = payload.get("data")
    if not _is_int(created) or created < 0:
        raise UpstreamError("stable-diffusion.cpp returned an invalid creation time")
    if payload.get("output_format") != "png":
        raise UpstreamError("stable-diffusion.cpp returned the wrong image format")
    if (
        not isinstance(data, list)
        or len(data) != 1
        or not isinstance(data[0], dict)
    ):
        raise UpstreamError("stable-diffusion.cpp returned an invalid image list")
    encoded = data[0].get("b64_json")
    if not isinstance(encoded, str) or not encoded:
        raise UpstreamError("stable-diffusion.cpp returned no encoded image")
    max_encoded_bytes = math.ceil(state.max_output_bytes / 3) * 4 + 4
    if len(encoded) > max_encoded_bytes:
        raise ApiError(
            413,
            "generated image exceeds the configured output limit",
            error_type="server_error",
            code="output_too_large",
        )
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise UpstreamError("stable-diffusion.cpp returned invalid image base64") from error
    if not decoded or len(decoded) > state.max_output_bytes:
        raise ApiError(
            413,
            "generated image exceeds the configured output limit",
            error_type="server_error",
            code="output_too_large",
        )
    _validate_png(
        decoded,
        expected_width=request["width"],
        expected_height=request["height"],
    )
    return {
        "created": created,
        "data": [{"b64_json": base64.b64encode(decoded).decode("ascii")}],
    }


def _handler_for(state: ServerState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "stable-diffusion-cpp-openai/1"

        def log_message(self, format_string: str, *args: Any) -> None:
            del format_string, args

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(encoded)))
                self.send_header("cache-control", "no-store")
                self.send_header("x-content-type-options", "nosniff")
                self.end_headers()
                self.wfile.write(encoded)
            except OSError:
                self.close_connection = True

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

        def _method_not_allowed(self) -> None:
            self._send_error(
                ApiError(
                    405,
                    "method not allowed",
                    error_type="invalid_request_error",
                    code="method_not_allowed",
                )
            )

        do_DELETE = _method_not_allowed
        do_OPTIONS = _method_not_allowed
        do_PATCH = _method_not_allowed
        do_PUT = _method_not_allowed

        def do_GET(self) -> None:
            if self.path not in ("/healthz", "/v1/models"):
                self._send_error(
                    ApiError(404, "not found", error_type="not_found_error")
                )
                return
            try:
                _check_upstream_model(state)
            except UpstreamError:
                if self.path == "/healthz":
                    self._send_json(
                        503,
                        {"status": "unhealthy", "model": state.model_id},
                    )
                else:
                    self._send_error(
                        ApiError(
                            503,
                            "image model is unavailable",
                            error_type="server_error",
                            code="upstream_unavailable",
                        )
                    )
                return
            if self.path == "/healthz":
                self._send_json(
                    200,
                    {
                        "status": "ok",
                        "model": state.model_id,
                        "upstream_model": state.upstream_model_id,
                        "upstream": "stable-diffusion.cpp",
                    },
                )
                return
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

        def do_POST(self) -> None:
            if self.path != "/v1/images/generations":
                self._send_error(
                    ApiError(404, "not found", error_type="not_found_error")
                )
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
                try:
                    raw = self.rfile.read(content_length)
                except (TimeoutError, socket.timeout) as error:
                    raise ApiError(
                        408,
                        "request body read timed out",
                        code="request_timeout",
                    ) from error
                if len(raw) != content_length:
                    raise ApiError(400, "request body is incomplete", code="invalid_json")
                try:
                    payload = json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ApiError(
                        400,
                        "request body is invalid JSON",
                        code="invalid_json",
                    ) from error
                parsed = _parse_generation_request(payload, state)
                if state.shutdown_requested.is_set():
                    raise ApiError(
                        503,
                        "image generator is shutting down",
                        error_type="server_error",
                        code="service_shutting_down",
                    )
            except ApiError as error:
                self._send_error(error)
                return

            if not state.inference_slots.acquire(blocking=False):
                self._send_error(
                    ApiError(
                        429,
                        "the local image generator is busy",
                        error_type="rate_limit_error",
                        code="local_concurrency_saturated",
                    )
                )
                return
            started_at = time.monotonic()
            completed = threading.Event()
            outcome: dict[str, Any] = {}

            def run_generation() -> None:
                try:
                    _check_upstream_model(state)
                    upstream_result = _generate_image(state, parsed)
                    outcome["response"] = _validate_generation_result(
                        upstream_result, parsed, state
                    )
                except BaseException as error:
                    outcome["error"] = error
                finally:
                    # The slot belongs to the native request, not the client
                    # handler. In particular, a client-facing timeout must not
                    # admit overlapping GPU work while sd-server is still busy.
                    state.inference_slots.release()
                    completed.set()

            threading.Thread(
                target=run_generation,
                name="sd-cpp-image-generation",
                daemon=True,
            ).start()
            if not completed.wait(state.inference_timeout_seconds):
                logging.error("generation exceeded client deadline; native request still active")
                self._send_error(
                    ApiError(
                        504,
                        "image generation timed out",
                        error_type="server_error",
                        code="generation_timeout",
                    )
                )
                return

            error = outcome.get("error")
            if error is None:
                self._send_json(200, outcome["response"])
                logging.info(
                    "generation completed width=%d height=%d steps=%d elapsed_ms=%d",
                    parsed["width"],
                    parsed["height"],
                    parsed["steps"],
                    int((time.monotonic() - started_at) * 1000),
                )
            elif isinstance(error, ApiError):
                self._send_error(error)
            elif isinstance(error, UpstreamTimeout):
                logging.error("generation failed reason=upstream timeout")
                self._send_error(
                    ApiError(
                        504,
                        "image generation timed out",
                        error_type="server_error",
                        code="generation_timeout",
                    )
                )
            elif isinstance(error, UpstreamError):
                logging.error("generation failed reason=%s", str(error))
                self._send_error(
                    ApiError(
                        502,
                        "image generation failed",
                        error_type="server_error",
                        code="upstream_generation_failed",
                    )
                )
            else:
                logging.exception("generation failed with an unexpected worker error", exc_info=error)
                self._send_error(
                    ApiError(
                        500,
                        "image generation failed",
                        error_type="server_error",
                        code="internal_error",
                    )
                )

    return Handler


def _arg_size(value: str) -> tuple[int, int]:
    try:
        return _parse_size_text(value)
    except ApiError as error:
        raise argparse.ArgumentTypeError("size must use WIDTHxHEIGHT") from error


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--upstream-base-url", default=DEFAULT_UPSTREAM_BASE_URL)
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--upstream-model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--max-request-bytes", type=int, default=131_072)
    parser.add_argument("--max-output-bytes", type=int, default=67_108_864)
    parser.add_argument("--max-prompt-chars", type=int, default=8_192)
    parser.add_argument("--max-negative-prompt-chars", type=int, default=8_192)
    parser.add_argument("--min-width", type=int, default=64)
    parser.add_argument("--max-width", type=int, default=2_048)
    parser.add_argument("--min-height", type=int, default=64)
    parser.add_argument("--max-height", type=int, default=2_048)
    parser.add_argument("--max-pixels", type=int, default=4_194_304)
    parser.add_argument("--default-size", type=_arg_size, default=(768, 768))
    parser.add_argument("--default-steps", type=int, default=20)
    parser.add_argument("--max-steps", type=int, default=100)
    parser.add_argument(
        "--client-read-timeout-seconds",
        type=float,
        default=DEFAULT_CLIENT_READ_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--max-handler-threads",
        type=int,
        default=DEFAULT_MAX_HANDLER_THREADS,
    )
    parser.add_argument("--request-timeout-seconds", type=float, default=5.0)
    parser.add_argument("--inference-timeout-seconds", type=float, default=900.0)
    return parser.parse_args()


def _validate_loopback_origin(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    try:
        address = ipaddress.ip_address(parsed.hostname or "")
        port = parsed.port
    except ValueError as error:
        raise SystemExit("--upstream-base-url must be a loopback HTTP origin") from error
    if (
        parsed.scheme != "http"
        or not address.is_loopback
        or port is None
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise SystemExit("--upstream-base-url must be a loopback HTTP origin")
    return value.rstrip("/")


def main() -> int:
    args = _parse_args()
    try:
        address = ipaddress.ip_address(args.host)
    except ValueError as error:
        raise SystemExit("--host must be a loopback IP address") from error
    if not address.is_loopback:
        raise SystemExit("--host must be a loopback IP address")
    if not 1 <= args.port <= 65_535 and args.port != 0:
        raise SystemExit("--port must be 0 or between 1 and 65535")
    upstream_base_url = _validate_loopback_origin(args.upstream_base_url)
    if MODEL_ID_PATTERN.fullmatch(args.model_id) is None:
        raise SystemExit("--model-id is invalid")
    if MODEL_ID_PATTERN.fullmatch(args.upstream_model_id) is None:
        raise SystemExit("--upstream-model-id is invalid")

    integer_limits = (
        args.max_request_bytes,
        args.max_output_bytes,
        args.max_prompt_chars,
        args.max_negative_prompt_chars,
        args.min_width,
        args.max_width,
        args.min_height,
        args.max_height,
        args.max_pixels,
        args.default_steps,
        args.max_steps,
        args.max_handler_threads,
    )
    if any(value <= 0 for value in integer_limits):
        raise SystemExit("request and generation limits must be positive")
    if args.min_width > args.max_width or args.min_height > args.max_height:
        raise SystemExit("minimum image dimensions must not exceed maximums")
    default_width, default_height = args.default_size
    if (
        not args.min_width <= default_width <= args.max_width
        or not args.min_height <= default_height <= args.max_height
        or default_width * default_height > args.max_pixels
    ):
        raise SystemExit("default size is outside the configured image limits")
    if not 1 <= args.default_steps <= args.max_steps:
        raise SystemExit("default steps are outside the configured range")
    for value, name in (
        (args.client_read_timeout_seconds, "client read timeout"),
        (args.request_timeout_seconds, "request timeout"),
        (args.inference_timeout_seconds, "inference timeout"),
    ):
        if not math.isfinite(value) or value <= 0:
            raise SystemExit(f"{name} must be positive")

    state = ServerState(
        upstream_base_url=upstream_base_url,
        model_id=args.model_id,
        upstream_model_id=args.upstream_model_id,
        max_request_bytes=args.max_request_bytes,
        max_output_bytes=args.max_output_bytes,
        max_prompt_chars=args.max_prompt_chars,
        max_negative_prompt_chars=args.max_negative_prompt_chars,
        min_width=args.min_width,
        max_width=args.max_width,
        min_height=args.min_height,
        max_height=args.max_height,
        max_pixels=args.max_pixels,
        default_size=args.default_size,
        default_steps=args.default_steps,
        max_steps=args.max_steps,
        request_timeout_seconds=args.request_timeout_seconds,
        inference_timeout_seconds=args.inference_timeout_seconds,
    )
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.info("checking stable-diffusion.cpp model catalog")
    try:
        _check_upstream_model(state)
    except UpstreamError as error:
        raise SystemExit("stable-diffusion.cpp model preflight failed") from error
    server = ImageHttpServer(
        (args.host, args.port),
        _handler_for(state),
        client_read_timeout_seconds=args.client_read_timeout_seconds,
        max_handler_threads=args.max_handler_threads,
    )

    def request_shutdown(signum: int, frame: Any) -> None:
        del signum, frame
        state.shutdown_requested.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

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
                "upstream_model": state.upstream_model_id,
                "upstream": state.upstream_base_url,
                "client_read_timeout_seconds": args.client_read_timeout_seconds,
                "max_handler_threads": args.max_handler_threads,
                "inference_slots": 1,
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
