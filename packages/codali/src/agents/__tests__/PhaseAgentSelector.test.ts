import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GlobalRepository } from "@mcoda/db";
import { CryptoHelper } from "@mcoda/shared";
import { selectPhaseAgents } from "../PhaseAgentSelector.js";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "codali-phase-select-"));
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("selectPhaseAgents prefers capability + rating per phase", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      const cloudArchitect = await repo.createAgent({
        slug: "cloud-architect",
        adapter: "ollama-remote",
        defaultModel: "kimi-k2-thinking:cloud",
        config: { baseUrl: "http://localhost:11434" },
        rating: 10,
        reasoningRating: 10,
        costPerMillion: 0,
        bestUsage: "deep_reasoning",
      });
      await repo.setAgentCapabilities(cloudArchitect.id, ["plan", "deep_reasoning"]);

      const librarian = await repo.createAgent({
        slug: "tiny-librarian",
        adapter: "ollama-remote",
        defaultModel: "smollm2:135m",
        config: { baseUrl: "http://localhost:11434" },
        rating: 4,
        reasoningRating: 3,
        costPerMillion: 0,
        maxComplexity: 1,
        bestUsage: "lightweight_tasks",
      });
      await repo.setAgentCapabilities(librarian.id, [
        "summarization",
        "keyword_extraction",
      ]);

      const builder = await repo.createAgent({
        slug: "cheap-builder",
        adapter: "ollama-remote",
        defaultModel: "codellama:7b",
        config: { baseUrl: "http://localhost:11434" },
        rating: 5,
        reasoningRating: 4,
        costPerMillion: 0,
        maxComplexity: 2,
        bestUsage: "code_write",
      });
      await repo.setAgentCapabilities(builder.id, ["code_write"]);

      const architect = await repo.createAgent({
        slug: "big-architect",
        adapter: "openai-api",
        defaultModel: "gpt-4o",
        rating: 8,
        reasoningRating: 9,
        costPerMillion: 10,
        bestUsage: "system_architecture",
        openaiCompatible: true,
      });
      await repo.setAgentCapabilities(architect.id, ["plan", "system_architecture"]);
      await repo.setAgentAuth(architect.id, await CryptoHelper.encryptSecret("key-1"));

      const critic = await repo.createAgent({
        slug: "critic-pro",
        adapter: "openai-api",
        defaultModel: "gpt-4o",
        rating: 9,
        reasoningRating: 9,
        costPerMillion: 10,
        bestUsage: "code_review",
        openaiCompatible: true,
      });
      await repo.setAgentCapabilities(critic.id, ["code_review"]);
      await repo.setAgentAuth(critic.id, await CryptoHelper.encryptSecret("key-2"));
    } finally {
      await repo.close();
    }

    const selections = await selectPhaseAgents({
      overrides: {},
      builderMode: "freeform",
    });

    assert.notEqual(selections.architect.agent?.slug, "cloud-architect");
    assert.equal(selections.librarian.agent?.slug, "tiny-librarian");
    assert.equal(selections.builder.agent?.slug, "cheap-builder");
    assert.equal(selections.architect.agent?.slug, "big-architect");
    assert.equal(selections.critic.agent?.slug, "critic-pro");
    assert.equal(selections.interpreter.agent?.slug, "critic-pro");
  });
});

test("selectPhaseAgents honors critic override", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    let overrideAgentId: string;
    try {
      const criticDefault = await repo.createAgent({
        slug: "critic-default",
        adapter: "openai-api",
        defaultModel: "gpt-4o",
        rating: 7,
        reasoningRating: 7,
        costPerMillion: 5,
        bestUsage: "code_review",
        openaiCompatible: true,
      });
      await repo.setAgentCapabilities(criticDefault.id, ["code_review"]);
      await repo.setAgentAuth(criticDefault.id, await CryptoHelper.encryptSecret("key-crit"));

      const criticOverride = await repo.createAgent({
        slug: "critic-override",
        adapter: "openai-api",
        defaultModel: "gpt-4o-mini",
        rating: 5,
        reasoningRating: 5,
        costPerMillion: 2,
        bestUsage: "code_review_secondary",
        openaiCompatible: true,
      });
      await repo.setAgentCapabilities(criticOverride.id, ["code_review"]);
      await repo.setAgentAuth(criticOverride.id, await CryptoHelper.encryptSecret("key-crit-2"));
      overrideAgentId = criticOverride.id;
    } finally {
      await repo.close();
    }

    const selections = await selectPhaseAgents({
      overrides: { critic: overrideAgentId },
      builderMode: "freeform",
    });

    assert.equal(selections.critic.agent?.id, overrideAgentId);
    assert.equal(selections.critic.source, "override");
  });
});

