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
  // @ts-expect-error override for testing
  target[key] = impl;
  try {
    await fn();
  } finally {
    // @ts-expect-error restore
    target[key] = original;
  }
};

const captureLogs = async (fn: () => Promise<void>): Promise<string[]> => {
  const logs: string[] = [];
  const original = console.log;
  // @ts-expect-error override
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    // @ts-expect-error restore
    console.log = original;
  }
  return logs;
};

const workspace = {
  workspaceRoot: "/tmp/ws-routing",
  workspaceId: "ws-routing",
  id: "ws-routing",
  mcodaDir: "/tmp/ws-routing/.mcoda",
  workspaceDbPath: "/tmp/ws-routing/.mcoda/mcoda.db",
  globalDbPath: "/tmp/global/mcoda.db",
};

describe("RoutingCommands", () => {
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
        },
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
});
