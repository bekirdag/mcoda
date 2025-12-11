import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoutingCommands } from "../commands/routing/RoutingCommands.js";
import { RoutingService, WorkspaceResolver, JobService } from "@mcoda/core";

const withPatched = async <T, K extends keyof T>(
  target: T,
  key: K,
  impl: T[K],
  fn: () => Promise<void>,
) => {
  const original = target[key];
  (target as any)[key] = impl;
  try {
    await fn();
  } finally {
    (target as any)[key] = original;
  }
};

const captureLogs = async (fn: () => Promise<void>): Promise<string[]> => {
  const logs: string[] = [];
  const original = console.log;
  (console as any).log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    (console as any).log = original;
  }
  return logs;
};

const workspace = {
  workspaceRoot: "/tmp/ws-routing",
  workspaceId: "ws-routing",
  id: "ws-routing",
  legacyWorkspaceIds: [],
  mcodaDir: "/tmp/ws-routing/.mcoda",
  workspaceDbPath: "/tmp/ws-routing/.mcoda/mcoda.db",
  globalDbPath: "/tmp/global/mcoda.db",
};

describe("RoutingCommands", () => {
  it("shows help for defaults", async () => {
    const logs = await captureLogs(async () => RoutingCommands.run(["defaults", "--help"]));
    assert.ok(logs.join("\n").includes("Manage per-workspace routing defaults"));
  });

  it("lists defaults in json", async () => {
    const stubRouting: any = {
      normalizeCommand: (c: string) => c,
      getWorkspaceDefaults: async (id: string) =>
        id === "__GLOBAL__"
          ? [{ workspaceId: "__GLOBAL__", commandName: "default", agentId: "agent-global", updatedAt: "t1" }]
          : [{ workspaceId: workspace.workspaceId, commandName: "create-tasks", agentId: "agent-local", updatedAt: "t2" }],
      getAgentSummary: async (agentId: string) => ({
        id: agentId,
        slug: agentId,
        adapter: "local-model",
        createdAt: "t",
        updatedAt: "t",
      }),
      close: async () => {},
    };

    await withPatched(RoutingService as any, "create", async () => stubRouting, async () => {
      await withPatched(WorkspaceResolver as any, "resolveWorkspace", async () => workspace, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-1" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async () => {}, async () => {
            await withPatched(JobService.prototype as any, "close", async () => {}, async () => {
              const logs = await captureLogs(async () => RoutingCommands.run(["defaults", "--json"]));
              const parsed = JSON.parse(logs.join("\n"));
              assert.equal(parsed.defaults.length, 1);
              assert.equal(parsed.globalDefaults.length, 1);
            });
          });
        });
      });
    });
  });

  it("updates defaults with set-command", async () => {
    const calls: any[] = [];
    const stubRouting: any = {
      normalizeCommand: (c: string) => c,
      updateWorkspaceDefaults: async (workspaceId: string, update: any) => {
        calls.push({ workspaceId, update });
        return [{ workspaceId, commandName: "create-tasks", agentId: "codex", updatedAt: "now" }];
      },
      getAgentSummary: async () => ({ id: "codex", slug: "codex", adapter: "local", createdAt: "t", updatedAt: "t" }),
      close: async () => {},
    };
    await withPatched(RoutingService as any, "create", async () => stubRouting, async () => {
      await withPatched(WorkspaceResolver as any, "resolveWorkspace", async () => workspace, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-2" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async () => {}, async () => {
            await withPatched(JobService.prototype as any, "close", async () => {}, async () => {
              await RoutingCommands.run(["defaults", "--set-command", "create-tasks=codex", "--json"]);
              assert.equal(calls[0]?.workspaceId, workspace.workspaceId);
              assert.deepEqual(calls[0]?.update?.set, { "create-tasks": "codex" });
            });
          });
        });
      });
    });
  });

  it("updates qa/doc defaults", async () => {
    const calls: any[] = [];
    const stubRouting: any = {
      normalizeCommand: (c: string) => c,
      updateWorkspaceDefaults: async (workspaceId: string, update: any) => {
        calls.push({ workspaceId, update });
        return [];
      },
      getAgentSummary: async () => undefined,
      close: async () => {},
    };
    await withPatched(RoutingService as any, "create", async () => stubRouting, async () => {
      await withPatched(WorkspaceResolver as any, "resolveWorkspace", async () => workspace, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-qa" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async () => {}, async () => {
            await withPatched(JobService.prototype as any, "close", async () => {}, async () => {
              await RoutingCommands.run(["defaults", "--set-qa-profile", "integration", "--set-docdex-scope", "sds"]);
              assert.equal(calls[0]?.update?.qaProfile, "integration");
              assert.equal(calls[0]?.update?.docdexScope, "sds");
            });
          });
        });
      });
    });
  });

  it("shows preview output", async () => {
    const stubRouting: any = {
      normalizeCommand: (c: string) => c,
      resolveAgentForCommand: async () => ({
        agentId: "a1",
        agentSlug: "agent-one",
        agent: { id: "a1", slug: "agent-one" },
        model: "stub",
        capabilities: ["code_write"],
        healthStatus: "healthy",
        source: "workspace_default",
        routingPreview: { workspaceId: workspace.workspaceId, commandName: "work-on-tasks" },
        requiredCapabilities: ["code_write"],
      }),
      close: async () => {},
    };
    const tokenCalls: any[] = [];
    await withPatched(RoutingService as any, "create", async () => stubRouting, async () => {
      await withPatched(WorkspaceResolver as any, "resolveWorkspace", async () => workspace, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-3" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async () => {}, async () => {
            await withPatched(JobService.prototype as any, "recordTokenUsage", async (...args: any[]) => {
              tokenCalls.push(args);
            }, async () => {
              await withPatched(JobService.prototype as any, "close", async () => {}, async () => {
                const logs = await captureLogs(async () =>
                  RoutingCommands.run(["preview", "--command", "work-on-tasks"]),
                );
                assert.ok(logs.join("\n").includes("agent-one"));
                assert.equal(tokenCalls.length, 1);
              });
            });
          });
        });
      });
    });
  });

  it("prints explain json", async () => {
    const stubRouting: any = {
      normalizeCommand: (c: string) => c,
      resolveAgentForCommand: async () => ({
        agentId: "a1",
        agentSlug: "agent-one",
        agent: { id: "a1", slug: "agent-one" },
        model: "stub",
        capabilities: ["code_review"],
        healthStatus: "healthy",
        source: "workspace_default",
        routingPreview: {
          workspaceId: workspace.workspaceId,
          commandName: "code-review",
          resolvedAgent: { id: "a1" },
          candidates: [{ agentId: "a1", agentSlug: "agent-one", source: "workspace_default" }],
          provenance: "workspace_default",
        },
        requiredCapabilities: ["code_review"],
      }),
      close: async () => {},
    };
    await withPatched(RoutingService as any, "create", async () => stubRouting, async () => {
      await withPatched(WorkspaceResolver as any, "resolveWorkspace", async () => workspace, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-4" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async () => {}, async () => {
            await withPatched(JobService.prototype as any, "recordTokenUsage", async () => {}, async () => {
              await withPatched(JobService.prototype as any, "close", async () => {}, async () => {
                const logs = await captureLogs(async () =>
                  RoutingCommands.run(["explain", "--command", "code-review", "--json"]),
                );
                const parsed = JSON.parse(logs.join("\n"));
                assert.equal(parsed.commandName ?? parsed.command_name, "code-review");
              });
            });
          });
        });
      });
    });
  });

  it("prints preview json with provenance", async () => {
    const stubRouting: any = {
      normalizeCommand: (c: string) => c,
      resolveAgentForCommand: async () => ({
        agentId: "a2",
        agentSlug: "agent-two",
        agent: { id: "a2", slug: "agent-two" },
        model: "stub",
        capabilities: ["plan"],
        healthStatus: "healthy",
        source: "global_default",
        routingPreview: {
          workspaceId: workspace.workspaceId,
          commandName: "create-tasks",
          resolvedAgent: { id: "a2" },
          provenance: "global_default",
        },
        requiredCapabilities: ["plan"],
      }),
      close: async () => {},
    };
    await withPatched(RoutingService as any, "create", async () => stubRouting, async () => {
      await withPatched(WorkspaceResolver as any, "resolveWorkspace", async () => workspace, async () => {
        await withPatched(JobService.prototype as any, "startCommandRun", async () => ({ id: "cmd-5" }), async () => {
          await withPatched(JobService.prototype as any, "finishCommandRun", async () => {}, async () => {
            await withPatched(JobService.prototype as any, "recordTokenUsage", async () => {}, async () => {
              await withPatched(JobService.prototype as any, "close", async () => {}, async () => {
                const logs = await captureLogs(async () =>
                  RoutingCommands.run(["preview", "--command", "create-tasks", "--json"]),
                );
                const parsed = JSON.parse(logs.join("\n"));
                assert.equal(parsed.provenance, "global_default");
                assert.equal(parsed.commandName ?? parsed.command_name, "create-tasks");
              });
            });
          });
        });
      });
    });
  });
});
