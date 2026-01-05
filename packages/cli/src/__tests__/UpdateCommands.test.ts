import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { test } from "node:test";
import { UpdateCommands } from "../commands/update/UpdateCommands.js";
import { Connection } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { SystemClient } from "@mcoda/integrations";
import { SystemUpdateService } from "@mcoda/core";

const withPatched = <T, K extends keyof T>(
  target: T,
  key: K,
  impl: T[K],
  fn: () => Promise<void> | void,
): Promise<void> => {
  const original = target[key];
  // @ts-ignore override for testing
  target[key] = impl;
  return (async () => {
    try {
      await fn();
    } finally {
      // @ts-ignore restore original
      target[key] = original;
    }
  })();
};

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
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-update-"));
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

const readCommandRuns = async (): Promise<Array<{ command_name: string; status: string; exit_code: number | null; error_summary: string | null }>> => {
  const dbPath = PathHelper.getGlobalDbPath();
  const conn = await Connection.open(dbPath);
  try {
    const rows = await conn.db.all(
      "SELECT command_name, status, exit_code, error_summary FROM command_runs ORDER BY started_at ASC",
    );
    return rows as any[];
  } finally {
    await conn.close();
  }
};

test("update --check writes releases.json and outputs json", async () => {
  await withTempHome(async (home) => {
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    await withPatched(
      SystemClient.prototype as any,
      "checkUpdate",
      async () => ({
        currentVersion: "0.1.3",
        latestVersion: "0.2.0",
        channel: "stable",
        updateAvailable: true,
        notes: "Changelog",
      }),
      async () => {
        const logs = await captureLogs(async () => {
          await UpdateCommands.run(["--check", "--json"]);
        });
        const parsed = JSON.parse(logs.join("\n"));
        assert.equal(parsed.latestVersion, "0.2.0");
        assert.equal(parsed.updateAvailable, true);
        const releasesRaw = await fs.readFile(path.join(home, ".mcoda", "releases.json"), "utf8");
        const releases = JSON.parse(releasesRaw);
        assert.equal(releases.lastCheck.latestVersion, "0.2.0");
        assert.ok(releases.lastCheck.checkedAt);
      },
    );
    process.exitCode = originalExit;
  });
});

test("update apply succeeds and records state", async () => {
  await withTempHome(async (home) => {
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    await withPatched(
      SystemClient.prototype as any,
      "checkUpdate",
      async () => ({
        currentVersion: "0.1.3",
        latestVersion: "0.3.0",
        channel: "stable",
        updateAvailable: true,
      }),
      async () => {
        await withPatched(
          SystemClient.prototype as any,
          "applyUpdate",
          async () => ({ status: "completed", logFile: "/tmp/log" }),
          async () => {
            await UpdateCommands.run(["--force"]);
            const releasesRaw = await fs.readFile(path.join(home, ".mcoda", "releases.json"), "utf8");
            const releases = JSON.parse(releasesRaw);
            assert.equal(releases.lastCheck.currentVersion, "0.3.0");
            assert.equal(releases.lastCheck.updateAvailable, false);
            assert.equal(process.exitCode ?? 0, 0);
          },
        );
      },
    );
    process.exitCode = originalExit;
  });
});

test("requires --force when CI is set", async () => {
  await withTempHome(async () => {
    const originalExit = process.exitCode;
    const originalCi = process.env.CI;
    process.exitCode = undefined;
    process.env.CI = "true";
    let applyCalled = 0;
    await withPatched(
      SystemClient.prototype as any,
      "checkUpdate",
      async () => ({
        currentVersion: "0.1.3",
        latestVersion: "0.3.0",
        channel: "stable",
        updateAvailable: true,
      }),
      async () => {
        await withPatched(
          SystemClient.prototype as any,
          "applyUpdate",
          async () => {
            applyCalled += 1;
            return { status: "completed" };
          },
          async () => {
            await UpdateCommands.run([]);
            assert.equal(applyCalled, 0);
            assert.equal(process.exitCode, 2);
          },
        );
      },
    );
    process.exitCode = originalExit;
    process.env.CI = originalCi;
  });
});

test("invalid channel yields usage error", async () => {
  await withTempHome(async () => {
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    await UpdateCommands.run(["--channel", "bogus"]);
    assert.equal(process.exitCode, 1);
    process.exitCode = originalExit;
  });
});

test("writes command_runs row with exit code 4 on network failure", async () => {
  await withTempHome(async () => {
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    await withPatched(
      SystemClient.prototype as any,
      "checkUpdate",
      async () => {
        throw new Error("network down");
      },
      async () => {
        await UpdateCommands.run(["--check"]);
        const runs = await readCommandRuns();
        assert.equal(runs.length, 1);
        assert.equal(runs[0].command_name, "update");
        assert.equal(runs[0].status, "failed");
        assert.equal(runs[0].exit_code, 4);
        assert.match(runs[0].error_summary ?? "", /network down/);
        assert.equal(process.exitCode, 4);
      },
    );
    process.exitCode = originalExit;
  });
});

test("writes command_runs row with exit code 6 on install failure", async () => {
  await withTempHome(async () => {
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    await withPatched(
      SystemClient.prototype as any,
      "checkUpdate",
      async () => ({
        currentVersion: "0.1.3",
        latestVersion: "0.3.0",
        channel: "stable",
        updateAvailable: true,
      }),
      async () => {
        await withPatched(
          SystemClient.prototype as any,
          "applyUpdate",
          async () => {
            throw new Error("apply failed");
          },
          async () => {
            await withPatched(
              (SystemUpdateService.prototype as any) as { runNpmInstall: any },
              "runNpmInstall",
              async () => ({ code: 1 }),
              async () => {
                await UpdateCommands.run(["--force"]);
                const runs = await readCommandRuns();
                assert.equal(runs.length, 1);
                assert.equal(runs[0].status, "failed");
                assert.equal(runs[0].exit_code, 6);
                assert.match(runs[0].error_summary ?? "", /npm install exited with code 1/);
                assert.equal(process.exitCode, 6);
              },
            );
          },
        );
      },
    );
    process.exitCode = originalExit;
  });
});

test("falls back to npm on apply failure and succeeds", async () => {
  await withTempHome(async () => {
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    await withPatched(
      SystemClient.prototype as any,
      "checkUpdate",
      async () => ({
        currentVersion: "0.1.3",
        latestVersion: "0.3.0",
        channel: "beta",
        updateAvailable: true,
      }),
      async () => {
        await withPatched(
          SystemClient.prototype as any,
          "applyUpdate",
          async () => {
            throw new Error("apply failed");
          },
          async () => {
            await withPatched(
              (SystemUpdateService.prototype as any) as { runNpmInstall: any },
              "runNpmInstall",
              async () => ({ code: 0 }),
              async () => {
                await UpdateCommands.run(["--force", "--channel", "beta"]);
                const runs = await readCommandRuns();
                assert.equal(runs.length, 1);
                assert.equal(runs[0].status, "succeeded");
                assert.equal(runs[0].exit_code, 0);
                assert.equal(runs[0].error_summary, null);
                assert.equal(process.exitCode ?? 0, 0);
              },
            );
          },
        );
      },
    );
    process.exitCode = originalExit;
  });
});
