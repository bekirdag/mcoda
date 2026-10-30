import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { registerSecretValue, StreamingSecretRedactor } from "../runtime/SecretRedaction.js";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Provider, ProviderMessage } from "../providers/ProviderTypes.js";
import { ConfiguredEmbeddings } from "../providers/ConfiguredEmbeddings.js";
import { DocdexClient } from "./DocdexClient.js";
import { runtimeFileHash } from "./ManagedRuntime.js";

const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve((server.address() as { port: number }).port); });
});
const closeServer = async (server?: Server) => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
};

/** A private Docdex process whose inference is routed through the owning controller. */
export class ManagedDocdex {
  private child?: ChildProcess;
  private bridge?: Server;
  private launchDirectory?: string;
  private abort?: () => void;
  private diagnostic = "";
  private activeRequests = 0;
  private readonly lifetime = new AbortController();
  constructor(private readonly options: {
    workspaceRoot: string; stateRoot: string; embeddings: ConfiguredEmbeddings; provider: Provider;
    binary?: string; binarySha256?: string; signal?: AbortSignal; allowWeb?: boolean; startupTimeoutMs?: number;
    webSearch?: (query: string, signal: AbortSignal) => Promise<unknown>;
    onStatus?: (status: string) => void;
  }) {}

  async start(): Promise<DocdexClient> {
    this.options.signal?.throwIfAborted();
    if (this.child || this.bridge) throw new Error("Managed Docdex already started");
    if (this.options.binarySha256 && (!this.options.binary || await runtimeFileHash(this.options.binary) !== this.options.binarySha256)) throw new Error("Managed Docdex runtime checksum mismatch; run codali doctor before continuing");
    const { embeddings } = this.options;
    const root = path.join(this.options.stateRoot, embeddings.space.id);
    await embeddings.pin(root);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    this.launchDirectory = await fs.mkdtemp(path.join(root, "launch-"));
    const capability = randomBytes(32).toString("hex");
    const authToken = randomBytes(32).toString("hex");
    registerSecretValue(capability); registerSecretValue(authToken);
    const model = `codali-embedding-${embeddings.space.id}`;
    const signal = AbortSignal.any([this.lifetime.signal, ...(this.options.signal ? [this.options.signal] : [])]);
    const prefix = `/${capability}`;
    this.bridge = createServer(async (request, response) => {
      const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      // Docdex resolves the web route from the origin, discarding baseUrl paths.
      // Accept only this exact route with the ephemeral header capability.
      const webRoute = request.url === "/v1/swarm/web/search" && request.headers["x-api-key"] === capability;
      if (request.headers.origin || (!webRoute && !request.url?.startsWith(`${prefix}/`))) { send(403, { error: "forbidden" }); return; }
      if (this.activeRequests >= 2) { send(429, { error: "managed inference busy" }); return; }
      this.activeRequests++;
      const requestAbort = new AbortController();
      const onClose = () => { if (!response.writableEnded) requestAbort.abort(); };
      response.once("close", onClose);
      try {
        const route = webRoute ? request.url! : request.url!.slice(prefix.length);
        if (request.method === "GET" && route === "/api/version") { send(200, { version: "codali-managed-v1" }); return; }
        if (request.method === "GET" && route === "/api/tags") { send(200, { models: [{ name: "configured-docdex-helper", model: "configured-docdex-helper" }] }); return; }
        if (request.method !== "POST") { send(405, { error: "method not allowed" }); return; }
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 1_048_576) { send(413, { error: "request too large" }); return; }
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        const requestSignal = AbortSignal.any([signal, requestAbort.signal]);
        if (route === "/v1/swarm/web/search") {
          if (!this.options.allowWeb || !this.options.webSearch || request.headers["x-api-key"] !== capability) { send(403, { error: "web research unavailable" }); return; }
          if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 4000 || body.tool_id !== "docdex") { send(400, { error: "invalid web query" }); return; }
          send(200, await this.options.webSearch(body.query, requestSignal)); return;
        }
        if (route === "/v1/embeddings") {
          if (body.model !== model || !["query", "document"].includes(String(body.input_type))) { send(400, { error: "managed embedding identity and input_type are required" }); return; }
          const input = typeof body.input === "string" ? [body.input] : body.input;
          if (!Array.isArray(input) || input.some(text => typeof text !== "string")) { send(400, { error: "invalid embedding input" }); return; }
          const vectors = await embeddings.embed(input, body.input_type as "query" | "document", requestSignal);
          send(200, { object: "list", model, data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })) }); return;
        }
        if (body.model !== "configured-docdex-helper") { send(400, { error: "undeclared inference model" }); return; }
        if (route === "/api/show") { send(200, { capabilities: ["completion"], model_info: { "general.architecture": "managed" } }); return; }
        if (!["/api/chat", "/api/generate"].includes(route)) { send(404, { error: "unsupported managed inference operation" }); return; }
        const messages: ProviderMessage[] = route === "/api/generate" && typeof body.prompt === "string"
          ? [{ role: "user", content: body.prompt }] : body.messages as ProviderMessage[];
        if (!Array.isArray(messages) || messages.length > 128 || messages.some(message => !message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string")) { send(400, { error: "invalid inference messages" }); return; }
        const requested = body.options && typeof body.options === "object" ? (body.options as Record<string, unknown>).num_predict : undefined;
        const maxTokens = typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0 ? Math.min(2048, requested) : 2048;
        const result = await this.options.provider.generate({ messages, signal: requestSignal, stream: false, maxTokens });
        send(200, { model: "configured-docdex-helper", created_at: new Date().toISOString(), done: true,
          message: { role: "assistant", content: result.message.content }, response: result.message.content,
          ...(result.usage ? { prompt_eval_count: result.usage.inputTokens, eval_count: result.usage.outputTokens } : {}) });
      } catch { if (!response.headersSent) send(502, { error: "Managed inference failed; consult the owning session receipts" }); }
      finally { this.activeRequests--; response.removeListener("close", onClose); }
    });
    try {
      const bridgePort = await listen(this.bridge);
      const bridgeBase = `http://127.0.0.1:${bridgePort}${prefix}`;
      const reservation = createServer(); const port = await listen(reservation); await closeServer(reservation);
      const configPath = path.join(this.launchDirectory, "config.toml");
      const repositoryState = path.join(root, "repositories", createHash("sha256").update(path.resolve(this.options.workspaceRoot)).digest("hex"));
      const config = `[core]\nglobal_state_dir = ${JSON.stringify(root)}\n[server]\nhttp_bind_addr = "127.0.0.1:${port}"\n[llm]\nprovider = "ollama"\nbase_url = ${JSON.stringify(bridgeBase)}\ndefault_model = "configured-docdex-helper"\nembedding_model = ${JSON.stringify(model)}\n[llm.delegation]\nenabled = false\nauto_enable = false\n[memory]\nenabled = true\n[memory.profile]\nembedding_model = "hash-embed-v1"\nembedding_dim = 768\n[memory.conversations]\nenabled = true\nauto_capture = false\n[memory.personal_preferences]\nenabled = false\n[memory.user_memory_sync]\nenabled = false\n`;
      // The private process sees only a short-lived bridge credential. The host
      // retains the service credential and owns authorization/audit at tool entry.
      const webConfig = this.options.allowWeb && this.options.webSearch
        ? `\n[web]\ndiscovery_provider = "mswarm"\n[integrations.mswarm]\nbase_url = ${JSON.stringify(bridgeBase)}\napi_key = ${JSON.stringify(capability)}\n` : "";
      await fs.writeFile(configPath, config + webConfig, { mode: 0o600, flag: "wx" });
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SystemRoot"]) if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, { DOCDEX_CONFIG_PATH: configPath, DOCDEX_AUTH_TOKEN: authToken,
        DOCDEX_DAEMON_LOCK_PATH: path.join(this.launchDirectory, "daemon.lock"),
        DOCDEX_MANAGED_INSTANCE: "1",
        DOCDEX_HTTP_BASE_URL: `http://127.0.0.1:${port}`,
        DOCDEX_EMBEDDING_PROVIDER: "llama-cpp", DOCDEX_EMBEDDING_BASE_URL: `${bridgeBase}/v1`, DOCDEX_EMBEDDING_MODEL: model,
        DOCDEX_PROFILE_EMBEDDING_PROVIDER: "hash", DOCDEX_PROFILE_EMBEDDING_MODEL: "hash-embed-v1",
        DOCDEX_PROFILE_STATE_DIR: path.join(this.options.stateRoot, "global-profile"),
        DOCDEX_EMBEDDING_SEND_PURPOSE: "1", DOCDEX_EMBEDDING_STRICT: "1", DOCDEX_WEB_ENABLED: this.options.allowWeb ? "1" : "0",
        DOCDEX_DISABLE_METRICS: "1", DOCDEX_WORKSPACE_METADATA: "0" });
      this.child = spawn(this.options.binary ?? "docdexd", ["serve", "--repo", this.options.workspaceRoot, "--state-dir", repositoryState,
        "--workspace-metadata=false", "--host", "127.0.0.1", "--port", String(port), "--enable-memory=true", "--enable-mcp", "--mcp-ipc", "off", "--preflight-check=false", "--log", "warn"],
      { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let startError: Error | undefined;
      this.child.on("error", error => { startError = error; });
      const diagnosticRedactor = new StreamingSecretRedactor();
      const output = (chunk: Buffer) => { this.diagnostic = (this.diagnostic + diagnosticRedactor.write(chunk.toString())).slice(-4000); };
      this.child.stdout?.on("data", output); this.child.stderr?.on("data", output);
      this.abort = () => { this.child?.kill("SIGTERM"); };
      signal.addEventListener("abort", this.abort, { once: true });
      const baseUrl = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + (this.options.startupTimeoutMs ?? 90_000);
      this.options.onStatus?.("Starting private Docdex with configured embedding space");
      while (true) {
        signal.throwIfAborted();
        if (startError || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`Managed Docdex failed to start: ${startError?.message ?? this.diagnostic}`);
        try {
          const response = await fetch(`${baseUrl}/v1/capabilities`, { headers: { authorization: `Bearer ${authToken}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
          if (response.ok) {
            const capabilities = await response.json() as { managed_clients?: Record<string, boolean> };
            if (!["workspace_metadata_control", "embedding_input_type", "strict_repo_embeddings", "deterministic_profile_embeddings"].every(key => capabilities.managed_clients?.[key])) throw new Error("Managed Docdex capabilities missing");
            return new DocdexClient({ baseUrl, repoRoot: this.options.workspaceRoot, authToken, localSearchOnly: true, timeoutMs: 30_000, signal: () => signal });
          }
        } catch (error) { if (error instanceof Error && error.message === "Managed Docdex capabilities missing") throw error; }
        if (Date.now() >= deadline) throw new Error(`Managed Docdex startup timed out: ${this.diagnostic}`);
        await delay(200, undefined, { signal });
      }
    } catch (error) { await this.close(); throw error; }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    const child = this.child; this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await Promise.race([exited, delay(1000)]); }
    }
    await closeServer(this.bridge); this.bridge = undefined;
    if (this.launchDirectory) await fs.rm(this.launchDirectory, { recursive: true, force: true });
    this.launchDirectory = undefined;
  }
}