test("selectPhaseAgents prefers structured-output capable builders in patch_json mode", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      const unsupportedBuilder = await repo.createAgent({
        slug: "unsupported-builder",
        adapter: "ollama-remote",
        defaultModel: "codellama:34b",
        config: { baseUrl: "http://localhost:11434" },
        rating: 7,
        reasoningRating: 7,
        costPerMillion: 0,
        maxComplexity: 2,
        bestUsage: "code_write",
        supportsTools: false,
      });
      await repo.setAgentCapabilities(unsupportedBuilder.id, [
        "code_write",
        "migration_assist",
      ]);

      const genericBuilder = await repo.createAgent({
        slug: "generic-builder",
        adapter: "ollama-remote",
        defaultModel: "qwen3-coder:latest",
        config: { baseUrl: "http://localhost:11434" },
        rating: 6,
        reasoningRating: 6,
        costPerMillion: 0,
        maxComplexity: 2,
        bestUsage: "code_write",
        supportsTools: true,
      });
      await repo.setAgentCapabilities(genericBuilder.id, [
        "code_write",
        "iterative_coding",
      ]);

      const structuredBuilder = await repo.createAgent({
        slug: "structured-builder",
        adapter: "ollama-remote",
        defaultModel: "glm-4.7-flash",
        config: { baseUrl: "http://localhost:11434" },
        rating: 5,
        reasoningRating: 5,
        costPerMillion: 0,
        maxComplexity: 2,
        bestUsage: "code_write",
        supportsTools: true,
      });
      await repo.setAgentCapabilities(structuredBuilder.id, [
        "code_write",
        "strict_instruction_following",
      ]);
    } finally {
      await repo.close();
    }

    const selections = await selectPhaseAgents({
      overrides: {},
      builderMode: "patch_json",
    });

    assert.equal(selections.builder.agent?.slug, "structured-builder");
  });
});

test("selectPhaseAgents still prefers structured patch builders when unstructured options are cheaper", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      const cheapUnstructured = await repo.createAgent({
        slug: "cheap-unstructured-builder",
        adapter: "ollama-remote",
        defaultModel: "qwen3-coder:latest",
        config: { baseUrl: "http://localhost:11434" },
        rating: 6,
        reasoningRating: 6,
        costPerMillion: 0,
        maxComplexity: 2,
        bestUsage: "code_write",
        supportsTools: true,
      });
      await repo.setAgentCapabilities(cheapUnstructured.id, [
        "code_write",
        "iterative_coding",
      ]);

      const expensiveStructured = await repo.createAgent({
        slug: "expensive-structured-builder",
        adapter: "openai-api",
        defaultModel: "gpt-4o",
        rating: 8,
        reasoningRating: 8,
        costPerMillion: 10,
        maxComplexity: 3,
        bestUsage: "code_write",
        openaiCompatible: true,
        supportsTools: true,
      });
      await repo.setAgentCapabilities(expensiveStructured.id, [
        "code_write",
        "strict_instruction_following",
      ]);
      await repo.setAgentAuth(expensiveStructured.id, await CryptoHelper.encryptSecret("key-builder"));
    } finally {
      await repo.close();
    }

    const selections = await selectPhaseAgents({
      overrides: {},
      builderMode: "patch_json",
    });

    assert.equal(selections.builder.agent?.slug, "expensive-structured-builder");
  });
});
