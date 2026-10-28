import test from "node:test";
import assert from "node:assert/strict";
import { TerminalTui } from "../TerminalTui.js";
import type { SessionEvent } from "../../../runtime/SessionController.js";

const make = (): TerminalTui => new TerminalTui({ workspace: "/tmp/project", version: "preview", profile: "local", effort: "medium", permissions: "ask", history: [], commands: [], submit: () => {}, cancel: () => {}, close: () => {} });
const event = (type: string, data: Record<string, unknown>): SessionEvent => ({ schemaVersion: 1, id: "fixture", sessionId: "fixture", sequence: 1, at: new Date(0).toISOString(), type, data });

test("streamed terminal controls cannot become clipboard or screen commands", () => {
  const ui = make();
  ui.event(event("turn_started", {}));
  ui.event(event("token", { content: "hello\x1b]52;c;" }));
  ui.event(event("token", { content: "clipboard\x07 world" }));
  ui.event(event("turn_result", { completed: true }));
  assert.equal(ui.state.blocks[0].text, "hello world");
  assert.equal(ui.state.busy, false);
});

test("streamed final content is not duplicated and actual usage updates status", () => {
  const ui = make(); ui.event(event("turn_started", {}));
  ui.event(event("token", { content: "Completed the change." }));
  ui.event(event("usage", { usage: { tokens: 1200 } }));
  ui.event(event("turn_result", { completed: true })); ui.result("Completed the change.");
  assert.equal(ui.state.blocks.length, 1); assert.equal(ui.state.tokens, 1200);
});

test("approval abort denies and clears the modal without input", async () => {
  const ui = make(), signal = new AbortController();
  const result = ui.approve("shell", "command: test", signal.signal);
  assert.equal(ui.state.overlay?.selected, 2);
  signal.abort(); assert.equal(await result, "deny"); assert.equal(ui.state.overlay, undefined);
});

test("completed tool cards retain actual results and sanitize terminal escapes", () => {
  const ui = make();
  ui.event(event("tool_intent", { receipt: { id: "read", tool: "read_file", args: { path: "src/main.ts" } } }));
  ui.event(event("tool_receipt", { receipt: { id: "read", tool: "read_file", status: "success", args: { path: "src/main.ts" }, output: "export const value = 42;\x1b[2J" } }));
  assert.match(ui.state.blocks[0].title, /success/);
  assert.match(ui.state.blocks[0].text, /src\/main\.ts/);
  assert.match(ui.state.blocks[0].text, /export const value = 42;/);
  assert.doesNotMatch(ui.state.blocks[0].text, /\x1b/);
});

test("workspace labels and persisted history cannot inject terminal controls", () => {
  const ui = new TerminalTui({ workspace: "/tmp/\x1b[2Jproject", version: "preview", profile: "local", effort: "medium", permissions: "ask", history: ["x\x1b]52;c;secret\x07y"], commands: [], submit: () => {}, cancel: () => {}, close: () => {} });
  assert.doesNotMatch(ui.state.workspace, /\x1b/); assert.equal(ui.editor.history[0], "xy");
});

test("late inspection cannot hide a pending approval", async () => {
  const ui = make(), signal = new AbortController();
  const result = ui.approve("Confirm action", "Complete arguments", signal.signal);
  ui.show({ answer: 42 }, "Usage");
  assert.equal(ui.state.overlay?.title, "Confirm action");
  signal.abort();
  assert.equal(await result, "deny");
  assert.equal(ui.state.overlay?.title, "Usage");
});

test("restoring another session resets stale usage and route and rebuilds conversation", () => {
  const ui = make();
  ui.event(event("usage", { usage: { tokens: 1200 } }));
  ui.event(event("model_route", { modelId: "old" }));
  ui.restore([
    event("session_started", { objective: "New goal" }),
    event("goal_amended", { instruction: "Keep the public API" }),
    event("turn_result", { content: "Verified the change" }),
  ]);
  assert.equal(ui.state.tokens, 0); assert.equal(ui.state.route, "");
  assert.equal(ui.state.session, "fixture");
  assert.deepEqual(ui.state.blocks.map(block => [block.kind, block.text]), [
    ["user", "New goal"], ["user", "Keep the public API"], ["assistant", "Verified the change"],
  ]);
});
