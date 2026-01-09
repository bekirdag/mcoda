import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayAgentCommand } from "../commands/agents/GatewayAgentCommand.js";

const captureOutput = async (fn: () => Promise<void> | void): Promise<{ logs: string[]; errors: string[] }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  // @ts-ignore override
  console.log = (...args: any[]) => logs.push(args.join(" "));
  // @ts-ignore override
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    console.log = originalLog;
    // @ts-ignore restore
    console.error = originalError;
  }
  return { logs, errors };
};

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-gateway-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

test("GatewayAgentCommand requires a job name", { concurrency: false }, async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const { logs } = await captureOutput(() => GatewayAgentCommand.run([]));
    assert.ok(logs.join("\n").includes("mcoda gateway-agent"));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("GatewayAgentCommand rejects self-invocation", { concurrency: false }, async () => {
  const originalExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const { errors } = await captureOutput(() => GatewayAgentCommand.run(["gateway-agent"]));
    assert.ok(errors.join("\n").includes("cannot invoke itself"));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("GatewayAgentCommand requires input or task selectors", { concurrency: false }, async () => {
  await withTempDir(async (dir) => {
    const originalExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      const { errors } = await captureOutput(() =>
        GatewayAgentCommand.run(["work-on-tasks", "--workspace", dir, "--project", "proj"]),
      );
      assert.ok(errors.join("\n").includes("requires --input"));
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});

test("GatewayAgentCommand reports missing input file", { concurrency: false }, async () => {
  await withTempDir(async (dir) => {
    const missing = path.join(dir, "nope.txt");
    const originalExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      const { errors } = await captureOutput(() =>
        GatewayAgentCommand.run(["work-on-tasks", "--workspace", dir, "--input-file", missing]),
      );
      assert.ok(errors.join("\n").includes("Failed to read input file"));
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
