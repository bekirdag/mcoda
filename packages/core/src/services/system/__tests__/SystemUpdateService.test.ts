import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SystemUpdateService } from "../SystemUpdateService.js";

test("SystemUpdateService persists channel preferences and update state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-update-"));
  const service = await SystemUpdateService.create(undefined, {
    mcodaDir: dir,
    client: {
      checkUpdate: async () => ({
        currentVersion: "0.1.5",
        latestVersion: "0.1.5",
        channel: "stable",
        updateAvailable: true,
      }),
      applyUpdate: async () => ({ status: "started" }),
    } as any,
    repo: undefined,
  });

  try {
    await service.savePreferredChannel("beta");
    const channel = await service.resolveChannel();
    assert.equal(channel, "beta");

    const result = await service.checkUpdate("stable");
    assert.equal(result.info.latestVersion, "0.1.5");

    const statePath = path.join(dir, "releases.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as any;
    assert.equal(state.lastCheck.channel, "stable");
    assert.equal(state.preferences.channel, "stable");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
