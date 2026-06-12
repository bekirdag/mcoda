import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentsCommands } from "../commands/agents/AgentsCommands.js";
import { GlobalRepository } from "@mcoda/db";
import { AgentsApi, WorkspaceResolver } from "@mcoda/core";

const captureLogs = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const logs: string[] = [];
  const originalLog = console.log;
  // @ts-ignore override
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    console.log = originalLog;
  }
  return logs;
};

const captureConsole = async (
  fn: () => Promise<void> | void,
): Promise<{ logs: string[]; warnings: string[] }> => {
  const logs: string[] = [];
  const warnings: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  // @ts-ignore override
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  // @ts-ignore override
  console.warn = (...args: any[]) => {
    warnings.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    console.log = originalLog;
    // @ts-ignore restore
    console.warn = originalWarn;
  }
  return { logs, warnings };
};

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-agent-cli-"));
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("agent --help prints usage", { concurrency: false }, async () => {
  const logs = await captureLogs(() => AgentsCommands.run(["--help"]));
  const output = logs.join("\n");
  assert.match(output, /Usage: mcoda agent/);
  assert.match(output, /vllm-local/);
  assert.match(output, /llama-cpp-local/);
  assert.match(output, /--config-header <K=V>/);
  assert.match(output, /--config-extra-body-json <JSON>/);
  assert.match(output, /update <NAME>[\s\S]*--adapter <TYPE>/);
  assert.match(output, /update <NAME>[\s\S]*--config-runner-kind <K>/);
  assert.match(output, /update <NAME>[\s\S]*--config-extra-body-json <JSON>/);

  const logsSub = await captureLogs(() => AgentsCommands.run(["list", "--help"]));
  const outputSub = logsSub.join("\n");
  assert.match(outputSub, /Usage: mcoda agent/);
});

test("agent add/list surfaces health from agent_health", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const slug = "codex-super-long-agent-name";
    await AgentsCommands.run([
      "add",
      slug,
      "--adapter",
      "codex-cli",
      "--capability",
      "chat",
      "--max-complexity",
      "8",
      "--openai-compatible",
      "true",
      "--context-window",
      "16384",
      "--max-output-tokens",
      "2048",
      "--supports-tools",
      "true",
    ]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug(slug);
    assert.ok(agent);
    assert.equal(agent.openaiCompatible, true);
    assert.equal(agent.contextWindow, 16384);
    assert.equal(agent.maxOutputTokens, 2048);
    assert.equal(agent.supportsTools, true);
    await repo.setAgentHealth({
      agentId: agent.id,
      status: "healthy",
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 5,
    });
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["list"]));
    const output = logs.join("\n");
    assert.match(output, new RegExp(slug));
    assert.match(output, /healthy/);
    assert.match(output, /MAX CPLX/);
    const row = output.split("\n").find((line) => line.includes(slug));
    assert.ok(row);
    const cells = row.split("│").map((cell) => cell.trim()).filter(Boolean);
    assert.equal(cells[5], "8");
  });
});

test("agent list supports JSON output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "json-agent", "--adapter", "codex-cli", "--capability", "chat"]);
    const logs = await captureLogs(() => AgentsCommands.run(["list", "--json"]));
    const parsed = JSON.parse(logs.join("\n"));
    assert.ok(Array.isArray(parsed));
    const agent = parsed.find((entry: any) => entry.slug === "json-agent");
    assert.ok(agent);
    assert.equal(agent.adapter, "codex-cli");
    assert.ok(agent.auth);
    assert.equal(agent.auth.configured, false);
  });
});

test("agent details supports JSON output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run([
      "add",
      "detail-agent",
      "--adapter",
      "codex-cli",
      "--capability",
      "chat",
      "--max-complexity",
      "7",
    ]);
    const logs = await captureLogs(() => AgentsCommands.run(["details", "detail-agent", "--json"]));
    const parsed = JSON.parse(logs.join("\n"));
    assert.equal(parsed.slug, "detail-agent");
    assert.equal(parsed.maxComplexity, 7);
    assert.ok(Array.isArray(parsed.capabilities));
  });
});

