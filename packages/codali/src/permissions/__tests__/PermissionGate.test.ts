import test from "node:test";
import assert from "node:assert/strict";
import { PermissionGate } from "../PermissionGate.js";
import type { ToolDescriptor } from "../../tools/ToolTypes.js";
const tool = (name: string, readOnly = false): ToolDescriptor => ({ name, readOnly, capability: "workspace", description: name });
test("planning denies writes even with a previous session grant", async () => {
  const gate = new PermissionGate("ask", async () => ({ allow: true, scope: "session" }));
  await gate.authorize(tool("write_file"), { path: "a" });
  gate.setProfile("plan");
  await assert.rejects(gate.authorize(tool("write_file"), { path: "a" }), /Planning mode/);
  await gate.authorize(tool("read_file", true), { path: "a" });
});
test("unknown external read hints and generation require approval", async () => {
  const gate = new PermissionGate("workspace");
  await assert.rejects(gate.authorize(tool("untrusted_remote", true), {}), /Permission is required/);
  await assert.rejects(gate.authorize(tool("image_generate", true), {}), /Permission is required/);
});
test("workspace execution fails closed without an isolation backend", async () => {
  await assert.rejects(new PermissionGate("workspace").authorize(tool("run_shell"), { command: "node" }), /isolated shell/);
});
test("a permission change while awaiting approval is rechecked", async () => {
  let finish!: (v: { allow: boolean }) => void;
  const gate = new PermissionGate("ask", () => new Promise(resolve => { finish = resolve; }));
  const pending = gate.authorize(tool("write_file"), { path: "a" });
  gate.setProfile("plan"); finish({ allow: true });
  await assert.rejects(pending, /Planning mode/);
});

test("persisted session grants remain exact and cannot bypass a stronger current policy", async () => {
  const first = new PermissionGate("ask", async () => ({ allow: true, scope: "session" }));
  await first.authorize(tool("write_file"), { path: "a", content: "approved" });
  const resumed = new PermissionGate("ask");
  resumed.restoreGrants(first.exportGrants());
  await resumed.authorize(tool("write_file"), { path: "a", content: "approved" });
  await assert.rejects(resumed.authorize(tool("write_file"), { path: "a", content: "different" }), /Permission is required/);
  resumed.setProfile("plan");
  await assert.rejects(resumed.authorize(tool("write_file"), { path: "a", content: "approved" }), /Planning mode/);
});
