import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { SessionController, type SessionEvent } from "../runtime/SessionController.js";
import { INTERACTION_CONTRACT_VERSION } from "../runtime/InteractionRouter.js";
import { loadOrchestrationConfig, orchestrationHash, validateOrchestrationConfig, type EffortLevel, type OrchestrationConfig, type ResolvedOrchestrationConfig } from "../config/OrchestrationConfig.js";
import { ConfiguredProvider, ModelServiceClient, providerCredential } from "../providers/ConfiguredProvider.js";
import { PermissionGate, type PermissionProfile, type PermissionPrompt } from "../permissions/PermissionGate.js";
import { executorStatus } from "../tools/shell/IsolatedExecutor.js";
import { atomicWriteJson } from "../session/AtomicState.js";
import { readTerminalCredential, setTerminalCredential } from "./TerminalCredentials.js";
import { redactSecretValues } from "../gateway/GatewayTracer.js";
import { terminalText, TerminalTextStream } from "./TerminalText.js";
import { validateEmbeddingPreprocessing, type ProjectTaskAuthority } from "@mcoda/shared";
import { TerminalInput, insertTerminalPaste } from "./TerminalInput.js";
import { ModelServiceError } from "../providers/ModelServiceError.js";
import { discoverHostToolchain } from "../tools/shell/HostToolchain.js";
import { ensureManagedDocdexRuntime, inspectManagedDocdexRuntime, type ManagedRuntimeIdentity } from "../docdex/ManagedRuntime.js";
import { TerminalTui } from "./tui/TerminalTui.js";
import { inspectPlanDiff } from "./TerminalPlan.js";
import { openTerminalArtifact } from "./TerminalArtifacts.js";
import { mediaJobSummary } from "../connectors/media/ConfiguredMediaTools.js";
import { proposeTerminalModel, saveTerminalModel, terminalModelOperation } from "./TerminalModels.js";

const DEFAULT_PROVIDER = { adapter: "mswarm" as const, baseUrl: "https://api.mswarm.org/v1/swarm/self-hosted/openai", credentialRef: "env:MCODA_MSWARM_API_KEY" };
const CONFIG_PATH = path.join(os.homedir(), ".codali", "orchestration.json");
const COMMANDS = ["/help", "/usage", "/status", "/permissions", "/effort", "/model", "/models", "/config", "/goal", "/plan", "/tasks", "/decisions", "/context", "/diff", "/skills", "/tools", "/mcp", "/docdex", "/review", "/compact", "/checkpoint", "/sessions", "/resume", "/fork", "/retention", "/delete-session", "/new", "/clear", "/steer", "/continue", "/stop", "/cancel", "/reconcile", "/reconcile-media", "/export", "/artifacts", "/exit", "/quit"];
const HELP = `Codali terminal\n  codali [chat] [prompt] [--workspace-root PATH] [--config PATH]\n  codali exec PROMPT [--json] [--permissions plan|ask|workspace] [--effort low|medium|high|max]\n  codali setup [--config PATH] [--docdex-binary PATH]\n  codali login [--stdin] | logout | auth status\n  codali sessions | resume SESSION_ID | status SESSION_ID\n\n${COMMANDS.join("  ")}\n\nInteractive terminals open the TUI; --plain selects line-oriented output.\nEnter sends/queues; Alt-Enter or Ctrl-J inserts a newline; Ctrl-S steers.\nCtrl-P commands; Ctrl-R history; Tab completes commands and @files.\nPage Up/Down scroll; Ctrl-O expands tools; Escape closes views or cancels.\nCtrl-C cancels the active turn. A second Ctrl-C exits after cleanup.\nIn noninteractive mode approvals are denied; choose an explicit permission profile.\nProject tasks: mcoda codali chat --project-task TASK_KEY (existing workspace task database).\nExit codes: 0 verified completion, 1 error, 2 open/blocked goal, 130 cancelled.`;

interface Arguments { command: string; prompt: string; workspaceRoot: string; config?: string; docdexBinary?: string; projectTask?: string; effort: EffortLevel; permissions: PermissionProfile; json: boolean; plain: boolean; stdin: boolean; allowWeb?: boolean; allowMemory?: boolean; allowMedia?: boolean; allowNetwork?: boolean; }
export interface TerminalHost { projectTaskAuthority?: ProjectTaskAuthority; }
export const parseTerminalArguments = (argv: string[]): Arguments => {
  const [command = "chat", ...input] = argv;
  const result: Arguments = { command, prompt: "", workspaceRoot: process.cwd(), effort: "medium", permissions: "ask", json: false, plain: false, stdin: false };
  const positional: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const flag = input[i];
    if (["--allow-web", "--allow-memory", "--allow-media", "--allow-network"].includes(flag)) { const key = { "--allow-web": "allowWeb", "--allow-memory": "allowMemory", "--allow-media": "allowMedia", "--allow-network": "allowNetwork" }[flag]!; (result as unknown as Record<string, unknown>)[key] = true; continue; }
    if (["--json", "--plain", "--stdin"].includes(flag)) { (result as unknown as Record<string, unknown>)[flag.slice(2)] = true; continue; }
    if (["--workspace-root", "--config", "--file", "--docdex-binary", "--effort", "--permissions", "--permission-profile", "--output-format", "--project-task"].includes(flag)) {
      const value = input[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (flag === "--workspace-root") result.workspaceRoot = path.resolve(value);
      if (flag === "--config") result.config = path.resolve(value);
      if (flag === "--file") { if (command !== "config") throw new Error("--file is a config validate option"); result.config = path.resolve(value); }
      if (flag === "--output-format") { if (!["jsonl", "text"].includes(value)) throw new Error("Expected --output-format jsonl or text"); result.json = value === "jsonl"; }
      if (flag === "--docdex-binary") { if (command !== "setup") throw new Error("--docdex-binary is a setup option"); result.docdexBinary = value.includes(path.sep) ? path.resolve(value) : value; }
      if (flag === "--project-task") result.projectTask = value;
      if (flag === "--effort") { if (!["low", "medium", "high", "max"].includes(value)) throw new Error("Invalid effort level"); result.effort = value as EffortLevel; }
      if (flag === "--permissions" || flag === "--permission-profile") { if (!["plan", "ask", "workspace"].includes(value)) throw new Error("Invalid permission profile"); result.permissions = value as PermissionProfile; }
    } else if (flag.startsWith("--")) throw new Error(`Unknown terminal option: ${flag}`); else positional.push(flag);
  }
  result.prompt = positional.join(" "); return result;
};

