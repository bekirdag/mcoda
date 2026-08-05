import assert from "node:assert/strict";
import test from "node:test";
import {
  getAgentInventory,
  loadAgentInventory,
  resetAgentInventoryCache,
} from "../AgentInventory.js";

const ok = (agents: unknown[]) => ({
  code: 0,
  stdout: JSON.stringify(agents),
  stderr: "",
});

const healthyAgent = (slug: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${slug}`,
  slug,
  adapter: "openai-cli",
  defaultModel: `${slug}-model`,
  supportsTools: true,
  health: { status: "healthy" },
  ...extra,
});

test("inventory is loaded from mcoda and normalized to expose a model", async () => {
  const result = await loadAgentInventory({
    runCommand: async () => ok([healthyAgent("alpha")]),
  });
  assert.equal(result.source, "mcoda");
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]?.model, "alpha-model");
});

test("unhealthy and quota-limited agents are excluded with a warning", async () => {
  const result = await loadAgentInventory({
    runCommand: async () =>
      ok([
        healthyAgent("alpha"),
        healthyAgent("beta", { health: { status: "unhealthy" } }),
        healthyAgent("gamma", { health: { status: "limited" } }),
      ]),
  });
  assert.deepEqual(result.agents.map((agent) => agent.slug), ["alpha"]);
  assert.ok(result.warnings.some((w) => w.startsWith("agent_inventory_excluded_unhealthy:2")));
});

test("agents with unknown health are included by default", async () => {
  const result = await loadAgentInventory({
    runCommand: async () => ok([healthyAgent("alpha", { health: undefined })]),
  });
  assert.equal(result.agents.length, 1);
});

test("a missing --refresh-health flag falls back to the plain listing", async () => {
  const calls: string[][] = [];
  const result = await loadAgentInventory({
    runCommand: async (_command, args) => {
      calls.push(args);
      if (args.includes("--refresh-health")) {
        return { code: 1, stdout: "", stderr: "unknown option" };
      }
      return ok([healthyAgent("alpha")]);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.agents.length, 1);
  assert.ok(result.warnings.includes("agent_inventory_refresh_health_unavailable"));
});

test("an unavailable mcoda CLI degrades to an empty inventory, not a throw", async () => {
  const result = await loadAgentInventory({
    runCommand: async () => ({ code: -1, stdout: "", stderr: "command not found" }),
  });
  assert.equal(result.source, "empty");
  assert.deepEqual(result.agents, []);
  assert.ok(result.warnings.some((w) => w.startsWith("agent_inventory_unavailable:")));
});

test("malformed JSON degrades to an empty inventory", async () => {
  const result = await loadAgentInventory({
    runCommand: async () => ({ code: 0, stdout: "not json", stderr: "" }),
  });
  assert.equal(result.source, "empty");
  assert.ok(result.warnings.includes("agent_inventory_empty"));
});

test("the inventory is loaded once per process, not once per query", async () => {
  resetAgentInventoryCache();
  let loads = 0;
  const options = {
    runCommand: async () => {
      loads += 1;
      return ok([healthyAgent("alpha")]);
    },
  };

  await getAgentInventory(options);
  await getAgentInventory(options);
  await getAgentInventory(options);

  // One subprocess spawn total. Shelling out per query would put ~hundreds of
  // milliseconds on the critical path of every question.
  assert.equal(loads, 1);
  resetAgentInventoryCache();
});
