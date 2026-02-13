import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SystemUpdateService } from "../SystemUpdateService.js";
import { ToolDenylist } from "../ToolDenylist.js";

test("SystemUpdateService persists channel preferences and update state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-update-"));
  const service = await SystemUpdateService.create(undefined, {
    mcodaDir: dir,
    client: {
      checkUpdate: async () => ({
        currentVersion: "0.1.8",
        latestVersion: "0.1.8",
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
    assert.equal(result.info.latestVersion, "0.1.8");

    const statePath = path.join(dir, "releases.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as any;
    assert.equal(state.lastCheck.channel, "stable");
    assert.equal(state.preferences.channel, "stable");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ToolDenylist loads default, config, and env entries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-denylist-"));
  try {
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ tools: { denylist: ["legacy-tool"] } }, null, 2),
      "utf8",
    );
    const denylist = await ToolDenylist.load({
      mcodaDir: dir,
      env: { MCODA_TOOL_DENYLIST: "extra-tool" } as NodeJS.ProcessEnv,
    });
    assert.equal(denylist.match("gpt-creator"), "gpt-creator");
    assert.equal(denylist.match("legacy-tool"), "legacy-tool");
    assert.equal(denylist.match("extra-tool"), "extra-tool");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ToolDenylist findMatch and formatViolation include guidance", async () => {
  const denylist = await ToolDenylist.load({
    env: { MCODA_TOOL_DENYLIST: "legacy-tool" } as NodeJS.ProcessEnv,
  });
  assert.equal(denylist.findMatch([undefined, "legacy-tool", "other"]), "legacy-tool");
  const message = denylist.formatViolation("gpt-creator");
  assert.ok(message.includes("gpt-creator"));
  assert.ok(message.toLowerCase().includes("suggested"));
});
