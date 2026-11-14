import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceRepository } from "@mcoda/db";
import { TerminalCommand, type TerminalHost } from "@mcoda/codali";
import { CodaliTerminalCommand } from "../commands/work/CodaliTerminalCommand.js";

test("mcoda terminal opens existing project authority without initializing ordinary repositories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-terminal-command-"));
  const originalPath = PathHelper.getGlobalMcodaDir; const originalRun = TerminalCommand.run;
  const calls: Array<{ argv: string[]; host?: TerminalHost }> = [];
  PathHelper.getGlobalMcodaDir = () => path.join(root, "private-state");
  TerminalCommand.run = async (argv, host) => { calls.push({ argv, host }); };
  try {
    await CodaliTerminalCommand.run(["--workspace-root", root]);
    assert.equal(calls[0].argv[0], "chat"); assert.equal(calls[0].host?.projectTaskAuthority, undefined);
    await assert.rejects(fs.access(PathHelper.getWorkspaceDbPath(root)), /ENOENT/);
    await assert.rejects(CodaliTerminalCommand.run(["exec", "Work", "--project-task", "TASK-1", "--workspace-root", root]), /no mcoda project database/);
    const repo = await WorkspaceRepository.create(root); await repo.close();
    await CodaliTerminalCommand.run(["chat", "--workspace-root", root]);
    assert.ok(calls.at(-1)?.host?.projectTaskAuthority);
    await CodaliTerminalCommand.run(["chat", "--help"]);
    assert.deepEqual(calls.at(-1)?.argv, ["chat", "--help"]);
  } finally { PathHelper.getGlobalMcodaDir = originalPath; TerminalCommand.run = originalRun; await fs.rm(root, { recursive: true, force: true }); }
});

test("mcoda terminal preserves an existing project database keyed by a workspace alias", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-terminal-alias-"));
  const root = path.join(fixture, "repository"); const alias = path.join(fixture, "workspace-alias");
  await fs.mkdir(root); await fs.symlink(root, alias, "junction");
  const originalPath = PathHelper.getGlobalMcodaDir; const originalRun = TerminalCommand.run;
  let authority: TerminalHost["projectTaskAuthority"];
  PathHelper.getGlobalMcodaDir = () => path.join(fixture, "private-state");
  TerminalCommand.run = async (_argv, host) => { authority = host?.projectTaskAuthority; };
  try {
    const repo = await WorkspaceRepository.create(alias); await repo.close();
    await assert.rejects(fs.access(PathHelper.getWorkspaceDbPath(await fs.realpath(root))), /ENOENT/);
    await CodaliTerminalCommand.run(["chat", "--workspace-root", alias]);
    assert.ok(authority, "The project authority must use the existing alias-keyed database");
    await assert.rejects(fs.access(PathHelper.getWorkspaceDbPath(await fs.realpath(root))), /ENOENT/);
  } finally {
    PathHelper.getGlobalMcodaDir = originalPath; TerminalCommand.run = originalRun;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
