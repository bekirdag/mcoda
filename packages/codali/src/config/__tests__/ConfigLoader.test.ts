import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../ConfigLoader.js";

test("loadConfig merges cli over env over file", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const configPath = path.join(tmpDir, "codali.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaceRoot: "/file",
        provider: "file-provider",
        model: "file-model",
        agentId: "file-agent",
        limits: { maxSteps: 7 },
      },
      null,
      2,
    ),
  );

  const env: NodeJS.ProcessEnv = {
    CODALI_WORKSPACE_ROOT: "/env",
    CODALI_PROVIDER: "env-provider",
    CODALI_MODEL: "env-model",
    CODALI_AGENT_ID: "env-agent",
  };

  const config = await loadConfig({
    cwd: tmpDir,
    env,
    cli: {
      workspaceRoot: "cli-root",
      provider: "cli-provider",
      model: "cli-model",
      agentId: "cli-agent",
    },
  });

  assert.equal(config.workspaceRoot, path.resolve(tmpDir, "cli-root"));
  assert.equal(config.provider, "cli-provider");
  assert.equal(config.model, "cli-model");
  assert.equal(config.agentId, "cli-agent");
  assert.equal(config.limits.maxSteps, 7);
});

test("loadConfig defaults docdex base URL", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
    },
  });

  assert.equal(config.docdex.baseUrl, "http://127.0.0.1:28491");
});

test("loadConfig provides defaults for context/security/builder/streaming/cost/localContext", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
    },
  });

  assert.equal(config.context.mode, "bundle_text");
  assert.equal(config.context.maxFiles, 8);
  assert.equal(config.security.redactPatterns.length > 0, true);
  assert.equal(config.security.allowDocEdits, false);
  assert.ok(config.security.readOnlyPaths.includes("docs/sds"));
  assert.equal(config.builder.mode, "patch_json");
  assert.equal(config.builder.fallbackToInterpreter, true);
  assert.equal(config.tools.allowDestructiveOperations, false);
  assert.equal(config.interpreter.provider, "auto");
  assert.equal(config.interpreter.model, "auto");
  assert.equal(config.interpreter.format, "json");
  assert.equal(config.interpreter.maxRetries, 1);
  assert.equal(config.interpreter.timeoutMs, 300_000);
  assert.equal(config.streaming.enabled, true);
  assert.equal(config.cost.maxCostPerRun, 0.5);
  assert.equal(config.cost.charPerToken, 4);
  assert.equal(config.localContext.enabled, true);
  assert.equal(config.localContext.storageDir, "codali/context");
  assert.equal(config.localContext.maxMessages, 200);
  assert.equal(config.localContext.summarize.enabled, true);
  assert.equal(config.deepInvestigation?.enabled, true);
  assert.equal(config.deepInvestigation?.deepScanPreset, false);
  assert.equal(config.deepInvestigation?.toolQuota.search, 3);
  assert.equal(config.workflow?.profile, "run");
  assert.equal(config.resolvedWorkflowProfile?.name, "run");
  assert.equal(config.resolvedWorkflowProfile?.source, "default");
  assert.equal(config.workflow?.profiles?.fix?.outputContract, "patch_summary");
  assert.equal(config.workflow?.profiles?.explain?.allowWrites, false);
  assert.equal(config.workflow?.profiles?.test?.verificationMinimumChecks, 1);
  assert.equal(config.workflow?.profiles?.test?.verificationEnforceHighConfidence, true);
  assert.equal(config.eval.report_dir, "logs/codali/eval");
  assert.equal(config.eval.gates.patch_apply_drop_max, 0.02);
  assert.equal(config.eval.gates.verification_pass_rate_min, 0.9);
  assert.equal(config.eval.gates.hallucination_rate_max, 0.02);
  assert.equal(config.eval.gates.scope_violation_rate_max, 0);
});

test("loadConfig uses DOCDEX_HTTP_BASE_URL when set", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      DOCDEX_HTTP_BASE_URL: "http://127.0.0.1:9999",
    },
  });

  assert.equal(config.docdex.baseUrl, "http://127.0.0.1:9999");
});

test("loadConfig parses maxRetries from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_LIMIT_MAX_RETRIES: "5",
    },
  });

  assert.equal(config.limits.maxRetries, 5);
});

