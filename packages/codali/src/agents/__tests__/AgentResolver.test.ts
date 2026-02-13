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
