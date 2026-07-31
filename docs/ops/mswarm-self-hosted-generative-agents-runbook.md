# mswarm Self-Hosted Image, Audio, and Video Agent Runbook

Date: 2026-07-31

This runbook covers non-text OpenAI-compatible runners exposed through an
outbound `@mcoda/mswarm` self-hosted node. Commands that operate the model or
service manager are intended for the owner of `sukunahikona`; this document does
not deploy anything or require a public listener on that host.

## Identifier and Routing Contract

Keep the local upstream model separate from the public mswarm model:

| Field | Image value | Meaning |
| --- | --- | --- |
| Local mcoda slug | `sd3.5-large-q4` | Source agent discovered by the node; matches the host's existing node allowlist |
| `defaultModel` / `--model` | `sd-cpp-local` | Model sent to the loopback `sd-server` |
| `publicModelId` | `mcoda-sukunahikona-sd3-5-large-q4` | Model requested through mswarm |
| Synced mcoda agent slug | `mswarm-self-hosted-mcoda-sukunahikona-sd3-5-large-q4` | Managed agent used by an off-box mcoda client |

The relay rewrites the public request to the local upstream model. Do not put
the public model id in `--model`; `sd-server` reports and expects
`sd-cpp-local`.

Self-hosted discovery is heartbeat/catalog based. Use both
`mcoda self-hosted agent list` for managed-agent materialization and
authenticated `GET /v1/swarm/self-hosted/openai/models` for the OpenAI-shaped
published inventory.

## Register the Existing SD 3.5 Server

Preconditions:

- Native `sd-server` listens only on `http://127.0.0.1:11445`.
- The packaged image bridge listens only on `http://127.0.0.1:11449` and uses
  11445 as its fixed upstream origin.
- Both `GET /v1/models` endpoints report `sd-cpp-local`.
- The bridge's `POST /v1/images/generations` returns
  `{"data":[{"b64_json":"..."}]}` for `response_format: "b64_json"`.
- The mswarm node uses discovery mode `mcoda` and server name
  `sukunahikona`.

Register the source agent:

```bash
mcoda agent add sd3.5-large-q4 \
  --adapter openai-compatible-local \
  --model sd-cpp-local \
  --openai-compatible true \
  --supports-tools false \
  --best-usage image_generation \
  --cost-per-million 0 \
  --capability image_generation \
  --config-base-url http://127.0.0.1:11449 \
  --config-runner-kind custom \
  --config-auth-mode none \
  --config-health-path /healthz \
  --config-models-path /v1/models \
  --config-public-model-id mcoda-sukunahikona-sd3-5-large-q4 \
  --config-input-modality text \
  --config-output-modality image \
  --config-operation '{"operation":"images.generations","path":"/v1/images/generations","requestParameterAllowlist":["model","prompt","n","size","response_format","seed","steps","negative_prompt"],"responseFormats":["b64_json"],"outputMimeTypes":["image/png"],"limits":{"maxRequestBytes":131072,"maxOutputBytes":67108864,"maxPromptChars":8192,"maxNegativePromptChars":8192,"maxN":1,"minWidth":64,"maxWidth":2048,"minHeight":64,"maxHeight":2048,"maxPixels":4194304,"maxSteps":100}}'
```

If the slug already exists, use `mcoda agent update sd3.5-large-q4` with the
same declaration flags instead of `add`.

The dedicated bridge makes `seed`, `steps`, and `negative_prompt` effective
even though this `sd-server` build ignores those fields at the top level. It
rejects a reserved `<sd_cpp_extra_args>` tag in either text field, serializes
only those three validated controls into a new native extension, and maps
`response_format: b64_json` to upstream `output_format: png`. It also verifies
the native model catalog and PNG structure before returning data.

Use runner kind `custom` for this registration. The legacy node-side
`stable-diffusion-cpp` dialect would append the reserved tag before the request
reaches the bridge, and the bridge correctly rejects preconstructed tags. Keep
the legacy dialect only as a rollback path for a direct 11445 registration.

Install the wrapper from the installed `@mcoda/mswarm` package and record its
package version and SHA-256 in the deployment evidence:

