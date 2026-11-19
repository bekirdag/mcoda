"""Deterministic host admission tests; no production services or GPU are used."""
import copy
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import ExitStack
from unittest.mock import patch

import native_load_guard as guard
from media_gpu_lock import media_gpu_slot, MediaGpuBusy, MediaGpuRecoveryRequired

REAL_WAIT_READY = guard.wait_ready


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.lock = self.root / "gpu.lock"
        self.policy_path = self.root / "policy.json"
        self.policy = {"schemaVersion": 1, "lockPath": str(self.lock), "waitSeconds": .03,
                       "minAvailableMiB": 90, "restoreReserveMiB": 10, "serviceTimeoutSeconds": .1,
                       "services": [{"unit": "video.service", "restoreMiB": 20, "readyUrl": "http://127.0.0.1:1234/ready"},
                                    {"unit": "image.service", "restoreMiB": 10, "readyUrl": "http://127.0.0.1:1235/ready"}]}
        self.env = {"MCODA_NATIVE_LOAD_POLICY": str(self.policy_path)}
        self.states = {"video.service": "active", "image.service": "active"}
        self.actions = []
        self.ready = []
        self.free = 100
        self.write_policy()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {"MCODA_MEDIA_GPU_LOCK_PATH": str(self.lock), "MCODA_MEDIA_GPU_WAIT_SECONDS": ".01"}))
        self.stack.enter_context(patch.object(guard, "available_mib", side_effect=lambda: self.free))
        self.stack.enter_context(patch.object(guard, "service_state", side_effect=lambda unit, timeout: self.states[unit]))
        self.stack.enter_context(patch.object(guard, "service_action", side_effect=self.action))
        self.stack.enter_context(patch.object(guard, "wait_ready", side_effect=lambda peer, timeout: self.ready.append(peer["unit"])))

    def write_policy(self):
        self.policy_path.write_text(json.dumps(self.policy))
        self.policy_path.chmod(0o600)

    def action(self, action, unit, timeout):
        self.actions.append((action, unit))
        self.states[unit] = "inactive" if action == "stop" else "active"

    def test_disabled_has_no_side_effects(self):
        with patch.object(guard, "read_policy", side_effect=AssertionError("unexpected policy read")):
            with guard.native_load_guard({}) as lease:
                self.assertIsNone(lease)
        self.assertFalse(self.lock.exists())
        self.assertFalse(self.actions)

    def test_load_serializes_and_restores_only_originally_active_services(self):
        self.states["image.service"] = "inactive"
        with guard.native_load_guard(self.env) as lease:
            self.assertEqual(self.actions, [("stop", "video.service")])
            self.assertEqual(json.loads(self.lock.read_text())["label"], "native-model-load")
            with self.assertRaises(MediaGpuBusy):
                with media_gpu_slot("waiting-image"):
                    self.fail("media ran during model load")
            lease.confirm_ready()
        self.assertEqual(self.actions, [("stop", "video.service"), ("start", "video.service")])
        self.assertEqual(self.ready, ["video.service"])
        self.assertEqual(self.lock.read_bytes(), b"")
        with media_gpu_slot("after-load"):
            pass

    def test_active_media_is_never_stopped_or_lease_overwritten(self):
        with media_gpu_slot("active-video"):
            before = self.lock.read_bytes()
            with self.assertRaisesRegex(guard.NativeLoadError, "active media"):
                with guard.native_load_guard(self.env):
                    self.fail("model loaded while video active")
            self.assertEqual(self.lock.read_bytes(), before)
            self.assertEqual(self.actions, [])

    def test_uncertain_media_receipt_is_not_cleared(self):
        with media_gpu_slot("lost-video") as lease:
            lease.mark_uncertain("disconnected")
        before = self.lock.read_bytes()
        with self.assertRaisesRegex(guard.NativeLoadError, "reconciled"):
            with guard.native_load_guard(self.env):
                self.fail("uncertain media was overwritten")
        self.assertEqual(self.lock.read_bytes(), before)
        self.assertFalse(self.actions)

    def test_insufficient_ram_restores_peers_without_entering_model(self):
        self.free = 80
        with self.assertRaisesRegex(guard.NativeLoadError, "measured 80"):
            with guard.native_load_guard(self.env):
                self.fail("insufficient RAM was admitted")
        self.assertEqual(self.states, {"video.service": "active", "image.service": "active"})
        self.assertEqual(self.lock.read_bytes(), b"")

    def test_nested_constructor_retry_owns_one_lease(self):
        with guard.native_load_guard(self.env) as outer:
            with guard.native_load_guard(self.env) as inner:
                self.assertIs(inner, outer)
                inner.confirm_ready()
            self.assertEqual(len(self.actions), 2)
            self.assertNotEqual(self.lock.read_bytes(), b"")
            outer.confirm_ready()
        self.assertEqual(len(self.actions), 4)

    def test_confirmed_failed_process_restores_and_preserves_original_error(self):
        with self.assertRaisesRegex(ValueError, "native load failed"):
            with guard.native_load_guard(self.env) as lease:
                lease.confirm_stopped()
                raise ValueError("native load failed")
        self.assertEqual(self.lock.read_bytes(), b"")
        self.assertEqual(len(self.actions), 4)

    def test_unknown_model_failure_stays_fenced_and_peers_stay_parked(self):
        with self.assertRaisesRegex(ValueError, "unknown process"):
            with guard.native_load_guard(self.env):
                raise ValueError("unknown process")
        self.assertEqual(json.loads(self.lock.read_text())["status"], "uncertain")
        self.assertEqual(self.states, {"video.service": "inactive", "image.service": "inactive"})
        with self.assertRaises(MediaGpuRecoveryRequired):
            with media_gpu_slot("next"):
                self.fail("unknown native load was ignored")

    def test_return_without_process_proof_is_an_error(self):
        with self.assertRaisesRegex(guard.NativeLoadError, "without readiness"):
            with guard.native_load_guard(self.env):
                pass
        receipt = json.loads(self.lock.read_text())
        self.assertEqual(receipt["status"], "uncertain")
        self.assertEqual(receipt["parked_units"], ["video.service", "image.service"])

    def test_restore_ram_reservation_refuses_to_start_peers(self):
        with self.assertRaisesRegex(guard.NativeLoadError, "restoration failed"):
            with guard.native_load_guard(self.env) as lease:
                self.free = 15
                lease.confirm_ready()
        self.assertEqual(json.loads(self.lock.read_text())["status"], "uncertain")
        self.assertEqual(len(self.actions), 2)
        self.assertFalse(self.ready)

    def test_restore_failure_preserves_other_original_peer(self):
        original = self.action
        def action(command, unit, timeout):
            if command == "start" and unit == "video.service":
                raise RuntimeError("fixture service failure")
            return original(command, unit, timeout)
        with patch.object(guard, "service_action", side_effect=action):
            with self.assertRaises(guard.NativeLoadError):
                with guard.native_load_guard(self.env) as lease:
                    lease.confirm_ready()
        self.assertEqual(self.states["image.service"], "active")
        self.assertEqual(json.loads(self.lock.read_text())["status"], "uncertain")

    def test_policy_validation_prevents_unknown_fields_nonfinite_values_and_remote_readiness(self):
        original = copy.deepcopy(self.policy)
        mutations = [lambda p: p.update(extra=True), lambda p: p.update(schemaVersion=True),
                     lambda p: p.update(waitSeconds=float("nan")), lambda p: p.update(minAvailableMiB=True),
                     lambda p: p.update(lockPath="relative"), lambda p: p["services"].append(p["services"][0]),
                     lambda p: p["services"][0].update(unit="--danger.service"),
                     lambda p: p["services"][0].update(readyUrl="http://example.com/ready"),
                     lambda p: p["services"][0].update(readyUrl="http://user:password@127.0.0.1/ready")]
        for mutation in mutations:
            self.policy = copy.deepcopy(original)
            mutation(self.policy)
            self.write_policy()
            with self.assertRaises(guard.NativeLoadError):
                guard.read_policy(str(self.policy_path))
        self.assertFalse(self.actions)

    def test_policy_rejects_public_files_symlinks_and_hardlinks(self):
        self.policy_path.chmod(0o644)
        with self.assertRaises(guard.NativeLoadError):
            guard.read_policy(str(self.policy_path))
        self.policy_path.chmod(0o600)
        link = self.root / "link"
        link.symlink_to(self.policy_path)
        with self.assertRaises(OSError):
            guard.read_policy(str(link))
        link.unlink()
        os.link(self.policy_path, link)
        with self.assertRaises(guard.NativeLoadError):
            guard.read_policy(str(link))

    def test_readiness_waits_for_http_success_and_never_follows_redirects(self):
        paths = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                paths.append(self.path)
                status = 302 if self.path == "/redirect" else 503 if paths.count("/ready") == 1 else 200
                self.send_response(status)
                if status == 302:
                    self.send_header("Location", "/forbidden")
                self.end_headers()
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            peer = {"unit": "video.service", "readyUrl": f"http://127.0.0.1:{server.server_port}/ready"}
            with patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "http_proxy": "http://127.0.0.1:1", "NO_PROXY": ""}):
                REAL_WAIT_READY(peer, 1)
                self.assertEqual(paths.count("/ready"), 2)
                peer["readyUrl"] = f"http://127.0.0.1:{server.server_port}/redirect"
                with self.assertRaisesRegex(guard.NativeLoadError, "timed out"):
                    REAL_WAIT_READY(peer, .05)
                self.assertNotIn("/forbidden", paths)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_corrupt_lease_is_preserved_and_reported_as_native_admission_error(self):
        self.lock.write_text("corrupt fixture")
        self.lock.chmod(0o600)
        with self.assertRaisesRegex(guard.NativeLoadError, "unreadable"):
            with guard.native_load_guard(self.env):
                self.fail("corrupt lease admitted")
        self.assertEqual(self.lock.read_text(), "corrupt fixture")
        self.assertFalse(self.actions)

    def test_killed_loader_keeps_durable_fence(self):
        self.policy["services"] = []
        self.policy["minAvailableMiB"] = 1
        self.write_policy()
        child = subprocess.Popen([sys.executable, "-c", """
import json,sys,time
from native_load_guard import native_load_guard
with native_load_guard({'MCODA_NATIVE_LOAD_POLICY':sys.argv[1]}):
 print('OWNED',flush=True)
 time.sleep(60)
""", str(self.policy_path)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "OWNED")
            child.kill()
            child.wait(timeout=5)
            with self.assertRaises(MediaGpuRecoveryRequired):
                with media_gpu_slot("after-kill"):
                    self.fail("dead loader discarded its ownership receipt")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            child.stdout.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
