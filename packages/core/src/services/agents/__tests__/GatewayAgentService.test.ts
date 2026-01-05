import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { GatewayAgentService } from "../GatewayAgentService.js";

test("GatewayAgentService returns analysis and agent decision", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });

  const agent = { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub", rating: 6, reasoningRating: 6 };
  const service = new (GatewayAgentService as any)(workspace, {
    agentService: {
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "gateway-agent": "Prompt" },
      }),
      invoke: async () => ({
        output: JSON.stringify({
          summary: "Update docs",
          reasoningSummary: "Docs work",
          currentState: "Unknown",
          todo: "Update README",
          understanding: "Docs updated",
          plan: ["Review", "Edit", "Verify"],
          complexity: 3,
          discipline: "docs",
          filesLikelyTouched: ["README.md"],
          filesToCreate: [],
          assumptions: [],
          risks: [],
          docdexNotes: ["No matching docs"],
        }),
      }),
    },
    docdex: { search: async () => [] },
    globalRepo: {
      listAgents: async () => [agent],
      listAgentHealthSummary: async () => [{ agentId: agent.id, status: "healthy" }],
      getAgentCapabilities: async () => ["plan", "docdex_query", "code_write"],
    },
    jobService: {
      startCommandRun: async () => ({ id: "run-1" }),
      recordTokenUsage: async () => {},
      finishCommandRun: async () => {},
    },
    workspaceRepo: {},
    routingService: {
      resolveAgentForCommand: async () => ({ agent }),
    },
  });

  try {
    const result = await service.run({
      workspace,
      job: "work-on-tasks",
      inputText: "Update README",
      agentStream: false,
    });

    assert.equal(result.job, "work-on-tasks");
    assert.equal(result.gatewayAgent.id, agent.id);
    assert.equal(result.analysis.discipline, "docs");
    assert.equal(result.chosenAgent.agentId, agent.id);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
