import test from "node:test";
import assert from "node:assert/strict";
import { createShellTool } from "../shell/ShellTool.js";

test("ShellTool runs allowlisted commands", { concurrency: false }, async () => {
  const tool = createShellTool();
  const result = await tool.handler(
    { command: process.execPath, args: ["-e", "console.log('hello')"] },
    { workspaceRoot: process.cwd(), shellAllowlist: [process.execPath], allowShell: true },
  );

  assert.match(result.output, /hello/);
});

test("ShellTool blocks disallowed commands", { concurrency: false }, async () => {
  const tool = createShellTool();
  await assert.rejects(async () => {
    await tool.handler(
      { command: "ls" },
      { workspaceRoot: process.cwd(), shellAllowlist: [process.execPath], allowShell: true },
    );
  }, /Command not allowed/);
});

test("ShellTool blocks when disabled", { concurrency: false }, async () => {
  const tool = createShellTool();
  await assert.rejects(async () => {
    await tool.handler(
      { command: process.execPath, args: ["-e", "console.log('hello')"] },
      { workspaceRoot: process.cwd(), shellAllowlist: [process.execPath], allowShell: false },
    );
  }, /Shell tool is disabled/);
});

test("ShellTool fails when command exits non-zero", { concurrency: false }, async () => {
  const tool = createShellTool();
  await assert.rejects(async () => {
    await tool.handler(
      { command: process.execPath, args: ["-e", "console.error('fail'); process.exit(2);"] },
      { workspaceRoot: process.cwd(), shellAllowlist: [process.execPath], allowShell: true },
    );
  }, /fail|exit code/);
});
