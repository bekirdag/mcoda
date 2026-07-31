#!/usr/bin/env python3
"""Loopback-only OpenAI-shaped HTTP wrapper for Stable Audio 3 TensorRT."""

from __future__ import annotations

import argparse
import base64
import io
import ipaddress
import json
import logging
import math
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from typing import Any, Protocol


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 11446
DEFAULT_MODEL_ID = "stable-audio-3-local"
DEFAULT_RUNTIME_ROOT = (
    "/mnt/githubActions/piriatlas/tools/stable-audio-3/optimized/tensorRT"
)
SAMPLE_RATE = 44_100
CHANNELS = 2
SAMPLE_WIDTH_BYTES = 2
ALLOWED_FIELDS = {
    "model",
    "prompt",
    "duration_seconds",
    "response_format",
    "n",
    "seed",
    "steps",
}


class AudioBackend(Protocol):
    def generate(
        self,
        prompt: str,
        *,
        seconds: float,
        steps: int,
        seed: int | None,
    ) -> tuple[bytes, dict[str, Any]]: ...


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


class MockBackend:
    """Dependency-free backend used only by the HTTP contract test."""

    def generate(
        self,
        prompt: str,
        *,
        seconds: float,
        steps: int,
        seed: int | None,
    ) -> tuple[bytes, dict[str, Any]]:
        del prompt, steps
        sample_count = int(round(seconds * SAMPLE_RATE))
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(CHANNELS)
            wav_file.setsampwidth(SAMPLE_WIDTH_BYTES)
            wav_file.setframerate(SAMPLE_RATE)
            wav_file.writeframes(b"\x00" * (sample_count * CHANNELS * SAMPLE_WIDTH_BYTES))
        return output.getvalue(), {"seed": 0 if seed is None else seed}


class SubprocessBackend:
    """Runs one canonical Stable Audio CLI process per request.

    Upstream documents that the TensorRT decoder workspace evolves after the
    first inference in a process. A fresh process per request preserves the
    canonical CLI's deterministic behavior while the HTTP listener remains
    resident and bounded.
    """

    def __init__(
        self,
        runtime_root: Path,
        *,
        dit: str,
        decoder: str,
        precision: str | None,
        models_dir: Path | None,
        engine_arch: str,
        max_output_bytes: int,
        timeout_seconds: float,
    ) -> None:
        self.runtime_root = runtime_root
        self.python = runtime_root / ".venv" / "bin" / "python"
        self.entrypoint = runtime_root / "scripts" / "sa3_trt.py"
        if not self.python.is_file() or not os.access(self.python, os.X_OK):
            raise RuntimeError(f"Stable Audio Python is missing or not executable: {self.python}")
        if not self.entrypoint.is_file():
            raise RuntimeError(f"Stable Audio TensorRT entrypoint not found at {self.entrypoint}")
        self.dit = dit
        self.decoder = decoder
        self.precision = precision
        self.models_dir = models_dir
        self.max_output_bytes = max_output_bytes
        self.timeout_seconds = timeout_seconds
        precision_name = precision or "fp16mixed"
        dit_directory = {
            "sm-music": "sa3-sm-music",
            "sm-sfx": "sa3-sm-sfx",
            "medium": "sa3-m",
        }[dit]
        decoder_filename = (
            "dec_dynamic_fp32.trt"
            if precision_name == "fp32"
            else {
                "same-s": "dec_dynamic_bf16.trt",
                "same-l": "dec_dynamic_triton_swa.trt",
            }[decoder]
        )
        models_root = models_dir or runtime_root / "models"
        required_files = (
            runtime_root / "scripts" / "tokenizer.json",
            models_root / engine_arch / "t5gemma" / "t5gemma_fp16mixed.trt",
            models_root / engine_arch / dit_directory / f"dit_{precision_name}.trt",
            models_root / engine_arch / decoder / decoder_filename,
        )
        missing = [path for path in required_files if not path.is_file() or path.stat().st_size == 0]
        if missing:
            raise RuntimeError(f"Stable Audio runtime file is missing or empty: {missing[0]}")

    def generate(
        self,
        prompt: str,
        *,
        seconds: float,
        steps: int,
        seed: int | None,
    ) -> tuple[bytes, dict[str, Any]]:
        effective_seed = seed if seed is not None else secrets.randbelow(2**31)
        with tempfile.TemporaryDirectory(prefix="stable-audio-3-") as temp_dir:
            output_path = Path(temp_dir) / "generation.wav"
            command = [
                str(self.python),
                str(self.entrypoint),
                f"--prompt={prompt}",
                "--dit",
                self.dit,
                "--decoder",
                self.decoder,
                "--seconds",
                str(seconds),
                "--steps",
                str(steps),
                "--seed",
                str(effective_seed),
                "--quiet",
                "--out",
                str(output_path),
            ]
            if self.precision:
                command.extend(("--precision", self.precision))
            if self.models_dir:
                command.extend(("--models-dir", str(self.models_dir)))
            process = subprocess.Popen(
                    command,
                    cwd=self.runtime_root,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
            )
            try:
                return_code = process.wait(timeout=self.timeout_seconds)
            except subprocess.TimeoutExpired as error:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                except ProcessLookupError:
                    pass
                raise RuntimeError("Stable Audio CLI timed out") from error
            if return_code != 0:
                raise RuntimeError(
                    f"Stable Audio CLI exited with status {return_code}"
                )
            try:
                if output_path.stat().st_size > self.max_output_bytes:
                    raise RuntimeError("Stable Audio CLI output exceeds the configured limit")
                wav_data = output_path.read_bytes()
            except OSError as error:
                raise RuntimeError("Stable Audio CLI did not produce a WAV file") from error
        _validate_wav(wav_data, seconds)
        return wav_data, {"seed": effective_seed}


