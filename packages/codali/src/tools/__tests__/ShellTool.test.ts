import test from "node:test";
import assert from "node:assert/strict";
import { createShellTool } from "../shell/ShellTool.js";
import { ToolExecutionError } from "../ToolTypes.js";

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
  }, (error: unknown) => {
    assert.ok(error instanceof ToolExecutionError);
    assert.equal(error.code, "tool_permission_denied");
    assert.match(error.message, /Command not allowed/);
    return true;
  });
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

test("ShellTool blocks destructive operations by default", { concurrency: false }, async () => {
  const tool = createShellTool();
  await assert.rejects(async () => {
    await tool.handler(
      { command: "/bin/rm", args: ["-rf", "tmp"] },
      {
        workspaceRoot: process.cwd(),
        shellAllowlist: ["/bin/rm"],
        allowShell: true,
        allowDestructiveOperations: false,
      },
    );
  }, (error: unknown) => {
    assert.ok(error instanceof ToolExecutionError);
    assert.equal(error.code, "tool_permission_denied");
    assert.equal(error.details?.reason_code, "destructive_operation_blocked");
    return true;
  });
});

test("ShellTool allows destructive operations when policy enabled", { concurrency: false }, async () => {
  const tool = createShellTool();
  const result = await tool.handler(
    {
      command: process.execPath,
      args: ["-e", "console.log(process.argv.slice(2).join(' '))", "rm", "-rf", "tmp"],
    },
    {
      workspaceRoot: process.cwd(),
      shellAllowlist: [process.execPath],
      allowShell: true,
      allowDestructiveOperations: true,
    },
  );
  assert.match(result.output, /-rf tmp/);
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
