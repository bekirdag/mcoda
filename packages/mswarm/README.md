# @mcoda/mswarm

Owner-run mswarm node for exposing local `mcoda` agents through the mswarm self-hosted gateway.

## Install

```sh
npm install -g @mcoda/mswarm
```

## Quick Setup

```sh
mswarm node install <MSWARM_API_KEY>
```

`node install` registers the current machine, stores a local runtime token, posts the first heartbeat, pushes the discovered local `mcoda` agent inventory, and installs a persistent background daemon. It does not store the owner API key. The owner API key is only used for bootstrap.

For automation, avoid putting the key in shell history:

```sh
printf '%s' '<MSWARM_API_KEY>' | mswarm node install --api-key-stdin
```

The daemon is installed with the local OS service manager:

- macOS: user `launchd` agent at `~/Library/LaunchAgents/com.mcoda.mswarm.self-hosted-node.plist`
- Linux: user `systemd` service at `~/.config/systemd/user/mswarm-self-hosted-node.service`
- Windows: per-user Task Scheduler task `MswarmSelfHostedNode` running a PowerShell watchdog at `%USERPROFILE%\.mswarm\self-hosted-node\mswarm-self-hosted-node.ps1`

On Windows, the scheduled task starts at user logon, has no execution time limit, and runs a wrapper that restarts the node whenever the Node.js process exits. On macOS and Linux, launchd/systemd provide the restart policy directly. Linux installs also attempt `loginctl enable-linger` so the user service can survive logout and start after reboot when supported by the host.

The default setup values are:

- gateway: `https://api.mswarm.org`
- server name: normalized `os.hostname()`
- relay mode: `outbound`
- discovery mode: `mcoda`
- exposure policy: expose all healthy non-embedding local agents
- machine fingerprint: `sha256` of a random local machine ID

Runtime state is written under `~/.mswarm/self-hosted-node/`:

- `machine.id`: local random ID used for idempotent setup
- `config.json`: node ID, gateway, relay mode, heartbeat settings, and local model config
- `node.key`: node runtime token, written with `0600` permissions
- `daemon.log` / `daemon.err.log`: background daemon logs

## Run

```sh
mswarm node run
```

For the default outbound mode, `node run` sends heartbeats and long-polls mswarm for self-hosted execution jobs. For direct mode, it also starts the local direct-job HTTP server. `node run` is foreground-only; use `node install` for the stable background daemon that survives closing the terminal.

To bootstrap without installing the service:

```sh
mswarm setup --api-key <MSWARM_API_KEY>
```

## Daemon Control

```text
mswarm node start
mswarm node stop
mswarm node restart
mswarm node status
mswarm node health
mswarm node doctor
mswarm node logs --lines 200
mswarm node logs --error
mswarm node uninstall
```

`node start`, `node stop`, and `node restart` control the installed macOS launchd agent, Linux systemd user service, or Windows scheduled task. `node uninstall` also sends a best-effort runtime-token signal to the gateway after stopping the local daemon so the server is immediately marked unreachable. `node status` reports the service manager status plus the stored node config. `node health` and `node doctor` check local config, the runtime token, gateway health, heartbeat authorization, and local agent discovery.

## Advanced Setup

By default, the node exposes all healthy non-embedding local agents. Expose only selected local agents:

```sh
mswarm node install <MSWARM_API_KEY> --allow phi3-reviewer,llama-local
```

Hide selected local agents:

```sh
mswarm node install <MSWARM_API_KEY> --block experimental-agent
```

Keep discovery running but expose only allowlisted agents:

```sh
mswarm node install <MSWARM_API_KEY> --no-expose-all
```

Set local scheduling capacity during install:

```sh
mswarm node install <MSWARM_API_KEY> --max-concurrent-jobs 4 --max-concurrent-llm-jobs 2
```

The node reports additive load telemetry in each heartbeat: runtime protocol
version, active and queued work, LLM/generic job concurrency, free slots, drain
state, recent failures, moving average latency, and a fingerprinted local agent
catalog revision. Existing gateways can ignore the new fields; the legacy
`capacity.active_jobs` and `capacity.queued_jobs` values are still present.

Use drain mode before maintenance so new scheduled work avoids the node while
existing in-flight jobs can finish:

```sh
MSWARM_SELF_HOSTED_DRAIN_MODE=1 mswarm node run
```

Detailed host metrics are off by default. If enabled by the node owner, the
heartbeat includes only coarse pressure telemetry such as CPU load ratio, RAM
bucket/usage ratio, GPU availability/count/CUDA support, and a coarse VRAM tier
with no exact memory values. It does not include process lists, usernames,
filesystem paths, environment variables, raw prompts, GPU names, driver
versions, serial numbers, or exact VRAM values.

Use direct mode only when the node has a public HTTPS or tunnel URL:

```sh
mswarm node install <MSWARM_API_KEY> --mode direct --direct-url https://node.example.com
```

## Load-Balanced Routing

When an mswarm account has multiple upgraded self-hosted nodes, the hosted
control plane can expose synthetic `Auto load-balanced` catalog aliases for
matching local mcoda agents. Selecting an auto alias lets mswarm choose an
eligible node at request time based on tenant/API-key scope, model or capability
match, protocol compatibility, heartbeat freshness, drain state, active work,
and reservations.

This is additive to direct routing:

- Direct self-hosted slugs keep routing to their pinned node.
- Existing assignments are not migrated automatically.
- Older direct-only nodes still work as direct targets but are auto-ineligible
  until they advertise load-balancer protocol, load telemetry, and catalog
  fingerprint fields.