@dataclass
class ServerState:
    backend: AudioBackend
    backend_name: str
    model_id: str
    dit: str
    decoder: str
    max_request_bytes: int
    max_output_bytes: int
    max_prompt_chars: int
    min_duration_seconds: float
    max_duration_seconds: float
    max_steps: int
    default_steps: int
    fatal_error: threading.Event = field(default_factory=threading.Event)
    inference_slots: threading.BoundedSemaphore = field(
        default_factory=lambda: threading.BoundedSemaphore(1)
    )


class AudioHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def server_bind(self) -> None:
        # HTTPServer.server_bind performs a reverse-DNS lookup via getfqdn().
        # That lookup is unnecessary for this loopback-only service and can
        # stall startup on hosts whose resolver does not map loopback quickly.
        TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = int(port)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


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

    model = payload.get("model")
    if model != state.model_id:
        raise ApiError(
            400,
            f"model must be {state.model_id}",
            param="model",
            code="model_not_found",
        )

    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ApiError(
            400,
            "prompt must be a non-empty string",
            param="prompt",
            code="invalid_prompt",
        )
    if len(prompt) > state.max_prompt_chars:
        raise ApiError(
            400,
            "prompt exceeds the configured limit",
            param="prompt",
            code="prompt_limit_exceeded",
        )
    if "\x00" in prompt:
        raise ApiError(
            400,
            "prompt must not contain a null character",
            param="prompt",
            code="invalid_prompt",
        )
    try:
        prompt.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise ApiError(
            400,
            "prompt must be valid UTF-8 text",
            param="prompt",
            code="invalid_prompt",
        ) from error

    duration = payload.get("duration_seconds")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)):
        raise ApiError(
            400,
            "duration_seconds must be a number",
            param="duration_seconds",
            code="invalid_duration",
        )
    duration = float(duration)
    if not math.isfinite(duration):
        raise ApiError(
            400,
            "duration_seconds must be finite",
            param="duration_seconds",
            code="invalid_duration",
        )
    if not state.min_duration_seconds <= duration <= state.max_duration_seconds:
        raise ApiError(
            400,
            "duration_seconds is outside the configured range",
            param="duration_seconds",
            code="duration_limit_exceeded",
        )

    response_format = payload.get("response_format", "wav")
    if response_format != "wav":
        raise ApiError(
            400,
            "response_format must be wav",
            param="response_format",
            code="unsupported_response_format",
        )

    n = payload.get("n", 1)
    if not _is_int(n) or n != 1:
        raise ApiError(400, "n must be 1", param="n", code="invalid_n")

    seed = payload.get("seed")
    if seed is not None and (not _is_int(seed) or not 0 <= seed <= 2**31 - 1):
        raise ApiError(
            400,
            "seed must be an integer between 0 and 2147483647",
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
        "duration_seconds": duration,
        "steps": steps,
        "seed": seed,
    }


