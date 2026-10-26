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

test("killed media owners remain fenced until matching native completion is proved", { skip: !available }, () => {
  const result = spawnSync("python3", ["-c", `
import json, os, pathlib, subprocess, sys, tempfile
from media_gpu_lock import media_gpu_slot, reconcile_media_gpu_slot, MediaGpuRecoveryRequired, MediaGpuBusy
with tempfile.TemporaryDirectory() as directory:
    lock=pathlib.Path(directory)/'gpu.lock'
    os.environ['MCODA_MEDIA_GPU_LOCK_PATH']=str(lock)
    child=subprocess.Popen([sys.executable,'-c', '''
import time
from media_gpu_lock import media_gpu_slot
with media_gpu_slot('video') as lease:
    lease.record_native_job('job-fixture')
    print(lease.record['id'],flush=True)
    time.sleep(60)
'''],stdout=subprocess.PIPE,text=True)
    try:
        identifier=child.stdout.readline().strip()
        assert identifier
        try:
            reconcile_media_gpu_slot(identifier, lambda record: True)
            raise AssertionError('live worker lease cleared')
        except MediaGpuBusy: pass
        child.kill(); child.wait(timeout=3)
        original=lock.read_bytes()
        assert json.loads(original)['native_job_id']=='job-fixture'
        try:
            with media_gpu_slot('next'): raise AssertionError('killed owner treated as completed')
        except MediaGpuRecoveryRequired: pass
        assert not reconcile_media_gpu_slot('stale-id', lambda record: (_ for _ in ()).throw(AssertionError('stale probe called')))
        assert not reconcile_media_gpu_slot(identifier, lambda record: False)
        assert lock.read_bytes()==original
        assert reconcile_media_gpu_slot(identifier, lambda record: record['native_job_id']=='job-fixture')
        with media_gpu_slot('next'): pass
        assert lock.read_bytes()==b''
    finally:
        if child.poll() is None: child.kill(); child.wait(timeout=3)
`], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("uncertain outcomes and corrupt media leases never silently expire or cross a receipt fence", { skip: !available }, () => {
  const result = spawnSync("python3", ["-c", `
import os, pathlib, tempfile
from media_gpu_lock import media_gpu_slot, reconcile_media_gpu_slot, MediaGpuRecoveryRequired, MediaGpuError
with tempfile.TemporaryDirectory() as directory:
    lock=pathlib.Path(directory)/'gpu.lock'; os.environ['MCODA_MEDIA_GPU_LOCK_PATH']=str(lock)
    with media_gpu_slot('image') as lease:
        old_id=lease.record['id']; lease.mark_uncertain('transport_lost')
    try:
        lease.confirm_finished(); raise AssertionError('closed lease reused')
    except MediaGpuError: pass
    try:
        with media_gpu_slot('next'): raise AssertionError('uncertain native job overlapped')
    except MediaGpuRecoveryRequired: pass
    assert reconcile_media_gpu_slot(old_id, lambda record: True)
    with media_gpu_slot('new') as newer:
        new_id=newer.record['id']; newer.mark_uncertain('new_job_pending')
    assert new_id!=old_id
    assert not reconcile_media_gpu_slot(old_id, lambda record: True)
    assert reconcile_media_gpu_slot(new_id, lambda record: True)
    with media_gpu_slot('confirmed') as confirmed:
        confirmed.mark_uncertain('pending'); confirmed.confirm_finished()
    assert lock.read_bytes()==b''
    lock.write_text('{torn')
    try:
        with media_gpu_slot('corrupt'): raise AssertionError('corrupt state overwritten')
    except MediaGpuRecoveryRequired: pass
    assert lock.read_text()=='{torn'
`], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("image transport loss quarantines admission and video completion must match the native job", { skip: !available }, () => {
  const result = spawnSync("python3", ["-c", `
import importlib.util, json, os, pathlib, sys, tempfile, threading
from types import SimpleNamespace
from media_gpu_lock import media_gpu_slot, MediaGpuRecoveryRequired
def load(name, filename):
    spec=importlib.util.spec_from_file_location(name, pathlib.Path(sys.argv[1])/filename)
    module=importlib.util.module_from_spec(spec); sys.modules[name]=module; spec.loader.exec_module(module); return module
image=load('image_bridge_fixture','stable-diffusion-cpp-openai-server.py')
video=load('video_bridge_fixture','wan22-openai-server.py')
with tempfile.TemporaryDirectory() as directory:
    lock=pathlib.Path(directory)/'gpu.lock'; os.environ['MCODA_MEDIA_GPU_LOCK_PATH']=str(lock)
    def disconnected(*args): raise image.UpstreamTransportError('fixture disconnect')
    image._generate_image_locked=disconnected
    try:
        image._generate_image(SimpleNamespace(shutdown_requested=threading.Event()), {})
        raise AssertionError('disconnected render succeeded')
    except image.UpstreamTransportError: pass
    assert json.loads(lock.read_text())['status']=='uncertain'
    try:
        with media_gpu_slot('new-video'): raise AssertionError('uncertain image overlapped')
    except MediaGpuRecoveryRequired: pass
    responses=iter([(200,{'id':'other-job','status':'completed'}),(200,{'id':'our-job','status':'generating'}),(200,{'id':'our-job','status':'completed'})])
    seen=[]
    def poll(*args,**kwargs):
        response=next(responses); seen.append(response); return response
    video._bounded_json_request=poll; video.time.sleep=lambda seconds: None
    video._wait_for_native_job_end(SimpleNamespace(upstream_base_url='http://127.0.0.1:1',max_output_bytes=1024,request_timeout_seconds=1,poll_interval_seconds=0.1),'our-job')
    assert len(seen)==3
` , scripts], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