- Load-balanced aliases never require browser-visible node tokens, direct URLs,
  invocation signing secrets, or API keys.

Use drain mode before maintenance so auto routing avoids the node while direct
operators can decide whether to keep or move pinned traffic:

```sh
MSWARM_SELF_HOSTED_DRAIN_MODE=1 mswarm node run
```

Rollback is done from the control plane or consuming product by switching the
assignment back to a direct slug or omitting load-balanced aliases during
catalog sync. Keep the node installed; direct routing does not depend on the
load-balancer protocol fields.

## Commands

```text
mswarm node install <MSWARM_API_KEY> [options]
mswarm node start
mswarm node stop
mswarm node restart
mswarm node status
mswarm node health
mswarm node doctor
mswarm node logs [--error] [--lines N]
mswarm node uninstall
mswarm node run
mswarm setup [options]
mswarm once
mswarm models
mswarm agents
mswarm enroll
mswarm serve
```

The legacy aliases `mswarm install <MSWARM_API_KEY>`, `mswarm start`, `mswarm doctor`, and `mswarm status` remain available. `mswarm start` is a foreground run alias; use `mswarm node start` to start the installed daemon. `mswarm status` keeps the old one-shot heartbeat/status behavior; use `mswarm node status` for service manager status. The package also installs `mswarm-self-hosted-node`; it accepts the same commands.

## Codali Execution

Self-hosted jobs for local `mcoda` agents run through the vendored Codali runtime shipped with `@mcoda/mswarm`. The node resolves the requested `source_agent_slug` or model from local `mcoda agent list --json --refresh-health` inventory, maps the selected local adapter and model into Codali, and enforces the job policy before running tools.

Direct-mode `stream: true` jobs are returned as OpenAI-compatible Server-Sent Events:

```text
data: {"object":"chat.completion.chunk",...}
data: [DONE]
```

Codali status and tool events are tracked internally, but tool outputs are not emitted as assistant stream content. Raw `provider: "ollama"` jobs remain available as a minimal no-tool fallback path.

Jobs can additionally scope execution with:

- `workspace.root` and `workspace.read_only`
- `docdex.base_url`, `docdex.repo_root`, `docdex.repo_id`, and Docdex write/web/index flags
- `policy.allow_tools`, `policy.allowed_tools`, `policy.denied_tools`, write/shell/destructive flags, `policy.max_runtime_ms`, and `policy.max_tool_calls`

## Owner-Local Generic GPU Jobs

mswarm can also expose a separate owner-local generic job plane for trusted GPU
and package workloads such as Blender rendering, CUDA package jobs, ffmpeg CUDA
jobs, and Python GPU jobs. This path is separate from the OpenAI-compatible LLM
execution path and is disabled by default.

Enable it only on a trusted local node:

```sh
MSWARM_SELF_HOSTED_GENERIC_JOBS_ENABLED=1 \
MSWARM_SELF_HOSTED_DIRECT_HOST=127.0.0.1 \
MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET=<local-secret> \
mswarm node run --enable-generic-jobs
```

The generic job endpoints require scoped HMAC tokens or the owner-local signing
secret. They expose capability discovery, artifact upload, lifecycle status,
logs, events, cancellation, retry, and an ops summary for queue/usage/quota
inspection. Use `mcoda gpu list`, `mcoda gpu ops`, and the GPU-aware
`mcoda job artifact upload|run|status|logs|events|artifacts|cancel|retry`
commands to operate the local node.

Do not expose the node signing secret to browsers or untrusted tenants.
Production scheduling should issue short-lived scoped tokens from a control
plane; owner-local direct use is for a trusted operator on the node.

## Environment

`MSWARM_API_KEY` can replace `--api-key` during legacy `setup`, but the preferred flow is `mswarm node install <MSWARM_API_KEY>` or `mswarm node install --api-key-stdin` so the key is never exported into the shell environment. `MSWARM_GATEWAY_BASE_URL` overrides the gateway. The default discovery mode is `mcoda`, so the node reads `mcoda agent list --json --refresh-health`; set `MSWARM_SELF_HOSTED_DISCOVERY_MODE=ollama` only for raw Ollama fallback discovery. `MSWARM_SELF_HOSTED_EXPOSURE_POLICY=none` disables default exposure while keeping allowlists/blocklists available. `MSWARM_SELF_HOSTED_REQUEST_TIMEOUT_MS` controls short gateway and inventory requests; self-hosted execution jobs default to one hour and can be overridden with `MSWARM_SELF_HOSTED_JOB_TIMEOUT_MS` or `--job-timeout-ms` during install.

Load-balancer telemetry controls:

- `MSWARM_SELF_HOSTED_MAX_CONCURRENT_JOBS`: overall advertised job capacity, default `1`
- `MSWARM_SELF_HOSTED_MAX_CONCURRENT_LLM_JOBS`: LLM/Codali capacity, default matches overall capacity
- `MSWARM_SELF_HOSTED_GENERIC_JOB_MAX_CONCURRENCY`: generic job capacity, default `1`
- `MSWARM_SELF_HOSTED_DRAIN_MODE=1`: report zero free slots for maintenance
- `MSWARM_SELF_HOSTED_LOAD_REPORTING_ENABLED=0`: fall back to legacy heartbeat capacity shape
- `MSWARM_SELF_HOSTED_HARDWARE_TELEMETRY_ENABLED=1`: opt in to coarse pressure telemetry
