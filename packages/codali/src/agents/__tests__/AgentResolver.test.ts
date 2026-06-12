import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GlobalRepository } from "@mcoda/db";
import { CryptoHelper } from "@mcoda/shared";
import { resolveAgentConfig } from "../AgentResolver.js";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "codali-agent-resolver-"));
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("resolveAgentConfig maps ollama agent to codali provider", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      await repo.createAgent({
        slug: "codellama-34b",
        adapter: "ollama-remote",
        defaultModel: "codellama:34b",
        config: { baseUrl: "http://localhost:11434" },
      });
    } finally {
      await repo.close();
    }

    const resolved = await resolveAgentConfig("codellama-34b");
    assert.equal(resolved.provider, "ollama-remote");
    assert.equal(resolved.model, "codellama:34b");
    assert.equal(resolved.baseUrl, "http://localhost:11434");
    assert.equal(resolved.apiKey, undefined);
    assert.equal(resolved.requiresApiKey, false);
  });
});

test("resolveAgentConfig rejects ollama agents without baseUrl", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      await repo.createAgent({
        slug: "ollama-no-baseurl",
        adapter: "ollama-remote",
        defaultModel: "codellama:34b",
      });
    } finally {
      await repo.close();
    }

    await assert.rejects(
      () => resolveAgentConfig("ollama-no-baseurl"),
      /missing a baseUrl/i,
    );
  });
});

test("resolveAgentConfig maps local OpenAI-compatible agents without api key", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      await repo.createAgent({
        slug: "vllm-agent",
        adapter: "openai-compatible-local",
        defaultModel: "local-model",
        config: { baseUrl: "http://127.0.0.1:8000/v1" },
      });
    } finally {
      await repo.close();
    }

    const resolved = await resolveAgentConfig("vllm-agent");
    assert.equal(resolved.provider, "openai-compatible");
    assert.equal(resolved.model, "local-model");
    assert.equal(resolved.baseUrl, "http://127.0.0.1:8000/v1");
    assert.equal(resolved.apiKey, undefined);
    assert.equal(resolved.requiresApiKey, false);
    assert.equal(resolved.authMode, "none");
  });
});

test("resolveAgentConfig applies runner kind defaults for local OpenAI-compatible aliases", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      await repo.createAgent({
        slug: "vllm-alias",
        adapter: "vllm-local",
        defaultModel: "local-model",
        config: { baseUrl: "http://127.0.0.1:8000/v1" },
      });
      await repo.createAgent({
        slug: "llama-cpp-alias",
        adapter: "llama-cpp-local",
        defaultModel: "local-model",
        config: { baseUrl: "http://127.0.0.1:8001/v1" },
      });
      await repo.createAgent({
        slug: "llamacpp-alias",
        adapter: "llamacpp-local",
        defaultModel: "local-model",
        config: { baseUrl: "http://127.0.0.1:8002/v1" },
      });
    } finally {
      await repo.close();
    }

    const vllm = await resolveAgentConfig("vllm-alias");
    assert.equal(vllm.provider, "openai-compatible");
    assert.equal(vllm.runnerKind, "vllm");
    assert.equal(vllm.authMode, "none");

    const llamaCpp = await resolveAgentConfig("llama-cpp-alias");
    assert.equal(llamaCpp.provider, "openai-compatible");
    assert.equal(llamaCpp.runnerKind, "llama-cpp");
    assert.equal(llamaCpp.authMode, "none");

    const legacyLlamaCpp = await resolveAgentConfig("llamacpp-alias");
    assert.equal(legacyLlamaCpp.provider, "openai-compatible");
    assert.equal(legacyLlamaCpp.runnerKind, "llama-cpp");
    assert.equal(legacyLlamaCpp.authMode, "none");
  });
});

test("resolveAgentConfig rejects local OpenAI-compatible agents without baseUrl", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      await repo.createAgent({
        slug: "local-openai-no-baseurl",
        adapter: "openai-compatible-local",
        defaultModel: "local-model",
      });
    } finally {
      await repo.close();
    }

    await assert.rejects(
      () => resolveAgentConfig("local-openai-no-baseurl"),
      /missing a baseUrl/i,
    );
  });
});

test("resolveAgentConfig requires stored auth only for bearer-mode local OpenAI-compatible agents", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      const agent = await repo.createAgent({
        slug: "local-openai-bearer",
        adapter: "openai-compatible-local",
        defaultModel: "local-model",
        config: { baseUrl: "http://127.0.0.1:8000/v1", authMode: "bearer" },
      });

      await assert.rejects(
        () => resolveAgentConfig("local-openai-bearer"),
        /AUTH_REQUIRED/i,
      );

      const encrypted = await CryptoHelper.encryptSecret("local-secret");
      await repo.setAgentAuth(agent.id, encrypted);
    } finally {
      await repo.close();
    }

    const resolved = await resolveAgentConfig("local-openai-bearer");
    assert.equal(resolved.provider, "openai-compatible");
    assert.equal(resolved.requiresApiKey, true);
    assert.equal(resolved.apiKey, "local-secret");
    assert.equal(resolved.authMode, "bearer");
  });
});

test("resolveAgentConfig uses stored auth for openai agents", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      const agent = await repo.createAgent({
        slug: "openai-agent",
        adapter: "openai-api",
        defaultModel: "gpt-4o-mini",
      });
      const encrypted = await CryptoHelper.encryptSecret("test-key");
      await repo.setAgentAuth(agent.id, encrypted);
    } finally {
      await repo.close();
    }

    const resolved = await resolveAgentConfig("openai-agent");
    assert.equal(resolved.provider, "openai-compatible");
    assert.equal(resolved.model, "gpt-4o-mini");
    assert.equal(resolved.apiKey, "test-key");
    assert.equal(resolved.requiresApiKey, true);
  });
});

test("resolveAgentConfig rejects non-openai compatible agents for openai provider", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      await repo.createAgent({
        slug: "openai-incompatible",
        adapter: "openai-api",
        defaultModel: "gpt-4o-mini",
        openaiCompatible: false,
      });
    } finally {
      await repo.close();
    }

    await assert.rejects(
      () => resolveAgentConfig("openai-incompatible"),
      /not marked openai-compatible/i,
    );
  });
});