test("agent limits shows reset precision and supports JSON output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "limit-cli", "--adapter", "codex-cli", "--capability", "chat"]);
    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("limit-cli");
    assert.ok(agent);
    await repo.upsertAgentUsageLimit({
      agentId: agent.id,
      limitScope: "model",
      limitKey: "codex-main",
      windowType: "daily",
      status: "exhausted",
      resetAt: "2026-03-03T00:00:00.000Z",
      observedAt: "2026-03-02T10:00:00.000Z",
      source: "invoke_error_parse",
      details: { resetAtSource: "absolute" },
    });
    await repo.upsertAgentUsageLimit({
      agentId: agent.id,
      limitScope: "model",
      limitKey: "codex-main",
      windowType: "weekly",
      status: "exhausted",
      observedAt: "2026-03-02T10:00:00.000Z",
      source: "invoke_error_parse",
      details: {
        resetAtSource: "estimated_window_fallback",
        estimatedResetAt: "2026-03-09T10:00:00.000Z",
      },
    });
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["limits", "--agent", "limit-cli"]));
    const output = logs.join("\n");
    assert.match(output, /AGENT/);
    assert.match(output, /EXACT/);
    assert.match(output, /limit-cli/);
    assert.match(output, /estimated_window_fallback/);

    const jsonLogs = await captureLogs(() =>
      AgentsCommands.run(["limits", "--agent", "limit-cli", "--json"]),
    );
    const parsed = JSON.parse(jsonLogs.join("\n"));
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    const daily = parsed.find((entry: any) => entry.windowType === "daily");
    assert.ok(daily);
    assert.equal(daily.resetAtExact, true);
    const weekly = parsed.find((entry: any) => entry.windowType === "weekly");
    assert.ok(weekly);
    assert.equal(weekly.resetAtExact, false);
    assert.equal(weekly.effectiveResetAt, "2026-03-09T10:00:00.000Z");
  });
});

test("agent list includes usage-limit window summaries", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "limit-list", "--adapter", "codex-cli", "--capability", "chat"]);
    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("limit-list");
    assert.ok(agent);
    await repo.upsertAgentUsageLimit({
      agentId: agent.id,
      limitScope: "model",
      limitKey: "codex-main",
      windowType: "rolling_5h",
      status: "exhausted",
      resetAt: "2026-03-02T15:00:00.000Z",
      observedAt: "2026-03-02T10:00:00.000Z",
      source: "invoke_error_parse",
      details: { resetAtSource: "absolute" },
    });
    await repo.upsertAgentUsageLimit({
      agentId: agent.id,
      limitScope: "model",
      limitKey: "codex-main",
      windowType: "daily",
      status: "exhausted",
      observedAt: "2026-03-02T10:00:00.000Z",
      source: "invoke_error_parse",
      details: {
        resetAtSource: "estimated_window_fallback",
        estimatedResetAt: "2026-03-03T10:00:00.000Z",
      },
    });
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["list"]));
    const output = logs.join("\n");
    assert.match(output, /LIMITS/);
    assert.match(output, /5h:exh@2026-03-02 15:00/);
    assert.match(output, /daily:exh@~2026-03-03 10:00/);
  });
});

test("agent details renders command prompts in text output", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "detail-prompts", "--adapter", "codex-cli", "--capability", "chat"]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("detail-prompts");
    assert.ok(agent);
    await repo.setAgentPrompts(agent.id, {
      commandPrompts: {
        "code-review": "Follow checklist",
        "qa-tasks": "QA prompt",
      },
    });
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["details", "detail-prompts"]));
    const output = logs.join("\n");
    assert.match(output, /Command prompts\s*: code-review=Follow checklist; qa-tasks=QA prompt/);
  });
});

test("agent delete blocks when referenced unless --force is set", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "api-agent", "--adapter", "openai-api"]);
    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("api-agent");
    assert.ok(agent);
    await repo.setWorkspaceDefault("ws-cli", "work-on-tasks", agent.id);
    await repo.close();

    await assert.rejects(() => AgentsCommands.run(["delete", "api-agent"]), /routing defaults/i);

    await AgentsCommands.run(["delete", "api-agent", "--force"]);
    const verify = await GlobalRepository.create();
    const missing = await verify.getAgentBySlug("api-agent");
    assert.equal(missing, undefined);
    await verify.close();
  });
});

test("agent auth set stores encrypted secret and auth-status reports configured", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "secure", "--adapter", "openai-api"]);
    await AgentsCommands.run(["auth", "set", "secure", "--api-key", "top-secret"]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("secure");
    assert.ok(agent);
    const secret = await repo.getAgentAuthSecret(agent.id);
    assert.ok(secret);
    assert.notEqual(secret.encryptedSecret, "top-secret");
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["auth-status", "secure"]));
    const output = logs.join("\n");
    assert.match(output, /configured/i);
    assert.match(output, /secure/);
  });
});