test("loadConfig applies context/builder/streaming/cost/localContext overrides from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_CONTEXT_MODE: "bundle_text",
      CODALI_CONTEXT_MAX_FILES: "9",
      CODALI_CONTEXT_PREFERRED_FILES: "src/index.ts,src/app.ts",
      CODALI_CONTEXT_SKIP_SEARCH: "true",
      CODALI_BUILDER_MODE: "freeform",
      CODALI_BUILDER_FALLBACK_INTERPRETER: "true",
      CODALI_COST_MAX_PER_RUN: "0.25",
      CODALI_SECURITY_ALLOW_DOC_EDITS: "true",
      CODALI_SECURITY_READONLY_PATHS: "docs/qa,openapi.yaml",
      CODALI_LOCAL_CONTEXT_ENABLED: "true",
      CODALI_LOCAL_CONTEXT_MAX_MESSAGES: "150",
      CODALI_LOCAL_CONTEXT_SUMMARIZE_ENABLED: "false",
      CODALI_ALLOW_DESTRUCTIVE_OPERATIONS: "true",
    },
  });

  assert.equal(config.context.mode, "bundle_text");
  assert.equal(config.context.maxFiles, 9);
  assert.ok(config.context.preferredFiles?.includes("src/index.ts"));
  assert.equal(config.context.skipSearchWhenPreferred, true);
  assert.equal(config.builder.mode, "freeform");
  assert.equal(config.builder.fallbackToInterpreter, true);
  assert.equal(config.streaming.enabled, true);
  assert.equal(config.cost.maxCostPerRun, 0.25);
  assert.equal(config.security.allowDocEdits, true);
  assert.ok(config.security.readOnlyPaths.includes("docs/qa"));
  assert.equal(config.localContext.enabled, true);
  assert.equal(config.localContext.maxMessages, 150);
  assert.equal(config.localContext.summarize.enabled, false);
  assert.equal(config.tools.allowDestructiveOperations, true);
  assert.equal(config.eval.report_dir, "logs/codali/eval");
});

test("loadConfig applies eval gate/report overrides from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_EVAL_REPORT_DIR: "logs/custom-eval",
      CODALI_EVAL_GATE_PATCH_APPLY_DROP_MAX: "0.05",
      CODALI_EVAL_GATE_VERIFICATION_PASS_RATE_MIN: "0.8",
      CODALI_EVAL_GATE_HALLUCINATION_RATE_MAX: "0.1",
      CODALI_EVAL_GATE_SCOPE_VIOLATION_RATE_MAX: "0.2",
    },
  });

  assert.equal(config.eval.report_dir, "logs/custom-eval");
  assert.equal(config.eval.gates.patch_apply_drop_max, 0.05);
  assert.equal(config.eval.gates.verification_pass_rate_min, 0.8);
  assert.equal(config.eval.gates.hallucination_rate_max, 0.1);
  assert.equal(config.eval.gates.scope_violation_rate_max, 0.2);
});

test("loadConfig supports destructive policy alias env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_ALLOW_DESTRUCTIVE_ACTIONS: "true",
    },
  });

  assert.equal(config.tools.allowDestructiveOperations, true);
});

test("loadConfig accepts CODALI_SECURITY_READ_ONLY_PATHS alias", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_SECURITY_READ_ONLY_PATHS: "docs/sds,openapi.yaml",
    },
  });

  assert.ok(config.security.readOnlyPaths.includes("docs/sds"));
  assert.ok(config.security.readOnlyPaths.includes("openapi.yaml"));

  const configOverride = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_SECURITY_READ_ONLY_PATHS: "docs/sds",
      CODALI_SECURITY_READONLY_PATHS: "docs/rfp",
    },
  });

  assert.ok(configOverride.security.readOnlyPaths.includes("docs/rfp"));
  assert.ok(!configOverride.security.readOnlyPaths.includes("docs/sds"));
});

test("loadConfig captures CODALI_PLAN_HINT from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_PLAN_HINT: "{\"steps\":[\"Do it\"],\"target_files\":[\"src/index.ts\"]}",
    },
  });

  assert.equal(config.planHint, "{\"steps\":[\"Do it\"],\"target_files\":[\"src/index.ts\"]}");
});

