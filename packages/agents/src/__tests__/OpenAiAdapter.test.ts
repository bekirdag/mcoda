import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiAdapter } from "../adapters/openai/OpenAiAdapter.js";
import { Agent } from "@mcoda/shared";

const agent: Agent = {
  id: "agent-openai",
  slug: "openai",
  adapter: "openai-api",
  createdAt: "now",
  updatedAt: "now",
};

test("OpenAiAdapter healthCheck reflects missing api key", async () => {
  const adapter = new OpenAiAdapter({ agent, capabilities: ["chat"], model: "gpt-4o" });
  const health = await adapter.healthCheck();
  assert.equal(health.status, "unreachable");
  assert.equal(health.details?.reason, "missing_api_key");
});

test("OpenAiAdapter invoke returns stub output and metadata", async () => {
  const adapter = new OpenAiAdapter({
    agent,
    capabilities: ["chat"],
    model: "gpt-4o",
    apiKey: "secret",
    adapter: "openai-api",
  });
  const result = await adapter.invoke({ input: "hello" });
  assert.equal(result.output, "openai-stub:hello");
  assert.equal(result.adapter, "openai-api");
  assert.equal(result.model, "gpt-4o");
  assert.equal(result.metadata?.authMode, "api");
});

test("OpenAiAdapter invokeStream yields stub output", async () => {
  const adapter = new OpenAiAdapter({
    agent,
    capabilities: ["chat"],
    model: "gpt-4o",
    apiKey: "secret",
  });
  const chunks: string[] = [];
  for await (const chunk of adapter.invokeStream({ input: "stream" })) {
    chunks.push(chunk.output);
  }
  assert.deepEqual(chunks, ["openai-stream:stream"]);
});
