import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  isToolEnabled,
  resolveWorkspaceRoot,
  RunCommand,
  assessPhaseFallbackSuitability,
} from "../RunCommand.js";
import type { ToolConfig } from "../../config/Config.js";

test("parseArgs captures cli flags", { concurrency: false }, () => {
  const parsed = parseArgs([
    "--workspace-root",
    "/tmp/workspace",
    "--provider",
    "openai-compatible",
    "--model",
    "gpt-4o-mini",
    "--api-key",
    "secret",
    "--base-url",
    "https://api.example.com",
    "--task",
    "tasks/work.txt",
    "--config",
    "codali.config.json",
    "--docdex-base-url",
    "http://127.0.0.1:28491",
    "--docdex-repo-id",
    "repo-123",
    "--docdex-repo-root",
    "/tmp/workspace",
    "--agent",
    "agent-ref",
    "--agent-id",
    "agent-99",
    "--agent-slug",
    "agent-slug",
    "--agent-librarian",
    "agent-lib",
    "--agent-architect",
    "agent-arch",
    "--agent-builder",
    "agent-build",
    "--agent-critic",
    "agent-crit",
    "--agent-interpreter",
    "agent-interp",
    "--plan-hint",
    "{\"steps\":[\"Do it\"],\"target_files\":[\"src/index.ts\"]}",
    "--no-deep-investigation",
    "--context-mode",
    "bundle_text",
    "--context-max-files",
    "12",
    "--builder-mode",
    "freeform",
    "--interpreter-provider",
    "openai-compatible",
    "--interpreter-model",
    "gpt-5.2-codex",
    "--interpreter-format",
    "json",
    "--interpreter-max-retries",
    "2",
    "--interpreter-timeout-ms",
    "90000",
    "--cost-max",
    "0.75",
  ]);

  assert.equal(parsed.workspaceRoot, "/tmp/workspace");
  assert.equal(parsed.provider, "openai-compatible");
  assert.equal(parsed.model, "gpt-4o-mini");
  assert.equal(parsed.apiKey, "secret");
  assert.equal(parsed.baseUrl, "https://api.example.com");
  assert.equal(parsed.taskFile, "tasks/work.txt");
  assert.equal(parsed.configPath, "codali.config.json");
  assert.equal(parsed.docdexBaseUrl, "http://127.0.0.1:28491");
  assert.equal(parsed.docdexRepoId, "repo-123");
  assert.equal(parsed.docdexRepoRoot, "/tmp/workspace");
  assert.equal(parsed.agent, "agent-ref");
  assert.equal(parsed.agentId, "agent-99");
  assert.equal(parsed.agentSlug, "agent-slug");
  assert.equal(parsed.agentLibrarian, "agent-lib");
  assert.equal(parsed.agentArchitect, "agent-arch");
  assert.equal(parsed.agentBuilder, "agent-build");
  assert.equal(parsed.agentCritic, "agent-crit");
  assert.equal(parsed.agentInterpreter, "agent-interp");
  assert.equal(parsed.planHint, "{\"steps\":[\"Do it\"],\"target_files\":[\"src/index.ts\"]}");
  assert.equal(parsed.deepInvestigationEnabled, false);
  assert.equal(parsed.contextMode, "bundle_text");
  assert.equal(parsed.contextMaxFiles, 12);
  assert.equal(parsed.builderMode, "freeform");
  assert.equal(parsed.interpreterProvider, "openai-compatible");
  assert.equal(parsed.interpreterModel, "gpt-5.2-codex");
  assert.equal(parsed.interpreterFormat, "json");
  assert.equal(parsed.interpreterMaxRetries, 2);
  assert.equal(parsed.interpreterTimeoutMs, 90000);
  assert.equal(parsed.costMaxPerRun, 0.75);
});

