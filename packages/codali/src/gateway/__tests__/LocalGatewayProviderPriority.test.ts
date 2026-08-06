import assert from "node:assert/strict";
import test from "node:test";
import { CODALI_MSWARM_PRIORITY, createProviderForAssignment,
  localAgentApiKeyEnvVar } from "../LocalGatewayProvider.js";
import type { CodaliGatewayAgentAssignment } from "../AgentTierResolver.js";

const assignment = (
  baseUrl: string | undefined,
  localRunner?: Record<string, unknown>,
): CodaliGatewayAgentAssignment =>
  ({
    role: "worker",
    policy: { tier: "medium" },
    score: 1,
    reasons: [],
    agent: { slug: "a", adapter: "openai-api", model: "m" },
    candidate: {
      slug: "a",
      adapter: "openai-api",
      model: "m",
      tier: "medium",
      supportsTools: true,
      raw: { config: { baseUrl, ...(localRunner ? { localRunner } : {}) } },
    },
  }) as unknown as CodaliGatewayAgentAssignment;

const extraBody = (provider: unknown): Record<string, unknown> | undefined => {
  const runner = (provider as { config?: { localRunner?: { extraBody?: Record<string, unknown> } } })
    .config?.localRunner?.extraBody;
  return runner;
};

test("mswarm calls carry a high scheduling priority", () => {
  // mswarm sorts ascending and reserves capacity for priority <= -1. Codali
  // runs are interactive, so they should not queue behind batch work.
  const provider = createProviderForAssignment(
    assignment("https://api.mswarm.org/v1/swarm/self-hosted/openai/"),
  );
  const scheduling = extraBody(provider)?.scheduling as { priority?: number } | undefined;
  assert.equal(scheduling?.priority, CODALI_MSWARM_PRIORITY);
  assert.ok(CODALI_MSWARM_PRIORITY < 0, "a lower number must mean sooner");
});

test("a caller can override the priority", () => {
  const provider = createProviderForAssignment(
    assignment("https://api.mswarm.org/v1/swarm/self-hosted/openai/"),
    { priority: -50 },
  );
  const scheduling = extraBody(provider)?.scheduling as { priority?: number } | undefined;
  assert.equal(scheduling?.priority, -50);
});

test("a priority already set on the agent wins", () => {
  const provider = createProviderForAssignment(
    assignment("https://api.mswarm.org/v1/swarm/self-hosted/openai/", {
      extraBody: { scheduling: { priority: -3 } },
    }),
  );
  const scheduling = extraBody(provider)?.scheduling as { priority?: number } | undefined;
  assert.equal(scheduling?.priority, -3);
});

test("existing runner settings are preserved", () => {
  const provider = createProviderForAssignment(
    assignment("https://api.mswarm.org/v1/swarm/self-hosted/openai/", {
      extraBody: { temperature_scale: 0.5 },
    }),
  );
  assert.equal(extraBody(provider)?.temperature_scale, 0.5);
});

test("a non-mswarm endpoint is left alone", () => {
  // Ollama and other local runners have no such field; sending it would be
  // noise at best.
  const provider = createProviderForAssignment(assignment("http://127.0.0.1:11434"));
  assert.equal(extraBody(provider)?.scheduling, undefined);
});

test("a self-hosted agent takes its key from the operator's environment", () => {
  // mcoda stores agent secrets encrypted and never discloses them, so an agent
  // registered with bearer auth and a direct base URL arrives with no key. The
  // provider then threw before making any request: a worker that failed in 0ms
  // on every call while the run still reported success.
  const previous = process.env.CODALI_AGENT_API_KEY_QWEN_9B;
  process.env.CODALI_AGENT_API_KEY_QWEN_9B = "local-secret";
  try {
    const provider = createProviderForAssignment({
      candidate: {
        slug: "qwen-9b",
        adapter: "openai-api",
        model: "qwen-9b",
        supportsTools: true,
        raw: { config: { baseUrl: "http://127.0.0.1:11441/v1", authMode: "bearer" } },
      },
    } as never);
    assert.equal((provider as unknown as { config: { apiKey?: string } }).config.apiKey, "local-secret");
  } finally {
    if (previous === undefined) delete process.env.CODALI_AGENT_API_KEY_QWEN_9B;
    else process.env.CODALI_AGENT_API_KEY_QWEN_9B = previous;
  }
});

test("the per-agent variable name is derived from the slug", () => {
  assert.equal(localAgentApiKeyEnvVar("qwen3.5-9b-suku"), "CODALI_AGENT_API_KEY_QWEN3_5_9B_SUKU");
  assert.equal(localAgentApiKeyEnvVar("local-qwen3b"), "CODALI_AGENT_API_KEY_LOCAL_QWEN3B");
});

test("an mswarm-relayed agent is unaffected by the local key lookup", () => {
  const previous = process.env.CODALI_API_KEY;
  process.env.CODALI_API_KEY = "should-not-be-used-for-relay";
  try {
    const provider = createProviderForAssignment({
      candidate: {
        slug: "mswarm-self-hosted-thing",
        adapter: "openai-api",
        model: "thing",
        raw: { config: { baseUrl: "https://api.mswarm.org/v1/swarm/self-hosted/openai/" } },
      },
    } as never);
    const key = (provider as unknown as { config: { apiKey?: string } }).config.apiKey;
    assert.notEqual(key, "should-not-be-used-for-relay");
  } finally {
    if (previous === undefined) delete process.env.CODALI_API_KEY;
    else process.env.CODALI_API_KEY = previous;
  }
});