test("agent set-default resolves workspace via WorkspaceResolver", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "codex", "--adapter", "codex-cli", "--capability", "chat"]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-agent-ws-"));
    await AgentsCommands.run(["set-default", "codex", "--workspace", workspaceRoot]);

    const workspace = await WorkspaceResolver.resolveWorkspace({ explicitWorkspace: workspaceRoot });
    const repo = await GlobalRepository.create();
    const defaults = await repo.getWorkspaceDefaults(workspace.workspaceId);
    const agent = await repo.getAgentBySlug("codex");
    await repo.close();
    const mapping = defaults.find((d) => d.commandName === "default");
    assert.ok(mapping);
    assert.ok(agent);
    assert.equal(mapping.agentId, agent.id);
  });
});

test("agent add stores config for ollama-remote", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run([
      "add",
      "suku-ollama",
      "--adapter",
      "ollama-remote",
      "--model",
      "gpt-oss:20b",
      "--config-base-url",
      "http://192.168.1.115:11434",
      "--capability",
      "plan",
    ]);
    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("suku-ollama");
    assert.ok(agent);
    assert.equal((agent.config as any)?.baseUrl, "http://192.168.1.115:11434");
    await repo.close();
  });
});

test("agent add stores local OpenAI-compatible runner config flags", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run([
      "add",
      "phase4-vllm",
      "--adapter",
      "vllm-local",
      "--model",
      "local-model",
      "--config-base-url",
      "http://127.0.0.1:8000/v1",
      "--config-header",
      "X-Trace=phase4",
      "--config-header",
      "X-Runner=vllm",
      "--config-extra-body-json",
      '{"guided_choice":["yes","no"],"top_k":40}',
      "--config-response-format-strategy",
      "json_schema",
      "--config-health-path",
      "/health",
      "--config-models-path",
      "/v1/models",
      "--config-dummy-bearer-token",
      "not-a-secret",
      "--capability",
      "plan",
      "--capability",
      "code_write",
    ]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("phase4-vllm");
    assert.ok(agent);
    assert.equal(agent.adapter, "vllm-local");
    assert.equal(agent.defaultModel, "local-model");
    assert.equal(agent.openaiCompatible, true);
    assert.equal(agent.costPerMillion, 0);
    assert.deepEqual(await repo.getAgentCapabilities(agent.id), ["code_write", "plan"]);
    assert.equal((agent.config as any)?.baseUrl, "http://127.0.0.1:8000/v1");
    assert.equal((agent.config as any)?.runnerKind, "vllm");
    assert.equal((agent.config as any)?.authMode, "none");
    assert.equal((agent.config as any)?.dummyBearerToken, "not-a-secret");
    assert.deepEqual((agent.config as any)?.headers, {
      "X-Trace": "phase4",
      "X-Runner": "vllm",
    });
    assert.deepEqual((agent.config as any)?.extraBody, {
      guided_choice: ["yes", "no"],
      top_k: 40,
    });
    assert.equal((agent.config as any)?.responseFormatStrategy, "json-schema");
    assert.equal((agent.config as any)?.healthPath, "/health");
    assert.equal((agent.config as any)?.modelsPath, "/v1/models");
    await repo.close();
  });
});

test("agent add defaults llama.cpp local runner kinds", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run([
      "add",
      "phase4-llama-cpp",
      "--adapter",
      "llama-cpp-local",
      "--config-base-url",
      "http://127.0.0.1:8080/v1",
    ]);
    await AgentsCommands.run([
      "add",
      "phase4-legacy-llamacpp",
      "--adapter",
      "llamacpp-local",
      "--config-base-url",
      "http://127.0.0.1:8081/v1",
    ]);

    const repo = await GlobalRepository.create();
    const llamaCpp = await repo.getAgentBySlug("phase4-llama-cpp");
    const legacy = await repo.getAgentBySlug("phase4-legacy-llamacpp");
    assert.ok(llamaCpp);
    assert.ok(legacy);
    assert.equal((llamaCpp.config as any)?.runnerKind, "llama-cpp");
    assert.equal((legacy.config as any)?.runnerKind, "llama-cpp");
    assert.equal((llamaCpp.config as any)?.authMode, "none");
    assert.equal((legacy.config as any)?.authMode, "none");
    await repo.close();
  });
});

