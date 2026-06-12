import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_OPENAI_COMPATIBLE_ADAPTER,
  defaultLocalRunnerKindForAdapter,
  isReservedLocalRunnerExtraBodyKey,
  isSecretLocalRunnerHeaderKey,
  normalizeLocalOpenAiCompatibleAdapter,
  normalizeLocalOpenAiCompatibleRunnerConfig,
  normalizeLocalRunnerAuthMode,
  normalizeLocalRunnerKind,
  normalizeLocalRunnerResponseFormatStrategy,
} from "../llm/LocalRunnerConfig.js";

describe("LocalRunnerConfig", () => {
  it("normalizes local OpenAI-compatible adapter aliases", () => {
    assert.equal(
      normalizeLocalOpenAiCompatibleAdapter("openai-compatible-local"),
      LOCAL_OPENAI_COMPATIBLE_ADAPTER,
    );
    assert.equal(normalizeLocalOpenAiCompatibleAdapter("vllm-local"), LOCAL_OPENAI_COMPATIBLE_ADAPTER);
    assert.equal(
      normalizeLocalOpenAiCompatibleAdapter("llama-cpp-local"),
      LOCAL_OPENAI_COMPATIBLE_ADAPTER,
    );
    assert.equal(
      normalizeLocalOpenAiCompatibleAdapter("llamacpp-local"),
      LOCAL_OPENAI_COMPATIBLE_ADAPTER,
    );
    assert.equal(normalizeLocalOpenAiCompatibleAdapter(" VLLM-LOCAL "), LOCAL_OPENAI_COMPATIBLE_ADAPTER);
    assert.equal(normalizeLocalOpenAiCompatibleAdapter("openai-api"), undefined);
  });

  it("normalizes runner kind and auth spelling aliases", () => {
    assert.equal(defaultLocalRunnerKindForAdapter("vllm-local"), "vllm");
    assert.equal(defaultLocalRunnerKindForAdapter(" VLLM-LOCAL "), "vllm");
    assert.equal(defaultLocalRunnerKindForAdapter("llamacpp-local"), "llama-cpp");
    assert.equal(normalizeLocalRunnerKind("llama.cpp"), "llama-cpp");
    assert.equal(normalizeLocalRunnerKind("llamacpp"), "llama-cpp");
    assert.equal(normalizeLocalRunnerKind("text-generation-inference"), "tgi");
    assert.equal(normalizeLocalRunnerAuthMode("dummy"), "dummy-bearer");
    assert.equal(normalizeLocalRunnerAuthMode("dummy_bearer"), "dummy-bearer");
    assert.equal(normalizeLocalRunnerResponseFormatStrategy("json_schema"), "json-schema");
  });

  it("merges top-level and agent config with safe defaults for local aliases", () => {
    const result = normalizeLocalOpenAiCompatibleRunnerConfig({
      adapter: "llamacpp-local",
      agentConfig: {
        apiBaseUrl: "http://127.0.0.1:7000/v1",
        runnerKind: "vllm",
      },
      config: {
        endpoint: "http://127.0.0.1:8080/v1",
        authMode: "dummy",
      },
    });

    assert.equal(result.adapter, LOCAL_OPENAI_COMPATIBLE_ADAPTER);
    assert.equal(result.originalAdapter, "llamacpp-local");
    assert.equal(result.isLocalOpenAiCompatible, true);
    assert.equal(result.config.baseUrl, "http://127.0.0.1:8080/v1");
    assert.equal(result.config.runnerKind, "vllm");
    assert.equal(result.config.authMode, "dummy-bearer");
    assert.equal(result.config.dummyBearerToken, "local");
    assert.deepEqual(result.issues, []);
  });

  it("uses alias runner defaults when runnerKind is omitted", () => {
    const result = normalizeLocalOpenAiCompatibleRunnerConfig({
      adapter: "llama-cpp-local",
      config: {
        baseUrl: "http://127.0.0.1:8080/v1",
      },
    });

    assert.equal(result.config.runnerKind, "llama-cpp");
    assert.equal(result.config.authMode, "none");
  });

  it("preserves non-local adapter detection without local auth defaults", () => {
    const result = normalizeLocalOpenAiCompatibleRunnerConfig({
      adapter: "openai-api",
      config: {
        baseUrl: "https://api.openai.com/v1",
      },
    });

    assert.equal(result.adapter, undefined);
    assert.equal(result.isLocalOpenAiCompatible, false);
    assert.equal(result.config.authMode, undefined);
  });

  it("flags secret headers and reserved extraBody request fields", () => {
    const result = normalizeLocalOpenAiCompatibleRunnerConfig({
      adapter: "vllm-local",
      config: {
        headers: {
          Authorization: "Bearer secret",
          "x-trace-id": "trace-1",
        },
        extraBody: {
          model: "override",
          top_k: 40,
        },
      },
    });

    assert.equal(isSecretLocalRunnerHeaderKey("Authorization"), true);
    assert.equal(isReservedLocalRunnerExtraBodyKey("model"), true);
    assert.ok(
      result.issues.some((issue) => issue.code === "secret_header" && issue.path === "headers.Authorization"),
    );
    assert.ok(
      result.issues.some((issue) => issue.code === "reserved_extra_body_key" && issue.path === "extraBody.model"),
    );
    assert.deepEqual(result.config.headers, { "x-trace-id": "trace-1" });
    assert.deepEqual(result.config.extraBody, { top_k: 40 });
  });

  it("reports invalid enum-like values", () => {
    const result = normalizeLocalOpenAiCompatibleRunnerConfig({
      adapter: "vllm-local",
      config: {
        runnerKind: "bad-runner",
        authMode: "api-key",
        responseFormatStrategy: "strict-json",
      },
    });

    assert.equal(result.config.runnerKind, "vllm");
    assert.equal(result.config.authMode, "none");
    assert.ok(result.issues.some((issue) => issue.code === "invalid_runner_kind"));
    assert.ok(result.issues.some((issue) => issue.code === "invalid_auth_mode"));
    assert.ok(result.issues.some((issue) => issue.code === "invalid_response_format_strategy"));
  });
});
