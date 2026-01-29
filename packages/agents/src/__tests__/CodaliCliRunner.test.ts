import test from "node:test";
import assert from "node:assert/strict";
import { buildArgs } from "../adapters/codali/CodaliCliRunner.js";

test("buildArgs includes optional docdex flags", { concurrency: false }, () => {
  const args = buildArgs({
    workspaceRoot: "/repo",
    provider: "openai-compatible",
    model: "gpt-4o-mini",
    baseUrl: "https://api.example.com",
    docdexBaseUrl: "http://127.0.0.1:28491",
    docdexRepoId: "repo-123",
    docdexRepoRoot: "/repo",
    agentId: "agent-1",
    agentSlug: "agent-one",
  });

  assert.deepEqual(args, [
    "run",
    "--workspace-root",
    "/repo",
    "--provider",
    "openai-compatible",
    "--model",
    "gpt-4o-mini",
    "--agent-id",
    "agent-1",
    "--agent-slug",
    "agent-one",
    "--base-url",
    "https://api.example.com",
    "--docdex-base-url",
    "http://127.0.0.1:28491",
    "--docdex-repo-id",
    "repo-123",
    "--docdex-repo-root",
    "/repo",
  ]);
});
