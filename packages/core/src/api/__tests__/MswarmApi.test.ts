import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GlobalRepository } from "@mcoda/db";
import { MswarmApi } from "../MswarmApi.js";
import { MswarmConfigStore } from "../MswarmConfigStore.js";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-core-mswarm-api-"));
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

const withStubServer = async (
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP listener");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.close();
    await once(server, "close");
  }
};

test("MswarmApi.listCloudAgents sends auth and query params", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await withStubServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      assert.equal(req.headers["x-api-key"], "cloud-key");
      assert.equal(url.pathname, "/v1/swarm/cloud/agents");
      assert.equal(url.searchParams.get("shape"), "mcoda");
      assert.equal(url.searchParams.get("provider"), "openrouter");
      assert.equal(url.searchParams.get("limit"), "2");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agents: [
            {
              slug: "openai/gpt-4.1-mini",
              provider: "openrouter",
              default_model: "openai/gpt-4.1-mini",
              cost_per_million: 0.9,
              rating: 8.2,
              reasoning_rating: 8.5,
              max_complexity: 8,
              capabilities: ["code_write", "plan"],
              health_status: "healthy",
              context_window: 128000,
              supports_tools: true,
              pricing_version: "2026-03-17",
            },
          ],
        }),
      );
    }, async (baseUrl) => {
      const api = await MswarmApi.create({ baseUrl, apiKey: "cloud-key" });
      try {
        const agents = await api.listCloudAgents({ provider: "openrouter", limit: 2 });
        assert.equal(agents.length, 1);
        assert.equal(agents[0]?.slug, "openai/gpt-4.1-mini");
        assert.equal(agents[0]?.supports_tools, true);
      } finally {
        await api.close();
      }
    });
  });
});

test("MswarmApi.create falls back to the stored encrypted API key", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const store = new MswarmConfigStore();
    await store.saveApiKey("stored-cloud-key");
    await withStubServer((req, res) => {
      assert.equal(req.headers["x-api-key"], "stored-cloud-key");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ agents: [] }));
    }, async (baseUrl) => {
      const api = await MswarmApi.create({ baseUrl });
      try {
        const agents = await api.listCloudAgents();
        assert.deepEqual(agents, []);
      } finally {
        await api.close();
      }
    });
  });
});

test("MswarmApi.create respects MCODA_CONFIG for stored API key fallback", { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const originalConfig = process.env.MCODA_CONFIG;
    process.env.MCODA_CONFIG = path.join(home, "custom", "config.json");
    try {
      const store = new MswarmConfigStore();
      await store.saveApiKey("stored-cloud-key");
      await withStubServer((req, res) => {
        assert.equal(req.headers["x-api-key"], "stored-cloud-key");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ agents: [] }));
      }, async (baseUrl) => {
        const api = await MswarmApi.create({ baseUrl });
        try {
          const agents = await api.listCloudAgents();
          assert.deepEqual(agents, []);
        } finally {
          await api.close();
        }
      });
    } finally {
      if (originalConfig === undefined) {
        delete process.env.MCODA_CONFIG;
      } else {
        process.env.MCODA_CONFIG = originalConfig;
      }
    }
  });
});

test("MswarmApi.create defaults to the public mswarm gateway", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const api = await MswarmApi.create({ apiKey: "cloud-key" });
    try {
      assert.equal(api.baseUrl, "https://api.mswarm.org/");
    } finally {
      await api.close();
    }
  });
});

test("MswarmApi.syncCloudAgents materializes managed cloud agents into the registry", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await withStubServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/v1/swarm/cloud/agents") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agents: [
            {
              slug: "openai/gpt-4.1-mini",
              provider: "openrouter",
              default_model: "openai/gpt-4.1-mini",
              cost_per_million: 0.9,
              rating: 8.2,
              reasoning_rating: 8.5,
              max_complexity: 8,
              capabilities: ["code_write", "plan"],
              health_status: "healthy",
              context_window: 128000,
              supports_tools: true,
              model_id: "openai/gpt-4.1-mini",
              display_name: "GPT-4.1 mini",
              description: "Fast cloud model",
              supports_reasoning: true,
              pricing_snapshot_id: "snap-1",
              pricing_version: "2026-03-17",
              sync: { source: "openrouter.models" },
            },
          ],
        }),
      );
    }, async (baseUrl) => {
      const api = await MswarmApi.create({ baseUrl, apiKey: "cloud-key" });
      try {
        const summary = await api.syncCloudAgents();
        assert.equal(summary.created, 1);
        assert.equal(summary.updated, 0);
        assert.equal(summary.agents[0]?.localSlug, "mswarm-cloud-openai-gpt-4-1-mini");

        const repo = await GlobalRepository.create();
        try {
          const agent = await repo.getAgentBySlug("mswarm-cloud-openai-gpt-4-1-mini");
          assert.ok(agent);
          assert.equal(agent.adapter, "openai-api");
          assert.equal(agent.defaultModel, "openai/gpt-4.1-mini");
          assert.equal(agent.openaiCompatible, true);
          assert.equal(agent.contextWindow, 128000);
          assert.equal(agent.supportsTools, true);
          assert.equal(agent.costPerMillion, 0.9);
          assert.equal(agent.rating, 8.2);
          assert.equal(agent.reasoningRating, 8.5);
          assert.equal(agent.maxComplexity, 8);
          assert.equal((agent.config as any)?.baseUrl, new URL("/v1/swarm/openai/", baseUrl).toString());
          assert.equal((agent.config as any)?.mswarmCloud?.managed, true);
          assert.equal((agent.config as any)?.mswarmCloud?.remoteSlug, "openai/gpt-4.1-mini");
          assert.equal((agent.config as any)?.mswarmCloud?.pricingVersion, "2026-03-17");

          const auth = await repo.getAgentAuthMetadata(agent.id);
          assert.equal(auth.configured, true);

          const capabilities = await repo.getAgentCapabilities(agent.id);
          assert.deepEqual(capabilities, ["code_write", "plan"]);

          const models = await repo.getAgentModels(agent.id);
          assert.equal(models.length, 1);
          assert.equal(models[0]?.modelName, "openai/gpt-4.1-mini");

          const health = await repo.getAgentHealth(agent.id);
          assert.equal(health?.status, "healthy");
          assert.equal((health?.details as any)?.source, "mswarm");
        } finally {
          await repo.close();
        }
      } finally {
        await api.close();
      }
    });
  });
});

test("MswarmApi.syncCloudAgents refuses to overwrite a non-managed agent with the same local slug", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      await repo.createAgent({
        slug: "mswarm-cloud-openai-gpt-4-1-mini",
        adapter: "codex-cli",
        defaultModel: "gpt-5.4",
      });
    } finally {
      await repo.close();
    }

    await withStubServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/v1/swarm/cloud/agents") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          agents: [
            {
              slug: "openai/gpt-4.1-mini",
              provider: "openrouter",
              default_model: "openai/gpt-4.1-mini",
              capabilities: [],
              supports_tools: true,
            },
          ],
        }),
      );
    }, async (baseUrl) => {
      const api = await MswarmApi.create({ baseUrl, apiKey: "cloud-key" });
      try {
        await assert.rejects(() => api.syncCloudAgents(), /Refusing to overwrite non-mswarm agent/);
      } finally {
        await api.close();
      }
    });
  });
});
