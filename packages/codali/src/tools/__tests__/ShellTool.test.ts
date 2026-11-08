import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createShellTool } from "../shell/ShellTool.js";
import { ToolExecutionError } from "../ToolTypes.js";

test("Bash reports failed pipeline stages while preserving handled failures and arguments", async t => {
  if (process.platform === "win32") { t.skip("Bash platform qualification runs on Linux/macOS"); return; }
  const tool = createShellTool();
  const context = { workspaceRoot: process.cwd(), shellAllowlist: ["bash"], allowShell: true };
  const args = ["--noprofile", "--norc", "-c", "false | true"];
  await assert.rejects(tool.handler({ command: "bash", args }, context), (error: unknown) => {
    assert.ok(error instanceof ToolExecutionError); assert.equal(error.code, "tool_execution_failed"); return true;
  });
  assert.deepEqual(args, ["--noprofile", "--norc", "-c", "false | true"]);
  assert.match((await tool.handler({ command: "bash", args: ["-c", "if false | true; then printf wrong; else printf handled; fi"] }, context)).output, /^handled$/);
  assert.equal((await tool.handler({ command: "bash", args: ["--noprofile", "-c", 'printf "%s" "$1"', "argument-zero", "literal spaces"] }, context)).output, "literal spaces");
});

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

test("ShellTool permits formatting source syntax but still blocks disk formatting", async () => {
  const tool = createShellTool();
  let launches = 0;
  const context = { workspaceRoot: process.cwd(), shellAllowlist: ["sh", "format"], allowShell: true,
    shellExecutor: async () => { launches++; return { output: "checked" }; } };
  for (const source of ['swift -e \'print(String(format: "%.2f", 1.2))\'', 'node -e \'value.format()\'']) {
    assert.equal((await tool.handler({ command: "sh", args: ["-c", source] }, context)).output, "checked");
  }
  for (const request of [{ command: "format", args: ["disk"] }, { command: "sh", args: ["-c", 'format "disk"'] }, { command: "sh", args: ["-c", "rm -rf directory"] }]) {
    await assert.rejects(tool.handler(request, context), /Destructive operation blocked/);
  }
  assert.equal(launches, 2);
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

test("ShellTool runs module-local checks from cwd without changing the workspace scope", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-shell-cwd-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const module = path.join(root, "modules", "feature");
  await fs.mkdir(module, { recursive: true });
  await fs.writeFile(path.join(module, "check.cjs"), "console.log(require('fs').readFileSync('fixture.txt','utf8'))");
  await fs.writeFile(path.join(module, "fixture.txt"), "module fixture");
  const tool = createShellTool();
  const context = { workspaceRoot: root, shellAllowlist: [process.execPath], allowShell: true, allowedWritePaths: ["modules/feature/fixture.txt"] };
  const result = await tool.handler({ command: process.execPath, args: ["check.cjs"], cwd: "modules/feature" }, context);
  assert.equal(result.output.trim(), "module fixture");
  assert.equal(context.workspaceRoot, root);
  assert.deepEqual(context.allowedWritePaths, ["modules/feature/fixture.txt"]);
  const defaultResult = await tool.handler({ command: process.execPath, args: ["-e", "console.log(process.cwd())"] }, context);
  assert.equal(defaultResult.output.trim(), await fs.realpath(root));
});

test("ShellTool rejects cwd traversal, symlink escapes and non-directories before launching", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-shell-cwd-"));
  const outside = await fs.mkdtemp(`${root}-neighbor-`);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, "file.txt"), "original");
  await fs.symlink(outside, path.join(root, "escape"), "junction");
  let launches = 0;
  const context = { workspaceRoot: root, shellAllowlist: [process.execPath], allowShell: true, shellExecutor: async () => { launches++; return { output: "unexpected" }; } };
  for (const cwd of ["..", outside, "escape", "file.txt", "missing", "", 42]) {
    await assert.rejects(createShellTool().handler({ command: process.execPath, cwd }, context), error => error instanceof ToolExecutionError);
  }
  assert.equal(launches, 0);
});
