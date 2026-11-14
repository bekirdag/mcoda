import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import { createAdesTool } from "../AdesTool.js";
import { ToolRegistry } from "../../ToolRegistry.js";
test("ADES uses only the local deterministic lane and preserves uncertainty/provenance", async t => {
  let request: any;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk; request = JSON.parse(body);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ version: "0.4.1", pack: "general-en", entities: [{ text: "Paris", label: "organization", confidence: .61, start: 0, end: 5, link: { entity_id: "ambiguous" }, provenance: { weak_alias: true, lane: "deterministic_alias" } }], refinement_applied: false }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number }; const registry = new ToolRegistry(); registry.register(createAdesTool({ baseUrl: `http://127.0.0.1:${address.port}` }));
  const result = await registry.execute("extract_entities", { text: "Paris" }, { workspaceRoot: os.tmpdir() });
  assert.equal(result.ok, true, result.output); const data = JSON.parse(result.output);
  assert.equal(request.options.hybrid, false); assert.equal(request.options.refine_links, false); assert.equal(request.options.include_graph_support, false);
  assert.equal(data.entities[0].confidence, .61); assert.equal(data.entities[0].provenance.weakAlias, true); assert.match(data.scope, /original query/);
  // The registry drops unknown arguments; they must never reach the service.
  await registry.execute("extract_entities", { text: "Paris", output: { path: "/tmp/escape" } }, { workspaceRoot: os.tmpdir() });
  assert.equal(request.output, undefined);
});
test("ADES refuses remote endpoints instead of uploading prompt text", async () => {
  const registry = new ToolRegistry(); registry.register(createAdesTool({ baseUrl: "https://api.adestool.com" }));
  const result = await registry.execute("extract_entities", { text: "private" }, { workspaceRoot: os.tmpdir() });
  assert.equal(result.ok, false); assert.equal(result.error?.code, "tool_permission_denied");
});
