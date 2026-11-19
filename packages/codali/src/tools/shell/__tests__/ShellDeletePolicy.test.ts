import test from "node:test";
import assert from "node:assert/strict";
import { createShellTool, DEVELOPMENT_COMMANDS } from "../ShellTool.js";
import type { ToolContext } from "../../ToolTypes.js";

test("deletes run only when the host confines the shell, and stay blocked otherwise", async () => {
  const ran: string[] = [];
  const base: ToolContext = { workspaceRoot: process.cwd(), allowShell: true, shellAllowlist: DEVELOPMENT_COMMANDS,
    shellExecutor: async (command, args) => { ran.push([command, ...args].join(" ")); return { output: "ok" }; } };
  const tool = createShellTool();
  for (const args of [{ command: "rm", args: ["-f", "scratch.sqlite"] }, { command: "bash", args: ["-c", 'rm -f "$TMPDIR/x"'] }]) {
    await assert.rejects(async () => tool.handler(args, base), /Destructive operation blocked by policy/);
  }
  assert.deepEqual(ran, []);
  await tool.handler({ command: "rm", args: ["-f", "scratch.sqlite"] }, { ...base, shellIsolated: true });
  await tool.handler({ command: "bash", args: ["-c", 'rm -f "$TMPDIR/x"'] }, { ...base, shellIsolated: true });
  assert.equal(ran.length, 2);
  // Confinement does not widen the executable allowlist.
  await assert.rejects(async () => tool.handler({ command: "shred", args: ["x"] }, { ...base, shellIsolated: true }), /Command not allowed/);
});
