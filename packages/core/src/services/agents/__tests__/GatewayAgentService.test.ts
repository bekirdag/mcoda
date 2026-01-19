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

test("GatewayAgentService downgrades non-SDS paths labeled SDS", async () => {
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
    docdex: {
      search: async () => [
        {
          id: "doc-1",
          docType: "SDS",
          path: "docs/architecture.md",
          title: "Architecture",
          content: "No frontmatter here.",
        },
      ],
    },
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
      inputText: "Review SDS architecture",
      agentStream: false,
    });

    assert.equal(result.docdex.length, 1);
    assert.equal(result.docdex[0]?.docType, "DOC");
    assert.ok(result.warnings.some((warning: string) => warning.includes("docType downgraded")));
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
    assert.ok(capturedInput.includes("Do not assume repository structure"));
    assert.ok(capturedInput.includes("tests/all.js"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayAgentService repair prompt allows empty file lists with justification", async () => {
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
              reasoningSummary: "Docs work",
              currentState: "Unknown",
              todo: "Update README",
              understanding: "Docs updated",
              plan: ["Review", "Edit", "Verify"],
              complexity: 3,
              discipline: "docs",
              assumptions: [],
              risks: [],
              docdexNotes: ["No matching docs; file paths unknown"],
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
    assert.ok(repairInput.includes("If file paths are unknown, leave filesLikelyTouched/filesToCreate empty"));
    assert.ok(missingFields.includes("summary"));
    assert.ok(!missingFields.includes("filesLikelyTouched"));
    assert.ok(!missingFields.includes("filesToCreate"));
    assert.ok(!missingFields.includes("files"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayAgentService warns on empty file lists without justification", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const inputs: string[] = [];
  const agent = { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub", rating: 6, reasoningRating: 6 };
  const service = new (GatewayAgentService as any)(workspace, {
    agentService: {
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "gateway-agent": "Prompt" },
      }),
      invoke: async (_id: string, req: any) => {
        inputs.push(req?.input ?? "");
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
            filesLikelyTouched: [],
            filesToCreate: [],
            assumptions: [],
            risks: [],
            docdexNotes: [],
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
      startCommandRun: async () => ({ id: "run-2" }),
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
    assert.equal(inputs.length, 1);
    assert.ok(
      result.warnings.some((warning: string) => warning.includes("no file paths") && warning.includes("justification")),
    );
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

test("GatewayAgentService filters placeholder dependencies from task summaries", async () => {
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
          summary: "Handle task",
          reasoningSummary: "Tasks work",
          currentState: "Unknown",
          todo: "Work tasks",
          understanding: "Tasks updated",
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
    const now = new Date().toISOString();
    (service as any).taskSelectionService = {
      selectTasks: async () => ({
        project: undefined,
        filters: { effectiveStatuses: [] },
        ordered: [
          {
            task: {
              id: "task-1",
              projectId: "proj-1",
              epicId: "epic-1",
              userStoryId: "story-1",
              key: "proj-epic-us-01-t01",
              title: "Task title",
              description: "Task description",
              status: "not_started",
              storyPoints: 3,
              priority: 1,
              assignedAgentId: null,
              assigneeHuman: null,
              vcsBranch: null,
              vcsBaseBranch: null,
              vcsLastCommitSha: null,
              metadata: {},
              openapiVersionAtCreation: null,
              createdAt: now,
              updatedAt: now,
              epicKey: "proj-epic",
              storyKey: "proj-epic-us-01",
              epicTitle: "Epic",
              storyTitle: "Story",
              storyDescription: "Story description",
              acceptanceCriteria: ["criterion"],
            },
            dependencies: {
              ids: [],
              keys: ["t0", "task-1", "proj-epic-us-01-t02", "proj-epic-us-01-t02"],
              blocking: [],
            },
          },
        ],
        blocked: [],
        warnings: [],
      }),
    };

    const result = await service.run({
      workspace,
      job: "work-on-tasks",
      taskKeys: ["proj-epic-us-01-t01"],
      agentStream: false,
    });

    assert.deepEqual(result.tasks[0]?.dependencies, ["proj-epic-us-01-t02"]);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GatewayAgentService de-duplicates OpenAPI doc context", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  let capturedInput = "";
  const agent = { id: "agent-1", slug: "agent-1", adapter: "local", defaultModel: "stub", rating: 6, reasoningRating: 6 };
  const service = new (GatewayAgentService as any)(workspace, {
    agentService: {
      getPrompts: async () => ({
        jobPrompt: "Job",
        characterPrompt: "Char",
        commandPrompts: { "gateway-agent": "Prompt" },
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
    docdex: {
      search: async ({ docType }: { docType?: string }) => {
        if (docType === "OPENAPI") {
          return [
            {
              id: "doc-openapi-1",
              docType: "OPENAPI",
              path: "openapi/one.yaml",
              title: "OpenAPI One",
              content: "openapi: 3.1.0",
            },
            {
              id: "doc-openapi-2",
              docType: "OPENAPI",
              path: "openapi/two.yaml",
              title: "OpenAPI Two",
              content: "openapi: 3.1.0",
            },
          ];
        }
        return [];
      },
    },
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

    const openApiMatches = capturedInput.match(/\[OPENAPI\]/g) ?? [];
    assert.equal(openApiMatches.length, 1);
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
