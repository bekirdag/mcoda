import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createDiffTool } from "../diff/DiffTool.js";

const hasGit = (() => {
  const result = spawnSync("git", ["--version"], { encoding: "utf8" });
  return result.status === 0;
})();

const initGitRepo = (cwd: string): void => {
  const result = spawnSync("git", ["init"], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr ?? result.stdout ?? "git init failed");
  }
};

test(
  "DiffTool reports git status changes",
  { concurrency: false, skip: !hasGit },
  async () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-diff-"));
    initGitRepo(workspaceRoot);

    const filePath = path.join(workspaceRoot, "notes.txt");
    writeFileSync(filePath, "hello", "utf8");

    const tool = createDiffTool();
    const result = await tool.handler({}, { workspaceRoot });
    assert.match(result.output, /\?\?\s+notes\.txt/);
  },
);
