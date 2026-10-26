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
    responses=iter([(404,{}),(200,{'id':'other-job','status':'completed'}),(200,{'id':'our-job','status':'generating'}),(200,{'id':'our-job','status':'completed'})])
    seen=[]
    def poll(*args,**kwargs):
        response=next(responses); seen.append(response); return response
    video._bounded_json_request=poll; video.time.sleep=lambda seconds: None
    video._wait_for_native_job_end(SimpleNamespace(upstream_base_url='http://127.0.0.1:1',max_output_bytes=1024,request_timeout_seconds=1,poll_interval_seconds=0.1),'our-job')
    assert len(seen)==4
` , scripts], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("native audio ownership records process identity and retains the fence after lost waits or surviving groups", { skip: !available || process.platform !== "linux" }, () => {
  const result = spawnSync("python3", ["-c", `
import importlib.util, json, os, pathlib, signal, subprocess, sys, tempfile
from media_gpu_lock import media_gpu_slot, reconcile_media_gpu_slot, MediaGpuRecoveryRequired
spec=importlib.util.spec_from_file_location('audio_lease_fixture', pathlib.Path(sys.argv[1])/'stable-audio-3-openai-server.py')
audio=importlib.util.module_from_spec(spec); sys.modules[spec.name]=audio; spec.loader.exec_module(audio)
real_popen=subprocess.Popen; real_killpg=os.killpg
with tempfile.TemporaryDirectory() as directory:
    root=pathlib.Path(directory); lock=root/'gpu.lock'; os.environ['MCODA_MEDIA_GPU_LOCK_PATH']=str(lock)
    entry=root/'native.py'
    entry.write_text("import sys,time,wave\\nfrom pathlib import Path\\ntime.sleep(0.1)\\np=Path(sys.argv[sys.argv.index('--out')+1])\\nwith wave.open(str(p),'wb') as w:\\n w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100); w.writeframes(bytes(44100*4))\\n")
    backend=audio.SubprocessBackend.__new__(audio.SubprocessBackend)
    backend.python=pathlib.Path(sys.executable); backend.entrypoint=entry; backend.runtime_root=root
    backend.dit='fixture'; backend.decoder='fixture'; backend.precision=None; backend.models_dir=None
    backend.timeout_seconds=2; backend.max_output_bytes=1048576
    # Real successful child proves the ordinary path still releases the lease.
    wav, metadata=backend.generate('fixture',seconds=1,steps=1,seed=2)
    assert wav[:4]==b'RIFF' and metadata['seed']==2 and lock.read_bytes()==b''
    for mode in ('lost_wait','surviving_group'):
        children=[]
        def launch(*args,**kwargs):
            child=real_popen(*args,**kwargs); children.append(child)
            if mode=='lost_wait':
                original_wait=child.wait
                def lost_wait(*args,**kwargs): raise RuntimeError('fixture wait observation lost')
                child.wait=lost_wait
                child.original_wait=original_wait
            return child
        def group_probe(pid,sig):
            if mode=='surviving_group' and sig==0: return
            return real_killpg(pid,sig)
        subprocess.Popen=launch; os.killpg=group_probe
        try:
            try:
                backend.generate('fixture',seconds=1,steps=1,seed=2)
                raise AssertionError('uncertain child reported finished')
            except RuntimeError as error:
                assert 'observation lost' in str(error) or isinstance(error,MediaGpuRecoveryRequired)
            receipt=json.loads(lock.read_text()); identity=receipt['native_process']
            assert receipt['status']=='uncertain' and identity['pid']==children[0].pid
            assert identity['process_group']==children[0].pid and identity['start_ticks']>0
            assert identity['boot_id']==pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            try:
                with media_gpu_slot('image'): raise AssertionError('audio uncertainty allowed overlap')
            except MediaGpuRecoveryRequired: pass
        finally:
            subprocess.Popen=real_popen; os.killpg=real_killpg
            for child in children:
                if child.poll() is None:
                    try: real_killpg(child.pid,signal.SIGKILL)
                    except ProcessLookupError: pass
                getattr(child,'original_wait',child.wait)(timeout=3)
        assert reconcile_media_gpu_slot(receipt['id'], lambda current: current['native_process']==identity and children[0].poll() is not None)
    # Failed exec never admitted native work, so it may release its own lease.
    backend.python=root/'missing-python'
    try: backend.generate('fixture',seconds=1,steps=1,seed=2); raise AssertionError('missing executable succeeded')
    except FileNotFoundError: pass
    assert lock.read_bytes()==b''
`, scripts], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("all media health endpoints expose shared quarantine without clearing or disclosing the lease", { skip: !available }, () => {
  const result = spawnSync("python3", ["-c", `
import importlib.util, json, os, pathlib, socket, sys, tempfile, threading, urllib.request, urllib.error
from types import SimpleNamespace
from media_gpu_lock import media_gpu_health, media_gpu_slot
def reject_reverse_dns(*args, **kwargs):
    raise AssertionError('health server must not perform reverse DNS')
socket.getfqdn=reject_reverse_dns
with tempfile.TemporaryDirectory() as directory:
    lock=pathlib.Path(directory)/'gpu.lock'; os.environ['MCODA_MEDIA_GPU_LOCK_PATH']=str(lock)
    servers=[]; threads=[]
    try:
        for name,filename in [('image','stable-diffusion-cpp-openai-server.py'),('audio','stable-audio-3-openai-server.py'),('video','wan22-openai-server.py')]:
            spec=importlib.util.spec_from_file_location('health_'+name,pathlib.Path(sys.argv[1])/filename)
            module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module)
            module._check_upstream_model=lambda state: None
            module._check_upstream_ready=lambda state: None
            state=SimpleNamespace(model_id=name,upstream_model_id='fixture',fatal_error=threading.Event(),backend_name='fixture',dit='fixture',decoder='fixture')
            server_class=getattr(module,{'image':'ImageHttpServer','audio':'AudioHttpServer','video':'VideoHttpServer'}[name])
            server=server_class(('127.0.0.1',0),module._handler_for(state)); servers.append(server)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();threads.append(thread)
        def check(expected_status,expected_gpu):
            for server in servers:
                try: response=urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/healthz',timeout=2)
                except urllib.error.HTTPError as error: response=error
                with response:
                    payload=json.load(response);assert response.status==expected_status,(response.status,payload)
                    assert payload['media_gpu']==expected_gpu
                    assert not any(key in payload for key in ('id','pid','native_job_id','native_process'))
        assert media_gpu_health()=='ready';check(200,'ready')
        with media_gpu_slot('video') as lease:
            assert media_gpu_health()=='busy';check(200,'busy');lease.record_native_job('private-native-job');lease.mark_uncertain('lost')
        original=lock.read_bytes();check(503,'recovery_required');assert lock.read_bytes()==original
        lock.write_text('{partial');check(503,'recovery_required');assert lock.read_text()=='{partial'
        lock.chmod(0o644);check(503,'unavailable');assert lock.read_text()=='{partial'
    finally:
        for server in servers:server.shutdown();server.server_close()
        for thread in threads:thread.join(timeout=2)
`, scripts], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
