import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { readFileSync } from "node:fs";
import { DocdexClient } from "../DocdexClient.js";
import { docdexCatalog, docdexCatalogKind } from "../DocdexCatalog.js";
import { createDocdexTools } from "../../tools/docdex/DocdexTools.js";
import { ToolRegistry, toolDescriptorFor } from "../../tools/ToolRegistry.js";
import { permissionKind } from "../../permissions/PermissionGate.js";

test("all 107 advertised Docdex tools have explicit policies and callable wrappers", () => {
  const client = new DocdexClient({ baseUrl: "http://127.0.0.1:1", repoRoot: os.tmpdir() });
  const tools = createDocdexTools(client, { includeCatalog: true });
  assert.equal(docdexCatalog.length, 107);
  for (const entry of docdexCatalog) { assert.ok(docdexCatalogKind(entry.name), entry.name); assert.ok(tools.find(tool => tool.name === entry.name), entry.name); }
  assert.equal(docdexCatalogKind("docdex_future_delete"), undefined);
  for (const name of ["docdex_conversation_delete", "docdex_kg_clear", "docdex_personal_preferences_generated_skill_install"]) {
    const tool = tools.find(tool => tool.name === name)!; assert.equal(tool.readOnly, false); assert.equal(permissionKind(toolDescriptorFor(tool)), "external");
  }
  assert.equal(permissionKind(toolDescriptorFor(tools.find(tool => tool.name === "docdex_personal_preferences_generated_skill_validate")!)), "memory");
});

test("standard MCP catalog initializes, caches discovery and binds repository/agent scope", async t => {
  const calls: Array<{ method: string; params: any }> = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") { res.end('{"status":"ok"}'); return; }
    let raw = ""; for await (const chunk of req) raw += chunk; const call = JSON.parse(raw); calls.push(call);
    if (call.method === "initialize") { res.setHeader("mcp-session-id", "catalog-session"); res.end(JSON.stringify({ result: { protocolVersion: "2024-11-05" } })); return; }
    assert.equal(req.headers["mcp-session-id"], "catalog-session");
    res.end(JSON.stringify({ result: call.method === "tools/list" ? { tools: docdexCatalog } : { structuredContent: { scoped: call.params.arguments } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const client = new DocdexClient({ baseUrl: `http://127.0.0.1:${address.port}`, repoRoot: os.tmpdir() });
  const registry = new ToolRegistry(); for (const tool of createDocdexTools(client, { includeCatalog: true })) registry.register(tool);
  const first = await registry.execute("docdex_conversation_list", { project_root: "/secret", conversation_namespace: "outside", agent_id: "other" }, { workspaceRoot: os.tmpdir() });
  assert.equal(first.ok, true, first.error?.message); const args = JSON.parse(first.output).scoped;
  assert.equal(args.project_root, os.tmpdir()); assert.equal(args.agent_id, "codali-terminal"); assert.equal(args.conversation_namespace, undefined);
  await client.callCatalog("docdex_memory_layers", { project_root: os.tmpdir() });
  // Exercise each memory lane through the real registry, not just catalog names.
  for (const [name, input] of [
    ["docdex_memory_store", { text: "Verified fixture fact" }],
    ["docdex_personal_preferences_status", {}],
    ["docdex_kg_timeline", { entity: "fixture" }],
    ["docdex_conversation_hook", { action: "periodic_memory_save", summary_text: "Fixture milestone" }],
    ["docdex_memory_route", { query: "remember an explicit preference" }],
  ] as const) {
    const result = await registry.execute(name, input, { workspaceRoot: os.tmpdir() });
    assert.equal(result.ok, true, `${name}: ${result.error?.message}`);
  }
  const delegated = await registry.execute("docdex_local_completion", { task_type: "general_question", instruction: "Return OK", context: "Fixture", agent: "model:unapproved", mode: "draft_then_refine", max_tokens: 9000 }, { workspaceRoot: os.tmpdir() });
  assert.equal(delegated.ok, true, delegated.error?.message);
  const delegatedArgs = JSON.parse(delegated.output).scoped;
  assert.equal(delegatedArgs.agent, undefined, "shared daemon routing must not be overridden");
  assert.equal(delegatedArgs.mode, "draft_only");
  assert.equal(delegatedArgs.max_tokens, 2048);
  assert.equal(delegatedArgs.project_root, os.tmpdir());
  assert.equal(calls.filter(call => call.method === "initialize").length, 1); assert.equal(calls.filter(call => call.method === "tools/list").length, 1);
});

test("lazy Docdex skill reference covers every bundled native tool", () => {
  const reference = readFileSync(new URL("../../../config/skills/docdex-research/references/catalog.md", import.meta.url), "utf8");
  for (const entry of docdexCatalog) assert.ok(reference.includes(`**${entry.name}**`), entry.name);
  const skill = readFileSync(new URL("../../../config/skills/docdex-research/SKILL.md", import.meta.url), "utf8");
  assert.ok(skill.length <= 2400, "entrypoint must fit a normal skill load");
  for (const name of ["memory", "retrieval", "operations", "catalog"]) {
    assert.ok(skill.includes(`references/${name}.md`));
    assert.ok(readFileSync(new URL(`../../../config/skills/docdex-research/references/${name}.md`, import.meta.url), "utf8").length < 65536);
  }
});

test("catalog scopes and unknown RPC methods cannot bypass immutable operation restrictions", async () => {
  const client = new DocdexClient({ baseUrl: "http://127.0.0.1:1", repoRoot: os.tmpdir(), repoId: "fixed", apiKey: "fixture", immutableRuntimeContext: true, allowedOperations: ["search"], capabilities: { search: true } });
  await assert.rejects(client.callCatalog("docdex_kg_clear", {}), /not allowed/);
  await assert.rejects(client.callMcp("docdex_future_delete", {}), /Unknown Docdex operation/);
  await assert.rejects(client.callMcp("tools\/call", { name: "docdex_kg_clear" }), /Unknown Docdex operation/);
});