test("loadConfig applies command-derived workflow profile precedence", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const configPath = path.join(tmpDir, "codali.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaceRoot: tmpDir,
        provider: "openai",
        model: "gpt-test",
        workflow: {
          profile: "review",
        },
      },
      null,
      2,
    ),
  );

  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_WORKFLOW_PROFILE: "explain",
    },
    cli: {
      command: "fix",
      workflow: {
        profile: "test",
      },
    },
  });

  assert.equal(config.resolvedWorkflowProfile?.name, "fix");
  assert.equal(config.resolvedWorkflowProfile?.source, "command");
  assert.equal(config.workflow?.profile, "fix");
});

test("loadConfig allows run command workflow override from CLI", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_WORKFLOW_PROFILE: "review",
    },
    cli: {
      command: "run",
      workflow: {
        profile: "explain",
      },
    },
  });

  assert.equal(config.resolvedWorkflowProfile?.name, "explain");
  assert.equal(config.resolvedWorkflowProfile?.source, "cli");
  assert.equal(config.smart, true);
});

test("loadConfig supports verification policy minimum/high-confidence profile overrides", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const configPath = path.join(tmpDir, "codali.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaceRoot: tmpDir,
        provider: "openai",
        model: "gpt-test",
        workflow: {
          profile: "fix",
          profiles: {
            fix: {
              verificationPolicy: "strict-fix",
              verificationMinimumChecks: 2,
              verificationEnforceHighConfidence: true,
            },
          },
        },
      },
      null,
      2,
    ),
  );
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
    },
  });
  assert.equal(config.resolvedWorkflowProfile?.name, "fix");
  assert.equal(config.resolvedWorkflowProfile?.verificationPolicy, "strict-fix");
  assert.equal(config.resolvedWorkflowProfile?.verificationMinimumChecks, 2);
  assert.equal(config.resolvedWorkflowProfile?.verificationEnforceHighConfidence, true);
});

test("loadConfig rejects negative verification minimum checks", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  await assert.rejects(async () => {
    await loadConfig({
      cwd: tmpDir,
      env: {
        CODALI_WORKSPACE_ROOT: tmpDir,
        CODALI_PROVIDER: "openai",
        CODALI_MODEL: "gpt-test",
      },
      cli: {
        workflow: {
          profiles: {
            run: {
              verificationMinimumChecks: -1,
            },
          },
        },
      },
    });
  }, /verificationMinimumChecks/i);
});

test("loadConfig rejects invalid workflow profile env value", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  await assert.rejects(async () => {
    await loadConfig({
      cwd: tmpDir,
      env: {
        CODALI_WORKSPACE_ROOT: tmpDir,
        CODALI_PROVIDER: "openai",
        CODALI_MODEL: "gpt-test",
        CODALI_WORKFLOW_PROFILE: "unknown",
      },
    });
  }, /unsupported workflow profile/i);
});

test("loadConfig applies interpreter overrides from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_INTERPRETER_PROVIDER: "openai-compatible",
      CODALI_INTERPRETER_MODEL: "gpt-override",
      CODALI_INTERPRETER_FORMAT: "json",
      CODALI_INTERPRETER_MAX_RETRIES: "2",
      CODALI_INTERPRETER_TIMEOUT_MS: "90000",
    },
  });

  assert.equal(config.interpreter.provider, "openai-compatible");
  assert.equal(config.interpreter.model, "gpt-override");
  assert.equal(config.interpreter.format, "json");
  assert.equal(config.interpreter.maxRetries, 2);
  assert.equal(config.interpreter.timeoutMs, 90000);
});

test("loadConfig applies routing model overrides from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_MODEL_BUILDER: "builder-model",
      CODALI_MODEL_ARCHITECT: "architect-model",
    },
  });

  assert.equal(config.routing?.builder?.model, "builder-model");
  assert.equal(config.routing?.architect?.model, "architect-model");
});

