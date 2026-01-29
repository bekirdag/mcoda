import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, isToolEnabled } from "../RunCommand.js";
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
    "--agent-id",
    "agent-99",
    "--agent-slug",
    "agent-slug",
    "--context-mode",
    "bundle_text",
    "--context-max-files",
    "12",
    "--builder-mode",
    "patch_json",
    "--streaming-enabled",
    "false",
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
  assert.equal(parsed.agentId, "agent-99");
  assert.equal(parsed.agentSlug, "agent-slug");
  assert.equal(parsed.contextMode, "bundle_text");
  assert.equal(parsed.contextMaxFiles, 12);
  assert.equal(parsed.builderMode, "patch_json");
  assert.equal(parsed.streamingEnabled, false);
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
