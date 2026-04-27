#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import Fastify from "fastify";
import {
  verifySelfHostedInvocationToken,
  type SelfHostedInvocationTokenClaims
} from "./invocation-token.js";
import {
  controlSelfHostedNodeService,
  installSelfHostedNodeService,
  readOwnerSetupConfig,
  readSelfHostedNodeConfig,
  resolveSelfHostedNodeServiceLayout,
  SelfHostedNodeRuntime,
  uninstallSelfHostedNodeService,
  type SelfHostedNodeConfig,
  type SelfHostedNodeInvocationJob
} from "./runtime.js";

const SELF_HOSTED_NODE_PROCESS_TITLE = "mswarm-node";

function applySelfHostedNodeProcessTitle(): void {
  const title = process.env.MSWARM_SELF_HOSTED_PROCESS_TITLE?.trim() || SELF_HOSTED_NODE_PROCESS_TITLE;
  process.title = title;
}

function printUsage(): void {
  console.log(`Usage: mswarm <node|install|setup|start|doctor|once|daemon|serve|enroll|models|agents|status>

Commands:
  node install [options]   Bootstrap this machine and install a persistent background daemon
  node start               Start the installed background daemon
  node stop                Stop the installed background daemon
  node restart             Restart the installed background daemon
  node status              Show installed daemon/service status
  node health              Run node health checks
  node doctor              Run deep node diagnostics
  node logs [options]      Print daemon logs
  node uninstall           Remove the installed daemon but keep runtime state
  node run                 Run the node in the foreground

Compatibility aliases:
  install <API_KEY>        Alias for node install <API_KEY>
  setup --api-key <KEY>   Bootstrap without installing a daemon
  start                   Foreground node run; node start controls the daemon
  doctor                  Alias for node doctor
  status                  Legacy one-shot heartbeat/status check

Environment:
  MSWARM_GATEWAY_BASE_URL                  Gateway base URL, defaults to http://127.0.0.1:8080
  MSWARM_SELF_HOSTED_NODE_ID               Node id from the owner registration response
  MSWARM_SELF_HOSTED_ENROLLMENT_TOKEN      One-time enrollment token
  MSWARM_SELF_HOSTED_RUNTIME_TOKEN         Optional runtime token override
  MSWARM_SELF_HOSTED_DISCOVERY_MODE        mcoda or ollama, defaults to mcoda
  MSWARM_SELF_HOSTED_MCODA_BIN             mcoda binary, defaults to mcoda
  MSWARM_SELF_HOSTED_MCODA_LIST_ARGS       Comma-separated args, defaults to agent,list,--json,--refresh-health
  MSWARM_SELF_HOSTED_OLLAMA_BASE_URL       Ollama base URL, defaults to http://127.0.0.1:11434
  MSWARM_SELF_HOSTED_NODE_STATE_PATH       Config/state file, defaults to ~/.mswarm/self-hosted-node/config.json
  MSWARM_SELF_HOSTED_NODE_KEY_PATH         Runtime token file, defaults to ~/.mswarm/self-hosted-node/node.key
  MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET  Shared direct-job signing secret
  MSWARM_SELF_HOSTED_LISTEN_HOST           Direct node bind host, defaults to 127.0.0.1
  MSWARM_SELF_HOSTED_LISTEN_PORT           Direct node bind port, defaults to 18083
  MSWARM_SELF_HOSTED_MODEL_ALLOWLIST       Comma-separated local agent slugs/model names to expose
  MSWARM_SELF_HOSTED_MODEL_BLOCKLIST       Comma-separated local agent slugs/model names to hide

Setup options:
  node install <KEY>       Quick setup flow; avoids shell-exporting the API key
  --api-key <KEY>           Owner mswarm API key; fallback MSWARM_API_KEY
  --api-key-stdin           Read owner API key from stdin for automation
  --gateway <URL>           Defaults to https://api.mswarm.org
  --server-name <NAME>      Defaults to os.hostname()
  --mode <outbound|direct>  Defaults to outbound
  --direct-url <URL>        Required only for direct mode
  --allow <SLUGS>           Comma-separated allowlist
  --block <SLUGS>           Comma-separated blocklist
  --expose-all              Expose all healthy non-embedding local agents
  --start                   Start foreground daemon after setup

Log options:
  --error                   Read daemon.err.log instead of daemon.log
  --lines <N>               Number of log lines to print, defaults to 200
`);
}

