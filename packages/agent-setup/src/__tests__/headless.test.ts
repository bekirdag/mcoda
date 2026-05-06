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
