import assert from "node:assert/strict";
import test from "node:test";
import { CODALI_MSWARM_PRIORITY, createProviderForAssignment } from "../LocalGatewayProvider.js";
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