```bash
MSWARM_PACKAGE_ROOT="$(npm root -g)/@mcoda/mswarm"
install -d -m 0755 /home/wodo/.local/libexec/mcoda
install -m 0755 \
  "$MSWARM_PACKAGE_ROOT/scripts/stable-diffusion-cpp-openai-server.py" \
  /home/wodo/.local/libexec/mcoda/stable-diffusion-cpp-openai-server.py
npm list -g @mcoda/mswarm --depth=0
sha256sum /home/wodo/.local/libexec/mcoda/stable-diffusion-cpp-openai-server.py
```

Persist it separately from the native GPU service:

```ini
# ~/.config/systemd/user/mcoda-sd3.5-image.service
[Unit]
Description=mcoda SD 3.5 OpenAI-compatible image bridge
After=sd35-q4-server.service
Wants=sd35-q4-server.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /home/wodo/.local/libexec/mcoda/stable-diffusion-cpp-openai-server.py --host 127.0.0.1 --port 11449 --upstream-base-url http://127.0.0.1:11445 --model-id sd-cpp-local --upstream-model-id sd-cpp-local --max-request-bytes 131072 --max-output-bytes 67108864 --max-prompt-chars 8192 --max-negative-prompt-chars 8192 --min-width 64 --max-width 2048 --min-height 64 --max-height 2048 --max-pixels 4194304 --default-size 768x768 --default-steps 20 --max-steps 100 --client-read-timeout-seconds 10 --max-handler-threads 8 --request-timeout-seconds 5 --inference-timeout-seconds 900
Restart=on-failure
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=30
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
IPAddressDeny=any
IPAddressAllow=localhost

[Install]
WantedBy=default.target
```

`Wants`, rather than `Requires`, keeps the bridge eligible for its own restart
policy if the native service is restarted. The startup preflight fails closed
until native `/v1/models` reports exactly the configured upstream model. The
upstream HTTP client ignores all proxy environment variables and refuses every
3xx response; it can only call the configured loopback origin and fixed model
and generation paths.

The bridge accepts at most eight concurrent handler threads and uses an
eight-connection kernel listen backlog. Every accepted socket receives a
ten-second I/O timeout before HTTP headers or a body are read. A partial JSON
body that reaches that timeout gets canonical 408 `request_timeout` when the
client can still receive it. Once all eight handler slots are occupied, the
accept loop sends canonical 503 `server_busy` and closes the connection without
creating another thread or parsing its request. These controls are independent
of the single inference semaphore: a second valid generation still gets 429
`local_concurrency_saturated` while one GPU generation is active.

`--inference-timeout-seconds` is the client-facing response deadline, not a
claim that closing an HTTP socket cancels CUDA work. If that deadline expires,
the bridge returns 504 but a single background transport continues waiting for
the native response and retains the inference slot. Later generations receive
429 until native completion is known; the slot is released only then. If the
native server never replies, the bridge stays fail-closed until an operator
restarts the native service and bridge.

## Image Readiness Checks

Run these on `sukunahikona`:

```bash
curl -fsS http://127.0.0.1:11445/v1/models
curl -fsS http://127.0.0.1:11449/healthz
curl -fsS http://127.0.0.1:11449/v1/models

IMAGE_SMOKE_JSON="$(mktemp)"
curl -fsS http://127.0.0.1:11449/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"model":"sd-cpp-local","prompt":"readiness check: a blue circle","negative_prompt":"text, watermark","n":1,"size":"768x768","response_format":"b64_json","seed":43,"steps":20}' \
  > "$IMAGE_SMOKE_JSON"
python3 - "$IMAGE_SMOKE_JSON" <<'PY'
import base64, json, pathlib, sys
payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
image = base64.b64decode(payload["data"][0]["b64_json"], validate=True)
assert image.startswith(b"\x89PNG\r\n\x1a\n")
print({"png_bytes": len(image), "created": payload["created"]})
PY
rm -f "$IMAGE_SMOKE_JSON"

mcoda agent details sd3.5-large-q4 --json
mswarm node restart
mswarm node health
mswarm node doctor
mcoda self-hosted agent list --provider mcoda --include-unreachable --json
mcoda self-hosted agent sync --provider mcoda --json
```

From a different machine with an authorized owner key, exercise the actual
outbound relay rather than an SSH tunnel:

```bash
OFFBOX_IMAGE_JSON="$(mktemp)"
curl -fsS https://api.mswarm.org/v1/swarm/self-hosted/openai/images/generations \
  -H "Authorization: Bearer $MSWARM_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"mcoda-sukunahikona-sd3-5-large-q4","prompt":"off-box readiness: a blue circle","negative_prompt":"text, watermark","n":1,"size":"768x768","response_format":"b64_json","seed":44,"steps":20}' \
  > "$OFFBOX_IMAGE_JSON"
python3 - "$OFFBOX_IMAGE_JSON" <<'PY'
import base64, json, pathlib, sys
payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
image = base64.b64decode(payload["data"][0]["b64_json"], validate=True)
assert image.startswith(b"\x89PNG\r\n\x1a\n")
print({"offbox_png_bytes": len(image), "created": payload["created"]})
PY
rm -f "$OFFBOX_IMAGE_JSON"
```

Confirm that the catalog entry advertises:

- public model `mcoda-sukunahikona-sd3-5-large-q4`;
- input modality `text` and output modality `image`;
- operation `images.generations` at `/v1/images/generations`;
- response format `b64_json`;
- the request allowlist and limits from the registration command.

After sync, confirm the managed slug is
`mswarm-self-hosted-mcoda-sukunahikona-sd3-5-large-q4`.

Rollback does not touch the native model service. While the bridge is still
available, first restore the source-agent base URL to 11445, health path to
`/v1/models`, and runner kind to `stable-diffusion-cpp`; restart the mswarm node,
sync the managed catalog, and verify one off-box fallback generation. Only then
stop and disable `mcoda-sd3.5-image.service`. To roll forward, start the bridge,
verify its local smoke, restore the 11449/custom declaration, restart and sync
the node, verify the off-box route, and only then retire the fallback state.

## Stable Audio 3 HTTP Wrapper Contract

The TensorRT/CUDA-graph Stable Audio 3 deployment must add a small HTTP wrapper;
the Gradio UI and CLI are not relay targets. Bind the wrapper to loopback and
implement the following surface.

### Discovery and readiness

```text
GET /healthz
GET /v1/models
```

The shipped wrapper checks the canonical CLI, tokenizer, and the exact non-empty
TensorRT engine files before it starts listening. `/healthz` reports that
startup readiness; a real bounded generation remains the GPU readiness gate.
`/v1/models` exposes one stable upstream id, `stable-audio-3-local`.

The wrapper intentionally launches the canonical `sa3` CLI in a fresh child for
every request. Upstream documents that the SAME-S/SAME-L decoder workspace
drifts after the first inference in one process; reusing a resident
`SA3Inference` instance is therefore not production-safe. Concurrency remains
one and the parent HTTP listener stays resident.

### Generation request

```http
POST /v1/audio/generations
Content-Type: application/json
```

```json
{
  "model": "stable-audio-3-local",
  "prompt": "Warm analog synth pads with a slow cinematic pulse",
  "duration_seconds": 30,
  "response_format": "wav",
  "n": 1,
  "seed": 43,
  "steps": 8
}
```

Required fields are `model`, a non-empty `prompt`, and a positive
`duration_seconds`. The initial TensorRT profile is deliberately narrow:
`response_format` defaults to and must equal `wav`, `n` must equal `1`, output
is fixed at signed 16-bit stereo PCM at 44,100 Hz, duration is 3–120 seconds,
and steps are 1–32. `seed` and `steps` are optional and effective. Unknown
parameters, including `negative_prompt` and `sample_rate`, are rejected rather
than ignored. A future wrapper may advertise more formats only after it
actually implements and tests them.

### Generation response

Return HTTP 200 with base64 audio in `data[].b64_audio`:

```json
{
  "created": 1785484800,
  "model": "stable-audio-3-local",
  "data": [
    {
      "b64_audio": "<base64 audio bytes>",
      "mime_type": "audio/wav",
      "duration_seconds": 30,
      "sample_rate": 44100,
      "seed": 43
    }
  ]
}
```

The wrapper response includes its stable local `model` id. The public proxy
rewrites that field to the requested public model id. The codec and MIME type
must agree. `duration_seconds`, `sample_rate`, and the effective `seed` are
recommended per-output metadata:

| `response_format` | `mime_type` |
| --- | --- |
| `wav` | `audio/wav` |

Do not return filesystem paths or URLs. Use an OpenAI-shaped error envelope and
an appropriate status: 400 for validation, 413 for size limits, 429 for local
concurrency saturation, and 500 for inference or encoding failure.

```json
{
  "error": {
    "message": "duration_seconds exceeds the configured limit",
    "type": "invalid_request_error",
    "param": "duration_seconds",
    "code": "duration_limit_exceeded"
  }
}
```

