import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatInstructionBlocks, loadInstructionBlocks } from "../InstructionLoader.js";

test("InstructionLoader loads Codali and AGENTS hierarchy for focused paths", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-instructions-"));
  mkdirSync(path.join(workspaceRoot, ".codali"), { recursive: true });
  mkdirSync(path.join(workspaceRoot, "packages", "codali", "src"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, ".codali", "instructions.md"), "codali root\n");
  writeFileSync(path.join(workspaceRoot, ".codali", "local.md"), "local override\n");
  writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "repo agents\n");
  writeFileSync(path.join(workspaceRoot, "packages", "AGENTS.md"), "packages agents\n");
  writeFileSync(path.join(workspaceRoot, "packages", "codali", "AGENTS.md"), "codali agents\n");

  const blocks = await loadInstructionBlocks({
    workspaceRoot,
    focusPaths: ["packages/codali/src/runtime.ts"],
  });

  assert.deepEqual(
    blocks.map((block) => block.sourcePath),
    [
      ".codali/instructions.md",
      "AGENTS.md",
      "packages/AGENTS.md",
      "packages/codali/AGENTS.md",
      ".codali/local.md",
    ],
  );
  const formatted = formatInstructionBlocks(blocks);
  assert.match(formatted, /Instruction source: AGENTS.md/);
  assert.match(formatted, /codali agents/);
});

test("InstructionLoader rejects focus paths outside workspace", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-instructions-"));
  await assert.rejects(
    () => loadInstructionBlocks({ workspaceRoot, focusPaths: ["../outside.ts"] }),
    /outside workspace root/,
  );
});
