import test from "node:test";
import assert from "node:assert/strict";
import { ConfiguredModelScope } from "../ConfiguredModelScope.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";

const configuration = () => {
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "route-limits",
    providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
    models: { large: { provider: "local", catalogId: "large", revision: "v1", operations: ["chat.completions"], contextWindow: 4096, maxOutputTokens: 100 } },
    bindings: { lead: { candidates: ["large"] } },
    effort: { low: { maxModelCalls: 4, maxTotalTokens: 20000, maxOutputTokens: 100 } },
  };
  return { config, hash: orchestrationHash(config), source: "fixture" };
};
const request = { messages: [{ role: "user" as const, content: "Write the long answer." }] };

test("an alias resolves to a route that meets the configured limits before one that advertises less", async () => {
  const original = globalThis.fetch; const sent: number[] = [];
  const scope = new ConfiguredModelScope(configuration(), { effort: "low" });
  let catalog = [{ id: "pool-a-capped", default_model: "large", context_window: 4096, max_output_tokens: 50 }, { id: "pool-b-full", default_model: "large", context_window: 4096, max_output_tokens: 100 }];
  let generated = 20;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: catalog });
    sent.push(JSON.parse(String(init?.body)).max_tokens);
    return Response.json({ choices: [{ message: { role: "assistant", content: "An answer that stops" } }], usage: { prompt_tokens: 10, completion_tokens: generated, total_tokens: 10 + generated } });
  };
  try {
    const full = await scope.provider("lead").generate(request);
    // The capped pool sorts first; choosing it would have limited the request to 50.
    assert.equal(sent.at(-1), 100); assert.equal(full.outputLimited, undefined);
    // A reply that used the whole allowance may have been cut, whatever the service reported.
    generated = 100;
    assert.equal((await scope.provider("lead").generate(request)).outputLimited, true);
  } finally { scope.close(); globalThis.fetch = original; }
  // With only a capped route left, the request asks for what that route can give.
  const capped = new ConfiguredModelScope(configuration(), { effort: "low" });
  catalog = [catalog[0]]; generated = 50;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: catalog });
    sent.push(JSON.parse(String(init?.body)).max_tokens);
    return Response.json({ choices: [{ message: { role: "assistant", content: "An answer that stops" } }], usage: { prompt_tokens: 10, completion_tokens: generated, total_tokens: 60 } });
  };
  try {
    const reply = await capped.provider("lead").generate(request);
    assert.equal(sent.at(-1), 50); assert.equal(reply.outputLimited, true);
  } finally { capped.close(); globalThis.fetch = original; }
});