### Audio agent declaration

After the wrapper is deployed, register it with an owner-chosen loopback port.
This example uses `11446`; the port is not part of the public contract:

```bash
mcoda agent add stable-audio-3 \
  --adapter openai-compatible-local \
  --model stable-audio-3-local \
  --openai-compatible true \
  --supports-tools false \
  --best-usage audio_generation \
  --cost-per-million 0 \
  --capability audio_generation \
  --config-base-url http://127.0.0.1:11446 \
  --config-runner-kind custom \
  --config-auth-mode none \
  --config-health-path /healthz \
  --config-models-path /v1/models \
  --config-public-model-id mcoda-sukunahikona-stable-audio-3 \
  --config-input-modality text \
  --config-output-modality audio \
  --config-operation '{"operation":"audio.generations","path":"/v1/audio/generations","requestParameterAllowlist":["model","prompt","duration_seconds","response_format","n","seed","steps"],"responseFormats":["wav"],"outputMimeTypes":["audio/wav"],"limits":{"maxRequestBytes":131072,"maxOutputBytes":67108864,"maxPromptChars":8192,"maxN":1,"minDurationSeconds":3,"maxDurationSeconds":120,"maxSteps":32}}'
```

Expected identifiers:

- public model: `mcoda-sukunahikona-stable-audio-3`;
- synced agent:
  `mswarm-self-hosted-mcoda-sukunahikona-stable-audio-3`.

### Pinned TensorRT deployment profile

The production profile for `sukunahikona` is:

- upstream source `Stability-AI/stable-audio-3` at commit
  `52f530458733f1bed2ff699d4f5d24c1a8a27bee`;
- optimized artifacts revision
  `f8e0a0f789157d1ac629b24b5d2672a115660509`;
- `sm-music` DiT, `same-s` decoder, `fp16mixed` precision;
- locally built `sm_86` engines for one RTX 3090;
- PyTorch `2.7.1` with CUDA 12.6, Triton `3.3.1`, and
  `tensorrt-cu12==10.15.1.29`.

Do not run upstream `install.sh` unchanged on this host. The unqualified
TensorRT package now resolves a CUDA 13 build that requires a newer driver.
Create the Python 3.10 environment with `uv`, choose the `cu126` PyTorch
backend, and install the CUDA-12 TensorRT package explicitly:

```bash
uv venv --python 3.10 .venv
uv pip install --python .venv/bin/python --torch-backend cu126 \
  'torch==2.7.1' 'triton==3.3.1'
uv pip install --python .venv/bin/python \
  'tensorrt-cu12==10.15.1.29' numpy tokenizers huggingface-hub nvidia-ml-py
```

The `sm-music`/SAME-S profile is the coexistence choice for this dual-3090
host: it needs about 8 GiB, while `medium`/SAME-L needs about 14 GiB and cannot
coexist with the current qwen3.6 allocation. GPU1 still needs the qwen3-4B
workload disabled or moved before audio is enabled. The published engines do
not include `sm_86`, so build from the pinned ONNX artifacts during a
maintenance window on the designated, drained GPU:

```bash
export CUDA_VISIBLE_DEVICES=1
cd /mnt/githubActions/piriatlas/tools/stable-audio-3/optimized/tensorRT/build
../.venv/bin/python build_from_onnx.py t5gemma
../.venv/bin/python build_from_onnx.py same-s-decoder
../.venv/bin/python build_from_onnx.py sa3-sm-music
```

Record SHA-256 checksums for the pinned ONNX inputs and generated engines.
The build helper follows the artifact repository's default branch unless its
download calls are pinned; do not call a moving revision in a production
build.

The source code and optimized model artifacts have different licenses. Before
enabling hosted production use, the operator must document compliance with the
Stability AI Community License, Gemma terms, acceptable-use policy, applicable
registration or enterprise-license requirement, attribution, and notices.
Public download availability is not a substitute for that approval.

## Wan 2.2 A14B Video Contract and Deployment

Wan 2.2 T2V A14B is a two-expert model set, not one 14B GGUF. A working
deployment requires matching LowNoise and HighNoise expert files, the Wan 2.1
VAE, and UMT5 XXL. The local stable-diffusion.cpp server exposes an asynchronous
native API, so it is not itself the mcoda runner endpoint. Install
`scripts/wan22-openai-server.py` as a loopback bridge that submits and polls the
native job while presenting this synchronous contract:

```http
POST /v1/videos/generations
Content-Type: application/json
```

```json
{
  "model": "wan2.2-t2v-a14b-q4-k-m-local",
  "prompt": "A red fox crossing a snowy clearing, cinematic tracking shot",
  "negative_prompt": "text, watermark, distorted anatomy",
  "size": "832x480",
  "duration_seconds": 2.0625,
  "fps": 16,
  "response_format": "webm",
  "n": 1,
  "seed": 43,
  "steps": 10,
  "high_noise_steps": 8
}
```

The initial production profile permits one `832x480` output, 9–33 effective
frames, 8–24 FPS, WebM only, and at most 30 steps in each noise stage. A caller
may send either `duration_seconds` or `video_frames`, not both. Wan normalizes
the actual frame count down to `4n+1`, so the bridge returns the effective
duration and frame count:

```json
{
  "created": 1785500000,
  "model": "wan2.2-t2v-a14b-q4-k-m-local",
  "data": [
    {
      "b64_video": "<base64 WebM bytes>",
      "mime_type": "video/webm",
      "response_format": "webm",
      "fps": 16,
      "frame_count": 33,
      "duration_seconds": 2.0625,
      "seed": 43
    }
  ]
}
```

The 33-frame ceiling is a conservative measured production limit, not an
unverified model maximum. A live bridge smoke produced VP8 WebM at 832x480 and
16 FPS with 33 frames, reported 2.0625 seconds (2.0 seconds by `ffprobe`), took
1,945 seconds, and reached a bridge-cgroup peak of 30,748,246,016 bytes. Keep
33 as both the default and maximum until a larger profile has equivalent
capacity evidence.

The bridge rejects unknown fields, client-selected paths or URLs, concurrent
generation, invalid base64/container signatures, oversized responses, and
upstream capability drift. On timeout or service shutdown it cancels the
native sd.cpp job.

### Pinned model set

Use these immutable revisions and verify every SHA-256 before enabling the
service:

| Artifact | Revision | SHA-256 |
| --- | --- | --- |
| `HighNoise/Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf` | `QuantStack/Wan2.2-T2V-A14B-GGUF@73eafba53a1a8f29254e4c77f92e74ea27d7cd6f` | `e0c490c6e316fd91ff52034e4ca66b825717e33ff11624585c0ccfcb5d410c59` |
| `LowNoise/Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf` | same | `091a5bae02e14aa016bc9b10a7892efda4c629346b81c5dcebbe30ea2ac8923a` |
| `VAE/Wan2.1_VAE.safetensors` | same | `2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b` |
| `umt5-xxl-encoder-Q4_K_M.gguf` | `city96/umt5-xxl-encoder-gguf@b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7` | `17cf97a5bbbc60a646d6105b832b6f657ce904a8a1ad970e4b59df0c67584a40` |

The complete Q4_K_M set is about 23.2 GB. Both repositories identify the
weights as Apache-2.0. Keep a copy of the licenses and model cards beside the
deployment manifest.

The existing SD3.5 build was compiled without WebM. Build a parallel tree so
rollback does not disturb the image service:

```bash
/home/wodo/.local/bin/cmake \
  -S /mnt/githubActions/piriatlas/tools/stable-diffusion.cpp \
  -B /mnt/githubActions/piriatlas/tools/stable-diffusion.cpp/build-cuda-webm \
  -G Ninja \
  -DCMAKE_MAKE_PROGRAM=/home/wodo/.local/bin/ninja \
  -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CUDA_ARCHITECTURES=86 \
  -DSD_CUDA=ON \
  -DSD_WEBP=ON \
  -DSD_WEBM=ON
/home/wodo/.local/bin/cmake \
  --build /mnt/githubActions/piriatlas/tools/stable-diffusion.cpp/build-cuda-webm \
  --target sd-server sd-cli --parallel 8
```

Use physical GPU 1 for Wan and retain CPU parameter backing with a 14 GiB
device ceiling. Keep text encoding and VAE compute on CPU while diffusion runs
on GPU. A live shared-RTX3090 smoke test reached about 24.1 GiB during GPU VAE
decode despite the diffusion VRAM ceiling; CPU VAE avoids that decode-time OOM.
With CPU VAE, native `--vae-tiling` reduced the verified nine-frame process peak
from 49.3 GB to 43.9 GB, so keep tiling enabled.
The native listener is private implementation detail on 11447; the OpenAI-shaped
bridge listens on 11448:

```ini
# ~/.config/systemd/user/mcoda-wan2.2-video-native.service
[Unit]
Description=mcoda Wan 2.2 A14B stable-diffusion.cpp video server
After=network-online.target
Wants=network-online.target
RequiresMountsFor=/mnt/githubActions/piriatlas

[Service]
Type=simple
Environment=CUDA_VISIBLE_DEVICES=1
Environment=WAIT_NVIDIA_EXPECTED_GPUS=1
WorkingDirectory=/mnt/githubActions/piriatlas/tools/stable-diffusion.cpp
ExecStartPre=/home/wodo/.local/bin/wait-nvidia-ready
ExecStart=/mnt/githubActions/piriatlas/tools/stable-diffusion.cpp/build-cuda-webm/bin/sd-server --listen-ip 127.0.0.1 --listen-port 11447 --diffusion-model /mnt/githubActions/piriatlas/models/stable-diffusion.cpp/wan2.2-t2v-a14b-q4-k-m/LowNoise/Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf --high-noise-diffusion-model /mnt/githubActions/piriatlas/models/stable-diffusion.cpp/wan2.2-t2v-a14b-q4-k-m/HighNoise/Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf --vae /mnt/githubActions/piriatlas/models/stable-diffusion.cpp/wan2.2-t2v-a14b-q4-k-m/VAE/Wan2.1_VAE.safetensors --t5xxl /mnt/githubActions/piriatlas/models/stable-diffusion.cpp/wan2.2-t2v-a14b-q4-k-m/text_encoders/umt5-xxl-encoder-Q4_K_M.gguf --backend te=cpu,vae=cpu,diffusion=cuda0 --params-backend te=cpu,vae=cpu,diffusion=cpu --max-vram cuda0=14 --stream-layers --diffusion-fa --vae-tiling --vae-conv-direct
Restart=on-failure
RestartSec=5
TimeoutStartSec=300
TimeoutStopSec=60
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
IPAddressDeny=any
IPAddressAllow=localhost

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/mcoda-wan2.2-video.service
[Unit]
Description=mcoda Wan 2.2 OpenAI-compatible video bridge
After=mcoda-wan2.2-video-native.service
Wants=mcoda-wan2.2-video-native.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /home/wodo/.local/libexec/mcoda/wan22-openai-server.py --host 127.0.0.1 --port 11448 --upstream-base-url http://127.0.0.1:11447 --model-id wan2.2-t2v-a14b-q4-k-m-local --allowed-size 832x480 --min-video-frames 9 --max-video-frames 33 --default-video-frames 33 --min-fps 8 --max-fps 24 --default-fps 16 --default-steps 10 --max-steps 30 --default-high-noise-steps 8 --max-high-noise-steps 30 --response-format webm --max-request-bytes 131072 --max-output-bytes 67108864 --inference-timeout-seconds 3600
Restart=on-failure
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=30
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
IPAddressDeny=any
IPAddressAllow=localhost

[Install]
WantedBy=default.target
```

Register the source agent only after `/healthz` and a real WebM smoke pass:

```bash
mcoda agent add wan2.2-t2v-a14b-q4-k-m \
  --adapter openai-compatible-local \
  --model wan2.2-t2v-a14b-q4-k-m-local \
  --openai-compatible true \
  --supports-tools false \
  --best-usage video_generation \
  --cost-per-million 0 \
  --capability video_generation \
  --config-base-url http://127.0.0.1:11448 \
  --config-runner-kind stable-diffusion-cpp \
  --config-auth-mode none \
  --config-health-path /healthz \
  --config-models-path /v1/models \
  --config-public-model-id mcoda-sukunahikona-wan2-2-t2v-a14b-q4-k-m \
  --config-input-modality text \
  --config-output-modality video \
  --config-operation '{"operation":"videos.generations","path":"/v1/videos/generations","requestParameterAllowlist":["model","prompt","negative_prompt","duration_seconds","fps","video_frames","response_format","n","size","seed","steps","high_noise_steps"],"responseFormats":["webm"],"outputMimeTypes":["video/webm"],"limits":{"maxRequestBytes":131072,"maxOutputBytes":67108864,"maxPromptChars":8192,"maxNegativePromptChars":8192,"maxN":1,"minWidth":832,"maxWidth":832,"minHeight":480,"maxHeight":480,"maxPixels":399360,"maxDurationSeconds":2.0625,"defaultFps":16,"minFps":8,"maxFps":24,"minVideoFrames":9,"maxVideoFrames":33,"maxSteps":30,"maxHighNoiseSteps":30}}'
```