export function buildInstallSetupArgs(argv: string[]): string[] {
  const [first, ...rest] = argv;
  if (first && !first.startsWith("--")) {
    return ["--api-key", first, ...rest];
  }
  return argv;
}

export function normalizeMswarmCommand(argv: string[]): { namespace: "node" | null; command: string; args: string[] } {
  const command = argv[2] || "once";
  if (command === "node") {
    return { namespace: "node", command: argv[3] || "help", args: argv.slice(4) };
  }
  return { namespace: null, command, args: argv.slice(3) };
}

function hasApiKeyArg(argv: string[]): boolean {
  return argv.some((entry, index) => entry === "--api-key" && typeof argv[index + 1] === "string");
}

async function readApiKeyFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function buildNodeInstallSetupArgs(argv: string[]): Promise<string[]> {
  const args = [...argv];
  const stdinIndex = args.indexOf("--api-key-stdin");
  if (stdinIndex >= 0) {
    args.splice(stdinIndex, 1);
    if (hasApiKeyArg(args) || (args[0] && !args[0].startsWith("--"))) {
      throw new Error("Use either --api-key, a positional API key, or --api-key-stdin; not more than one");
    }
    const apiKey = await readApiKeyFromStdin();
    if (!apiKey) {
      throw new Error("No API key received on stdin");
    }
    return ["--api-key", apiKey, ...args];
  }
  return buildInstallSetupArgs(args);
}

