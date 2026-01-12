import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProjectGuidance } from "../ProjectGuidance.js";

const setupDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-guidance-"));
  return dir;
};

const cleanupDir = async (dir: string) => {
  await fs.rm(dir, { recursive: true, force: true });
};

test("loadProjectGuidance returns null when guidance missing", async () => {
  const dir = await setupDir();
  try {
    const result = await loadProjectGuidance(dir);
    assert.equal(result, null);
  } finally {
    await cleanupDir(dir);
  }
});

test("loadProjectGuidance loads docs/project-guidance.md", async () => {
  const dir = await setupDir();
  try {
    const docsDir = path.join(dir, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    const guidancePath = path.join(docsDir, "project-guidance.md");
    await fs.writeFile(guidancePath, "Guidance content", "utf8");
    const result = await loadProjectGuidance(dir);
    assert.ok(result);
    assert.equal(result?.content, "Guidance content");
    assert.equal(result?.source, guidancePath);
  } finally {
    await cleanupDir(dir);
  }
});

test("loadProjectGuidance prefers .mcoda/docs/project-guidance.md", async () => {
  const dir = await setupDir();
  try {
    const docsDir = path.join(dir, "docs");
    const mcodaDocsDir = path.join(dir, ".mcoda", "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.mkdir(mcodaDocsDir, { recursive: true });
    const docsPath = path.join(docsDir, "project-guidance.md");
    const mcodaPath = path.join(mcodaDocsDir, "project-guidance.md");
    await fs.writeFile(docsPath, "Docs guidance", "utf8");
    await fs.writeFile(mcodaPath, "Mcoda guidance", "utf8");
    const result = await loadProjectGuidance(dir);
    assert.ok(result);
    assert.equal(result?.content, "Mcoda guidance");
    assert.equal(result?.source, mcodaPath);
  } finally {
    await cleanupDir(dir);
  }
});
