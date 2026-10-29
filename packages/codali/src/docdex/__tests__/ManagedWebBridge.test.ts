import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagedDocdex } from "../ManagedDocdex.js";
import { ConfiguredEmbeddings } from "../../providers/ConfiguredEmbeddings.js";
import { orchestrationHash, validateOrchestrationConfig } from "../../config/OrchestrationConfig.js";

test("private web bridge authenticates the origin-relative Docdex route and exposes no service credential", { skip: process.platform === "win32" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-web-bridge-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "docdex-fixture");
  await fs.writeFile(binary, `#!${process.execPath}
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
(async () => {
  const config = fs.readFileSync(process.env.DOCDEX_CONFIG_PATH, 'utf8');
  const base = JSON.parse(config.match(/base_url = (.*)/)[1]);
  const key = JSON.parse(config.match(/api_key = (.*)/)[1]);
  const url = new URL('/v1/swarm/web/search', base);
  const send = (headers, body) => fetch(url, {method:'POST', headers:{'content-type':'application/json', ...headers}, body:JSON.stringify(body)});
  const denied = await send({'x-api-key':'wrong'}, {query:'fixture',tool_id:'docdex'});
  const origin = await send({'x-api-key':key,origin:'https://untrusted.example'}, {query:'fixture',tool_id:'docdex'});
  const invalid = await send({'x-api-key':key}, {query:'fixture',tool_id:'different'});
  const accepted = await send({'x-api-key':key}, {query:'fixture',tool_id:'docdex'});
  for (const num_predict of [96, 50000]) await fetch(base+'/api/generate', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'configured-docdex-helper',prompt:'bounded helper',options:{num_predict}})});
  fs.writeFileSync(path.join(path.dirname(process.env.DOCDEX_CONFIG_PATH),'web-test.json'), JSON.stringify({denied:denied.status,origin:origin.status,invalid:invalid.status,accepted:accepted.status,result:await accepted.json()}));
  http.createServer((req,res) => {res.setHeader('content-type','application/json');res.end(JSON.stringify({managed_clients:{workspace_metadata_control:true,embedding_input_type:true,strict_repo_embeddings:true,deterministic_profile_embeddings:true}}));}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');
})().catch(error=>{console.error(error.message);process.exit(1)});
`, { mode: 0o700 });
  const config = validateOrchestrationConfig({ schemaVersion: 1, profile: "bridge-test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
    models: { text: { provider: "local", catalogId: "text", revision: "r1", operations: ["chat.completions"], contextWindow: 4096, maxOutputTokens: 128 },
      embed: { provider: "local", catalogId: "embed", revision: "sha256:fixture", operations: ["embeddings"], contextWindow: 8192, maxOutputTokens: 1, embeddingDimensions: 2,
        embedding: { queryPrefix: "q:", documentPrefix: "d:", normalization: "l2", pooling: "mean" } } },
    bindings: { lead: { candidates: ["text"] }, embedding: { candidates: ["embed"], embeddingSpace: "web-test" } } });
  const embeddings = new ConfiguredEmbeddings({ config, hash: orchestrationHash(config), source: "test" });
  let queries = 0;
  const limits: number[] = [];
  const instance = new ManagedDocdex({ workspaceRoot: root, stateRoot: path.join(root, "state"), embeddings, binary, allowWeb: true,
    provider: { name: "fixture", generate: async request => { limits.push(request.maxTokens!); return { message: { role: "assistant", content: "fixture" } }; } },
    webSearch: async (query, signal) => { signal.throwIfAborted(); assert.equal(query, "fixture"); queries++; return { results: [{ url: "https://example.org/source" }] }; } });
  try {
    await instance.start();
    const state = path.join(root, "state", embeddings.space.id);
    const launch = (await fs.readdir(state)).find(name => name.startsWith("launch-"))!;
    const report = JSON.parse(await fs.readFile(path.join(state, launch, "web-test.json"), "utf8"));
    assert.deepEqual(report, { denied: 403, origin: 403, invalid: 400, accepted: 200, result: { results: [{ url: "https://example.org/source" }] } });
    assert.equal(queries, 1);
    assert.deepEqual(limits, [96, 2048]);
  } finally { await instance.close(); }
});
