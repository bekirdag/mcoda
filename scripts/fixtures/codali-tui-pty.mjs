// Deterministic terminal fixture. It never calls a model or executes a tool.
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const packageRoot = process.env.CODALI_PACKAGE_ROOT ? pathToFileURL(path.resolve(process.env.CODALI_PACKAGE_ROOT) + path.sep) : new URL("../../packages/codali/", import.meta.url);
const [{ TerminalTui }, { TerminalCommand }, { SessionController }, { loadOrchestrationConfig }] = await Promise.all([
  import(new URL("dist/cli/tui/TerminalTui.js", packageRoot)),
  import(new URL("dist/cli/TerminalCommand.js", packageRoot)),
  import(new URL("dist/runtime/SessionController.js", packageRoot)),
  import(new URL("dist/config/OrchestrationConfig.js", packageRoot)),
]);
const [mode, workspace, log, configuration] = process.argv.slice(2);
const record = value => appendFileSync(log, JSON.stringify(value) + "\n");
if (mode === "models") {
  const { createServer } = await import("node:http");
  const { promises: fs } = await import("node:fs");
  let catalogs = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/v1/models") { record({ unexpectedRequest: request.url }); response.writeHead(500); response.end(); return; }
    const count = ++catalogs; record({ catalog: count });
    setTimeout(() => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "fixture" }, { id: "alternate" }] })); }, count === 3 ? 600 : 0);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = JSON.parse(await fs.readFile(configuration, "utf8"));
  config.providers.local.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  for (const id of ["alternate", "unentitled"]) config.models[id] = { ...config.models.fixture, catalogId: id };
  await fs.writeFile(configuration, JSON.stringify(config));
  SessionController.prototype.run = async function () { record({ executionStarted: true }); throw new Error("Model selection must not start inference"); };
  try { await TerminalCommand.run(["chat", "--workspace-root", workspace, "--config", configuration]); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
} else if (mode === "artifacts") {
  const [{ atomicWriteJson }, { persistMediaArtifact }] = await Promise.all([
    import(new URL("dist/session/AtomicState.js", packageRoot)), import(new URL("dist/connectors/media/MediaArtifactReceipt.js", packageRoot)),
  ]);
  const resolved = await loadOrchestrationConfig(configuration);
  const controller = new SessionController({ workspaceRoot: workspace, resolved, permissions: "ask" });
  await controller.start("Inspect generated artifacts without inference");
  const store = controller.mediaStore(); const now = new Date().toISOString();
  const job = { schemaVersion: 1, id: "pixel", sessionId: controller.sessionId, operation: "images.generations", binding: "image", modelId: "fixture", catalogId: "fixture", providerId: "local", configHash: resolved.hash, resolved, request: { prompt: "Pixel" }, status: "succeeded", createdAt: now, updatedAt: now };
  await atomicWriteJson(store.file(job.id), job);
  job.artifact = await persistMediaArtifact(path.dirname(store.file(job.id)), job, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6DNsAAAAASUVORK5CYII=", "base64"));
  await atomicWriteJson(store.file(job.id), job);
  await atomicWriteJson(store.file("render"), { ...job, id: "render", status: "running", artifact: undefined });
  SessionController.prototype.run = async function () { record({ executionStarted: true }); throw new Error("Artifact commands must not start inference"); };
  await TerminalCommand.run(["resume", controller.sessionId, "--workspace-root", workspace, "--config", configuration]);
  record({ cancelRequested: (await store.read("render")).cancelRequested, status: (await store.read("render")).status });
} else if (mode === "resume") {
  const controller = new SessionController({ workspaceRoot: workspace, resolved: await loadOrchestrationConfig(configuration), effort: "medium", permissions: "ask" });
  await controller.start("Saved user objective");
  await controller.emit("turn_result", { content: "Saved assistant response", completed: false });
  SessionController.prototype.run = async function () { record({ executionStarted: true }); return { content: "Continued only by explicit input", completed: false }; };
  await TerminalCommand.run(["resume", controller.sessionId, "--workspace-root", workspace, "--config", configuration]);
} else if (mode === "queue" || mode === "commands") {
  let turn = 0;
  SessionController.prototype.run = async function () {
    const current = ++turn;
    this.active = new AbortController(); const signal = this.active.signal;
    try {
      record({ turn: current, objective: this.state.objective, ...(mode === "commands" ? { sessionId: this.sessionId, originalObjective: this.state.originalObjective } : {}) });
      await this.emit("turn_started", {});
      if (signal.aborted) throw new Error("Cancelled by user");
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, mode === "commands" && current === 1 ? 30000 : 500);
        signal.addEventListener("abort", () => { clearTimeout(timeout); reject(new Error("Cancelled by user")); }, { once: true });
      });
      await this.update(state => { state.status = "completed"; });
      await this.emit("turn_result", { content: `Fixture turn ${current} complete`, completed: true });
      return { content: `Fixture turn ${current} complete`, completed: true };
    } finally { this.active = undefined; }
  };
  await TerminalCommand.run(["chat", "--workspace-root", workspace, "--config", configuration]);
} else if (mode === "startup" || mode === "new-startup") {
  const method = mode === "startup" ? "start" : "clearSession";
  const original = SessionController.prototype[method];
  SessionController.prototype[method] = async function (objective) {
    record({ initializing: true });
    await new Promise(resolve => setTimeout(resolve, 600));
    return original.call(this, objective);
  };
  SessionController.prototype.run = async function () { record({ executionStarted: true }); return { content: "Unexpected execution", completed: false }; };
  await TerminalCommand.run(["chat", "--workspace-root", workspace, "--config", configuration]);
} else {
  let interval, abort;
  let sequence = 0;
  const event = (type, data) => ({ schemaVersion: 1, sessionId: "fixture", id: String(++sequence), sequence, type, data, at: new Date().toISOString() });
  const ui = new TerminalTui({
    workspace, version: "PTY fixture", profile: "fixture", effort: "medium", permissions: "ask",
    history: ["previous instruction"], commands: [{ name: "/approval", description: "Fixture approval" }, { name: "/quit", description: "Exit fixture" }],
    submit: async (text, intent) => {
      record({ text, intent });
      if (text === "/quit") return close();
      if (text === "/approval") {
        abort = new AbortController();
        const result = await ui.approve("Permission: fixture", Array.from({ length: 70 }, (_, i) => `argument-${i}: complete value`).join("\n") + "\nLAST_ARGUMENT", abort.signal);
        record({ approval: result }); ui.notice(`Decision: ${result}`); return;
      }
      if (text === "/stream") {
        ui.event(event("turn_started", {}));
        let count = 0;
        interval = setInterval(() => {
          ui.event(event("token", { content: `stream-${++count} ` }));
          ui.event(event("usage", { usage: { tokens: count } }));
          if (count === 300) { clearInterval(interval); interval = undefined; ui.event(event("turn_result", { completed: false })); }
        }, 2);
        return;
      }
      ui.user(text); ui.notice("Message captured");
    },
    cancel: () => { abort?.abort(); clearInterval(interval); interval = undefined; ui.update({ busy: false }); record({ cancelled: true }); },
    close: () => close(),
  });
  function close() { abort?.abort(); clearInterval(interval); ui.stop(); }
  process.on("SIGTERM", close);
  ui.start();
  await ui.wait();
  process.off("SIGTERM", close);
}
writeFileSync(log + ".closed", JSON.stringify({ raw: process.stdin.isRaw }));