def _validate_wav(wav_data: bytes, duration_seconds: float) -> None:
    expected_samples = int(round(duration_seconds * SAMPLE_RATE))
    expected_pcm_bytes = expected_samples * CHANNELS * SAMPLE_WIDTH_BYTES
    try:
        with wave.open(io.BytesIO(wav_data), "rb") as wav_file:
            if wav_file.getnchannels() != CHANNELS:
                raise RuntimeError("backend WAV must be stereo")
            if wav_file.getsampwidth() != SAMPLE_WIDTH_BYTES:
                raise RuntimeError("backend WAV must use signed 16-bit samples")
            if wav_file.getframerate() != SAMPLE_RATE:
                raise RuntimeError(f"backend WAV must use {SAMPLE_RATE} Hz")
            if wav_file.getnframes() != expected_samples:
                raise RuntimeError(
                    f"backend WAV has {wav_file.getnframes()} frames; expected {expected_samples}"
                )
            pcm_data = wav_file.readframes(expected_samples + 1)
            if len(pcm_data) != expected_pcm_bytes:
                raise RuntimeError(
                    f"backend WAV has {len(pcm_data)} PCM bytes; expected {expected_pcm_bytes}"
                )
    except (EOFError, wave.Error) as error:
        raise RuntimeError("backend returned an invalid WAV file") from error
    if len(wav_data) != 44 + expected_pcm_bytes:
        raise RuntimeError("backend WAV contains truncated or trailing data")