The public model is
`mcoda-sukunahikona-wan2-2-t2v-a14b-q4-k-m`; the synced off-box agent is
`mswarm-self-hosted-mcoda-sukunahikona-wan2-2-t2v-a14b-q4-k-m`.

Before changing qwen3.6, snapshot its unit/drop-ins and the mcoda database.
Drain the mswarm node for at least one heartbeat, then apply a reversible
drop-in that keeps the same Q4_K_M model and alias while changing context from
262,144 to 131,072, enabling `--cpu-moe`, setting
`CUDA_VISIBLE_DEVICES=0`, and using `--split-mode none --main-gpu 0`.
Benchmark qwen health and latency before removing drain mode. Removing that
single drop-in restores the original dual-GPU configuration.

Readiness is not complete until the generated base64 decodes to a valid WebM
whose frame count, dimensions, FPS, and duration are independently verified
with `ffprobe`, and the same public model succeeds through the off-box mswarm
route.

## Security and Resource Limits

- Keep both inference servers on `127.0.0.1`; outbound mswarm relay does not
  require a public inference port or SSH tunnel.
- `authMode: none` is acceptable only for a loopback listener. Require TLS and
  real bearer authentication before any non-loopback exposure.
- The current `sd-server` has no `api_keys` file, and source inspection found
  no native bearer/API-key enforcement in this server build. That is acceptable
  only while the process is loopback-only; do not reuse this configuration on
  a public or LAN listener.
- Accept JSON only, reject unknown operations and non-allowlisted parameters,
  and never accept a client-selected upstream URL or output path.
- Enforce the declared prompt, duration, dimensions, count, step, request-byte,
  and response-byte limits before allocating large GPU or base64 buffers.
- Bound client handlers, listen backlog, accepted-socket reads, inference
  concurrency, and client-visible generation time. The image bridge uses eight
  handler slots, backlog eight, a ten-second client timeout, and one inference
  slot; handler overload returns 503 and GPU saturation returns 429. A timed-out
  native request retains that inference slot until its response arrives.
- Validate base64 output size after encoding. Base64 and its JSON envelope are
  larger than the raw media.
- Do not put API keys in agent config or systemd command lines. If a wrapper
  requires a local bearer token, load it from a mode-`0600` environment file
  owned by that service.

## systemd Persistence and Hardening

The 2026-07-31 read-only host check found `mcoda-llama-qwen3.6.service` and
`sd35-q4-server.service` active and enabled as user units, with user lingering
enabled. Native SD3.5 already uses the NVIDIA readiness preflight and the
loopback-only hardening below. Its command is intentionally kept in the
launcher at `/mnt/githubActions/piriatlas/services/sd35-q4/run-sd35-q4-server.sh`
rather than duplicated in the unit.

The inspected unit now has `TimeoutStopSec=330`; that production correction was
applied without restarting the active native model process so a long CUDA
shutdown is not killed early. The lines below match the unit currently loaded
on Suku:

```ini
# ~/.config/systemd/user/sd35-q4-server.service
[Unit]
Description=SD 3.5 Large Q4 stable-diffusion.cpp server
After=network-online.target
Wants=network-online.target
RequiresMountsFor=/mnt/githubActions
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/mnt/githubActions/piriatlas/services/sd35-q4
Environment=SD35_HOST=127.0.0.1
Environment=SD35_PORT=11445
Environment=CUDA_VISIBLE_DEVICES=1
Environment=WAIT_NVIDIA_TIMEOUT_SECONDS=300
Environment=WAIT_NVIDIA_EXPECTED_GPUS=1
TimeoutStartSec=330
ExecStartPre=/home/wodo/.local/bin/wait-nvidia-ready
ExecStart=/mnt/githubActions/piriatlas/services/sd35-q4/run-sd35-q4-server.sh
Restart=on-failure
RestartSec=5
TimeoutStopSec=330
UMask=0077
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
IPAddressDeny=any
IPAddressAllow=localhost

[Install]
WantedBy=default.target
```

