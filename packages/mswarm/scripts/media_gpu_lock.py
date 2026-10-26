"""Serialize GPU1 media inference across the independent HTTP services."""

from __future__ import annotations

import fcntl
import logging
import math
import os
import stat
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


class MediaGpuError(RuntimeError):
    status = 503
    code = "media_gpu_unavailable"


class MediaGpuBusy(MediaGpuError):
    status = 429
    code = "media_gpu_busy"


class MediaGpuCancelled(MediaGpuError):
    code = "service_shutting_down"


@contextmanager
def media_gpu_slot(
    label: str, *, cancelled: threading.Event | None = None,
    shutdown: threading.Event | None = None,
) -> Iterator[None]:
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
    runtime_dir = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
    path = os.environ.get("MCODA_MEDIA_GPU_LOCK_PATH", str(runtime_dir / "mcoda-media-gpu1.lock"))
    try:
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    except OSError as error:
        raise MediaGpuError("cannot access the shared media GPU scheduler") from error
    acquired = False
    started = time.monotonic()
    try:
        metadata = os.fstat(fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()
                or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) & 0o077):
            raise MediaGpuError("shared media GPU lock must be a private, owner-owned regular file")
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
        logging.info(
            "media_gpu_acquired label=%s pid=%d wait_ms=%d monotonic=%.6f",
            label, os.getpid(), int((time.monotonic() - started) * 1000), time.monotonic(),
        )
        yield
    finally:
        try:
            if acquired:
                logging.info(
                    "media_gpu_released label=%s pid=%d monotonic=%.6f",
                    label, os.getpid(), time.monotonic(),
                )
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
