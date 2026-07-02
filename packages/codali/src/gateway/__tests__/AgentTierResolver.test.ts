import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCodaliGatewayAgentCandidate,
  resolveCodaliGatewayAgentTiers,
} from "../AgentTierResolver.js";

const agent = (overrides: Record<string, unknown>) => ({
  id: overrides.slug,
  slug: overrides.slug,
  adapter: "ollama-remote",
  defaultModel: `${overrides.slug}:latest`,
  health: { status: "healthy", lastCheckedAt: "2026-07-02T00:00:00Z" },
  rating: 6,
  reasoningRating: 6,
  costPerMillion: 0,
  capabilities: ["structured_output", "schema_adherence"],
  supportsJsonSchema: true,
  createdAt: "2026-07-02T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
  ...overrides,
});

const inventory = () => [
  agent({
    slug: "local-small",
    tier: "small",
    contextWindow: 12_000,
    reasoningRating: 4,
  }),
  agent({
    slug: "local-medium",
    tier: "medium",
    contextWindow: 24_000,
    supportsTools: true,
    reasoningRating: 6,
  }),
  agent({
    slug: "local-large",
    tier: "large",
    contextWindow: 128_000,
    supportsTools: true,
    reasoningRating: 9,
  }),
  agent({
    slug: "local-image",
    tier: "image",
    contextWindow: 16_000,
    supportsImageGeneration: true,
    capabilities: ["image_generation"],
  }),
];

test("normalizes mcoda inventory records into gateway candidates", () => {
  const candidate = normalizeCodaliGatewayAgentCandidate(
    agent({
      slug: "candidate",
      tier: "medium",
      config: { localRunner: { runnerKind: "llama-cpp", baseUrl: "http://127.0.0.1" } },
      health_status: "healthy",
    }),
  );

  assert.equal(candidate?.slug, "candidate");
  assert.equal(candidate?.tier, "medium");
  assert.equal(candidate?.source, "local");
  assert.equal(candidate?.runnerKind, "llama-cpp");
  assert.equal(candidate?.baseUrl, "http://127.0.0.1");
});

test("resolves classifier, planner, verifier, and final roles by tier and capability", () => {
  const result = resolveCodaliGatewayAgentTiers({
    inventory: inventory(),
    roles: ["classifier", "planner", "verifier", "final_synthesizer"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.assignments.classifier?.candidate.slug, "local-small");
  assert.equal(result.assignments.planner?.candidate.slug, "local-medium");
  assert.equal(result.assignments.verifier?.candidate.slug, "local-medium");
  assert.equal(result.assignments.final_synthesizer?.candidate.slug, "local-large");
});

test("blocks image workers unless policy explicitly allows them", () => {
  const blocked = resolveCodaliGatewayAgentTiers({
    inventory: inventory(),
    roles: ["image_worker"],
    allowImageWorker: false,
  });
  assert.equal(blocked.ok, false);
  assert.ok(
    blocked.errors.some((error) => error.code === "GATEWAY_IMAGE_WORKER_DISABLED"),
  );

  const allowed = resolveCodaliGatewayAgentTiers({
    inventory: inventory(),
    roles: ["image_worker"],
    allowImageWorker: true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.assignments.image_worker?.candidate.slug, "local-image");
});

test("blocks cloud fallback unless the agent policy allows it", () => {
  const cloudInventory = [
    agent({
      slug: "mswarm-cloud-large",
      tier: "large",
      adapter: "openai-api",
      defaultModel: "remote-large",
      contextWindow: 128_000,
      config: { mswarmCloud: { managed: true } },
      reasoningRating: 9,
    }),
  ];

  const blocked = resolveCodaliGatewayAgentTiers({
    inventory: cloudInventory,
    roles: ["final_synthesizer"],
    agentPolicy: { resolver: "mcoda_inventory", allowCloudFallback: false },
  });
  assert.equal(blocked.ok, false);
  assert.ok(
    blocked.warnings.some(
      (warning) => warning.code === "GATEWAY_CLOUD_FALLBACK_BLOCKED",
    ),
  );

  const allowed = resolveCodaliGatewayAgentTiers({
    inventory: cloudInventory,
    roles: ["final_synthesizer"],
    agentPolicy: { resolver: "mcoda_inventory", allowCloudFallback: true },
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.assignments.final_synthesizer?.candidate.source, "cloud");
});

test("uses deterministic slug tie-breaks when candidates score equally", () => {
  const result = resolveCodaliGatewayAgentTiers({
    inventory: [
      agent({ slug: "b-small", tier: "small", contextWindow: 12_000 }),
      agent({ slug: "a-small", tier: "small", contextWindow: 12_000 }),
    ],
    roles: ["classifier"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.assignments.classifier?.candidate.slug, "a-small");
});

test("de-prioritizes nested self-hosted relay aliases behind direct candidates", () => {
  const nestedRelay = agent({
    slug: "mswarm-self-hosted-mcoda-cassandra-local-mswarm-self-hosted-mcoda-sukunahikona-json",
    tier: "medium",
    adapter: "openai-api",
    defaultModel: "mcoda-cassandra-local-mswarm-self-hosted-mcoda-sukunahikona-json",
    contextWindow: 24_000,
    rating: 8,
    reasoningRating: 8,
    config: {
      mswarmSelfHosted: {
        remoteSlug: "mcoda/cassandra-local/mswarm-self-hosted-mcoda-sukunahikona-json",
        sourceAgentSlug: "mswarm-self-hosted-mcoda-sukunahikona-json",
      },
    },
  });
  const directSelfHosted = agent({
    slug: "mswarm-self-hosted-mcoda-sukunahikona-json",
    tier: "medium",
    adapter: "openai-api",
    defaultModel: "mcoda-sukunahikona-json",
    contextWindow: 24_000,
    rating: 8,
    reasoningRating: 8,
    config: {
      mswarmSelfHosted: {
        remoteSlug: "mcoda/sukunahikona/json",
        sourceAgentSlug: "json",
      },
    },
  });

  const result = resolveCodaliGatewayAgentTiers({
    inventory: [nestedRelay, directSelfHosted],
    roles: ["planner"],
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.assignments.planner?.candidate.slug,
    "mswarm-self-hosted-mcoda-sukunahikona-json",
  );
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.slug === nestedRelay.slug &&
      diagnostic.reasons.includes("nested_self_hosted_relay_penalty")),
  );
});
