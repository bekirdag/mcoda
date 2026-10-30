import test from "node:test";
import assert from "node:assert/strict";
import { PermissionGate } from "../PermissionGate.js";
import type { ToolDescriptor } from "../../tools/ToolTypes.js";
const tool = (name: string, readOnly = false): ToolDescriptor => ({ name, readOnly, capability: "workspace", description: name });
test("document extraction is read-only and file creation requires workspace writes", async () => {
  const gate = new PermissionGate("plan");
  await gate.authorize(tool("document_read", true), { path: "input.pdf" });
  await assert.rejects(gate.authorize(tool("document_create"), { path: "output.pdf" }), /Planning mode/);
  await assert.rejects(gate.authorize(tool("document_read", false), {}), /Planning mode/);
  await new PermissionGate("workspace").authorize(tool("document_create"), { path: "output.pdf" });
  await assert.rejects(new PermissionGate("plan", undefined, { deniedTools: ["document_read"] }).authorize(tool("document_read", true), {}), /explicitly denied/);
});
test("only the trusted bounded verifier is a read capability, and explicit denial still wins", async () => {
  const verifier = { ...tool("verify_javascript", true), capability: "verification" };
  const gate = new PermissionGate("plan");
  await gate.authorize(verifier, {});
  await assert.rejects(gate.authorize({ ...verifier, capability: "workspace" }, {}), /Planning mode/);
  await assert.rejects(gate.authorize({ ...verifier, readOnly: false }, {}), /Planning mode/);
  await assert.rejects(new PermissionGate("plan", undefined, { deniedTools: ["verify_javascript"] }).authorize(verifier, {}), /explicitly denied/);
  await gate.authorize({ ...tool("tools_describe", true), capability: "discovery" }, {});
  await assert.rejects(gate.authorize(tool("tools_describe", true), {}), /Planning mode/);
});
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
test("planning retains plan controls but refuses execution work tools despite readOnly hints", async () => {
  const gate = new PermissionGate("plan");
  const execution = ["work_claim", "work_verify", "work_complete"];
  for (const name of execution) await assert.rejects(gate.authorize(tool(name, true), {}), /Planning mode/);
  for (const name of ["work_status", "work_refine", "work_plan", "work_checkpoint", "work_decision"]) await gate.authorize(tool(name, true), {});
  gate.setProfile("workspace");
  for (const name of execution) await gate.authorize(tool(name, true), {});
  gate.setProfile("plan");
  for (const name of execution) await assert.rejects(gate.authorize(tool(name, true), {}), /Planning mode/);
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
