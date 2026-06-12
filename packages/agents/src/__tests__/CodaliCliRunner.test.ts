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

test("buildArgs includes local runner pass-through flags", { concurrency: false }, () => {
  const args = buildArgs({
    workspaceRoot: "/repo",
    provider: "openai-compatible",
    model: "local-model",
    baseUrl: "http://127.0.0.1:8000/v1",
    localRunner: {
      runnerKind: "vllm",
      authMode: "none",
      headers: { "x-runner": "vllm" },
      extraBody: { top_k: 40 },
    },
    runnerKind: "vllm",
    authMode: "none",
    healthPath: "/health",
    modelsPath: "/v1/models",
    requireModelInRequest: true,
    supportsStreaming: true,
    supportsTools: false,
    supportsJsonSchema: true,
    supportsGbnf: false,
  });

  assert.deepEqual(args, [
    "run",
    "--workspace-root",
    "/repo",
    "--provider",
    "openai-compatible",
    "--model",
    "local-model",
    "--base-url",
    "http://127.0.0.1:8000/v1",
    "--local-runner-json",
    JSON.stringify({
      runnerKind: "vllm",
      authMode: "none",
      headers: { "x-runner": "vllm" },
      extraBody: { top_k: 40 },
    }),
    "--runner-kind",
    "vllm",
    "--auth-mode",
    "none",
    "--health-path",
    "/health",
    "--models-path",
    "/v1/models",
    "--require-model-in-request",
    "true",
    "--supports-streaming",
    "true",
    "--supports-tools",
    "false",
    "--supports-json-schema",
    "true",
    "--supports-gbnf",
    "false",
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

test("buildEnv sets CODALI_LOCAL_RUNNER_JSON when provided", { concurrency: false }, () => {
  const original = process.env.CODALI_LOCAL_RUNNER_JSON;
  try {
    delete process.env.CODALI_LOCAL_RUNNER_JSON;
    const env = buildEnv({
      workspaceRoot: "/repo",
      provider: "openai-compatible",
      model: "local-model",
      localRunner: { runnerKind: "llama-cpp", authMode: "dummy-bearer" },
    });
    assert.equal(
      env.CODALI_LOCAL_RUNNER_JSON,
      JSON.stringify({ runnerKind: "llama-cpp", authMode: "dummy-bearer" }),
    );
  } finally {
    if (original === undefined) {
      delete process.env.CODALI_LOCAL_RUNNER_JSON;
    } else {
      process.env.CODALI_LOCAL_RUNNER_JSON = original;
    }
  }
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
