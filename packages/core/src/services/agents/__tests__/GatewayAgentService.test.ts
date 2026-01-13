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

test("GatewayAgentService keeps gateway schema prompt content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  let capturedInput = "";
  const agent = { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub", rating: 6, reasoningRating: 6 };
  const service = new (GatewayAgentService as any)(workspace, {
    agentService: {
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: {
          "gateway-agent": "Return JSON only with the following schema: {\"filesLikelyTouched\":[],\"filesToCreate\":[]}",
        },
      }),
      invoke: async (_id: string, req: any) => {
        capturedInput = req?.input ?? "";
        return {
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
        };
      },
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
    await service.run({
      workspace,
      job: "work-on-tasks",
      inputText: "Update README",
      agentStream: false,
    });

    assert.ok(capturedInput.includes("Return JSON only with the following schema"));
    assert.ok(capturedInput.includes("filesLikelyTouched"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayAgentService repair prompt uses filesLikelyTouched/filesToCreate", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const inputs: string[] = [];
  const agent = { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub", rating: 6, reasoningRating: 6 };
  let callCount = 0;
  const service = new (GatewayAgentService as any)(workspace, {
    agentService: {
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "gateway-agent": "Prompt" },
      }),
      invoke: async (_id: string, req: any) => {
        inputs.push(req?.input ?? "");
        callCount += 1;
        if (callCount === 1) {
          return {
            output: JSON.stringify({
              summary: "Update docs",
              reasoningSummary: "Docs work",
              currentState: "Unknown",
              todo: "Update README",
              understanding: "Docs updated",
              plan: ["Review", "Edit", "Verify"],
              complexity: 3,
              discipline: "docs",
              assumptions: [],
              risks: [],
              docdexNotes: ["No matching docs"],
            }),
          };
        }
        return {
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
        };
      },
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
    await service.run({
      workspace,
      job: "work-on-tasks",
      inputText: "Update README",
      agentStream: false,
    });

    assert.ok(inputs.length >= 2);
    const repairInput = inputs[1] ?? "";
    const missingLine = repairInput
      .split("\n")
      .find((line) => line.startsWith("Missing fields:"))
      ?.replace("Missing fields:", "")
      .trim();
    const missingFields = missingLine
      ? missingLine.split(",").map((field) => field.trim().replace(/\.$/, ""))
      : [];
    assert.ok(missingFields.includes("filesLikelyTouched"));
    assert.ok(missingFields.includes("filesToCreate"));
    assert.ok(!missingFields.includes("files"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayAgentService strips routing-only prompts from agent profile", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  let capturedInput = "";
  const agent = { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub", rating: 6, reasoningRating: 6 };
  const service = new (GatewayAgentService as any)(workspace, {
    agentService: {
      getPrompts: async () => ({
        jobPrompt: "You are the routing gateway. Choose a route: devstral-local.",
        characterPrompt: "Routing gateway output only route JSON.",
        commandPrompts: {
          "gateway-agent": '"summary" "reasoningSummary" "currentState" "todo" "understanding" "filesLikelyTouched" "filesToCreate"',
        },
      }),
      invoke: async (_id: string, req: any) => {
        capturedInput = req?.input ?? "";
        return {
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
        };
      },
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
    await service.run({
      workspace,
      job: "work-on-tasks",
      inputText: "Update README",
      agentStream: false,
    });

    assert.ok(!capturedInput.includes("routing gateway"));
    assert.ok(!capturedInput.includes("devstral-local"));
    assert.ok(capturedInput.includes("\"summary\""));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayAgentService respects max complexity gating", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const agents = [
    { id: "agent-low-cap", slug: "agent-low-cap", adapter: "local", defaultModel: "stub", rating: 9, reasoningRating: 9, maxComplexity: 4 },
    { id: "agent-high-cap", slug: "agent-high-cap", adapter: "local", defaultModel: "stub", rating: 5, reasoningRating: 5, maxComplexity: 8 },
  ];
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
          complexity: 7,
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
      listAgents: async () => agents,
      listAgentHealthSummary: async () => agents.map((agent) => ({ agentId: agent.id, status: "healthy" })),
      getAgentCapabilities: async () => ["plan", "docdex_query", "code_write"],
    },
    jobService: {
      startCommandRun: async () => ({ id: "run-1" }),
      recordTokenUsage: async () => {},
      finishCommandRun: async () => {},
    },
    workspaceRepo: {},
    routingService: {
      resolveAgentForCommand: async () => ({ agent: agents[0] }),
    },
  });

  const originalRandom = Math.random;
  Math.random = () => 0.9;
  try {
    const result = await service.run({
      workspace,
      job: "work-on-tasks",
      inputText: "Update README",
      agentStream: false,
    });
    assert.equal(result.chosenAgent.agentId, "agent-high-cap");
  } finally {
    Math.random = originalRandom;
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayAgentService exploration can stretch below max complexity", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const agents = [
    { id: "agent-eligible", slug: "agent-eligible", adapter: "local", defaultModel: "stub", rating: 8, reasoningRating: 8, maxComplexity: 6 },
    { id: "agent-stretch", slug: "agent-stretch", adapter: "local", defaultModel: "stub", rating: 4, reasoningRating: 4, maxComplexity: 5 },
  ];
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
          complexity: 6,
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
      listAgents: async () => agents,
      listAgentHealthSummary: async () => agents.map((agent) => ({ agentId: agent.id, status: "healthy" })),
      getAgentCapabilities: async () => ["plan", "docdex_query", "code_write"],
    },
    jobService: {
      startCommandRun: async () => ({ id: "run-1" }),
      recordTokenUsage: async () => {},
      finishCommandRun: async () => {},
    },
    workspaceRepo: {},
    routingService: {
      resolveAgentForCommand: async () => ({ agent: agents[0] }),
    },
  });

  const originalRandom = Math.random;
  const sequence = [0.05, 0.2, 0.1];
  Math.random = () => sequence.shift() ?? 0.1;
  try {
    const result = await service.run({
      workspace,
      job: "work-on-tasks",
      inputText: "Update README",
      agentStream: false,
    });
    assert.equal(result.chosenAgent.agentId, "agent-stretch");
  } finally {
    Math.random = originalRandom;
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayAgentService exploration can select a lower-rated agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const agents = [
    { id: "agent-strong", slug: "agent-strong", adapter: "local", defaultModel: "stub", rating: 9, reasoningRating: 9, maxComplexity: 6 },
    { id: "agent-weak", slug: "agent-weak", adapter: "local", defaultModel: "stub", rating: 2, reasoningRating: 2, maxComplexity: 6 },
    { id: "agent-mid", slug: "agent-mid", adapter: "local", defaultModel: "stub", rating: 5, reasoningRating: 5, maxComplexity: 6 },
  ];
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
          complexity: 4,
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
      listAgents: async () => agents,
      listAgentHealthSummary: async () => agents.map((agent) => ({ agentId: agent.id, status: "healthy" })),
      getAgentCapabilities: async () => ["plan", "docdex_query", "code_write"],
    },
    jobService: {
      startCommandRun: async () => ({ id: "run-1" }),
      recordTokenUsage: async () => {},
      finishCommandRun: async () => {},
    },
    workspaceRepo: {},
    routingService: {
      resolveAgentForCommand: async () => ({ agent: agents[0] }),
    },
  });

  const originalRandom = Math.random;
  const sequence = [0.05, 0.3];
  Math.random = () => sequence.shift() ?? 0.3;
  try {
    const result = await service.run({
      workspace,
      job: "work-on-tasks",
      inputText: "Update README",
      agentStream: false,
    });
    assert.equal(result.chosenAgent.agentId, "agent-weak");
  } finally {
    Math.random = originalRandom;
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayAgentService avoids specified agents", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const agents = [
    { id: "agent-preferred", slug: "agent-preferred", adapter: "local", defaultModel: "stub", rating: 9, reasoningRating: 9, maxComplexity: 6 },
    { id: "agent-fallback", slug: "agent-fallback", adapter: "local", defaultModel: "stub", rating: 5, reasoningRating: 5, maxComplexity: 6 },
  ];
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
          complexity: 4,
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
      listAgents: async () => agents,
      listAgentHealthSummary: async () => agents.map((agent) => ({ agentId: agent.id, status: "healthy" })),
      getAgentCapabilities: async () => ["plan", "docdex_query", "code_write"],
    },
    jobService: {
      startCommandRun: async () => ({ id: "run-1" }),
      recordTokenUsage: async () => {},
      finishCommandRun: async () => {},
    },
    workspaceRepo: {},
    routingService: {
      resolveAgentForCommand: async () => ({ agent: agents[0] }),
    },
  });

  const originalRandom = Math.random;
  Math.random = () => 0.9;
  try {
    const result = await service.run({
      workspace,
      job: "work-on-tasks",
      inputText: "Update README",
      agentStream: false,
      avoidAgents: ["agent-preferred"],
    });
    assert.equal(result.chosenAgent.agentId, "agent-fallback");
  } finally {
    Math.random = originalRandom;
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
