"""Serialize GPU1 media inference across the independent HTTP services."""

from __future__ import annotations

import fcntl
import json
import logging
import math
import os
import stat
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator


class MediaGpuError(RuntimeError):
    status = 503
    code = "media_gpu_unavailable"


class MediaGpuBusy(MediaGpuError):
    status = 429
    code = "media_gpu_busy"


class MediaGpuCancelled(MediaGpuError):
    code = "service_shutting_down"


class MediaGpuRecoveryRequired(MediaGpuError):
    code = "media_gpu_recovery_required"


def _open_scheduler() -> int:
    runtime_dir = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
    path = os.environ.get("MCODA_MEDIA_GPU_LOCK_PATH", str(runtime_dir / "mcoda-media-gpu1.lock"))
    fd = -1
    try:
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        metadata = os.fstat(fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()
                or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) & 0o077):
            os.close(fd)
            raise MediaGpuError("shared media GPU lock must be a private, owner-owned regular file")
        return fd
    except OSError as error:
        if fd >= 0:
            os.close(fd)
        raise MediaGpuError("cannot access the shared media GPU scheduler") from error


def _read_lease(fd: int) -> dict | None:
    raw = os.pread(fd, 16_385, 0)
    if not raw:
        return None
    try:
        if len(raw) > 16_384:
            raise ValueError("oversized lease")
        value = json.loads(raw)
        if (not isinstance(value, dict) or value.get("version") != 1
                or not isinstance(value.get("id"), str)
                or value.get("status") not in ("active", "uncertain")):
            raise ValueError("invalid lease")
        return value
    except (ValueError, UnicodeDecodeError) as error:
        raise MediaGpuRecoveryRequired("media GPU lease is unreadable; reconcile native inference before recovery") from error


def _write_lease(fd: int, value: dict | None) -> None:
    data = b"" if value is None else json.dumps(value, separators=(",", ":")).encode("utf-8")
    os.lseek(fd, 0, os.SEEK_SET)
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        if written <= 0:
            raise MediaGpuError("cannot persist the shared media GPU lease")
        offset += written
    os.ftruncate(fd, len(data))
    os.fsync(fd)


class MediaGpuLease:
    """Host-owned receipt; never store prompts, credentials or client URLs."""

    def __init__(self, fd: int, label: str):
        self._fd = fd
        self._closed = False
        self._uncertain = False
        self.record = {"version": 1, "id": str(uuid.uuid4()), "status": "active",
                       "label": label[:128], "pid": os.getpid(), "started_at": time.time()}
        _write_lease(fd, self.record)

    def mark_uncertain(self, reason: str) -> None:
        if self._closed:
            raise MediaGpuError("media GPU lease is already closed")
        self._uncertain = True
        self.record.update(status="uncertain", reason=reason[:128])
        _write_lease(self._fd, self.record)

    def record_native_job(self, job_id: str) -> None:
        if self._closed or not isinstance(job_id, str) or not job_id or len(job_id) > 256:
            raise MediaGpuError("invalid native media job receipt")
        self.record["native_job_id"] = job_id
        _write_lease(self._fd, self.record)

    def confirm_finished(self) -> None:
        if self._closed:
            raise MediaGpuError("media GPU lease is already closed")
        self._uncertain = False
        self.record.update(status="active")
        self.record.pop("reason", None)
        _write_lease(self._fd, self.record)


def reconcile_media_gpu_slot(expected_id: str, terminal_probe: Callable[[dict], bool]) -> bool:
    """Clear one abandoned receipt only after a trusted backend terminal probe.

    Process death, elapsed time, HTTP disconnection and a cancel acknowledgement
    are not terminal proof. The caller supplies a backend-specific probe or
    evidence that the native engine was stopped and cannot retain that job.
    """
    fd = _open_scheduler()
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise MediaGpuBusy("media GPU lease is still owned by a running worker") from error
        current = _read_lease(fd)
        if current is None or current["id"] != expected_id:
            return False
        if terminal_probe(dict(current)) is not True:
            return False
        _write_lease(fd, None)
        return True
    finally:
        os.close(fd)


@contextmanager
def media_gpu_slot(
    label: str, *, cancelled: threading.Event | None = None,
    shutdown: threading.Event | None = None,
) -> Iterator[MediaGpuLease]:
    """Hold a kernel lock until native inference finishes, even if a client leaves.

    Never unlink the lock file: waiters must keep referring to the same inode.
    Each call opens its own file description so threads also exclude each other.
    """
    try:
        timeout = float(os.environ.get("MCODA_MEDIA_GPU_WAIT_SECONDS", "600"))
    except ValueError as error:
        raise MediaGpuError("media GPU wait limit must be a number") from error
    if not math.isfinite(timeout) or timeout < 0:
        raise MediaGpuError("media GPU wait limit must be finite and nonnegative")
    fd = _open_scheduler()
    acquired = False
    lease: MediaGpuLease | None = None
    started = time.monotonic()
    try:
        while True:
            if any(event is not None and event.is_set() for event in (cancelled, shutdown)):
                raise MediaGpuCancelled("media generation stopped while waiting for the GPU")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise MediaGpuBusy("the media GPU is busy; retry the request")
                if cancelled is not None:
                    cancelled.wait(min(0.1, remaining))
                else:
                    time.sleep(min(0.1, remaining))
        if any(event is not None and event.is_set() for event in (cancelled, shutdown)):
            raise MediaGpuCancelled("media generation stopped before GPU inference")
        if _read_lease(fd) is not None:
            raise MediaGpuRecoveryRequired("an earlier media GPU lease has no confirmed outcome; reconcile native inference before retrying")
        lease = MediaGpuLease(fd, label)
        logging.info(
            "media_gpu_acquired label=%s pid=%d wait_ms=%d monotonic=%.6f",
            label, os.getpid(), int((time.monotonic() - started) * 1000), time.monotonic(),
        )
        yield lease
    finally:
        try:
            if acquired:
                if lease is not None:
                    try:
                        if not lease._uncertain:
                            _write_lease(fd, None)
                    finally:
                        lease._closed = True
                logging.info(
                    "media_gpu_released label=%s pid=%d monotonic=%.6f",
                    label, os.getpid(), time.monotonic(),
                )
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
