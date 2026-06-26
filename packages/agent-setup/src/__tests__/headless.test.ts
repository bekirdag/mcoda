import assert from "node:assert/strict";
import test from "node:test";
import { defaultMcodaStageDefinitions } from "../defaultStages.js";
import {
  buildCloudAgentOptions,
  buildSelfHostedServerOptions,
  filterAgentOptions,
  getVirtualAgentWindow,
  syncedCloudSlug,
  syncedSelfHostedSlug,
} from "../headless/index.js";
import { normalizeAgentCatalogEntry } from "../headless/normalization.js";
import type { McodaAgentCatalogEntry } from "../types.js";

const cloudAgent = (slug: string, patch: Partial<McodaAgentCatalogEntry> = {}): McodaAgentCatalogEntry => ({
  slug,
  source: "cloud_catalog",
  synced: false,
  remoteSlug: slug,
  managedKind: "cloud",
  displayName: slug,
  provider: "openrouter",
  adapter: "openai-api",
  model: slug,
  defaultModel: slug,
  healthStatus: "healthy",
  supportsTools: true,
  rating: 8,
  reasoningRating: 7,
  maxComplexity: 6,
  costPerMillion: 0.5,
  ...patch,
});

test("default stages are portable and do not hardcode agent slugs", () => {
  assert.ok(defaultMcodaStageDefinitions.length >= 6);
  assert.ok(defaultMcodaStageDefinitions.every((stage) => stage.defaultAgentSlug === null));
  assert.ok(defaultMcodaStageDefinitions.every((stage) => stage.recommendedUsage));
});

test("synced slugs use stable mswarm prefixes", () => {
  assert.equal(syncedCloudSlug(cloudAgent("OpenRouter/Google Gemini")), "mswarm-cloud-openrouter-google-gemini");
  assert.equal(
    syncedSelfHostedSlug({
      ...cloudAgent("suku/qwen 35b"),
      source: "self_hosted_catalog",
      managedKind: "self_hosted",
    }),
    "mswarm-self-hosted-suku-qwen-35b"
  );
  assert.equal(
    syncedSelfHostedSlug({
      ...cloudAgent("suku/qwen 35b"),
      source: "self_hosted_catalog",
      managedKind: "self_hosted_load_balanced",
      routingMode: "auto",
      loadBalancedGroupId: "lb_group_123",
    }),
    "mswarm-self-hosted-auto-suku-qwen-35b"
  );
});

test("cloud options merge synced local entries with remote catalog metadata", () => {
  const remote = cloudAgent("openrouter-qwen");
  const local = {
    ...remote,
    slug: syncedCloudSlug(remote),
    source: "local_registry" as const,
    synced: true,
    displayName: null,
    healthStatus: "degraded",
  };
  const options = buildCloudAgentOptions([local], [remote]);
  assert.equal(options.length, 1);
  assert.equal(options[0].slug, "mswarm-cloud-openrouter-qwen");
  assert.equal(options[0].displayName, "openrouter-qwen");
  assert.equal(options[0].healthStatus, "degraded");
});

test("self-hosted server grouping prefers node and server metadata", () => {
  const agents: McodaAgentCatalogEntry[] = [
    {
      ...cloudAgent("suku-qwen-35b"),
      source: "self_hosted_catalog",
      managedKind: "self_hosted",
      nodeId: "node-1",
      serverName: "Suku GPU",
      serverLabel: "Suku GPU",
    },
    {
      ...cloudAgent("suku-llama"),
      source: "self_hosted_catalog",
      managedKind: "self_hosted",
      nodeId: "node-1",
      serverName: "Suku GPU",
      serverLabel: "Suku GPU",
    },
  ];
  const servers = buildSelfHostedServerOptions([], agents);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].nodeId, "node-1");
  assert.equal(servers[0].serverName, "Suku GPU");
  assert.equal(servers[0].agentCount, 2);
});

test("self-hosted server grouping falls back to remote slug prefix", () => {
  const servers = buildSelfHostedServerOptions([], [
    {
      ...cloudAgent("bdya-suku-qwen-35b"),
      source: "self_hosted_catalog",
      managedKind: "self_hosted",
      remoteSlug: "bdya-suku-qwen-35b",
    },
  ]);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].remoteSlugPrefix, "bdya-suku");
});

test("self-hosted load-balanced aliases group under an auto server", () => {
  const servers = buildSelfHostedServerOptions([], [
    {
      ...cloudAgent("auto-qwen-35b"),
      source: "self_hosted_catalog",
      managedKind: "self_hosted_load_balanced",
      routingMode: "auto",
      loadBalancedGroupId: "lb_group_123",
      nodeId: null,
      serverName: null,
      remoteSlug: "mswarm/load-balanced/qwen-35b",
    },
    {
      ...cloudAgent("auto-llama"),
      source: "self_hosted_catalog",
      managedKind: "self_hosted_load_balanced",
      routingMode: "auto",
      loadBalancedGroupId: "lb_group_456",
      remoteSlug: "mswarm/load-balanced/llama",
    },
  ]);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, "auto-load-balanced");
  assert.equal(servers[0].label, "Auto load-balanced");
  assert.equal(servers[0].routingMode, "auto");
  assert.equal(servers[0].nodeId, undefined);
  assert.equal(servers[0].serverName, undefined);
  assert.equal(servers[0].agentCount, 2);
});

test("filtering searches large catalogs without hidden cap", () => {
  const agents = Array.from({ length: 1000 }, (_, index) =>
    cloudAgent(`provider-model-${index}`, {
      displayName: `Provider Model ${index}`,
      bestUsage: index === 642 ? "reasoning" : "summarization",
    })
  );
  assert.equal(filterAgentOptions(agents, "").length, 1000);
  const filtered = filterAgentOptions(agents, "reasoning 642");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].slug, "provider-model-642");
});