test("loadConfig applies routing agent overrides from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_AGENT_BUILDER: "builder-agent",
      CODALI_AGENT_ARCHITECT: "architect-agent",
      CODALI_AGENT_INTERPRETER: "interpreter-agent",
    },
  });

  assert.equal(config.routing?.builder?.agent, "builder-agent");
  assert.equal(config.routing?.architect?.agent, "architect-agent");
  assert.equal(config.routing?.interpreter?.agent, "interpreter-agent");
});

test("loadConfig allows missing provider/model when smart routing agents set", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_SMART: "1",
      CODALI_AGENT_BUILDER: "builder-agent",
    },
  });

  assert.equal(config.smart, true);
  assert.equal(config.provider, "");
  assert.equal(config.model, "");
  assert.equal(config.routing?.builder?.agent, "builder-agent");
});

test("loadConfig applies routing provider overrides from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_PROVIDER_BUILDER: "ollama-remote",
    },
  });

  assert.equal(config.routing?.builder?.provider, "ollama-remote");
});

test("loadConfig applies routing format overrides from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_FORMAT_BUILDER: "gbnf",
    },
  });

  assert.equal(config.routing?.builder?.format, "gbnf");
});

test("loadConfig applies routing grammar overrides from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_GRAMMAR_BUILDER: "root ::= \"ok\"",
    },
  });

  assert.equal(config.routing?.builder?.grammar, "root ::= \"ok\"");
});

test("loadConfig preserves routing fields when env overrides model", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const configPath = path.join(tmpDir, "codali.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaceRoot: tmpDir,
        provider: "openai",
        model: "gpt-test",
        routing: {
          builder: { provider: "ollama-remote", format: "json" },
        },
      },
      null,
      2,
    ),
  );

  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_MODEL_BUILDER: "builder-model",
    },
  });

  assert.equal(config.routing?.builder?.provider, "ollama-remote");
  assert.equal(config.routing?.builder?.format, "json");
  assert.equal(config.routing?.builder?.model, "builder-model");
});

test("loadConfig keeps empty routing phases when specified", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const configPath = path.join(tmpDir, "codali.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaceRoot: tmpDir,
        provider: "openai",
        model: "gpt-test",
        routing: {
          librarian: {},
        },
      },
      null,
      2,
    ),
  );

  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
    },
  });

  assert.ok(config.routing?.librarian);
});

test("loadConfig throws on missing required fields", { concurrency: false }, async () => {
  await assert.rejects(async () => {
    await loadConfig({
      cwd: process.cwd(),
      env: {
        CODALI_SMART: "0",
      },
      cli: {},
    });
  }, /Missing required config/);
});

test("loadConfig rejects invalid localContext values", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  await assert.rejects(async () => {
    await loadConfig({
      cwd: tmpDir,
      env: {
        CODALI_WORKSPACE_ROOT: tmpDir,
        CODALI_PROVIDER: "openai",
        CODALI_MODEL: "gpt-test",
        CODALI_LOCAL_CONTEXT_MAX_MESSAGES: "-1",
      },
    });
  }, /Invalid config values/);
});

test("loadConfig applies deep investigation env overrides", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_DEEP_INVESTIGATION_ENABLED: "true",
      CODALI_DEEP_INVESTIGATION_DEEP_SCAN_PRESET: "1",
      CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_SEARCH: "4",
      CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_OPEN_OR_SNIPPET: "3",
      CODALI_DEEP_INVESTIGATION_BUDGET_MIN_CYCLES: "2",
      CODALI_DEEP_INVESTIGATION_BUDGET_MIN_SECONDS: "120",
      CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_SEARCH_HITS: "6",
    },
  });

  assert.equal(config.deepInvestigation?.enabled, true);
  assert.equal(config.deepInvestigation?.deepScanPreset, true);
  assert.equal(config.deepInvestigation?.toolQuota.search, 4);
  assert.equal(config.deepInvestigation?.toolQuota.openOrSnippet, 3);
  assert.equal(config.deepInvestigation?.investigationBudget.minCycles, 2);
  assert.equal(config.deepInvestigation?.investigationBudget.minSeconds, 120);
  assert.equal(config.deepInvestigation?.evidenceGate.minSearchHits, 6);
});

