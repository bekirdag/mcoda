import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GlobalRepository } from "@mcoda/db";
import { MswarmConfigStore } from "@mcoda/core";
import { CryptoHelper } from "@mcoda/shared";
import { ConfigCommands } from "../commands/config/ConfigCommands.js";

const captureLogs = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const logs: string[] = [];
  const originalLog = console.log;
  // @ts-ignore override
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    console.log = originalLog;
  }
  return logs;
};

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-config-cli-"));
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

test("config set mswarm-api-key stores an encrypted key in global config", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const logs = await captureLogs(() => ConfigCommands.run(["set", "mswarm-api-key", "cloud-key"]));
    const store = new MswarmConfigStore();
    const raw = await fs.readFile(store.configPath(), "utf8");
    const parsed = JSON.parse(raw) as { mswarm?: { encryptedApiKey?: string } };

    assert.ok(logs.join("\n").includes("Saved encrypted mswarm API key"));
    assert.ok(parsed.mswarm?.encryptedApiKey);
    assert.notEqual(parsed.mswarm?.encryptedApiKey, "cloud-key");
    const state = await store.readState();
    assert.equal(state.apiKey, "cloud-key");
  });
});

test("config set mswarm-api-key honors MCODA_CONFIG", { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const originalConfig = process.env.MCODA_CONFIG;
    const configPath = path.join(home, "custom", "mcoda-config.json");
    process.env.MCODA_CONFIG = configPath;
    try {
      await captureLogs(() => ConfigCommands.run(["set", "mswarm-api-key", "cloud-key"]));
      const raw = await fs.readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as { mswarm?: { encryptedApiKey?: string } };
      assert.ok(parsed.mswarm?.encryptedApiKey);
      assert.notEqual(parsed.mswarm?.encryptedApiKey, "cloud-key");
    } finally {
      if (originalConfig === undefined) {
        delete process.env.MCODA_CONFIG;
      } else {
        process.env.MCODA_CONFIG = originalConfig;
      }
    }
  });
});

test("config set mswarm-api-key refreshes managed agent auth", { concurrency: false }, async () => {
  await withTempHome(async () => {
    const repo = await GlobalRepository.create();
    try {
      const managed = await repo.createAgent({
        slug: "mswarm-cloud-openai-gpt-4-1-mini",
        adapter: "openai-api",
        defaultModel: "openai/gpt-4.1-mini",
        openaiCompatible: true,
        config: {
          baseUrl: "https://mswarm.example/v1/swarm/openai/",
          apiBaseUrl: "https://mswarm.example/v1/swarm/openai/",
          mswarmCloud: {
            managed: true,
            remoteSlug: "openai/gpt-4.1-mini",
            provider: "openrouter",
            catalogBaseUrl: "https://api.mswarm.org/",
            openAiBaseUrl: "https://mswarm.example/v1/swarm/openai/",
            syncedAt: new Date().toISOString(),
          },
        },
      });
      await repo.setAgentAuth(
        managed.id,
        await CryptoHelper.encryptSecret("old-cloud-key"),
      );
    } finally {
      await repo.close();
    }

    const logs = await captureLogs(() =>
      ConfigCommands.run(["set", "mswarm-api-key", "fresh-cloud-key"]),
    );
    assert.match(logs.join("\n"), /Refreshed managed cloud-agent auth for 1 agents/);

    const repoAfter = await GlobalRepository.create();
    try {
      const managed = await repoAfter.getAgentBySlug("mswarm-cloud-openai-gpt-4-1-mini");
      assert.ok(managed);
      const secret = await repoAfter.getAgentAuthSecret(managed.id);
      assert.equal(
        secret?.encryptedSecret
          ? await CryptoHelper.decryptSecret(secret.encryptedSecret)
          : undefined,
        "fresh-cloud-key",
      );
    } finally {
      await repoAfter.close();
    }
  });
});