test("agent update merges local runner config patches", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run([
      "add",
      "phase4-update-local",
      "--adapter",
      "vllm-local",
      "--config-base-url",
      "http://127.0.0.1:8000/v1",
      "--config-runner-kind",
      "custom",
      "--config-response-format-strategy",
      "none",
    ]);
    await AgentsCommands.run([
      "update",
      "phase4-update-local",
      "--config-header",
      "X-Trace=updated",
    ]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("phase4-update-local");
    assert.ok(agent);
    assert.equal((agent.config as any)?.baseUrl, "http://127.0.0.1:8000/v1");
    assert.equal((agent.config as any)?.runnerKind, "custom");
    assert.equal((agent.config as any)?.authMode, "none");
    assert.equal((agent.config as any)?.responseFormatStrategy, "none");
    assert.deepEqual((agent.config as any)?.headers, { "X-Trace": "updated" });
    await repo.close();
  });
});

test("agent update switching to local adapter stores local defaults", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "phase4-switch-local", "--adapter", "openai-api"]);
    await AgentsCommands.run([
      "update",
      "phase4-switch-local",
      "--adapter",
      "vllm-local",
      "--config-base-url",
      "http://127.0.0.1:8000/v1",
    ]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("phase4-switch-local");
    assert.ok(agent);
    assert.equal(agent.adapter, "vllm-local");
    assert.equal(agent.openaiCompatible, true);
    assert.equal(agent.costPerMillion, 0);
    assert.equal((agent.config as any)?.baseUrl, "http://127.0.0.1:8000/v1");
    assert.equal((agent.config as any)?.runnerKind, "vllm");
    assert.equal((agent.config as any)?.authMode, "none");
    await repo.close();
  });
});

test("agent update switching to local adapter reuses existing baseUrl config", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run([
      "add",
      "phase4-switch-existing-base-url",
      "--adapter",
      "openai-api",
      "--config-base-url",
      "http://127.0.0.1:8000/v1",
    ]);
    await AgentsCommands.run([
      "update",
      "phase4-switch-existing-base-url",
      "--adapter",
      "vllm-local",
    ]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("phase4-switch-existing-base-url");
    assert.ok(agent);
    assert.equal(agent.adapter, "vllm-local");
    assert.equal(agent.openaiCompatible, true);
    assert.equal(agent.costPerMillion, 0);
    assert.equal((agent.config as any)?.baseUrl, "http://127.0.0.1:8000/v1");
    assert.equal((agent.config as any)?.runnerKind, "vllm");
    assert.equal((agent.config as any)?.authMode, "none");
    await repo.close();
  });
});

test("agent add warns for non-loopback authless local runner URLs", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const output = await captureConsole(() =>
      AgentsCommands.run([
        "add",
        "phase4-lan-vllm",
        "--adapter",
        "vllm-local",
        "--config-base-url",
        "http://192.168.1.115:8000/v1",
      ]),
    );
    assert.match(output.logs.join("\n"), /Created agent phase4-lan-vllm/);
    assert.match(output.warnings.join("\n"), /authMode=none/);
    assert.match(output.warnings.join("\n"), /non-loopback baseUrl/);
  });
});

test("agent add rejects unsafe local runner config flags", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await assert.rejects(
      () =>
        AgentsCommands.run([
          "add",
          "phase4-invalid-json",
          "--adapter",
          "vllm-local",
          "--config-base-url",
          "http://127.0.0.1:8000/v1",
          "--config-extra-body-json",
          "{not-json",
        ]),
      /Invalid --config-extra-body-json/,
    );
    await assert.rejects(
      () =>
        AgentsCommands.run([
          "add",
          "phase4-secret-header",
          "--adapter",
          "vllm-local",
          "--config-base-url",
          "http://127.0.0.1:8000/v1",
          "--config-header",
          "Authorization=Bearer token",
        ]),
      /secret-bearing header/i,
    );
    await assert.rejects(
      () =>
        AgentsCommands.run([
          "add",
          "phase4-reserved-extra-body",
          "--adapter",
          "vllm-local",
          "--config-base-url",
          "http://127.0.0.1:8000/v1",
          "--config-extra-body-json",
          '{"messages":[]}',
        ]),
      /reserved OpenAI request key "messages"/,
    );
    await assert.rejects(
      () =>
        AgentsCommands.run([
          "add",
          "phase4-bad-url",
          "--adapter",
          "vllm-local",
          "--config-base-url",
          "not-a-url",
        ]),
      /Invalid --config-base-url/,
    );
    await assert.rejects(
      () =>
        AgentsCommands.run([
          "add",
          "phase4-bad-runner-kind",
          "--adapter",
          "vllm-local",
          "--config-base-url",
          "http://127.0.0.1:8000/v1",
          "--config-runner-kind",
          "mystery-runner",
        ]),
      /Invalid --config-runner-kind/,
    );
    await assert.rejects(
      () =>
        AgentsCommands.run([
          "add",
          "phase4-bad-auth-mode",
          "--adapter",
          "vllm-local",
          "--config-base-url",
          "http://127.0.0.1:8000/v1",
          "--config-auth-mode",
          "apikey",
        ]),
      /Invalid --config-auth-mode/,
    );
    await assert.rejects(
      () =>
        AgentsCommands.run([
          "add",
          "phase4-openai-false",
          "--adapter",
          "vllm-local",
          "--config-base-url",
          "http://127.0.0.1:8000/v1",
          "--openai-compatible",
          "false",
        ]),
      /Local OpenAI-compatible adapters require --openai-compatible true/,
    );
    await assert.rejects(
      () =>
        AgentsCommands.run([
          "add",
          "phase4-missing-base-url",
          "--adapter",
          "vllm-local",
        ]),
      /--config-base-url is required/,
    );
  });
});

