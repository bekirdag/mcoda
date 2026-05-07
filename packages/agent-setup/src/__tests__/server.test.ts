import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentsApi, MswarmApi, MswarmConfigStore } from "@mcoda/core";
import { createMcodaAgentSetupService } from "../server/service.js";
import { createInMemoryMcodaRuntimeAdapter } from "../server/inMemoryRuntime.js";
import { createInMemoryMcodaAgentSettingsStore } from "../server/settingsStore.js";
import { createCliMcodaRuntimeAdapter } from "../server/cliRuntime.js";
import { createMcodaAgentSetupHttpHandler } from "../server/httpHandlers.js";
import { createProgrammaticMcodaRuntimeAdapter } from "../server/programmaticRuntime.js";
import type { McodaAgentCatalogEntry, McodaStageDefinition } from "../types.js";

const stages: McodaStageDefinition[] = [
  {
    stageKey: "summarization",
    displayName: "Summarization",
    nullable: false,
  },
  {
    stageKey: "guardrail",
    displayName: "Guardrail",
    nullable: true,
  },
];

const remoteCloud: McodaAgentCatalogEntry = {
  slug: "openrouter-qwen",
  source: "cloud_catalog",
  synced: false,
  remoteSlug: "openrouter-qwen",
  managedKind: "cloud",
  displayName: "Qwen",
  provider: "openrouter",
  adapter: "openai-api",
  model: "qwen",
  defaultModel: "qwen",
  healthStatus: "healthy",
  supportsTools: true,
  rating: 9,
  reasoningRating: 8,
  maxComplexity: 7,
  costPerMillion: 0.4,
};

test("server helper configures key and syncs agents without requiring mcoda CLI", async () => {
  const service = createMcodaAgentSetupService({
    settingsStore: createInMemoryMcodaAgentSettingsStore(),
    mcoda: createInMemoryMcodaRuntimeAdapter({ cloudAgents: [remoteCloud] }),
    defaultStages: stages,
  });
  const snapshot = await service.configureMswarmApiKey({
    apiKey: "sk_live_test_7890",
    reasonCode: "test",
  });
  assert.equal(snapshot.runtime.mode, "programmatic");
  assert.equal(snapshot.runtime.requiresMcodaCli, false);
  assert.equal(snapshot.mswarmApiKeyConfigured, true);
  assert.equal(snapshot.mswarmApiKeyLast4, "7890");
  assert.equal(snapshot.catalog.localAgents.length, 1);
  assert.equal(snapshot.catalog.localAgents[0].slug, "mswarm-cloud-openrouter-qwen");
  assert.doesNotMatch(JSON.stringify(snapshot), /sk_live_test_7890/);
});

test("server helper validates assignments against local registry", async () => {
  const service = createMcodaAgentSetupService({
    settingsStore: createInMemoryMcodaAgentSettingsStore(),
    mcoda: createInMemoryMcodaRuntimeAdapter({ cloudAgents: [remoteCloud] }),
    defaultStages: stages,
  });
  await service.configureMswarmApiKey({ apiKey: "sk_test_1234" });
  await assert.rejects(
    () =>
      service.updateAssignments({
        assignments: { summarization: "missing-agent" },
      }),
    /not present in the local registry/
  );
  const saved = await service.updateAssignments({
    assignments: {
      summarization: "mswarm-cloud-openrouter-qwen",
      guardrail: null,
    },
  });
  assert.equal(saved.assignments.summarization, "mswarm-cloud-openrouter-qwen");
});

test("server helper rejects omitted required stage assignments", async () => {
  const service = createMcodaAgentSetupService({
    settingsStore: createInMemoryMcodaAgentSettingsStore(),
    mcoda: createInMemoryMcodaRuntimeAdapter({ cloudAgents: [remoteCloud] }),
    defaultStages: stages,
  });
  await service.configureMswarmApiKey({ apiKey: "sk_test_1234" });
  await assert.rejects(
    () =>
      service.updateAssignments({
        assignments: { guardrail: null },
      }),
    /Stage summarization requires an agent assignment/
  );
});

test("server helper surfaces sync failures as snapshot warnings", async () => {
  const runtime = createInMemoryMcodaRuntimeAdapter({ cloudAgents: [remoteCloud] });
  runtime.syncSelfHostedAgents = async () => {
    throw new Error("self-hosted unavailable");
  };
  const service = createMcodaAgentSetupService({
    settingsStore: createInMemoryMcodaAgentSettingsStore(),
    mcoda: runtime,
    defaultStages: stages,
  });
  const snapshot = await service.configureMswarmApiKey({ apiKey: "sk_test_1234" });
  assert.equal(snapshot.mswarmApiKeyConfigured, true);
  assert.match(snapshot.catalog.errors.self_hosted_agent_sync, /self-hosted unavailable/);
});

