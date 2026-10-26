"""Opt-in Linux host RAM admission for native model loading and recovery.

The embedding runtime must confirm model readiness or confirmed process death
before leaving the context. Unknown outcomes retain the shared media fence.
This module never dispatches or replays inference.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import stat
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import urlsplit
from contextlib import contextmanager
from pathlib import Path

try:
    from .media_gpu_lock import _open_scheduler, _read_lease, _write_lease, MediaGpuLease, MediaGpuError
except ImportError:
    from media_gpu_lock import _open_scheduler, _read_lease, _write_lease, MediaGpuLease, MediaGpuError


class NativeLoadError(RuntimeError):
    pass


_local = threading.local()


def read_policy(path: str) -> dict:
    if not isinstance(path, str) or not os.path.isabs(path):
        raise NativeLoadError("native load policy must be an absolute file path")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) & 0o077):
            raise NativeLoadError("native load policy must be a private, owner-owned regular file")
        data = os.read(fd, 32769)
        if len(data) > 32768:
            raise NativeLoadError("native load policy is too large")
        policy = json.loads(data)
    finally:
        os.close(fd)
    fields = {"schemaVersion", "lockPath", "waitSeconds", "minAvailableMiB",
              "restoreReserveMiB", "serviceTimeoutSeconds", "services"}
    if not isinstance(policy, dict) or set(policy) != fields or type(policy["schemaVersion"]) is not int or policy["schemaVersion"] != 1:
        raise NativeLoadError("unsupported native load policy fields or version")
    if not isinstance(policy["lockPath"], str) or not os.path.isabs(policy["lockPath"]):
        raise NativeLoadError("native load policy requires an absolute shared lock path")
    for key in ("waitSeconds", "minAvailableMiB", "restoreReserveMiB", "serviceTimeoutSeconds"):
        value = policy[key]
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise NativeLoadError(f"native load policy {key} must be finite and positive")
        if key.endswith("Seconds") and value > 3600:
            raise NativeLoadError(f"native load policy {key} exceeds one hour")
    peers = policy["services"]
    if not isinstance(peers, list) or len(peers) > 16:
        raise NativeLoadError("native load policy services must be a bounded array")
    seen = set()
    for peer in peers:
        if (not isinstance(peer, dict) or set(peer) != {"unit", "restoreMiB", "readyUrl"}
                or not isinstance(peer["unit"], str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@-]{0,240}\.service", peer["unit"])
                or peer["unit"] in seen or type(peer["restoreMiB"]) is not int or peer["restoreMiB"] <= 0):
            raise NativeLoadError("invalid or duplicate native load peer")
        url = urlsplit(peer["readyUrl"]) if isinstance(peer["readyUrl"], str) else None
        if (url is None or url.scheme != "http" or url.hostname not in ("127.0.0.1", "::1")
                or url.username or url.password or url.fragment):
            raise NativeLoadError("native load peer readiness must use credential-free loopback HTTP")
        seen.add(peer["unit"])
    return policy


def available_mib() -> int:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                fields = line.split()
                if len(fields) == 3 and fields[2] == "kB":
                    return int(fields[1]) // 1024
    except (OSError, ValueError):
        pass
    raise NativeLoadError("available host RAM cannot be measured")


def service_state(unit: str, timeout: float) -> str:
    try:
        result = subprocess.run(["/usr/bin/systemctl", "--user", "show", unit,
                                 "--property=LoadState", "--property=ActiveState"],
                                check=True, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as error:
        raise NativeLoadError(f"cannot inspect native load peer: {unit}") from error
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if values.get("LoadState") != "loaded":
        raise NativeLoadError(f"configured native load peer is not loaded: {unit}")
    return values.get("ActiveState", "unknown")


def service_action(action: str, unit: str, timeout: float) -> None:
    try:
        subprocess.run(["/usr/bin/systemctl", "--user", action, unit],
                       check=True, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as error:
        raise NativeLoadError(f"cannot {action} native load peer: {unit}") from error


def wait_ready(peer: dict, timeout: float) -> None:
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with opener.open(peer["readyUrl"], timeout=min(2, max(.01, deadline - time.monotonic()))) as response:
                if response.status == 200:
                    return
        except (OSError, ValueError):
            pass
        if service_state(peer["unit"], min(5, timeout)) not in ("active", "activating"):
            raise NativeLoadError(f"native load peer stopped during restoration: {peer['unit']}")
        time.sleep(min(.1, max(0, deadline - time.monotonic())))
    raise NativeLoadError(f"native load peer readiness timed out: {peer['unit']}")


class NativeLoadLease:
    def __init__(self, record: MediaGpuLease):
        self.record = record
        self.outcome = None

    def confirm_ready(self) -> None:
        self.outcome = "ready"

    def confirm_stopped(self) -> None:
        self.outcome = "stopped"


def _restore(policy: dict, parked: list[dict]) -> None:
    errors = []
    for peer in parked:
        try:
            needed = policy["restoreReserveMiB"] + peer["restoreMiB"]
            if available_mib() < needed:
                raise NativeLoadError(f"insufficient host RAM to restore {peer['unit']}")
            service_action("start", peer["unit"], policy["serviceTimeoutSeconds"])
            if service_state(peer["unit"], policy["serviceTimeoutSeconds"]) != "active":
                raise NativeLoadError(f"native load peer did not become active: {peer['unit']}")
            wait_ready(peer, policy["serviceTimeoutSeconds"])
        except Exception as error:
            # Preserve the other original peers when one cannot restart.
            errors.append(error)
    if errors:
        raise NativeLoadError("native load peer restoration failed; retain the admission fence") from errors[0]


@contextmanager
def native_load_guard(env: dict | None):
    """Use MCODA_NATIVE_LOAD_POLICY from trusted host configuration only.

    The caller must have stopped its old model process before entering. Nested
    retries in the same thread retain one lease; other threads/processes wait.
    No configured policy means no lock, filesystem, systemctl or RAM probes.
    """
    path = (env or {}).get("MCODA_NATIVE_LOAD_POLICY")
    if path is None:
        yield None
        return
    active = getattr(_local, "active", None)
    if active is not None:
        if active[0] != path:
            raise NativeLoadError("cannot nest different native load policies")
        active[1].outcome = None
        yield active[1]
        return
    import fcntl
    try:
        policy = read_policy(path)
        fd = _open_scheduler(policy["lockPath"])
    except (OSError, ValueError, MediaGpuError) as error:
        raise NativeLoadError("cannot open the native load policy or shared lease") from error
    record = None
    parked = []
    entered_model = False
    completed = False
    try:
        deadline = time.monotonic() + policy["waitSeconds"]
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError as error:
                if time.monotonic() >= deadline:
                    raise NativeLoadError("active media still owns the native load lease") from error
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
        try:
            previous = _read_lease(fd)
        except MediaGpuError as error:
            raise NativeLoadError("shared native/media lease is unreadable; reconciliation is required") from error
        if previous is not None:
            raise NativeLoadError("an earlier native/media outcome must be reconciled before model loading")
        record = MediaGpuLease(fd, "native-model-load")
        lease = NativeLoadLease(record)
        _local.active = (path, lease)
        for peer in policy["services"]:
            state = service_state(peer["unit"], policy["serviceTimeoutSeconds"])
            if state in ("inactive", "failed"):
                continue
            if state != "active":
                raise NativeLoadError(f"native load peer is changing state: {peer['unit']}")
            # Record before stop: a timed-out stop may still complete.
            parked.append(peer)
            record.record["parked_units"] = [item["unit"] for item in parked]
            _write_lease(fd, record.record)
            service_action("stop", peer["unit"], policy["serviceTimeoutSeconds"])
            if service_state(peer["unit"], policy["serviceTimeoutSeconds"]) != "inactive":
                raise NativeLoadError(f"native load peer has not stopped: {peer['unit']}")
        free = available_mib()
        if free < policy["minAvailableMiB"]:
            raise NativeLoadError(f"native model needs {policy['minAvailableMiB']} MiB available RAM; measured {free}")
        logging.info("native_model_load_admitted available_mib=%d parked_peers=%d", free, len(parked))
        entered_model = True
        try:
            yield lease
        finally:
            # A dead caller or an unconfirmed model process must never admit
            # concurrent media. Keep a durable receipt for native reconciliation.
            if lease.outcome is not None:
                record.mark_uncertain("native_model_peer_restore_pending")
                _restore(policy, parked)
                completed = True
                _write_lease(fd, None)
            else:
                record.mark_uncertain("native_model_load_outcome_unknown")
                if sys.exc_info()[0] is None:
                    raise NativeLoadError("native model load returned without readiness or process-death proof")
    finally:
        try:
            if record is not None and not entered_model:
                record.mark_uncertain("native_model_peer_restore_pending")
                _restore(policy, parked)
                completed = True
                _write_lease(fd, None)
            if record is not None and not completed:
                record.mark_uncertain("native_model_load_or_restore_unconfirmed")
        finally:
            if record is not None:
                record._closed = True
                _local.active = None
            os.close(fd)
