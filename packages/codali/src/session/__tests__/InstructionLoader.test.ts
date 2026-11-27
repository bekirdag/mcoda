import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
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
  assert.equal(blocks.find(block => block.sourcePath === ".codali/instructions.md")!.scope, ".");
  assert.equal(blocks.find(block => block.sourcePath === ".codali/local.md")!.scope, ".");
});

test("InstructionLoader rejects focus paths outside workspace", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-instructions-"));
  await assert.rejects(
    () => loadInstructionBlocks({ workspaceRoot, focusPaths: ["../outside.ts"] }),
    /outside workspace root/,
  );
});

test("packaged and user instructions precede workspace and local instructions with provenance", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codali-guide-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"); const user = path.join(root, "user");
  mkdirSync(path.join(workspace, ".codali"), { recursive: true }); mkdirSync(user);
  writeFileSync(path.join(user, "AGENTS.md"), "User default language.");
  writeFileSync(path.join(workspace, "AGENTS.md"), "Repository-specific language.");
  writeFileSync(path.join(workspace, ".codali", "local.md"), "Local style.");
  const blocks = await loadInstructionBlocks({ workspaceRoot: workspace, includeSystem: true, userInstructionsPath: path.join(user, "AGENTS.md") });
  assert.deepEqual(blocks.map(block => block.sourcePath), ["[codali]/AGENTS.md", "[user]/AGENTS.md", "AGENTS.md", ".codali/local.md"]);
  assert.match(blocks[0].content, /docdex_search\(\{query\}\)/);
  assert.ok(blocks.every(block => /^[a-f0-9]{64}$/.test(block.sha256!)));
});

test("instruction symlinks cannot read outside the workspace", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codali-guide-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"); mkdirSync(workspace);
  const secret = path.join(root, "outside.txt"); writeFileSync(secret, "Do not disclose this fixture.");
  try { symlinkSync(secret, path.join(workspace, "AGENTS.md")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("OS requires symlink permission"); return; } throw error; }
  await assert.rejects(loadInstructionBlocks({ workspaceRoot: workspace }), /escapes its allowed directory/);
});

test("oversized instructions fail explicitly before unbounded reads or silent truncation", async t => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-guide-")); t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const file = path.join(workspaceRoot, "AGENTS.md"); writeFileSync(file, "x".repeat(65537));
  await assert.rejects(loadInstructionBlocks({ workspaceRoot }), /exceeds 64 KiB/);
  writeFileSync(file, "x".repeat(24000));
  const blocks = await loadInstructionBlocks({ workspaceRoot });
  assert.throws(() => formatInstructionBlocks(blocks), /Instruction bundle exceeds/);
});