test("server helper does not show stale managed agents when remote mswarm catalog fails", async () => {
  const runtime = createInMemoryMcodaRuntimeAdapter({
    localAgents: [
      {
        ...remoteCloud,
        slug: "mswarm-cloud-stale",
        source: "local_registry",
        synced: true,
        managedKind: "cloud",
        remoteSlug: "stale",
      },
      {
        ...remoteCloud,
        slug: "mswarm-self-hosted-stale",
        source: "local_registry",
        synced: true,
        managedKind: "self_hosted",
        remoteSlug: "stale-self-hosted",
        nodeId: "stale-node",
        serverName: "stale-server",
      },
    ],
  });
  runtime.listCloudAgents = async () => {
    throw new Error("remote cloud unavailable");
  };
  runtime.listSelfHostedAgents = async () => {
    throw new Error("remote self-hosted unavailable");
  };
  const service = createMcodaAgentSetupService({
    settingsStore: createInMemoryMcodaAgentSettingsStore(),
    mcoda: runtime,
    defaultStages: stages,
  });
  const snapshot = await service.fetchSnapshot();
  assert.equal(snapshot.catalog.localAgents.length, 2);
  assert.equal(snapshot.catalog.cloudAgents.length, 0);
  assert.equal(snapshot.catalog.selfHostedServers.length, 0);
  assert.match(snapshot.catalog.errors.cloud_agents, /remote cloud unavailable/);
  assert.match(
    snapshot.catalog.errors.self_hosted_agents,
    /remote self-hosted unavailable/
  );
});

test("server helper retries transient remote mswarm catalog failures", async () => {
  const runtime = createInMemoryMcodaRuntimeAdapter();
  let cloudCalls = 0;
  let selfHostedCalls = 0;
  runtime.listCloudAgents = async () => {
    cloudCalls += 1;
    if (cloudCalls === 1) throw new Error("temporary cloud failure");
    return [remoteCloud];
  };
  runtime.listSelfHostedAgents = async () => {
    selfHostedCalls += 1;
    if (selfHostedCalls === 1) {
      throw new Error("temporary self-hosted failure");
    }
    return [
      {
        ...remoteCloud,
        slug: "suku-qwen",
        source: "self_hosted_catalog",
        managedKind: "self_hosted",
        remoteSlug: "suku-qwen",
        nodeId: "suku",
        serverName: "suku-gpu-box",
      },
    ];
  };
  const service = createMcodaAgentSetupService({
    settingsStore: createInMemoryMcodaAgentSettingsStore(),
    mcoda: runtime,
    defaultStages: stages,
  });
  const snapshot = await service.fetchSnapshot();
  assert.equal(cloudCalls, 2);
  assert.equal(selfHostedCalls, 2);
  assert.equal(snapshot.catalog.cloudAgents.length, 1);
  assert.equal(snapshot.catalog.selfHostedServers.length, 1);
  assert.deepEqual(snapshot.catalog.errors, {});
});

test("HTTP handler routes recommended backend endpoints", async () => {
  const service = createMcodaAgentSetupService({
    settingsStore: createInMemoryMcodaAgentSettingsStore(),
    mcoda: createInMemoryMcodaRuntimeAdapter({ cloudAgents: [remoteCloud] }),
    defaultStages: stages,
  });
  const handler = createMcodaAgentSetupHttpHandler(service);
  const saveKey = await handler({
    method: "POST",
    path: "/api/mcoda/mswarm-api-key",
    body: {
      mswarm_api_key: "sk_http_4567",
      reason_code: "configure",
    },
  });
  assert.equal(saveKey.status, 200);
  assert.equal((saveKey.body as any).mswarmApiKeyLast4, "4567");
  assert.doesNotMatch(JSON.stringify(saveKey.body), /sk_http_4567/);

  const patch = await handler({
    method: "PATCH",
    path: "/api/mcoda/agent-settings",
    body: {
      assignments: {
        summarization: "mswarm-cloud-openrouter-qwen",
        guardrail: null,
      },
    },
  });
  assert.equal(patch.status, 200);
  assert.equal((patch.body as any).assignments.summarization, "mswarm-cloud-openrouter-qwen");

  const missing = await handler({
    method: "GET",
    path: "/api/mcoda/missing",
  });
  assert.equal(missing.status, 404);
});

