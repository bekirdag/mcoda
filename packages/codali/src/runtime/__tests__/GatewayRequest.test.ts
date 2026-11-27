import test from "node:test";
import assert from "node:assert/strict";
import { interactionCallProblem, normalizeGatewayRequest, unwrapSelfEnvelope } from "../GatewayRequest.js";

test("unwraps only unambiguous redundant gateway envelopes", () => {
  const request = { name: "browser_read", args: { snapshotId: "x", query: "y" } };
  assert.deepEqual(normalizeGatewayRequest({ name: "codali", args: request }), request);
  assert.deepEqual(normalizeGatewayRequest({ args: request }), request);
  assert.deepEqual(normalizeGatewayRequest({ name: "codali", args: { args: request } }), request);
  assert.equal(normalizeGatewayRequest(request), request);
});

test("does not discard unknown fields, guess names, alter arguments or unwrap without a bound", () => {
  for (const request of [
    { name: "codali", args: { name: "read_file", args: {} }, extra: true },
    { tool: "read_file", input: {} }, { name: "codali", args: [] },
    { name: "read_file", args: { name: "codali", args: { secret: "not a tool request" } } },
  ]) assert.equal(normalizeGatewayRequest(request), request);
  let request: Record<string, unknown> = { name: "read_file", args: { path: "x" } };
  for (let i = 0; i < 5; i++) request = { name: "codali", args: request };
  assert.equal(normalizeGatewayRequest(request).name, "codali");
  assert.deepEqual(normalizeGatewayRequest(null), {});
});

// Cycle 7 (.43 WP-F1): the model mixed the gateway envelope with native tool
// calls. Fresh variants with list_files; only the envelope is removed.
test("recovers the mixed envelope forms without guessing a tool", () => {
  const listFiles = { name: "list_files", inputSchema: { type: "object", properties: { dir: { type: "string" }, depth: { type: "number" } } } };
  assert.deepEqual(normalizeGatewayRequest({ name: "codali", args: { name: "list_files", args: { dir: "src" } } }), { name: "list_files", args: { dir: "src" } });
  assert.deepEqual(normalizeGatewayRequest({ name: "codali", args: { name: "list_files", dir: "src", depth: 2 } }), { name: "list_files", args: { dir: "src", depth: 2 } });
  assert.deepEqual(normalizeGatewayRequest({ name: "list_files", dir: "src" }), { name: "list_files", args: { dir: "src" } });
  assert.deepEqual(unwrapSelfEnvelope("list_files", { name: "list_files", args: { dir: "src" } }, listFiles), { dir: "src" });
  assert.deepEqual(unwrapSelfEnvelope("list_files", { name: "list_files", dir: "src" }, listFiles), { dir: "src" });
  // A tool whose own schema takes name keeps its arguments untouched.
  const rename = { name: "rename_entity", inputSchema: { type: "object", properties: { name: { type: "string" }, to: { type: "string" } } } };
  assert.equal(unwrapSelfEnvelope("rename_entity", { name: "rename_entity", to: "x" }, rename), undefined);
  assert.equal(unwrapSelfEnvelope("list_files", { name: "other_tool", args: {} }, listFiles), undefined);
  assert.equal(unwrapSelfEnvelope("list_files", { dir: "src" }, listFiles), undefined);
});

test("a codali call without a tool name says what is missing and the corrected call", () => {
  const tools = [
    { name: "run_suite", inputSchema: { type: "object", properties: { runner: {}, files: {} } } },
    { name: "list_files", inputSchema: { type: "object", properties: { dir: {} } } },
  ];
  const raw = { name: "codali", args: { runner: "node", files: [] } };
  const message = interactionCallProblem("codali", normalizeGatewayRequest(raw), ["list_files", "final_answer", "codali"], tools, true, raw);
  assert.match(message, /names no tool/);
  assert.match(message, /"codali" is the gateway itself/);
  assert.match(message, /codali\(\{name:"run_suite", args:\{runner:…, files:…\}\}\)/);
  assert.doesNotMatch(message, /Final answers|only call in their batch/);
  assert.match(interactionCallProblem("codali", {}, ["list_files", "final_answer"], tools, true), /"codali" is not declared in this turn.*list_files\(/);
  assert.match(interactionCallProblem("list_files", { dir: "src" }, ["codali", "start_work"], tools, false), /only through codali.*codali\(\{name:"list_files", args:\{dir:…\}\}\)/);
  assert.match(interactionCallProblem("codali", { name: "list_files", args: { dir: "a" }, depth: 1 }, ["codali"], tools, false), /keys depth were given beside name and args/);
});
