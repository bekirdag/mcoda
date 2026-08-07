import assert from "node:assert/strict";
import test from "node:test";
import { agentRunsOnThisNode, isPrivateEndpointHost } from "../runtime.js";

test("a node does not advertise somebody else's public API", () => {
  // 159 of one node's 181 agents were OpenRouter, published as though the box
  // served them. A caller reaching them through the node paid a round trip for
  // nothing the node contributed.
  assert.equal(isPrivateEndpointHost("openrouter.ai"), false);
  assert.equal(isPrivateEndpointHost("api.openai.com"), false);
  assert.equal(isPrivateEndpointHost("api.mswarm.org"), false);
  assert.equal(
    agentRunsOnThisNode({ adapter: "openai-api", config: { baseUrl: "https://openrouter.ai/api/v1" } } as never),
    false,
  );
});

test("a llama.cpp server on loopback is this node's to serve", () => {
  // The case adapter-name gating got wrong: `openai-api` is equally OpenRouter
  // and a local llama.cpp server.
  assert.equal(
    agentRunsOnThisNode({ adapter: "openai-api", config: { baseUrl: "http://127.0.0.1:11437/v1" } } as never),
    true,
  );
});

test("a CLI adapter carries no endpoint and runs here by construction", () => {
  // The other case adapter-name gating got wrong.
  assert.equal(agentRunsOnThisNode({ adapter: "ollama-cli" } as never), true);
  assert.equal(agentRunsOnThisNode({ adapter: "codex-cli", config: {} } as never), true);
});

test("the operator's own network counts as theirs to serve", () => {
  for (const host of ["192.168.12.241", "10.0.0.6", "172.16.4.2", "suku", "ollama.test", "gpu.local"]) {
    assert.equal(isPrivateEndpointHost(host), true, `${host} should be private`);
  }
});

test("an unparseable endpoint is not vouched for", () => {
  assert.equal(agentRunsOnThisNode({ config: { baseUrl: "not a url" } } as never), false);
});