test("programmatic runtime reads injected config store for later API calls", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-agent-setup-"));
  const store = new MswarmConfigStore(path.join(tempDir, "config.json"));
  const originalCreate = MswarmApi.create;
  const originalRefresh = MswarmApi.refreshManagedAgentAuth;
  let capturedOptions: unknown;
  (MswarmApi as any).create = async (options: unknown) => {
    capturedOptions = options;
    return {
      async close() {},
      async listCloudAgents() {
        return [];
      },
      async listSelfHostedAgents() {
        return [];
      },
      async listWorkers() {
        return [];
      },
      async syncCloudAgents() {
        return { created: 0, updated: 0, deleted: 0, agents: [] };
      },
      async syncSelfHostedAgents() {
        return { created: 0, updated: 0, deleted: 0, agents: [] };
      },
      async syncWorkers() {
        return { created: 0, updated: 0, deleted: 0, agents: [] };
      },
    };
  };
  (MswarmApi as any).refreshManagedAgentAuth = async () => ({
    updated: 0,
    agents: [],
  });
  try {
    const adapter = createProgrammaticMcodaRuntimeAdapter({ store });
    await adapter.configureMswarmApiKey({ apiKey: "sk_store_9999" });
    await adapter.listCloudAgents();
    assert.equal((capturedOptions as any).apiKey, "sk_store_9999");
  } finally {
    (MswarmApi as any).create = originalCreate;
    (MswarmApi as any).refreshManagedAgentAuth = originalRefresh;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("programmatic runtime uses submitted mswarm key for real cloud and self-hosted catalogs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-agent-setup-real-"));
  const store = new MswarmConfigStore(path.join(tempDir, "config.json"));
  const originalMswarmCreate = MswarmApi.create;
  const originalRefresh = MswarmApi.refreshManagedAgentAuth;
  const originalAgentsCreate = AgentsApi.create;
  const capturedMswarmOptions: unknown[] = [];

  (MswarmApi as any).create = async (options: unknown) => {
    capturedMswarmOptions.push(options);
    return {
      async close() {},
      async listCloudAgents() {
        return [
          {
            slug: "real-cloud",
            provider: "openrouter",
            default_model: "qwen-real",
            supports_tools: true,
            capabilities: ["code"],
          },
        ];
      },
      async listSelfHostedAgents() {
        return [
          {
            slug: "real-self-hosted",
            provider: "ollama",
            default_model: "qwen-local",
            supports_tools: true,
            capabilities: ["local"],
            sync: {
              node_id: "suku",
              server_name: "suku-gpu-box",
            },
          },
        ];
      },
      async listWorkers() {
        return [
          {
            slug: "worker_real",
            provider: "mswarm",
            default_model: "mswarm-worker:worker_real",
            supports_tools: true,
            capabilities: ["structured_output"],
            worker: { name: "Real worker" },
          },
        ];
      },
      async syncCloudAgents() {
        return { created: 1, updated: 0, deleted: 0, agents: [] };
      },
      async syncSelfHostedAgents() {
        return { created: 1, updated: 0, deleted: 0, agents: [] };
      },
      async syncWorkers() {
        return { created: 1, updated: 0, deleted: 0, agents: [] };
      },
    };
  };
  (MswarmApi as any).refreshManagedAgentAuth = async () => ({
    updated: 0,
    agents: [],
  });
  (AgentsApi as any).create = async () => ({
    async close() {},
    async listAgents() {
      return [
        {
          slug: "mswarm-cloud-real-cloud",
          adapter: "openai-api",
          defaultModel: "qwen-real",
          supportsTools: true,
          config: {
            mswarmCloud: {
              managed: true,
              remoteSlug: "real-cloud",
              provider: "openrouter",
              modelId: "qwen-real",
            },
          },
        },
        {
          slug: "mswarm-self-hosted-real-self-hosted",
          adapter: "ollama-api",
          defaultModel: "qwen-local",
          supportsTools: true,
          config: {
            mswarmSelfHosted: {
              managed: true,
              remoteSlug: "real-self-hosted",
              agentSlug: "real-self-hosted",
              provider: "ollama",
              modelId: "qwen-local",
              nodeId: "suku",
              serverName: "suku-gpu-box",
            },
          },
        },
      ];
    },
  });

  try {
    const service = createMcodaAgentSetupService({
      settingsStore: createInMemoryMcodaAgentSettingsStore(),
      mcoda: createProgrammaticMcodaRuntimeAdapter({ store }),
      defaultStages: stages,
    });
    const snapshot = await service.configureMswarmApiKey({
      apiKey: "sk_real_catalog_1234",
    });
    assert.equal(snapshot.catalog.cloudAgents[0].remoteSlug, "real-cloud");
    assert.equal(
      snapshot.catalog.selfHostedServers[0].agents[0].remoteSlug,
      "real-self-hosted"
    );
    assert.equal(snapshot.catalog.selfHostedServers[0].nodeId, "suku");
    assert.ok(capturedMswarmOptions.length >= 4);
    assert.ok(
      capturedMswarmOptions.every(
        (options) => (options as any).apiKey === "sk_real_catalog_1234"
      )
    );
  } finally {
    (MswarmApi as any).create = originalMswarmCreate;
    (MswarmApi as any).refreshManagedAgentAuth = originalRefresh;
    (AgentsApi as any).create = originalAgentsCreate;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI runtime adapter refuses API key configuration and does not spawn with secrets", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const adapter = createCliMcodaRuntimeAdapter({
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return [];
    },
  });
  await assert.rejects(
    () => adapter.configureMswarmApiKey({ apiKey: "secret-value" }),
    /stdin-safe secret command/
  );
  assert.equal(calls.length, 0);
  await adapter.listCloudAgents();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["cloud", "agent", "list", "--json"]);
  assert.doesNotMatch(calls[0].args.join(" "), /secret-value/);
});