export const setupTerminalConfig = async (destination: string, options: { prepareRuntime?: () => Promise<ManagedRuntimeIdentity> } = {}): Promise<ResolvedOrchestrationConfig> => {
  try { await fs.access(destination); throw new Error(`Configuration already exists: ${destination}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const client = new ModelServiceClient(DEFAULT_PROVIDER);
  const catalog = await client.catalog(undefined, true);
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "mswarm-strata", providers: { mswarm: { ...DEFAULT_PROVIDER } }, models: {}, bindings: {}, routing: { strategy: "capability-and-capacity", requiredBackends: { lead: ["strata"], architect: ["strata"], worker: ["strata"], reviewer: ["strata"] } } };
  const mediaJobsUrl = new URL("/v1/media/jobs", DEFAULT_PROVIDER.baseUrl).toString();
  try {
    const capability = await client.json(mediaJobsUrl) as { protocol?: string };
    if (capability.protocol === "mswarm-media-jobs-v1") config.providers.mswarm.mediaJobsUrl = mediaJobsUrl;
  } catch (error) { if (!(error instanceof ModelServiceError) || ![404, 405].includes(error.status)) throw error; }
  const lead = catalog.filter(entry => entry.backend === "strata" && entry.supportsTools && entry.health === "healthy");
  if (!lead.length) throw new Error("No entitled healthy Strata tool route is advertised; setup cannot invent a fallback");
  for (const entry of lead) config.models[entry.id] = { provider: "mswarm", catalogId: entry.id, revision: String(entry.raw.digest ?? entry.raw.revision ?? "catalog-unversioned"), operations: ["chat.completions"], backend: "strata", contextWindow: entry.contextWindow ?? 32768, maxOutputTokens: 4096, supportsTools: true, supportsStreaming: false };
  config.bindings.lead = { candidates: lead.map(entry => entry.id) };
  for (const role of ["architect", "worker", "reviewer", "planner", "compactor", "router", "adjudicator", "synthesizer", "verifier", "repair"]) config.bindings[role] = { useBinding: "lead" };
  // Availability is not qualification for this version's dispatch contract.
  // Operators can bind a measured smaller candidate explicitly after evaluation.
  config.bindings.intent = { useBinding: "lead" };
  config.interaction = { routerBinding: "intent", answerBinding: "lead", promptVersion: INTERACTION_CONTRACT_VERSION };
  config.bindings.helper = { enabled: false }; config.bindings.embedding = { enabled: false };
  // Only explicit operator contracts can initialize an index. Incompatible
  // embedding spaces never become replicas merely because dimensions match.
  let embeddingIdentity: string | undefined;
  for (const entry of [...catalog].sort((a, b) => a.id.localeCompare(b.id))) {
    if (entry.health !== "healthy" || !entry.operations.includes("embeddings") || entry.raw.load_balanced === true) continue;
    const digest = entry.raw.digest;
    const descriptor = Array.isArray(entry.raw.operations) ? entry.raw.operations.find(item => item && typeof item === "object" && (item as Record<string, unknown>).type === "embeddings") as { limits?: { embedding_dimensions?: number } } | undefined : undefined;
    const dimensions = descriptor?.limits?.embedding_dimensions;
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(dimensions) || dimensions! < 1 || dimensions! > 4096) continue;
    let embedding;
    try { embedding = validateEmbeddingPreprocessing(entry.raw.embedding); } catch { continue; }
    const identity = JSON.stringify({ digest, dimensions, ...embedding });
    if (embeddingIdentity !== undefined && embeddingIdentity !== identity) continue;
    embeddingIdentity = identity;
    const previous = config.models[entry.id];
    config.models[entry.id] = { ...previous, provider: "mswarm", catalogId: entry.id, revision: digest,
      operations: [...new Set([...(previous?.operations ?? []), "embeddings" as const])],
      contextWindow: previous?.contextWindow ?? entry.contextWindow ?? 8192, maxOutputTokens: previous?.maxOutputTokens ?? 1,
      embeddingDimensions: dimensions, embedding };
    const candidates = config.bindings.embedding.candidates ?? [];
    config.bindings.embedding = { candidates: [...candidates, entry.id], embeddingSpace: "catalog-pinned-v1" };
  }
  for (const [binding, operation] of [["image", "images.generations"], ["audio", "audio.generations"], ["video", "videos.generations"]] as const) {
    const entries = catalog.filter(entry => entry.health === "healthy" && entry.operations.includes(operation));
    for (const entry of entries) {
      const previous = config.models[entry.id];
      config.models[entry.id] = previous ? { ...previous, operations: [...new Set([...previous.operations, operation])] }
        : { provider: "mswarm", catalogId: entry.id, revision: String(entry.raw.revision ?? "catalog-unversioned"), operations: [operation], contextWindow: 8192, maxOutputTokens: 1 };
    }
    config.bindings[binding] = entries.length ? { candidates: entries.map(entry => entry.id) } : { enabled: false };
  }
  if (options.prepareRuntime && config.bindings.embedding.enabled !== false) {
    const runtime = await options.prepareRuntime();
    config.docdex = { binary: runtime.binary, binarySha256: runtime.binarySha256 };
  }
  validateOrchestrationConfig(config); await atomicWriteJson(destination, config);
  return { config, source: destination, hash: orchestrationHash(config) };
};

const usageFor = async (resolved: ResolvedOrchestrationConfig): Promise<Record<string, unknown>> => {
  const entries = await Promise.all(Object.entries(resolved.config.providers).map(async ([id, provider]) => { try { return [id, await new ModelServiceClient(provider).usage()]; } catch (error) { return [id, { available: false, error: error instanceof Error ? error.message : String(error) }]; } }));
  return Object.fromEntries(entries);
};

export const terminalDoctor = async (configPath?: string): Promise<Record<string, unknown>> => {
  const report: Record<string, unknown> = { node: process.version, runtimeSupported: Number(process.versions.node.split(".")[0]) >= 20, isolation: executorStatus() };
  report.nodeToolchain = discoverHostToolchain(process.cwd()).map(runtime => ({ name: runtime.name, executable: runtime.executable, readOnlyRoot: runtime.readOnlyRoot }));
  try {
    const resolved = await loadOrchestrationConfig(configPath); report.configuration = { source: resolved.source, hash: resolved.hash, profile: resolved.config.profile };
    const routes: Record<string, unknown> = {};
    for (const binding of ["lead", "reviewer", "helper", "embedding", "image", "audio", "video"]) {
      if (resolved.config.bindings[binding]?.enabled === false) { routes[binding] = { enabled: false }; continue; }
      try { const selected = await new ConfiguredProvider(resolved, binding).select(binding === "embedding" ? "embeddings" : binding === "image" ? "images.generations" : binding === "audio" ? "audio.generations" : binding === "video" ? "videos.generations" : "chat.completions", undefined, binding === "lead"); routes[binding] = { model: selected.id, backend: selected.actual.backend, health: selected.actual.health }; }
      catch (error) { routes[binding] = { error: error instanceof Error ? error.message : String(error) }; }
    }
    report.routes = routes;
    report.mediaRecovery = Object.fromEntries(Object.entries(resolved.config.providers).map(([id, provider]) => [id, { protocol: provider.mediaJobsUrl ? "mswarm-media-jobs-v1" : "synchronous", reconnect: provider.mediaJobsUrl ? "Recover by durable job id" : "Only complete local receipts can be recovered; ambiguous remote jobs require reconciliation" }]));
    if (resolved.config.bindings.embedding?.enabled !== false && resolved.config.bindings.embedding) {
      try { if (!resolved.config.docdex?.binary) throw new Error("Managed Docdex binary is not configured; run setup with a qualified release"); report.docdex = { mode: "managed", available: true, ...await inspectManagedDocdexRuntime(resolved.config.docdex.binary, resolved.config.docdex.binarySha256) }; }
      catch (error) { report.docdex = { mode: "managed", available: false, error: error instanceof Error ? error.message : String(error), action: "Install a qualified runtime and update docdex.binary and binarySha256" }; }
    }
  } catch (error) { report.configuration = { error: error instanceof Error ? error.message : String(error) }; }
  if (!report.docdex) {
    try { const response = await fetch("http://127.0.0.1:28491/healthz", { signal: AbortSignal.timeout(3000) }); report.docdex = { mode: "external", available: response.ok, status: response.status, configuredEmbeddings: false }; }
    catch { report.docdex = { mode: "external", available: false, action: "Configure a qualified embedding binding and managed Docdex runtime" }; }
  }
  return report;
};

export class TerminalCommand {
  static async run(argv: string[], host: TerminalHost = {}): Promise<void> {
    try { await this.execute(argv, host); }
    catch (error) {
      const format = argv.lastIndexOf("--output-format");
      if (!(argv.lastIndexOf("--json") > format || (format >= 0 && argv[format + 1] === "jsonl"))) throw error;
      const message = redactSecretValues(error instanceof Error ? error.message : String(error));
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: "command_failed", data: { message, completed: false } })}\n`);
      process.exitCode = /cancel/i.test(message) ? 130 : 1;
    }
  }

  private static async execute(argv: string[], host: TerminalHost): Promise<void> {
    if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(`${HELP}\n`); return; }
    const args = parseTerminalArguments(argv);
    if (process.env.TERM === "dumb" || !process.stdout.isTTY) args.plain = true;
    if (args.projectTask && !host.projectTaskAuthority) throw new Error("Use mcoda codali with --project-task to attach to the existing mcoda task repository");
    if (args.stdin && ["chat", "exec"].includes(args.command)) {
      let text = "";
      for await (const chunk of process.stdin) { text += chunk.toString(); if (Buffer.byteLength(text) > 262144) throw new Error("Input prompt exceeds 256 KiB"); }
      args.prompt = [args.prompt, text.trim()].filter(Boolean).join("\n\n");
    }
    let tui: TerminalTui | undefined;
    let outputTitle = "Details";
    const output = (value: unknown): void => { const text = redactSecretValues(typeof value === "string" ? value : JSON.stringify(value, null, args.json ? 0 : 2)); if (tui) { tui.show(typeof value === "string" ? text : JSON.parse(text), outputTitle); return; } process.stdout.write(`${args.json ? text : terminalText(text)}\n`); };
    if (args.command === "login") { const key = await readTerminalCredential(args.stdin); if (!key) throw new Error("API key is required"); await new ModelServiceClient(DEFAULT_PROVIDER, key).catalog(undefined, true); await setTerminalCredential(key); output("mSwarm credential saved and validated."); return; }
    if (args.command === "logout") { await setTerminalCredential(); output("Stored Codali mSwarm credential removed. Environment credentials, if set, take precedence."); return; }
    if (args.command === "auth-status") { try { await providerCredential(DEFAULT_PROVIDER); const catalog = await new ModelServiceClient(DEFAULT_PROVIDER).catalog(); output({ authenticated: true, entitledModels: catalog.length }); } catch (error) { output({ authenticated: false, error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; } return; }
    if (args.command === "setup") {
      const resolved = await setupTerminalConfig(args.config ?? process.env.CODALI_ORCHESTRATION_CONFIG ?? CONFIG_PATH, { prepareRuntime: () => ensureManagedDocdexRuntime({ binary: args.docdexBinary }) });
      const docdex = resolved.config.docdex ? { mode: "managed", ...resolved.config.docdex, initialization: "Private repository indexing starts when execution needs it" }
        : { mode: "unavailable", reason: "No entitled embedding route advertises a pinned model and complete preprocessing contract" };
      output({ configuration: resolved.source, hash: resolved.hash, bindings: resolved.config.bindings, docdex }); return;
    }
    if (args.command === "doctor") { output(await terminalDoctor(args.config)); return; }
    if (args.command === "config" && args.prompt !== "validate") throw new Error("Usage: codali config validate --file PATH");
    let resolved = await loadOrchestrationConfig(args.config).catch(error => { throw new Error(`Cannot load orchestration configuration; run codali setup. ${error instanceof Error ? error.message : String(error)}`); });
    if (args.command === "config") { output({ valid: true, source: resolved.source, hash: resolved.hash }); return; }
    const interactive = ["chat", "resume"].includes(args.command) && !!process.stdin.isTTY && !args.json;
    let rl: Interface | undefined; let pendingApproval: ((decision: "once" | "session" | "deny") => void) | undefined;
    let closed = false; let lastCtrlC = 0; let cancelEpoch = 0; let activeRun: Promise<void> | undefined; let commandAbort: AbortController | undefined; const queued: Array<{ text: string; steer?: boolean }> = [];
    const approve: PermissionPrompt = async (request, signal) => {
      if (!interactive || closed) return { allow: false };
      const reviewableArgs = redactSecretValues(JSON.stringify(request.args, (key, value: unknown) => /authorization|api[_-]?key|password|credential|secret|signature|token/i.test(key) ? "[redacted]" : value, 2));
      if (tui) { const decision = await tui.approve(`Permission · ${request.tool}`, `${request.kind}\n\n${reviewableArgs}`, signal); return { allow: decision !== "deny", scope: decision === "session" ? "session" : "once" }; }
      process.stderr.write(terminalText(`\nPermission: ${request.tool} (${request.kind})\n${reviewableArgs}\nAllow once, for this session, or deny? [once/session/deny]\n`));
      return new Promise(resolve => {
        const abort = () => { pendingApproval = undefined; resolve({ allow: false }); };
        pendingApproval = decision => { signal?.removeEventListener("abort", abort); resolve({ allow: decision !== "deny", scope: decision === "session" ? "session" : "once" }); };
        signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      });
    };
    const textStream = new TerminalTextStream();
    const controller = new SessionController({ workspaceRoot: await fs.realpath(args.workspaceRoot), resolved, effort: args.effort, permissions: args.permissions, approve, allowWeb: args.allowWeb, allowMemory: args.allowMemory, allowMedia: args.allowMedia, allowNetwork: args.allowNetwork,
      projectTaskKey: args.projectTask, projectTaskAuthority: host.projectTaskAuthority,
      onEvent: (event: SessionEvent) => {
        if (tui) { tui.event(event); return; }
        if (args.json) { output(event); return; }
        if (event.type === "turn_started") textStream.reset();
        if (["tool_intent", "turn_result", "turn_failed"].includes(event.type) && !args.plain) process.stdout.write(textStream.finish());
        if (event.type === "token" && typeof event.data.content === "string" && !args.plain) process.stdout.write(textStream.write(event.data.content));
        else if (event.type === "model_route") process.stderr.write(terminalText(`\n[${event.data.binding}: ${event.data.modelId}${event.data.host ? ` on ${event.data.host}` : ""}]\n`));
        else if (event.type === "tool_intent") { const receipt = event.data.receipt as { tool: string }; process.stderr.write(terminalText(`[${receipt.tool}]\n`)); }
        else if (event.type === "process_output" && typeof event.data.content === "string") process.stderr.write(terminalText(event.data.content));
        else if (event.type === "index_progress") process.stderr.write(`[Docdex: ${terminalText(String(event.data.status))}]\n`);
      },
    });
    const cancelTurn = (): void => { cancelEpoch++; commandAbort?.abort(new Error("Cancelled by user")); controller.cancel(); };
    const showPrompt = (): void => { if (tui) { tui.update({ busy: !!activeRun || controller.busy, effort: controller.effort, permissions: controller.gate.profile, tokens: controller.usageSnapshot().tokens, queued: queued.length, session: controller.sessionId }); return; } if (!closed && !controller.busy && !pendingApproval) { rl?.setPrompt("codali> "); rl?.prompt(); } };
    const run = (prompt?: string, newSession = false, epoch = cancelEpoch): void => {
      if (closed || epoch !== cancelEpoch) { showPrompt(); return; }
      tui?.update({ busy: true, activity: "Preparing turn", queued: queued.length });
      activeRun = (async () => {
        try { if (closed || epoch !== cancelEpoch) return; if (newSession && controller.sessionId) await controller.clearSession(); if (closed || epoch !== cancelEpoch) throw new Error("Cancelled by user before execution"); const result = prompt ? await controller.interact(prompt) : await controller.run(); if (tui) tui.result(redactSecretValues(result.content)); else if (!args.json) output(`\n${result.content}`); if (!interactive) process.exitCode = result.completed || "mode" in result && result.mode !== "execute" || args.permissions === "plan" ? 0 : 2; }
        catch (error) { const message = redactSecretValues(error instanceof Error ? error.message : String(error)); if (tui) { tui.error(message); tui.update({ activity: "Turn stopped" }); } else if (args.json) output({ schemaVersion: 1, type: "command_failed", sessionId: controller.sessionId, data: { message, completed: false } }); else process.stderr.write(`${terminalText(message)}\n`); if (!interactive) process.exitCode = /cancel/i.test(String(error)) ? 130 : 1; }
        finally {
          pendingApproval?.("deny"); pendingApproval = undefined;
          if (!closed && queued.length) {
            const next = queued.shift()!; const nextEpoch = cancelEpoch;
            try {
              if (next.steer && controller.state && controller.state.status !== "completed") {
                await controller.steer(next.text); activeRun = undefined; run(undefined, false, nextEpoch);
              } else { activeRun = undefined; run(next.text, false, nextEpoch); }
            }
            catch (error) { activeRun = undefined; const message = terminalText(error instanceof Error ? error.message : String(error)); if (tui) tui.error(message); else process.stderr.write(`${message}\n`); showPrompt(); }
          } else { activeRun = undefined; showPrompt(); }
        }
      })();
    };
    const command = async (line: string): Promise<void> => {
      const commandEpoch = cancelEpoch;
      const [name, ...parts] = line.trim().split(/\s+/); const value = parts.join(" ");
      outputTitle = name.slice(1);
      if (name === "/cancel" || name === "/stop") { queued.length = 0; cancelTurn(); pendingApproval?.("deny"); pendingApproval = undefined; tui?.notice("Stopping the turn and clearing queued instructions; waiting for owned work to settle."); return; }
      if (name === "/quit" || name === "/exit") { closed = true; queued.length = 0; cancelTurn(); pendingApproval?.("deny"); pendingApproval = undefined; rl?.close(); tui?.stop(); return; }
      if (name === "/help") output(HELP);
      else if (name === "/status") output(controller.status());
      else if (name === "/usage") {
        const reconciliation = await controller.reconcileUsage();
        output({ session: controller.usageSnapshot(), turn: controller.turnUsageSnapshot(), reconciliation, server: await usageFor(resolved) });
      }
      else if (name === "/permissions") { if (value === "clear") await controller.clearPermissionGrants(); else if (value) { if (!["plan", "ask", "workspace"].includes(value)) throw new Error("Expected plan, ask, workspace or clear"); controller.gate.setProfile(value as PermissionProfile); } output(controller.gate.inspect()); }
      else if (name === "/effort") { if (value) { if (controller.busy) throw new Error("Change effort between turns"); if (!["low", "medium", "high", "max"].includes(value)) throw new Error("Expected low, medium, high or max"); controller.effort = value as EffortLevel; } output({ effort: controller.effort }); }
      else if (name === "/config") {
        if (value === "reload") { const next = await loadOrchestrationConfig(resolved.source); await controller.reloadConfiguration(next); resolved = next; }
        else if (parts[0] === "validate" || parts[0] === "diff") {
          const file = parts.slice(1).join(" "); if (!file) throw new Error("Usage: /config validate|diff PATH");
          const proposed = await loadOrchestrationConfig(path.resolve(file));
          if (parts[0] === "validate") output({ valid: true, source: proposed.source, hash: proposed.hash });
          else { const keys = new Set([...Object.keys(resolved.config), ...Object.keys(proposed.config)]); output({ current: resolved.hash, proposed: proposed.hash, changes: [...keys].filter(key => JSON.stringify((resolved.config as unknown as Record<string, unknown>)[key]) !== JSON.stringify((proposed.config as unknown as Record<string, unknown>)[key])).map(key => ({ setting: key, before: (resolved.config as unknown as Record<string, unknown>)[key], after: (proposed.config as unknown as Record<string, unknown>)[key] })), activated: false }); }
          return;
        } else if (value) throw new Error("Usage: /config [reload|validate PATH|diff PATH]");
        output({ source: resolved.source, hash: resolved.hash, configuration: resolved.config });
      }
      else if (name === "/models" || name === "/model") {
        if (!value) output({ source: resolved.source, configHash: resolved.hash, bindings: resolved.config.bindings, models: resolved.config.models, select: "/model select BINDING MODEL_ID [--save] (shared configuration)" });
        else {
          if (name !== "/model" || parts[0] !== "select" || ![3, 4].includes(parts.length) || parts.length === 4 && parts[3] !== "--save") throw new Error("Usage: /model select BINDING MODEL_ID [--save]. Preview first; --save changes the shared configuration for future turns and other consumers on reload.");
          if (activeRun || controller.busy) throw new Error("Change model bindings between turns");
          const [, binding, modelId] = parts;
          const proposed = proposeTerminalModel(resolved, binding, modelId);
          const active = new AbortController(); commandAbort = active;
          try {
            const signal = AbortSignal.any([active.signal, AbortSignal.timeout(15000)]);
            const selected = await new ConfiguredProvider(proposed, binding).select(terminalModelOperation(binding), signal, ["lead", "architect", "worker", "reviewer"].includes(binding));
            signal.throwIfAborted();
            if (commandEpoch !== cancelEpoch || closed) throw new Error("Cancelled before saving model selection");
            if (parts[3] === "--save") {
              await saveTerminalModel(resolved, proposed, signal);
              resolved = proposed;
              try { await controller.reloadConfiguration(proposed); }
              catch (error) { closed = true; queued.length = 0; tui?.stop(); rl?.close(); throw new Error(`Configuration saved to ${proposed.source}, but session activation failed. Restart Codali before continuing. ${error instanceof Error ? error.message : String(error)}`); }
            }
            output({ source: proposed.source, scope: "Shared configuration; other consumers apply it on reload", binding, modelId, backend: selected.actual.backend, health: selected.actual.health, configHash: proposed.hash, saved: parts[3] === "--save", activated: parts[3] === "--save", ...(parts[3] === "--save" ? {} : { apply: `/model select ${binding} ${modelId} --save` }) });
          } finally { if (commandAbort === active) commandAbort = undefined; }
        }
      }
      else if (name === "/goal") {
        if (parts[0] === "amend") { if (activeRun || controller.busy) throw new Error("Use /steer TEXT during a turn or stop before amending the goal"); const instruction = parts.slice(1).join(" "); if (!instruction) throw new Error("Usage: /goal amend INSTRUCTION"); await controller.steer(instruction); }
        else if (value && value !== "show") throw new Error("Usage: /goal [show|amend INSTRUCTION]");
        output(controller.state ? { original: controller.state.originalObjective, objective: controller.state.objective, revision: controller.state.goalRevision, constraints: controller.state.constraints, nonGoals: controller.state.nonGoals, requirements: controller.state.requirements, amendments: controller.state.amendments } : {});
      }
      else if (name === "/tasks") {
        if (!value) output({ tasks: controller.state?.tasks ?? [], media: await controller.artifacts() });
        else if (parts[0] === "media" && parts[1] && parts.length === 2) output(mediaJobSummary(await controller.mediaStore().read(parts[1])));
        else if (parts[0] === "cancel" && parts[1] && parts.length === 2) output(mediaJobSummary(await controller.mediaStore().cancel(parts[1])));
        else throw new Error("Usage: /tasks [media JOB_ID|cancel JOB_ID]. Cancellation is a request until the media worker confirms it.");
      }
      else if (name === "/plan") {
        if (parts[0] === "diff") { if (!controller.state) throw new Error("Start a goal before inspecting its plan"); if (parts.length > 3) throw new Error("Usage: /plan diff [FROM [TO]]"); output(inspectPlanDiff(controller.state, parts[1] === undefined ? undefined : Number(parts[1]), parts[2] === undefined ? undefined : Number(parts[2]))); return; }
        else if (parts[0] === "mode") { if (controller.busy) throw new Error("Cancel the active turn before changing plan mode"); if (!["plan", "execute"].includes(parts[1])) throw new Error("Usage: /plan mode plan|execute"); controller.gate.setProfile(parts[1] === "plan" ? "plan" : "ask"); }
        else if (parts[0] === "edit") { if (controller.busy) throw new Error("Cancel the active turn before revising the plan"); const instruction = parts.slice(1).join(" "); if (!instruction) throw new Error("Usage: /plan edit INSTRUCTION"); if (!controller.state) throw new Error("Start a goal before editing its plan"); controller.gate.setProfile("plan"); await controller.steer(`Revise the plan as requested: ${instruction}`); run(undefined, false, commandEpoch); return; }
        else if (value && !["show", "history"].includes(value)) throw new Error("Usage: /plan [show|history|diff [FROM [TO]]|edit INSTRUCTION|mode plan|execute]");
        output({ revision: controller.state?.planRevision ?? 1, mode: controller.gate.profile === "plan" ? "plan" : "execute", phases: controller.state?.phases ?? [], tasks: controller.state?.tasks ?? [], history: controller.state?.planHistory?.map(p => ({ revision: p.revision, goalRevision: p.goalRevision, at: p.at, reason: p.reason })) ?? [] });
      }
      else if (name === "/decisions") output(controller.state?.decisions ?? []);
      else if (name === "/context") output({ conversation: controller.conversationSnapshot(), goal: controller.state, configHash: resolved.hash });
      else if (name === "/diff") output(await controller.diff());
      else if (name === "/skills") {
        if (value) throw new Error("Usage: /skills. Ask Codali to use a named skill in your next message.");
        if (!controller.busy) await controller.skills.refresh();
        const catalog = controller.skills.list();
        const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
        output(["| Skill | Description |", "| --- | --- |", ...catalog.skills.map(skill => `| ${cell(skill.id)} | ${cell(skill.description)} |`),
          ...(!catalog.skills.length ? ["No skills found."] : []), "", ...catalog.warnings, "", "Ask Codali to use a skill by name. Add SKILL.md folders under .codali/skills or configure skills.directories."].join("\n"));
      }
      else if (name === "/tools") output(controller.registry.list().map(tool => ({ name: tool.name, description: tool.description })));
      else if (name === "/mcp") output({ connectors: controller.status().connectors, tools: controller.registry.list().filter(tool => tool.name.startsWith("mcp")).map(tool => ({ name: tool.name, description: tool.description })) });
      else if (name === "/docdex") output({ configuredRuntime: resolved.config.docdex, embedding: resolved.config.bindings.embedding, availableTools: controller.registry.list().filter(tool => tool.name.startsWith("docdex")).map(tool => tool.name), initialization: "Private repository indexing starts when execution needs it" });
      else if (name === "/sessions") output(await controller.store.listSessions());
      else if (name === "/artifacts") {
        if (!value) output(await controller.artifacts());
        else if (parts[0] === "export" && parts[1] && parts.length >= 3) {
          if (activeRun || controller.busy) throw new Error("Stop and wait for the current turn before exporting an artifact");
          output(await controller.exportArtifact(parts[1], parts.slice(2).join(" ")));
        } else if (parts[0] === "open" && parts[1] && parts.length === 2) {
          const active = new AbortController(); commandAbort = active;
          try { output({ opened: await openTerminalArtifact(controller.mediaStore(), parts[1], active.signal) }); }
          finally { if (commandAbort === active) commandAbort = undefined; }
        } else throw new Error("Usage: /artifacts [export JOB_ID PATH|open JOB_ID]");
      }
      else if (name === "/steer" && (activeRun || controller.busy)) { if (!value) throw new Error("Provide the correction"); queued.unshift({ text: value, steer: true }); cancelTurn(); tui?.notice("Cancelling the turn; steering will apply at the next safe checkpoint."); }
      else if (name === "/retention") { const days = value ? Number(value) : 30; if (!Number.isFinite(days) || days < 0) throw new Error("Retention days must be nonnegative"); output({ dryRun: true, days, candidates: (await controller.store.listSessions()).filter(s => s.status === "completed" && Date.parse(s.updatedAt) < Date.now() - days * 86_400_000).map(s => ({ id: s.sessionId, updatedAt: s.updatedAt })), action: "Use /delete-session ID to remove a reviewed session and its local artifacts" }); }
      else if (activeRun || controller.busy) throw new Error("This command requires an idle turn; use /cancel or queue an instruction");
      else if (name === "/resume") { await controller.resume(value); if (tui) { tui.restore((await controller.store.readTranscript(value)).map(item => item.data.event as SessionEvent).filter(Boolean)); showPrompt(); } else output(controller.status()); }
      else if (name === "/fork") { output({ sessionId: await controller.fork(), verification: "Fresh verification required; permissions were reset" }); }
      else if (name === "/delete-session") { await controller.deleteSession(value); output({ deleted: value }); }
      else if (name === "/new" || name === "/clear") {
        await controller.clearSession();
        tui?.restore([]); tui?.update({ activity: "Ready" });
        if (value) { tui?.user(value); run(value, true, commandEpoch); }
        else if (tui) tui.notice("Fresh session. Enter an objective to begin; previous sessions remain available through /sessions and /resume.");
        else output("Fresh session. Enter an objective to begin; previous sessions are preserved.");
      }
      else if (name === "/steer") { if (!value) throw new Error("Provide the correction"); await controller.steer(value); output(controller.state); }
      else if (name === "/continue") run(undefined, false, commandEpoch);
      else if (name === "/checkpoint") { await controller.checkpoint(value || "User checkpoint"); output("Checkpoint saved."); }
      else if (name === "/compact") { await controller.compact(); output("Context compacted."); }
      else if (name === "/review") { if (!controller.state) throw new Error("No goal to review"); await controller.steer("Review the current changes against the original goal and architecture decisions; fix concrete findings and reverify."); run(undefined, false, commandEpoch); }
      else if (name === "/reconcile") { const [id, outcome, ...note] = parts; if (!["success", "failed"].includes(outcome)) throw new Error("Usage: /reconcile ID success|failed observed outcome"); await controller.reconcile(id, outcome as "success" | "failed", note.join(" ")); output("Reconciliation recorded."); }
      else if (name === "/reconcile-media") { const [id, outcome, ...note] = parts; if (outcome !== "failed") throw new Error("Usage: /reconcile-media ID failed confirmed remote failure or cancellation; a lost response alone is not confirmation"); output(await controller.mediaStore().reconcileFailure(id, note.join(" ")).then(job => ({ id: job.id, status: job.status, reconciliation: job.reconciliation }))); }
      else if (name === "/export") { if (!controller.sessionId) throw new Error("No active session"); output({ schemaVersion: 1, state: controller.state, events: await controller.store.readTranscript(controller.sessionId) }); }
      else throw new Error(`Unknown command ${name}; use /help`);
    };
    const onSignal = (): void => { const now = Date.now(); if ((!activeRun && !controller.busy) || now - lastCtrlC < 1000) { closed = true; queued.length = 0; rl?.close(); tui?.stop(); } lastCtrlC = now; cancelTurn(); pendingApproval?.("deny"); pendingApproval = undefined; };
    const onTerminate = (): void => { closed = true; queued.length = 0; cancelTurn(); pendingApproval?.("deny"); pendingApproval = undefined; rl?.close(); tui?.stop(); };
    process.on("SIGINT", onSignal); process.on("SIGTERM", onTerminate);
    try {
    if (["sessions", "status", "resume", "inspect", "checkpoint", "amend"].includes(args.command)) {
      if (args.command === "sessions") { output(await controller.store.listSessions()); return; }
      const [id, ...rest] = args.prompt.split(" "); await controller.resume(id);
      if (args.command === "checkpoint") await controller.checkpoint(rest.join(" "));
      else if (args.command === "amend") await controller.steer(rest.join(" "));
      else if (args.command === "resume" && !interactive) { if (controller.state?.status === "completed") output(controller.status()); else { run(); await activeRun; } return; }
      if (args.command === "resume" && interactive) args.prompt = "";
      else { output(controller.status()); return; }
    }
      if (!interactive) { if (!args.prompt) throw new Error("Provide a prompt for noninteractive execution"); run(args.prompt); await activeRun; return; }
      const historyFile = path.join(path.dirname(controller.store.storageDir), "terminal-history.json");
      let history: string[] = [];
      try { const value = JSON.parse(await fs.readFile(historyFile, "utf8")); if (Array.isArray(value)) history = value.filter(v => typeof v === "string").slice(0, 500); } catch { /* First terminal session has no history. */ }
      if (!args.plain && process.stdout.isTTY && process.env.TERM !== "dumb") {
        let chain = Promise.resolve();
        const descriptions: Record<string, string> = { help: "Commands and keyboard shortcuts", status: "Workspace and current task", usage: "Usage and account limits", permissions: "Permission policy and grants", effort: "Model effort budget", models: "Configured model routes", config: "Inspect or reload configuration", goal: "Goal and requirements", plan: "Plan and dependencies", tasks: "Tasks, progress and media jobs", decisions: "Architecture decisions", context: "Retained task context", diff: "Inspect actual workspace changes", review: "Review and verify changes", sessions: "Saved sessions", artifacts: "Generated media and files", compact: "Compact context safely", checkpoint: "Save a checkpoint", continue: "Continue the current task", cancel: "Cancel the active turn", quit: "Close Codali" };
        const packageInfo = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
        tui = new TerminalTui({ workspace: controller.workspaceRoot, profile: resolved.config.profile, version: packageInfo.version, effort: args.effort, permissions: args.permissions, history,
          commands: COMMANDS.map(name => ({ name, description: descriptions[name.slice(1)] ?? name.slice(1).replace(/-/g, " ") })),
          cancel: onSignal, close: onTerminate,
          submit: (line, intent) => {
            if (/^\/(stop|cancel|exit|quit)\s*$/.test(line)) { void command(line).then(showPrompt).catch(error => tui!.error(String(error))); return; }
            const inputEpoch = cancelEpoch;
            chain = chain.then(async () => {
            if (closed || inputEpoch !== cancelEpoch) return;
            if (line.startsWith("/") && !/[\r\n]/.test(line)) { await command(line); showPrompt(); return; }
            tui!.user(line);
            if (activeRun || controller.busy) { if (intent === "steer") { queued.unshift({ text: line, steer: true }); cancelTurn(); tui!.notice("Cancelling the turn; steering will apply at the next safe checkpoint."); } else { queued.push({ text: line }); tui!.notice("Message queued for the next turn."); } }
            else run(line, false, inputEpoch);
            showPrompt();
          }).catch(error => tui!.error(redactSecretValues(error instanceof Error ? error.message : String(error)))); }
        });
        tui.start();
        if (controller.sessionId) { tui.restore((await controller.store.readTranscript(controller.sessionId)).map(item => item.data.event as SessionEvent).filter(Boolean)); showPrompt(); }
        if (args.prompt) { tui.user(args.prompt); run(args.prompt); }
        await tui.wait(); closed = true; cancelTurn(); await chain; await activeRun;
        await atomicWriteJson(historyFile, tui.editor.history.map(value => redactSecretValues(value))); return;
      }
      output(`Codali — ${resolved.config.profile}\nWorkspace: ${controller.workspaceRoot}\nUse /help for commands. Permissions: ${args.permissions}; effort: ${args.effort}.`);
      const pasteInput = args.plain ? undefined : new TerminalInput({ onPaste: text => { if (rl) insertTerminalPaste(rl, text); }, onRejected: message => { process.stderr.write(`${message}\n`); showPrompt(); } });
      const input = pasteInput ? Object.assign(pasteInput, { isTTY: process.stdin.isTTY, setRawMode: (mode: boolean) => process.stdin.setRawMode(mode) }) : process.stdin;
      rl = createInterface({ input, output: process.stdout, terminal: !args.plain, history, historySize: 500, removeHistoryDuplicates: true, completer: (line: string) => { const matches = COMMANDS.filter(c => c.startsWith(line)); return [matches.length ? matches : COMMANDS, line]; } });
      if (pasteInput) { process.stdout.write("\u001b[?2004h"); process.stdin.pipe(pasteInput); }
      rl.on("history", values => { history = values.map(value => redactSecretValues(value)); });
      rl.on("SIGINT", onSignal);
      let chain = Promise.resolve();
      rl.on("line", line => {
        if (/^\/(stop|cancel|exit|quit)\s*$/.test(line)) { void command(line).then(showPrompt).catch(error => process.stderr.write(`${terminalText(String(error))}\n`)); return; }
        const inputEpoch = cancelEpoch;
        chain = chain.then(async () => {
        if (closed || inputEpoch !== cancelEpoch) return;
        if (pendingApproval) { const response = line.trim().toLowerCase(); if (!["once", "session", "deny"].includes(response)) { process.stderr.write("Enter once, session or deny.\n"); return; } const resolve = pendingApproval; pendingApproval = undefined; resolve(response as "once" | "session" | "deny"); return; }
        if (!line.trim()) { showPrompt(); return; }
        if (line.startsWith("/") && !/[\r\n]/.test(line)) { await command(line); showPrompt(); }
        else if (activeRun || controller.busy) { queued.push({ text: line }); output("Instruction queued for the next turn. Use /cancel to interrupt first."); }
        else run(line, false, inputEpoch);
      }).catch(error => { process.stderr.write(`${terminalText(error instanceof Error ? error.message : String(error))}\n`); showPrompt(); }); });
      if (args.prompt) run(args.prompt); else showPrompt();
      await new Promise<void>(resolve => rl!.once("close", () => { closed = true; cancelTurn(); pendingApproval?.("deny"); pendingApproval = undefined;
        if (pasteInput) { process.stdin.unpipe(pasteInput); pasteInput.destroy(); process.stdout.write("\u001b[?2004l"); } resolve(); }));
      await chain; await activeRun; await atomicWriteJson(historyFile, history);
    } finally { process.off("SIGINT", onSignal); process.off("SIGTERM", onTerminate); rl?.close(); tui?.stop(); }
  }
}