function parsePositiveLineCount(argv: string[], fallback: number): number {
  const index = argv.indexOf("--lines");
  if (index < 0) return fallback;
  const parsed = Number(argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function lastLines(content: string, count: number): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function extractBearerToken(headers: Record<string, string | string[] | undefined>): string {
  const authorization = headers.authorization;
  const raw = Array.isArray(authorization) ? authorization[0] : authorization || "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function assertJobMatchesClaims(job: SelfHostedNodeInvocationJob, claims: SelfHostedInvocationTokenClaims): void {
  if (job.node_id !== claims.node_id) {
    throw new Error("job node_id does not match invocation token");
  }
  if (job.job_id !== claims.job_id) {
    throw new Error("job_id does not match invocation token");
  }
  if (job.request_id !== claims.request_id) {
    throw new Error("request_id does not match invocation token");
  }
  if (job.openai_request?.model !== claims.model) {
    throw new Error("model does not match invocation token");
  }
}

export function buildSelfHostedNodeApp(runtime: SelfHostedNodeRuntime, config: SelfHostedNodeConfig) {
  const app = Fastify({ logger: false });

  app.get("/healthz", async (_request, reply) => {
    reply.send({ service: "mswarm-self-hosted-node", status: "ok", node_id: config.nodeId });
  });

  app.post("/v1/swarm/self-hosted/node/jobs", async (request, reply) => {
    if (!config.invocationSigningSecret) {
      reply.status(503).send({
        error: "service_unavailable",
        code: "missing_config",
        message: "MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for direct jobs"
      });
      return;
    }
    const token = extractBearerToken(request.headers as Record<string, string | string[] | undefined>);
    if (!token) {
      reply.status(401).send({
        error: "unauthorized",
        code: "unauthorized",
        message: "Missing invocation token"
      });
      return;
    }
    let claims: SelfHostedInvocationTokenClaims;
    try {
      claims = verifySelfHostedInvocationToken({
        token,
        secret: config.invocationSigningSecret
      });
    } catch (error) {
      reply.status(401).send({
        error: "unauthorized",
        code: "unauthorized",
        message: error instanceof Error ? error.message : "Invalid invocation token"
      });
      return;
    }
    const job = request.body as SelfHostedNodeInvocationJob;
    try {
      assertJobMatchesClaims(job, claims);
    } catch (error) {
      reply.status(400).send({
        error: "bad_request",
        code: "validation_failed",
        message: error instanceof Error ? error.message : "Invalid invocation job"
      });
      return;
    }
    const result = await runtime.executeJob(job);
    if (result.status !== "success") {
      reply.status(502).send(result);
      return;
    }
    reply.send(result);
  });

  return app;
}

export async function main(argv = process.argv): Promise<void> {
  const parsed = normalizeMswarmCommand(argv);
  const command = parsed.command;
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (parsed.namespace === "node") {
    await handleNodeCommand(command, parsed.args, argv);
    return;
  }
  if (command === "install") {
    await installNode(parsed.args, argv);
    return;
  }
  if (command === "setup") {
    const setupConfig = await readOwnerSetupConfig(parsed.args);
    const result = await SelfHostedNodeRuntime.setup(setupConfig);
    console.log(`Registered ${result.serverName} as ${result.nodeId}`);
    console.log(`Discovered ${result.modelCount} local mcoda agents.`);
    console.log(
      result.status === "online"
        ? "Node is online. Keep it running with: mswarm node run"
        : "Node registered, but local discovery is degraded. Run: mswarm node doctor"
    );
    if (setupConfig.start) {
      await runNodeForeground();
    }
    return;
  }
  if (command === "doctor") {
    await runNodeDoctor();
    return;
  }
  if (command === "status") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.runOnce();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "once") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.runOnce();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "enroll") {
    const { config, runtime } = await loadNodeRuntime();
    const result = await runtime.ensureEnrolled();
    console.log(JSON.stringify({ enrolled: result.enrolled, state_path: config.statePath }, null, 2));
    return;
  }
  if (command === "models") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.pushModelsOnly();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "agents") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.pushModelsOnly();
    console.log(JSON.stringify({ pushed: result.count, response: result.response }, null, 2));
    return;
  }
  if (command === "daemon" || command === "start") {
    await runNodeForeground(command === "daemon" ? "daemon" : "start");
    return;
  }
  if (command === "serve") {
    await runNodeServerOnly();
    return;
  }
  printUsage();
  throw new Error(`Unknown command: ${command}`);
}

async function installNode(args: string[], argv: string[]): Promise<void> {
  const commandPath = realpathSync(argv[1] || fileURLToPath(import.meta.url));
  const setupConfig = await readOwnerSetupConfig(await buildNodeInstallSetupArgs(args));
  const result = await SelfHostedNodeRuntime.setup(setupConfig);
  const config = await readSelfHostedNodeConfig();
  const service = await installSelfHostedNodeService(config, {
    commandPath,
    nodePath: process.execPath
  });
  console.log(`Registered ${result.serverName} as ${result.nodeId}`);
  console.log(`Discovered ${result.modelCount} local mcoda agents.`);
  console.log(`Installed ${service.manager} service ${service.serviceName}`);
  console.log(`Service file: ${service.servicePath}`);
  console.log(`Logs: ${service.logPath}`);
  console.log("Node daemon is running in the background.");
}

async function loadNodeRuntime(): Promise<{ config: SelfHostedNodeConfig; runtime: SelfHostedNodeRuntime }> {
  const config = await readSelfHostedNodeConfig();
  const runtime = new SelfHostedNodeRuntime(config);
  return { config, runtime };
}

