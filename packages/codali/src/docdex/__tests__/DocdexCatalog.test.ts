import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
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
  assert.equal(calls.filter(call => call.method === "initialize").length, 1); assert.equal(calls.filter(call => call.method === "tools/list").length, 1);
});

test("catalog scopes and unknown RPC methods cannot bypass immutable operation restrictions", async () => {
  const client = new DocdexClient({ baseUrl: "http://127.0.0.1:1", repoRoot: os.tmpdir(), repoId: "fixed", apiKey: "fixture", immutableRuntimeContext: true, allowedOperations: ["search"], capabilities: { search: true } });
  await assert.rejects(client.callCatalog("docdex_kg_clear", {}), /not allowed/);
  await assert.rejects(client.callMcp("docdex_future_delete", {}), /Unknown Docdex operation/);
  await assert.rejects(client.callMcp("tools\/call", { name: "docdex_kg_clear" }), /Unknown Docdex operation/);
});
