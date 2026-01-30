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
  assert.equal(config.builder.mode, "freeform");
  assert.equal(config.builder.fallbackToInterpreter, true);
  assert.equal(config.interpreter.provider, "auto");
  assert.equal(config.interpreter.model, "auto");
  assert.equal(config.interpreter.format, "json");
  assert.equal(config.interpreter.maxRetries, 1);
  assert.equal(config.interpreter.timeoutMs, 120_000);
  assert.equal(config.streaming.enabled, true);
  assert.equal(config.cost.maxCostPerRun, 0.5);
  assert.equal(config.cost.charPerToken, 4);
  assert.equal(config.localContext.enabled, true);
  assert.equal(config.localContext.storageDir, "codali/context");
  assert.equal(config.localContext.maxMessages, 200);
  assert.equal(config.localContext.summarize.enabled, true);
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