async function runNodeDoctor(): Promise<void> {
  const { runtime } = await loadNodeRuntime();
  const result = await runtime.doctor();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function runNodeStatus(): Promise<void> {
  const service = await controlSelfHostedNodeService("status");
  let node: Record<string, unknown>;
  try {
    const config = await readSelfHostedNodeConfig();
    node = {
      configured: true,
      node_id: config.nodeId,
      server_name: config.serverName,
      relay_mode: config.relayMode,
      gateway_base_url: config.gatewayBaseUrl,
      state_path: config.statePath,
      runtime_token_path: config.runtimeTokenPath
    };
  } catch (error) {
    node = { configured: false, error: error instanceof Error ? error.message : String(error) };
  }
  console.log(JSON.stringify({ service, node }, null, 2));
}

async function runNodeLogs(args: string[]): Promise<void> {
  const layout = resolveSelfHostedNodeServiceLayout();
  const path = args.includes("--error") ? layout.errorLogPath : layout.logPath;
  const lines = parsePositiveLineCount(args, 200);
  const content = await readFile(path, "utf8");
  console.log(lastLines(content, lines));
}

async function runNodeForeground(label = "run"): Promise<void> {
  applySelfHostedNodeProcessTitle();
  const { config, runtime } = await loadNodeRuntime();
  if (config.relayMode === "direct") {
    if (!config.invocationSigningSecret) {
      throw new Error("MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for direct start");
    }
    runtime.startDaemon();
    const app = buildSelfHostedNodeApp(runtime, config);
    await app.listen({ host: config.listenHost, port: config.listenPort });
    console.log(`mswarm self-hosted node serving direct jobs for ${config.nodeId} on ${config.listenHost}:${config.listenPort}`);
    return new Promise(() => undefined);
  }
  runtime.startDaemon();
  console.log(`mswarm self-hosted node ${label === "daemon" ? "daemon" : "foreground run"} active for ${config.nodeId}`);
  return new Promise(() => undefined);
}

async function runNodeServerOnly(): Promise<void> {
  applySelfHostedNodeProcessTitle();
  const { config, runtime } = await loadNodeRuntime();
  if (!config.invocationSigningSecret) {
    throw new Error("MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET is required for serve");
  }
  runtime.startDaemon();
  const app = buildSelfHostedNodeApp(runtime, config);
  await app.listen({ host: config.listenHost, port: config.listenPort });
  console.log(`mswarm self-hosted node serving direct jobs for ${config.nodeId} on ${config.listenHost}:${config.listenPort}`);
  return new Promise(() => undefined);
}

async function handleNodeCommand(command: string, args: string[], argv: string[]): Promise<void> {
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "install") {
    await installNode(args, argv);
    return;
  }
  if (command === "start" || command === "stop" || command === "restart") {
    const result = await controlSelfHostedNodeService(command);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "status") {
    await runNodeStatus();
    return;
  }
  if (command === "health" || command === "doctor") {
    await runNodeDoctor();
    return;
  }
  if (command === "logs") {
    await runNodeLogs(args);
    return;
  }
  if (command === "uninstall") {
    const result = await uninstallSelfHostedNodeService();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "run" || command === "daemon") {
    await runNodeForeground(command);
    return;
  }
  if (command === "serve") {
    await runNodeServerOnly();
    return;
  }
  if (command === "once") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.runOnce();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "enroll") {
    const { config, runtime } = await loadNodeRuntime();
    const result = await runtime.ensureEnrolled();
    console.log(JSON.stringify({ enrolled: result.enrolled, state_path: config.statePath }, null, 2));
    return;
  }
  if (command === "models") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.pushModelsOnly();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "agents") {
    const { runtime } = await loadNodeRuntime();
    const result = await runtime.pushModelsOnly();
    console.log(JSON.stringify({ pushed: result.count, response: result.response }, null, 2));
    return;
  }
  printUsage();
  throw new Error(`Unknown node command: ${command}`);
}

export function isSelfHostedNodeDirectRun(argvEntry: string | undefined, moduleUrl: string): boolean {
  if (!argvEntry) {
    return false;
  }
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(resolve(argvEntry)) === realpathSync(modulePath);
  } catch {
    return resolve(argvEntry) === modulePath;
  }
}

const isDirectRun = isSelfHostedNodeDirectRun(process.argv[1], import.meta.url);

if (isDirectRun) {
  void main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
