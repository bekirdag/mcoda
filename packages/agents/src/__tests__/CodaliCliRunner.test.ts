import test from "node:test";
import assert from "node:assert/strict";
import { buildArgs, buildEnv } from "../adapters/codali/CodaliCliRunner.js";

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

test("buildEnv forces codex no-sandbox for codali", { concurrency: false }, () => {
  const env = buildEnv({
    workspaceRoot: "/repo",
    provider: "openai-compatible",
    model: "gpt-4o-mini",
    env: { MCODA_CODEX_NO_SANDBOX: "0" },
  });

  assert.equal(env.MCODA_CODEX_NO_SANDBOX, "1");
});

test("buildEnv sets CODALI_BASE_URL when provided", { concurrency: false }, () => {
  const original = process.env.CODALI_BASE_URL;
  try {
    delete process.env.CODALI_BASE_URL;
    const env = buildEnv({
      workspaceRoot: "/repo",
      provider: "ollama-remote",
      model: "glm-4.7-flash",
      baseUrl: "http://example.com:11434",
    });
    assert.equal(env.CODALI_BASE_URL, "http://example.com:11434");
  } finally {
    if (original === undefined) {
      delete process.env.CODALI_BASE_URL;
    } else {
      process.env.CODALI_BASE_URL = original;
    }
  }
});

test("buildEnv does not override existing CODALI_BASE_URL", { concurrency: false }, () => {
  const original = process.env.CODALI_BASE_URL;
  try {
    process.env.CODALI_BASE_URL = "http://existing:11434";
    const env = buildEnv({
      workspaceRoot: "/repo",
      provider: "ollama-remote",
      model: "glm-4.7-flash",
      baseUrl: "http://new:11434",
    });
    assert.equal(env.CODALI_BASE_URL, "http://existing:11434");
  } finally {
    if (original === undefined) {
      delete process.env.CODALI_BASE_URL;
    } else {
      process.env.CODALI_BASE_URL = original;
    }
  }
});