test("loadConfig merges deep investigation config with precedence", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const configPath = path.join(tmpDir, "codali.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaceRoot: "/file",
        provider: "file-provider",
        model: "file-model",
        deepInvestigation: {
          enabled: true,
          deepScanPreset: true,
          toolQuota: { search: 2 },
        },
      },
      null,
      2,
    ),
  );

  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: "/env",
      CODALI_PROVIDER: "env-provider",
      CODALI_MODEL: "env-model",
      CODALI_DEEP_INVESTIGATION_ENABLED: "false",
      CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_SEARCH: "3",
    },
    cli: {
      deepInvestigation: {
        toolQuota: { search: 4 },
      },
    },
  });

  assert.equal(config.deepInvestigation?.enabled, false);
  assert.equal(config.deepInvestigation?.deepScanPreset, true);
  assert.equal(config.deepInvestigation?.toolQuota.search, 4);
});

test("loadConfig rejects invalid deep investigation env values", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  await assert.rejects(async () => {
    await loadConfig({
      cwd: tmpDir,
      env: {
        CODALI_WORKSPACE_ROOT: tmpDir,
        CODALI_PROVIDER: "openai",
        CODALI_MODEL: "gpt-test",
        CODALI_DEEP_INVESTIGATION_ENABLED: "maybe",
      },
    });
  }, /Invalid CODALI_DEEP_INVESTIGATION_ENABLED/);
});

test("loadConfig rejects invalid deep investigation config values", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const configPath = path.join(tmpDir, "codali.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaceRoot: tmpDir,
        provider: "openai",
        model: "gpt-test",
        deepInvestigation: {
          toolQuota: { search: "nope" },
        },
      },
      null,
      2,
    ),
  );

  await assert.rejects(async () => {
    await loadConfig({
      cwd: tmpDir,
      env: {
        CODALI_WORKSPACE_ROOT: tmpDir,
        CODALI_PROVIDER: "openai",
        CODALI_MODEL: "gpt-test",
      },
    });
  }, /Invalid config\.deepInvestigation\.toolQuota\.search/);
});

test("loadConfig rejects invalid eval gate ranges", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  await assert.rejects(async () => {
    await loadConfig({
      cwd: tmpDir,
      env: {
        CODALI_WORKSPACE_ROOT: tmpDir,
        CODALI_PROVIDER: "openai",
        CODALI_MODEL: "gpt-test",
      },
      cli: {
        eval: {
          gates: {
            verification_pass_rate_min: 2,
          },
        },
      },
    });
  }, /Invalid config values: eval\.gates\.verification_pass_rate_min/);
});

test("loadConfig applies learning governance overrides from env", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  const config = await loadConfig({
    cwd: tmpDir,
    env: {
      CODALI_WORKSPACE_ROOT: tmpDir,
      CODALI_PROVIDER: "openai",
      CODALI_MODEL: "gpt-test",
      CODALI_LEARNING_PERSISTENCE_MIN_CONFIDENCE: "0.5",
      CODALI_LEARNING_ENFORCEMENT_MIN_CONFIDENCE: "0.9",
      CODALI_LEARNING_REQUIRE_CONFIRMATION_FOR_LOW_CONFIDENCE: "false",
      CODALI_LEARNING_AUTO_ENFORCE_HIGH_CONFIDENCE: "false",
      CODALI_LEARNING_CANDIDATE_STORE_FILE: "logs/codali/custom-learning.json",
    },
  });

  assert.equal(config.learning.persistence_min_confidence, 0.5);
  assert.equal(config.learning.enforcement_min_confidence, 0.9);
  assert.equal(config.learning.require_confirmation_for_low_confidence, false);
  assert.equal(config.learning.auto_enforce_high_confidence, false);
  assert.equal(config.learning.candidate_store_file, "logs/codali/custom-learning.json");
});

test("loadConfig rejects invalid learning threshold ordering", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-config-"));
  await assert.rejects(async () => {
    await loadConfig({
      cwd: tmpDir,
      env: {
        CODALI_WORKSPACE_ROOT: tmpDir,
        CODALI_PROVIDER: "openai",
        CODALI_MODEL: "gpt-test",
      },
      cli: {
        learning: {
          persistence_min_confidence: 0.8,
          enforcement_min_confidence: 0.6,
        },
      },
    });
  }, /learning\.enforcement_min_confidence/);
});