def _handler_for(state: ServerState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "stable-audio-3-openai/1"

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
                if state.fatal_error.is_set():
                    self._send_json(503, {"status": "unhealthy", "model": state.model_id})
                    return
                self._send_json(
                    200,
                    {
                        "status": "ok",
                        "model": state.model_id,
                        "backend": state.backend_name,
                        "dit": state.dit,
                        "decoder": state.decoder,
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
            if self.path != "/v1/audio/generations":
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
                content_length_header = self.headers.get("content-length")
                if content_length_header is None:
                    raise ApiError(411, "content-length is required", code="length_required")
                try:
                    content_length = int(content_length_header)
                except ValueError as error:
                    raise ApiError(
                        400, "content-length is invalid", code="invalid_content_length"
                    ) from error
                if content_length < 1:
                    raise ApiError(400, "request body is empty", code="invalid_json")
                if content_length > state.max_request_bytes:
                    raise ApiError(
                        413,
                        "request body exceeds the configured limit",
                        code="request_too_large",
                    )
                raw_body = self.rfile.read(content_length)
                if len(raw_body) != content_length:
                    raise ApiError(400, "request body is incomplete", code="invalid_json")
                try:
                    payload = json.loads(raw_body)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ApiError(400, "request body is invalid JSON", code="invalid_json") from error
                request = _parse_generation_request(payload, state)
            except ApiError as error:
                self._send_error(error)
                return

            if not state.inference_slots.acquire(blocking=False):
                self._send_error(
                    ApiError(
                        429,
                        "the local audio generator is busy",
                        error_type="rate_limit_error",
                        code="local_concurrency_saturated",
                    )
                )
                return

            started_at = time.monotonic()
            try:
                wav_data, timing = state.backend.generate(
                    request["prompt"],
                    seconds=request["duration_seconds"],
                    steps=request["steps"],
                    seed=request["seed"],
                )
                _validate_wav(wav_data, request["duration_seconds"])
                if len(wav_data) > state.max_output_bytes:
                    raise ApiError(
                        413,
                        "generated audio exceeds the configured output limit",
                        code="output_too_large",
                    )
                effective_seed = timing.get("seed") if isinstance(timing, dict) else None
                if not _is_int(effective_seed):
                    raise RuntimeError("backend did not report an effective seed")
                response = {
                    "created": int(time.time()),
                    "model": state.model_id,
                    "data": [
                        {
                            "b64_audio": base64.b64encode(wav_data).decode("ascii"),
                            "mime_type": "audio/wav",
                            "duration_seconds": request["duration_seconds"],
                            "sample_rate": SAMPLE_RATE,
                            "seed": effective_seed,
                        }
                    ],
                }
                self._send_json(200, response)
                logging.info(
                    "generation completed duration_seconds=%.3f steps=%d elapsed_ms=%d",
                    request["duration_seconds"],
                    request["steps"],
                    int((time.monotonic() - started_at) * 1000),
                )
            except ApiError as error:
                self._send_error(error)
            except Exception as error:
                logging.error("generation failed error_type=%s", type(error).__name__)
                self._send_error(
                    ApiError(
                        500,
                        "audio generation failed",
                        error_type="server_error",
                        code="generation_failed",
                    )
                )
                state.fatal_error.set()
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            finally:
                state.inference_slots.release()

    return Handler


def _load_subprocess_backend(args: argparse.Namespace) -> AudioBackend:
    runtime_root = Path(args.runtime_root).expanduser().resolve()
    models_dir = (
        Path(args.models_dir).expanduser().resolve() if args.models_dir else None
    )
    return SubprocessBackend(
        runtime_root,
        dit=args.dit,
        decoder=args.decoder,
        precision=args.precision,
        models_dir=models_dir,
        engine_arch=args.engine_arch,
        max_output_bytes=args.max_output_bytes,
        timeout_seconds=args.inference_timeout_seconds,
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--backend", choices=("subprocess", "mock"), default="subprocess")
    parser.add_argument("--runtime-root", default=os.environ.get("STABLE_AUDIO_3_TRT_ROOT", DEFAULT_RUNTIME_ROOT))
    parser.add_argument("--models-dir")
    parser.add_argument(
        "--engine-arch",
        default=os.environ.get("STABLE_AUDIO_3_ENGINE_ARCH", "sm_86"),
    )
    parser.add_argument("--dit", choices=("sm-music", "sm-sfx", "medium"), default="sm-music")
    parser.add_argument("--decoder", choices=("same-s", "same-l"), default="same-s")
    parser.add_argument("--precision", choices=("fp16mixed", "bf16", "fp8", "fp32"))
    parser.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    parser.add_argument("--max-request-bytes", type=int, default=131_072)
    parser.add_argument("--max-output-bytes", type=int, default=67_108_864)
    parser.add_argument("--max-prompt-chars", type=int, default=8_192)
    parser.add_argument("--min-duration-seconds", type=float, default=3.0)
    parser.add_argument("--max-duration-seconds", type=float, default=120.0)
    parser.add_argument("--default-steps", type=int, default=8)
    parser.add_argument("--max-steps", type=int, default=32)
    parser.add_argument("--inference-timeout-seconds", type=float, default=900.0)
    parser.add_argument(
        "--startup-self-test",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
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
    if args.decoder != ("same-l" if args.dit == "medium" else "same-s"):
        raise SystemExit("medium requires same-l; sm-music and sm-sfx require same-s")
    if args.precision in ("bf16", "fp8") and args.dit != "medium":
        raise SystemExit("bf16 and fp8 precision are available only for medium")
    if not 1 <= args.default_steps <= args.max_steps:
        raise SystemExit("--default-steps must be within the configured steps range")
    if (
        not math.isfinite(args.min_duration_seconds)
        or not math.isfinite(args.max_duration_seconds)
        or args.min_duration_seconds < 3
        or args.max_duration_seconds < args.min_duration_seconds
    ):
        raise SystemExit("duration limits are invalid")
    if not math.isfinite(args.inference_timeout_seconds) or args.inference_timeout_seconds <= 0:
        raise SystemExit("--inference-timeout-seconds must be positive")
    if args.max_request_bytes <= 0 or args.max_output_bytes <= 0 or args.max_prompt_chars <= 0:
        raise SystemExit("request, output, and prompt limits must be positive")
    if not args.model_id.strip():
        raise SystemExit("--model-id must be non-empty")
    if not args.startup_self_test and args.backend != "mock":
        raise SystemExit("--no-startup-self-test is permitted only with --backend mock")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    logging.info("loading backend=%s dit=%s decoder=%s", args.backend, args.dit, args.decoder)
    backend: AudioBackend = (
        MockBackend() if args.backend == "mock" else _load_subprocess_backend(args)
    )
    if args.startup_self_test:
        logging.info("running startup inference self-test")
        probe_seconds = max(3.0, args.min_duration_seconds)
        probe_wav, probe_timing = backend.generate(
            "readiness check: a clean warm analog synthesizer tone",
            seconds=probe_seconds,
            steps=args.default_steps,
            seed=1_001,
        )
        _validate_wav(probe_wav, probe_seconds)
        if len(probe_wav) > args.max_output_bytes:
            raise RuntimeError("startup self-test output exceeds the configured limit")
        if not _is_int(probe_timing.get("seed") if isinstance(probe_timing, dict) else None):
            raise RuntimeError("startup self-test did not report an effective seed")
        logging.info("startup inference self-test passed")
    state = ServerState(
        backend=backend,
        backend_name=args.backend,
        model_id=args.model_id,
        dit=args.dit,
        decoder=args.decoder,
        max_request_bytes=args.max_request_bytes,
        max_output_bytes=args.max_output_bytes,
        max_prompt_chars=args.max_prompt_chars,
        min_duration_seconds=args.min_duration_seconds,
        max_duration_seconds=args.max_duration_seconds,
        max_steps=args.max_steps,
        default_steps=args.default_steps,
    )
    server = AudioHttpServer((args.host, args.port), _handler_for(state))

    def request_shutdown(signum: int, frame: Any) -> None:
        del signum, frame
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
                "backend": state.backend_name,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    return 1 if state.fatal_error.is_set() else 0


if __name__ == "__main__":
    raise SystemExit(main())
