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
if (mode === "resume") {
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