test("normalization exposes local runner metadata and search terms", () => {
  const agent = normalizeAgentCatalogEntry(
    {
      slug: "local-vllm",
      adapter: "vllm-local",
      provider: "vllm",
      defaultModel: "qwen-local",
      config: {
        baseUrl: "http://127.0.0.1:8000/v1",
        localRunner: {
          runnerKind: "vllm",
          authMode: "none",
          responseFormatStrategy: "json-object",
          supportsJsonSchema: false,
          supportsGbnf: true,
        },
      },
    },
    { source: "local_registry", synced: true }
  );

  assert.equal(agent.localRunner?.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(agent.localRunner?.runnerKind, "vllm");
  assert.equal(agent.localRunner?.authMode, "none");
  assert.equal(agent.localRunner?.responseFormatStrategy, "json-object");
  assert.equal(agent.localRunner?.supportsJsonSchema, false);
  assert.equal(agent.localRunner?.supportsGbnf, true);
  assert.deepEqual(filterAgentOptions([agent], "vllm 8000 json-object"), [agent]);
});

test("normalization marks load-balanced self-hosted config as auto-routed", () => {
  const agent = normalizeAgentCatalogEntry(
    {
      slug: "mswarm-self-hosted-auto-qwen",
      defaultModel: "qwen",
      config: {
        mswarmSelfHosted: {
          managed: true,
          remoteSlug: "mswarm/load-balanced/qwen",
          agentSlug: "auto-qwen",
          provider: "mcoda",
          routingMode: "auto",
          loadBalanced: true,
          loadBalancedGroupId: "lb_group_123",
          sync: {
            node_id: "lb_group_123",
            server_name: "load-balanced",
            group_id: "lb_group_123",
            load_balanced: true,
          },
        },
      },
    },
    { source: "local_registry", synced: true }
  );

  assert.equal(agent.managedKind, "self_hosted_load_balanced");
  assert.equal(agent.routingMode, "auto");
  assert.equal(agent.loadBalancedGroupId, "lb_group_123");
  assert.equal(agent.nodeId, null);
  assert.equal(agent.serverName, null);
});

test("normalization exposes self-hosted lifecycle protocol metadata", () => {
  const missingRoute = "POST /v1/swarm/self-hosted/node/jobs/:jobId/start";
  const agent = normalizeAgentCatalogEntry(
    {
      slug: "mswarm-self-hosted-suku-qwen",
      defaultModel: "qwen",
      health_status: "degraded",
      health_reason: "self_hosted_protocol_mismatch",
      config: {
        mswarmSelfHosted: {
          managed: true,
          remoteSlug: "suku-qwen",
          agentSlug: "suku-qwen",
          provider: "ollama",
          nodeId: "suku",
          serverName: "suku-gpu-box",
          runtimePackageVersion: "0.1.81",
          relay: {
            gatewayBaseUrl: "https://gateway.example.test",
            jobsPollPath: "/v1/swarm/self-hosted/node/jobs/poll",
            jobsEventsPathTemplate:
              "/v1/swarm/self-hosted/node/jobs/:jobId/events",
            jobsResultPathTemplate:
              "/v1/swarm/self-hosted/node/jobs/:jobId/result",
          },
          lifecycle: {
            compatible: false,
            reason: "self_hosted_protocol_mismatch",
            missingRoutes: [missingRoute],
            checkedAt: "2026-06-26T10:00:00.000Z",
          },
        },
      },
    },
    { source: "local_registry", synced: true }
  );

  assert.equal(agent.healthReason, "self_hosted_protocol_mismatch");
  assert.equal(agent.selfHostedLifecycle?.compatible, false);
  assert.equal(agent.selfHostedLifecycle?.missingRoute, missingRoute);
  assert.deepEqual(agent.selfHostedLifecycle?.missingRoutes, [missingRoute]);
  assert.equal(agent.selfHostedLifecycle?.runtimePackageVersion, "0.1.81");
  assert.equal(
    agent.selfHostedLifecycle?.relay?.gatewayBaseUrl,
    "https://gateway.example.test"
  );
  assert.equal(
    agent.selfHostedLifecycle?.relay?.jobsStartPathTemplate,
    null
  );
  assert.deepEqual(filterAgentOptions([agent], "protocol mismatch start"), [agent]);

  const servers = buildSelfHostedServerOptions([agent], []);
  assert.equal(servers[0].status, "degraded");
  assert.equal(servers[0].statusReason, "self_hosted_protocol_mismatch");
  assert.equal(servers[0].lifecycle?.missingRoute, missingRoute);
});

test("normalization does not infer local runner metadata from generic capabilities", () => {
  const agent = normalizeAgentCatalogEntry(
    {
      slug: "openrouter-qwen",
      adapter: "openai-api",
      provider: "openrouter",
      defaultModel: "qwen",
      supportsTools: true,
    },
    { source: "cloud_catalog", synced: false, managedKind: "cloud" }
  );

  assert.equal(agent.localRunner, null);
});

test("virtual agent window renders only the visible slice while preserving total height", () => {
  const items = Array.from({ length: 1000 }, (_, index) => index);
  const windowed = getVirtualAgentWindow(items, {
    scrollTop: 400,
    rowHeight: 20,
    viewportHeight: 100,
    overscan: 2,
  });
  assert.equal(windowed.totalHeight, 20_000);
  assert.equal(windowed.startIndex, 18);
  assert.equal(windowed.endIndex, 27);
  assert.deepEqual(windowed.items, [18, 19, 20, 21, 22, 23, 24, 25, 26]);
});