The inspected launcher exports `CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES:-1}`
and execs `build-cuda/bin/sd-server` with loopback port 11445, the SD3.5 Large
Q4 diffusion model, CLIP-L, CLIP-G, quantized T5XXL, and SD3 VAE under
`/mnt/githubActions/piriatlas/models/stable-diffusion.cpp/sd3.5-large-q4`.
It preserves CPU text/VAE compute, CUDA diffusion, CPU parameter backing, the
8 GiB VRAM ceiling, streaming layers, diffusion flash attention, VAE tiling,
Euler sampling, CFG 4.5, 20 steps, and 768x768 defaults. Give Stable Audio 3
its own wrapper user unit when deployed; do not fold inference processes into
the mswarm node unit.

Install `scripts/stable-audio-3-openai-server.py` from the installed
`@mcoda/mswarm` package (its canonical source is
`packages/mswarm/scripts/stable-audio-3-openai-server.py`) at
`/home/wodo/.local/libexec/mcoda/stable-audio-3-openai-server.py`, owned by
`wodo` and mode `0755`. Record the package version and wrapper SHA-256 in the
deployment evidence.

After the engine checksums and GPU assignment are approved, use this audio
unit:

```ini
# ~/.config/systemd/user/mcoda-stable-audio-3.service
[Unit]
Description=mcoda Stable Audio 3 TensorRT OpenAI-compatible server
After=network-online.target
Wants=network-online.target
RequiresMountsFor=/mnt/githubActions/piriatlas

[Service]
Type=simple
Environment=CUDA_VISIBLE_DEVICES=1
Environment=STABLE_AUDIO_3_ENGINE_ARCH=sm_86
Environment=WAIT_NVIDIA_EXPECTED_GPUS=1
Environment=WAIT_NVIDIA_TIMEOUT_SECONDS=180
Environment=WAIT_NVIDIA_INTERVAL_SECONDS=2
WorkingDirectory=/mnt/githubActions/piriatlas/tools/stable-audio-3/optimized/tensorRT
ExecStartPre=/home/wodo/.local/bin/wait-nvidia-ready
ExecStart=/usr/bin/python3 /home/wodo/.local/libexec/mcoda/stable-audio-3-openai-server.py --host 127.0.0.1 --port 11446 --runtime-root /mnt/githubActions/piriatlas/tools/stable-audio-3/optimized/tensorRT --models-dir /mnt/githubActions/piriatlas/tools/stable-audio-3/optimized/tensorRT/models --engine-arch sm_86 --dit sm-music --decoder same-s --precision fp16mixed --model-id stable-audio-3-local --max-request-bytes 131072 --max-output-bytes 67108864 --max-prompt-chars 8192 --min-duration-seconds 3 --max-duration-seconds 120 --default-steps 8 --max-steps 32 --inference-timeout-seconds 900
Restart=on-failure
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=30
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
IPAddressDeny=any
IPAddressAllow=localhost

[Install]
WantedBy=default.target
```

All model files must be present before enabling this unit because its network
sandbox intentionally prevents Hugging Face lazy downloads. A valid
`/healthz` confirms the CLI/tokenizer/engine preflight; the canonical readiness
smoke is one 3-second, 8-step, fixed-seed request followed by WAV header and
duration validation.

For each inference unit:

- use an explicit executable, model paths, working directory, and GPU
  environment;
- set `Restart=on-failure`, a bounded restart delay, startup/stop timeouts, and
  resource/file-descriptor limits;
- use the existing user-unit hardening pattern: `RestartSec=5`,
  `NoNewPrivileges=true`, `PrivateTmp=true`, `RestrictSUIDSGID=true`,
  `LockPersonality=true`, `RestrictRealtime=true`, `IPAddressDeny=any`, and
  `IPAddressAllow=localhost`;
- run through the non-root user manager with narrowly scoped writable paths;
- keep the listener on loopback and protect any environment file with `0600`;
- order the unit after required local mounts and NVIDIA services;
- make readiness test `/v1/models` plus one small real generation, not merely a
  listening TCP socket.

The mswarm daemon has its own persistent service installed by
`mswarm node install`. After inference services are enabled and ready, restart
the node so it publishes a fresh catalog. Use `systemctl --user` for the
inference units, then use `mswarm node status`, `mswarm node health`,
`mswarm node doctor`, and `mswarm node logs --lines 200` to verify the
end-to-end state.
