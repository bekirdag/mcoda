import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { AgentsApi } from "../AgentsApi.js";
import { Connection, GlobalMigrations, GlobalRepository } from "@mcoda/db";
import { AgentService } from "@mcoda/agents";
import { PathHelper } from "@mcoda/shared";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-agents-api-"));
  process.env.HOME = home;
  try {
    await fn(home);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(home, { recursive: true, force: true });
  }
};

const originalSkipCliChecks = process.env.MCODA_SKIP_CLI_CHECKS;
process.env.MCODA_SKIP_CLI_CHECKS = "1";

const makeApi = async () => {
  const conn = await Connection.open(PathHelper.getGlobalDbPath());
  await GlobalMigrations.run(conn.db);
  const repo = new GlobalRepository(conn.db, conn);
  const agentService = new AgentService(repo);
  const routingService = {
    updateWorkspaceDefaults: async () => {},
    close: async () => {},
  };
  const api = new AgentsApi(repo, agentService as any, routingService as any);
  return { api, repo, conn };
};

test("setAgentAuth stores encrypted secret and returns redacted metadata", async () => {
  await withTempHome(async () => {
    const { api, repo } = await makeApi();
    await repo.createAgent({ slug: "openai", adapter: "openai-api" });

    const auth = await api.setAgentAuth("openai", "super-secret");
    assert.equal(auth.configured, true);
    assert.ok(auth.lastUpdatedAt);
    // ensure secrets are not returned
    assert.equal((auth as any).encryptedSecret, undefined);

    const agent = await api.getAgent("openai");
    assert.equal(agent.auth?.configured, true);
    assert.equal((agent.auth as any)?.encryptedSecret, undefined);
    const stored = await repo.getAgentAuthSecret(agent.id);
    assert.ok(stored?.encryptedSecret);
    assert.notEqual(stored?.encryptedSecret, "super-secret");

    await api.close();
  });
});

after(() => {
  process.env.MCODA_SKIP_CLI_CHECKS = originalSkipCliChecks;
});

test("getAgentPrompts returns stored prompt manifest", async () => {
  await withTempHome(async () => {
    const { api, repo } = await makeApi();
    await repo.createAgent({
      slug: "prompted",
      adapter: "local-model",
      prompts: { jobPrompt: "job", characterPrompt: "character", commandPrompts: { test: "cmd" } },
    });

    const manifest = await api.getAgentPrompts("prompted");
    assert.ok(manifest);
    assert.equal(manifest?.jobPrompt, "job");
    assert.equal(manifest?.commandPrompts?.test, "cmd");

    await api.close();
  });
});

test("testAgent stores health and command_runs entry", async () => {
  await withTempHome(async () => {
    const { api, repo, conn } = await makeApi();
    await repo.createAgent({ slug: "codex", adapter: "codex-cli", capabilities: ["chat"] });

    const health = await api.testAgent("codex");
    assert.equal(health.status, "healthy");
    const stored = await repo.getAgentHealth((await repo.getAgentBySlug("codex"))!.id);
    assert.equal(stored?.status, "healthy");
    const runs = await conn.db.all<{ command_name: string }[]>(
      "SELECT command_name FROM command_runs WHERE command_name = 'agent.test'",
    );
    assert.ok(runs.length >= 1);
    const tokenUsage = await conn.db.all<{ command_run_id: string }[]>("SELECT command_run_id FROM token_usage");
    assert.ok(tokenUsage.length >= 1);

    await api.close();
  });
});

test("deleteAgent blocks referenced agents unless forced and logs deletion", async () => {
  await withTempHome(async () => {
    const { api, repo, conn } = await makeApi();
    const agent = await repo.createAgent({ slug: "used", adapter: "local-model" });
    await repo.setWorkspaceDefault("ws-1", "work-on-tasks", agent.id);

    await assert.rejects(() => api.deleteAgent("used"), /routing defaults/i);
    const stillExists = await repo.getAgentBySlug("used");
    assert.ok(stillExists);

    await api.deleteAgent("used", true);
    const missing = await repo.getAgentBySlug("used");
    assert.equal(missing, undefined);
    const runs = await conn.db.all<{ command_name: string }[]>(
      "SELECT command_name FROM command_runs WHERE command_name = 'agent.delete'",
    );
    assert.ok(runs.length >= 1);

    await api.close();
  });
});

test("listAgents returns capabilities, models, and stored health", async () => {
  await withTempHome(async () => {
    const { api, repo } = await makeApi();
    const agent = await repo.createAgent({
      slug: "cap-agent",
      adapter: "openai-api",
      defaultModel: "gpt-4o",
      capabilities: ["chat", "code_write"],
      models: [
        { agentId: "ignore", modelName: "gpt-4o", isDefault: true },
        { agentId: "ignore", modelName: "gpt-4.1-mini", isDefault: false },
      ],
    });
    await repo.setAgentHealth({
      agentId: agent.id,
      status: "healthy",
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 1,
    });

    const agents = await api.listAgents();
    const found = agents.find((a) => a.slug === "cap-agent");
    assert.ok(found);
    assert.equal(found.health?.status, "healthy");
    assert.deepEqual(found.capabilities?.sort(), ["chat", "code_write"].sort());
    assert.ok(found.models?.find((m) => m.modelName === "gpt-4o"));

    await api.close();
  });
});

test("createAgent/updateAgent round trip with auth redaction", async () => {
  await withTempHome(async () => {
    const { api, repo } = await makeApi();
    await api.createAgent({ slug: "crud", adapter: "openai-api", defaultModel: "gpt-4o", capabilities: ["chat"] });
    await api.setAgentAuth("crud", "super-secret");
    const updated = await api.updateAgent("crud", { defaultModel: "gpt-4.1-mini", capabilities: ["chat", "plan"] });
    assert.equal(updated.defaultModel, "gpt-4.1-mini");
    assert.deepEqual(updated.capabilities?.sort(), ["chat", "plan"].sort());

    const agent = await api.getAgent("crud");
    assert.equal(agent.auth?.configured, true);
    assert.equal((agent.auth as any)?.encryptedSecret, undefined);
    const stored = await repo.getAgentAuthSecret(agent.id);
    assert.ok(stored?.encryptedSecret);

    await api.close();
  });
});

test("setDefaultAgent delegates to routing service", async () => {
  await withTempHome(async () => {
    const conn = await Connection.open(PathHelper.getGlobalDbPath());
    await GlobalMigrations.run(conn.db);
    const repo = new GlobalRepository(conn.db, conn);
    const agentService = new AgentService(repo);
    const agent = await repo.createAgent({ slug: "router", adapter: "local-model" });
    let called = 0;
    const routingService = {
      updateWorkspaceDefaults: async (workspaceId: string, update: any) => {
        called += 1;
        assert.equal(workspaceId, "ws-routing");
        assert.equal(update.set?.default, agent.slug);
      },
      close: async () => {},
    };
    const api = new AgentsApi(repo, agentService as any, routingService as any);
    await api.setDefaultAgent(agent.slug, "ws-routing");
    assert.equal(called, 1);
    await api.close();
  });
});
