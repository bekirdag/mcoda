import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleProvider } from "../OpenAiCompatibleProvider.js";
import { ConfiguredProvider } from "../ConfiguredProvider.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";

test("vision images reach native OpenAI content blocks and remote URLs are rejected", async () => {
  const original = globalThis.fetch; let body: any;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { role: "assistant", content: "blue" }, finish_reason: "stop" }] });
  };
  try {
    const provider = new OpenAiCompatibleProvider({ model: "vision", baseUrl: "http://127.0.0.1:11460/v1", supportsStreaming: false });
    const image = "data:image/png;base64,aGVsbG8=";
    await provider.generate({ messages: [{ role: "user", content: "Describe", images: [{ dataUrl: image }] }] });
    assert.deepEqual(body.messages[0].content, [{ type: "text", text: "Describe" }, { type: "image_url", image_url: { url: image } }]);
    await assert.rejects(() => provider.generate({ messages: [{ role: "user", content: "Describe", images: [{ dataUrl: "https://example.com/private.png" }] }] }), /bounded user PNG/);
  } finally { globalThis.fetch = original; }
});

test("configured model fits output into real catalog context instead of refusing a useful response", async () => {
  const original = globalThis.fetch; let maxTokens = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "specialist", context_window: 1024 }] });
    maxTokens = JSON.parse(String(init?.body)).max_tokens;
    return Response.json({ choices: [{ message: { role: "assistant", content: "patch" }, finish_reason: "stop" }] });
  };
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:11460/v1" } },
    models: { worker: { provider: "local", catalogId: "specialist", revision: "test", contextWindow: 32768, maxOutputTokens: 8192, operations: ["chat.completions"] } }, bindings: { lead: { candidates: ["worker"] } } };
  try {
    const provider = new ConfiguredProvider({ config, hash: orchestrationHash(config), source: "test" });
    await provider.generate({ messages: [{ role: "user", content: "Fix the bug" }], maxTokens: 8192 });
    assert.ok(maxTokens >= 128 && maxTokens < 1024);
    await assert.rejects(() => provider.generate({ messages: [{ role: "user", content: "x".repeat(4000) }] }), /Context budget exceeded/);
  } finally { globalThis.fetch = original; }
});