test("agent ratings lists recent run scores", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "rated-agent", "--adapter", "codex-cli"]);

    const repo = await GlobalRepository.create();
    const agent = await repo.getAgentBySlug("rated-agent");
    assert.ok(agent);
    await repo.insertAgentRunRating({
      agentId: agent.id,
      commandName: "work-on-tasks",
      taskKey: "proj-epic-us-01-t01",
      runScore: 8.4,
      qualityScore: 8.8,
      tokensTotal: 1200,
      durationSeconds: 45,
      iterations: 2,
      totalCost: 0.02,
      createdAt: new Date().toISOString(),
    });
    await repo.close();

    const logs = await captureLogs(() => AgentsCommands.run(["ratings", "--agent", "rated-agent"]));
    const output = logs.join("\n");
    assert.match(output, /work-on-tasks/);
    assert.match(output, /proj-epic-us-01-t01/);
  });
});

test("agent list forwards refresh-health only when explicitly requested", { concurrency: false }, async () => {
  const originalCreate = (AgentsApi as any).create;
  const listOptions: Array<{ refreshHealth?: boolean }> = [];
  const fakeApi = {
    listAgents: async (options?: { refreshHealth?: boolean }) => {
      listOptions.push(options ?? {});
      return [
        {
          id: "agent-1",
          slug: "agent-1",
          adapter: "codex-cli",
          capabilities: ["chat"],
          health: { status: "healthy", lastCheckedAt: "2026-03-07T00:00:00.000Z" },
        },
      ];
    },
    getAgent: async () => ({
      id: "agent-1",
      slug: "agent-1",
      adapter: "codex-cli",
      capabilities: ["chat"],
      auth: { configured: false },
      health: { status: "healthy", lastCheckedAt: "2026-03-07T00:00:00.000Z" },
    }),
    listAgentUsageLimits: async () => [],
    close: async () => {},
  };

  (AgentsApi as any).create = async () => fakeApi;
  try {
    await captureLogs(() => AgentsCommands.run(["list"]));
    await captureLogs(() => AgentsCommands.run(["list", "--json"]));
    await captureLogs(() => AgentsCommands.run(["list", "--json", "--no-refresh-health"]));
    await captureLogs(() => AgentsCommands.run(["list", "--refresh-health"]));
  } finally {
    (AgentsApi as any).create = originalCreate;
  }

  assert.equal(listOptions.length, 4);
  assert.equal(listOptions[0].refreshHealth, false);
  assert.equal(listOptions[1].refreshHealth, false);
  assert.equal(listOptions[2].refreshHealth, false);
  assert.equal(listOptions[3].refreshHealth, true);
});

test("agent list rejects conflicting refresh flags", { concurrency: false }, async () => {
  const originalCreate = (AgentsApi as any).create;
  const fakeApi = {
    listAgents: async () => [],
    listAgentUsageLimits: async () => [],
    close: async () => {},
  };
  (AgentsApi as any).create = async () => fakeApi;
  try {
    await assert.rejects(
      () => AgentsCommands.run(["list", "--refresh-health", "--no-refresh-health"]),
      /Conflicting flags/,
    );
  } finally {
    (AgentsApi as any).create = originalCreate;
  }
});
