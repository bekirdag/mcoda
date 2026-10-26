import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureMediaBridgeEnvironment } from "../helpers/media-bridge-environment.js";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/mswarm/scripts");
configureMediaBridgeEnvironment(test, scripts);
const available = spawnSync("python3", ["-c", "import fcntl"], { stdio: "ignore" }).status === 0;

test("shared GPU lock excludes other processes, bounds waiting, honors cancellation and releases after errors", { skip: !available }, () => {
  const result = spawnSync("python3", ["-c", `
import os, subprocess, sys, threading
from media_gpu_lock import media_gpu_slot, MediaGpuBusy, MediaGpuCancelled
with media_gpu_slot('parent'):
    child = subprocess.run([sys.executable, '-c', '''
from media_gpu_lock import media_gpu_slot, MediaGpuBusy
try:
    with media_gpu_slot('child'): raise AssertionError('concurrent GPU admission')
except MediaGpuBusy: pass
'''], env={**os.environ, 'MCODA_MEDIA_GPU_WAIT_SECONDS':'0.05'}, timeout=3)
    assert child.returncode == 0
cancel = threading.Event(); cancel.set()
try:
    with media_gpu_slot('cancelled', cancelled=cancel): raise AssertionError('cancelled admission')
except MediaGpuCancelled: pass
try:
    with media_gpu_slot('failure'): raise ValueError('fixture')
except ValueError: pass
with media_gpu_slot('next'): pass
`], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("shared GPU lock rejects symlinks, hard links, public files and nonfinite wait limits", { skip: !available }, () => {
  const result = spawnSync("python3", ["-c", `
import os, pathlib, tempfile
from media_gpu_lock import media_gpu_slot, MediaGpuError
with tempfile.TemporaryDirectory() as directory:
    root=pathlib.Path(directory); target=root/'private'; target.write_text('sentinel'); target.chmod(0o600)
    for mode in ('symlink','hardlink','public'):
        lock=root/mode
        if mode=='symlink': lock.symlink_to(target)
        elif mode=='hardlink': os.link(target,lock)
        else: lock.write_text(''); lock.chmod(0o644)
        os.environ['MCODA_MEDIA_GPU_LOCK_PATH']=str(lock)
        try:
            with media_gpu_slot(mode): raise AssertionError('unsafe lock admitted')
        except MediaGpuError: pass
        lock.unlink()
    assert target.read_text()=='sentinel'
    os.environ['MCODA_MEDIA_GPU_LOCK_PATH']=str(root/'valid')
    for value in ('nan','inf','-1','nonnumeric'):
        os.environ['MCODA_MEDIA_GPU_WAIT_SECONDS']=value
        try:
            with media_gpu_slot('invalid'): raise AssertionError('invalid wait limit admitted')
        except MediaGpuError: pass
`], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
