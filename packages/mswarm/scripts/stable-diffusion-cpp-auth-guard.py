#!/usr/bin/env python3
"""Authenticated loopback guard for a stable-diffusion.cpp OpenAI server."""

from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import math
import os
import secrets
import signal
import socket
import stat
import threading
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from typing import Any


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 11445
DEFAULT_UPSTREAM_BASE_URL = "http://127.0.0.1:11451"
DEFAULT_MAX_REQUEST_BYTES = 2_097_152
DEFAULT_MAX_RESPONSE_BYTES = 134_217_728
DEFAULT_CLIENT_READ_TIMEOUT_SECONDS = 10.0
DEFAULT_UPSTREAM_TIMEOUT_SECONDS = 5.0
DEFAULT_GENERATION_TIMEOUT_SECONDS = 1_800.0
DEFAULT_MAX_HANDLER_THREADS = 8
ALLOWED_ENDPOINTS = {
    ("GET", "/v1/models"),
    ("POST", "/v1/images/generations"),
}


@dataclass(frozen=True)
class GuardState:
    upstream_host: str
    upstream_port: int
    api_key: bytes
    max_request_bytes: int
    max_response_bytes: int
    upstream_timeout_seconds: float
    generation_timeout_seconds: float


class GuardHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(
        self,
        server_address: tuple[str, int],
        request_handler_class: type[BaseHTTPRequestHandler],
        *,
        client_read_timeout_seconds: float,
        max_handler_threads: int,
        bind_and_activate: bool = True,
    ) -> None:
        self.client_read_timeout_seconds = client_read_timeout_seconds
        self._handler_slots = threading.BoundedSemaphore(max_handler_threads)
        super().__init__(server_address, request_handler_class, bind_and_activate)

    def server_bind(self) -> None:
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
                body = b'{"error":{"message":"server is busy","type":"server_error","code":"server_busy"}}'
                request.sendall(
                    b"HTTP/1.1 503 Service Unavailable\r\n"
                    b"Content-Type: application/json\r\n"
                    + f"Content-Length: {len(body)}\r\n".encode("ascii")
                    + b"Connection: close\r\n\r\n"
                    + body
                )
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

    def process_request_thread(self, request: socket.socket, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._handler_slots.release()


def _read_api_key_file(path: str) -> bytes:
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise SystemExit("--api-key-file cannot be opened safely") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise SystemExit("--api-key-file must be a regular file")
        if os.name == "posix":
            if metadata.st_uid != os.geteuid():
                raise SystemExit("--api-key-file must be owned by the service user")
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise SystemExit("--api-key-file must not be accessible by group or others")
        raw = os.read(descriptor, 4_097)
        if len(raw) > 4_096 or os.read(descriptor, 1):
            raise SystemExit("--api-key-file is too large")
    finally:
        os.close(descriptor)
    try:
        api_key = raw.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise SystemExit("--api-key-file must contain an ASCII token") from error
    if not 32 <= len(api_key) <= 4_096 or any(character.isspace() for character in api_key):
        raise SystemExit("--api-key-file contains an invalid token")
    return api_key.encode("ascii")


def _validate_loopback_ip(value: str, option: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise SystemExit(f"{option} must be a loopback IP address") from error
    if not address.is_loopback:
        raise SystemExit(f"{option} must be a loopback IP address")
    return str(address)


def _validate_upstream(value: str) -> tuple[str, int]:
    parsed = urllib.parse.urlsplit(value)
    try:
        host = _validate_loopback_ip(parsed.hostname or "", "--upstream-base-url")
        port = parsed.port
    except ValueError as error:
        raise SystemExit("--upstream-base-url must be a loopback HTTP origin") from error
    if (
        parsed.scheme != "http"
        or port is None
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise SystemExit("--upstream-base-url must be a loopback HTTP origin")
    return host, port


def _handler_for(state: GuardState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "mcoda-sd-auth-guard"
        sys_version = ""

        def log_message(self, format_string: str, *args: Any) -> None:
            del format_string, args

        def _send_json_error(
            self,
            status: int,
            message: str,
            code: str,
            *,
            error_type: str = "server_error",
            authenticate: bool = False,
        ) -> None:
            body = json.dumps(
                {"error": {"message": message, "type": error_type, "code": code}},
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            if authenticate:
                self.send_header("WWW-Authenticate", "Bearer")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

        def _authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            scheme, separator, token = header.partition(" ")
            try:
                candidate = token.encode("ascii")
            except UnicodeEncodeError:
                candidate = b""
            matches = secrets.compare_digest(candidate, state.api_key)
            return separator == " " and scheme.lower() == "bearer" and matches

        def _require_authentication(self) -> bool:
            if self._authorized():
                return True
            self._send_json_error(
                401,
                "invalid authentication credentials",
                "invalid_api_key",
                error_type="authentication_error",
                authenticate=True,
            )
            return False

        def _read_request_body(self) -> bytes | None:
            if self.headers.get("Transfer-Encoding") is not None:
                self._send_json_error(
                    400,
                    "transfer encoding is unsupported",
                    "unsupported_transfer_encoding",
                    error_type="invalid_request_error",
                )
                return None
            content_length = self.headers.get("Content-Length")
            if content_length is None:
                self._send_json_error(
                    411,
                    "content-length is required",
                    "content_length_required",
                    error_type="invalid_request_error",
                )
                return None
            try:
                length = int(content_length, 10)
            except ValueError:
                length = -1
            if length < 0:
                self._send_json_error(
                    400,
                    "content-length is invalid",
                    "invalid_content_length",
                    error_type="invalid_request_error",
                )
                return None
            if length > state.max_request_bytes:
                self._send_json_error(
                    413,
                    "request body is too large",
                    "request_too_large",
                    error_type="invalid_request_error",
                )
                return None
            try:
                body = self.rfile.read(length)
            except (OSError, TimeoutError):
                self._send_json_error(408, "request body timed out", "request_timeout")
                return None
            if len(body) != length:
                self._send_json_error(400, "request body is incomplete", "incomplete_request")
                return None
            return body

        def _proxy(self, method: str, path: str, body: bytes | None) -> None:
            timeout = (
                state.generation_timeout_seconds
                if method == "POST"
                else state.upstream_timeout_seconds
            )
            connection = http.client.HTTPConnection(
                state.upstream_host,
                state.upstream_port,
                timeout=timeout,
            )
            headers = {"Accept": self.headers.get("Accept", "application/json")}
            if body is not None:
                headers["Content-Type"] = self.headers.get(
                    "Content-Type", "application/json"
                )
                headers["Content-Length"] = str(len(body))
            try:
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                raw = response.read(state.max_response_bytes + 1)
                status = response.status
                content_type = response.getheader("Content-Type")
                retry_after = response.getheader("Retry-After")
            except (OSError, http.client.HTTPException):
                self._send_json_error(
                    502,
                    "stable-diffusion.cpp is unavailable",
                    "upstream_unavailable",
                )
                return
            finally:
                connection.close()
            if len(raw) > state.max_response_bytes:
                self._send_json_error(
                    502,
                    "stable-diffusion.cpp response is too large",
                    "upstream_response_too_large",
                )
                return
            self.send_response(status)
            if content_type is not None:
                self.send_header("Content-Type", content_type)
            if retry_after is not None:
                self.send_header("Retry-After", retry_after)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

        def do_GET(self) -> None:
            if not self._require_authentication():
                return
            if ("GET", self.path) not in ALLOWED_ENDPOINTS:
                self._send_json_error(
                    404,
                    "endpoint not found",
                    "not_found",
                    error_type="not_found_error",
                )
                return
            self._proxy("GET", self.path, None)

        def do_POST(self) -> None:
            if not self._require_authentication():
                return
            if ("POST", self.path) not in ALLOWED_ENDPOINTS:
                self._send_json_error(
                    404,
                    "endpoint not found",
                    "not_found",
                    error_type="not_found_error",
                )
                return
            body = self._read_request_body()
            if body is None:
                return
            self._proxy("POST", self.path, body)

        def _method_not_allowed(self) -> None:
            if not self._require_authentication():
                return
            self._send_json_error(
                405,
                "method not allowed",
                "method_not_allowed",
                error_type="invalid_request_error",
            )

        do_DELETE = _method_not_allowed
        do_HEAD = _method_not_allowed
        do_OPTIONS = _method_not_allowed
        do_PATCH = _method_not_allowed
        do_PUT = _method_not_allowed

    return Handler


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--upstream-base-url", default=DEFAULT_UPSTREAM_BASE_URL)
    parser.add_argument("--api-key-file", required=True)
    parser.add_argument(
        "--max-request-bytes", type=int, default=DEFAULT_MAX_REQUEST_BYTES
    )
    parser.add_argument(
        "--max-response-bytes", type=int, default=DEFAULT_MAX_RESPONSE_BYTES
    )
    parser.add_argument(
        "--client-read-timeout-seconds",
        type=float,
        default=DEFAULT_CLIENT_READ_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--upstream-timeout-seconds",
        type=float,
        default=DEFAULT_UPSTREAM_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--generation-timeout-seconds",
        type=float,
        default=DEFAULT_GENERATION_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--max-handler-threads", type=int, default=DEFAULT_MAX_HANDLER_THREADS
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    host = _validate_loopback_ip(args.host, "--host")
    if not 1 <= args.port <= 65_535 and args.port != 0:
        raise SystemExit("--port must be 0 or between 1 and 65535")
    upstream_host, upstream_port = _validate_upstream(args.upstream_base_url)
    if args.port != 0 and host == upstream_host and args.port == upstream_port:
        raise SystemExit("guard and upstream must use different loopback endpoints")
    api_key = _read_api_key_file(args.api_key_file)
    if args.max_request_bytes <= 0 or args.max_response_bytes <= 0:
        raise SystemExit("request and response limits must be positive")
    if args.max_handler_threads <= 0:
        raise SystemExit("--max-handler-threads must be positive")
    for value, name in (
        (args.client_read_timeout_seconds, "client read timeout"),
        (args.upstream_timeout_seconds, "upstream timeout"),
        (args.generation_timeout_seconds, "generation timeout"),
    ):
        if not math.isfinite(value) or value <= 0:
            raise SystemExit(f"{name} must be positive")

    state = GuardState(
        upstream_host=upstream_host,
        upstream_port=upstream_port,
        api_key=api_key,
        max_request_bytes=args.max_request_bytes,
        max_response_bytes=args.max_response_bytes,
        upstream_timeout_seconds=args.upstream_timeout_seconds,
        generation_timeout_seconds=args.generation_timeout_seconds,
    )
    server = GuardHttpServer(
        (host, args.port),
        _handler_for(state),
        client_read_timeout_seconds=args.client_read_timeout_seconds,
        max_handler_threads=args.max_handler_threads,
    )

    def request_shutdown(signum: int, frame: Any) -> None:
        del signum, frame
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    bound_host, bound_port = server.server_address[:2]
    print(
        json.dumps(
            {
                "event": "listening",
                "host": bound_host,
                "port": bound_port,
                "upstream": f"http://{upstream_host}:{upstream_port}",
                "authentication": "bearer-file",
                "max_request_bytes": state.max_request_bytes,
                "max_response_bytes": state.max_response_bytes,
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