test("isToolEnabled respects enabled list and allowShell", { concurrency: false }, () => {
  const tools: ToolConfig = {
    enabled: ["read_file", "run_shell"],
    allowShell: false,
  };

  assert.equal(isToolEnabled("read_file", tools), true);
  assert.equal(isToolEnabled("run_shell", tools), false);
  assert.equal(isToolEnabled("search_repo", tools), false);
});

test("resolveWorkspaceRoot walks up to repo markers", { concurrency: false }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codali-root-"));
  writeFileSync(path.join(root, "package.json"), "{}");
  const nested = path.join(root, "src", "subdir");
  mkdirSync(nested, { recursive: true });
  const resolved = resolveWorkspaceRoot(nested);
  assert.equal(resolved, root);
});

test("resolveWorkspaceRoot uses explicit root when provided", { concurrency: false }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codali-root-"));
  const explicit = path.join(root, "explicit");
  mkdirSync(explicit, { recursive: true });
  const resolved = resolveWorkspaceRoot(root, "explicit");
  assert.equal(resolved, path.resolve(root, "explicit"));
});

test("resolveWorkspaceRoot falls back to cwd when no markers", { concurrency: false }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codali-root-"));
  const resolved = resolveWorkspaceRoot(root);
  assert.equal(resolved, path.resolve(root));
});

test("RunCommand rejects deep investigation without smart mode", { concurrency: false }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codali-deep-"));
  const prior = process.env.CODALI_DEEP_INVESTIGATION_ENABLED;
  const priorSmart = process.env.CODALI_SMART;
  process.env.CODALI_DEEP_INVESTIGATION_ENABLED = "true";
  process.env.CODALI_SMART = "false";
  try {
    await assert.rejects(
      () =>
        RunCommand.run([
          "--workspace-root",
          root,
          "--provider",
          "stub",
          "--model",
          "stub-model",
        ]),
      /deep investigation requires --smart/i,
    );
  } finally {
    if (prior === undefined) {
      delete process.env.CODALI_DEEP_INVESTIGATION_ENABLED;
    } else {
      process.env.CODALI_DEEP_INVESTIGATION_ENABLED = prior;
    }
    if (priorSmart === undefined) {
      delete process.env.CODALI_SMART;
    } else {
      process.env.CODALI_SMART = priorSmart;
    }
  }
});

test("assessPhaseFallbackSuitability rejects patch_json builder fallback without structured capabilities", () => {
  const suitability = assessPhaseFallbackSuitability("builder", "patch_json", {
    capabilities: ["code_write", "simple_refactor"],
    supportsTools: false,
  });
  assert.equal(suitability.ok, false);
  assert.equal(suitability.reason, "missing_structured_output_capability");
});

test("assessPhaseFallbackSuitability rejects patch_json builder fallback without code capabilities", () => {
  const suitability = assessPhaseFallbackSuitability("builder", "patch_json", {
    capabilities: ["strict_instruction_following", "json_formatting", "schema_adherence"],
  });
  assert.equal(suitability.ok, false);
  assert.equal(suitability.reason, "missing_patch_code_capability");
});

test("assessPhaseFallbackSuitability accepts patch_json builder fallback when capabilities are sufficient", () => {
  const suitability = assessPhaseFallbackSuitability("builder", "patch_json", {
    capabilities: ["code_write", "iterative_coding", "strict_instruction_following"],
  });
  assert.equal(suitability.ok, true);
  assert.equal(suitability.reason, "capability_requirements_met");
  assert.equal(suitability.builderMode, "patch_json");
});

test("assessPhaseFallbackSuitability keeps patch_json when structured output capability is unavailable", () => {
  const suitability = assessPhaseFallbackSuitability("builder", "patch_json", {
    capabilities: ["code_write", "simple_refactor", "tool_runner"],
    supportsTools: true,
  });
  assert.equal(suitability.ok, true);
  assert.equal(suitability.reason, "fallback_patch_json_without_structured_capability");
  assert.equal(suitability.builderMode, "patch_json");
});
