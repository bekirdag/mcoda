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

Use direct mode only when the node has a public HTTPS or tunnel URL:

```sh
mswarm node install <MSWARM_API_KEY> --mode direct --direct-url https://node.example.com
```

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

Self-hosted jobs for local `mcoda` agents run through the `@mcoda/codali` runtime. The node resolves the requested `source_agent_slug` or model from local `mcoda agent list --json --refresh-health` inventory, maps the selected local adapter and model into Codali, and enforces the job policy before running tools.

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

## Environment

`MSWARM_API_KEY` can replace `--api-key` during legacy `setup`, but the preferred flow is `mswarm node install <MSWARM_API_KEY>` or `mswarm node install --api-key-stdin` so the key is never exported into the shell environment. `MSWARM_GATEWAY_BASE_URL` overrides the gateway. The default discovery mode is `mcoda`, so the node reads `mcoda agent list --json --refresh-health`; set `MSWARM_SELF_HOSTED_DISCOVERY_MODE=ollama` only for raw Ollama fallback discovery. `MSWARM_SELF_HOSTED_EXPOSURE_POLICY=none` disables default exposure while keeping allowlists/blocklists available. `MSWARM_SELF_HOSTED_REQUEST_TIMEOUT_MS` controls short gateway and inventory requests; self-hosted execution jobs default to one hour and can be overridden with `MSWARM_SELF_HOSTED_JOB_TIMEOUT_MS` or `--job-timeout-ms` during install.
