import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MswarmConfigStore } from "@mcoda/core";
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
