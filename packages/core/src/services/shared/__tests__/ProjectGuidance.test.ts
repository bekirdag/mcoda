import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureProjectGuidance, loadProjectGuidance, normalizeDocType } from "../ProjectGuidance.js";
import { PathHelper } from "@mcoda/shared";

const setupDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-guidance-"));
  return dir;
};

const cleanupDir = async (dir: string) => {
  await fs.rm(dir, { recursive: true, force: true });
};

const withTempHome = async (fn: (home: string) => Promise<void>) => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-guidance-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    await fn(tempHome);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await cleanupDir(tempHome);
  }
};

test("loadProjectGuidance returns null when guidance missing", async () => {
  await withTempHome(async () => {
    const dir = await setupDir();
    try {
      const mcodaDir = PathHelper.getWorkspaceDir(dir);
      const result = await loadProjectGuidance(dir, mcodaDir);
      assert.equal(result, null);
    } finally {
      await cleanupDir(dir);
    }
  });
});

test("loadProjectGuidance loads docs/project-guidance.md", async () => {
  await withTempHome(async () => {
    const dir = await setupDir();
    try {
      const docsDir = path.join(dir, "docs");
      await fs.mkdir(docsDir, { recursive: true });
      const guidancePath = path.join(docsDir, "project-guidance.md");
      await fs.writeFile(guidancePath, "Guidance content", "utf8");
      const mcodaDir = PathHelper.getWorkspaceDir(dir);
      const result = await loadProjectGuidance(dir, mcodaDir);
      assert.ok(result);
      assert.equal(result?.content, "Guidance content");
      assert.equal(result?.source, guidancePath);
    } finally {
      await cleanupDir(dir);
    }
  });
});

test("loadProjectGuidance prefers workspace docs/project-guidance.md", async () => {
  await withTempHome(async () => {
    const dir = await setupDir();
    try {
      const docsDir = path.join(dir, "docs");
      const mcodaDir = PathHelper.getWorkspaceDir(dir);
      const workspaceDocsDir = path.join(mcodaDir, "docs");
      await fs.mkdir(docsDir, { recursive: true });
      await fs.mkdir(workspaceDocsDir, { recursive: true });
      const docsPath = path.join(docsDir, "project-guidance.md");
      const mcodaPath = path.join(workspaceDocsDir, "project-guidance.md");
      await fs.writeFile(docsPath, "Docs guidance", "utf8");
      await fs.writeFile(mcodaPath, "Mcoda guidance", "utf8");
      const result = await loadProjectGuidance(dir, mcodaDir);
      assert.ok(result);
      assert.equal(result?.content, "Mcoda guidance");
      assert.equal(result?.source, mcodaPath);
    } finally {
      await cleanupDir(dir);
    }
  });
});

test("ensureProjectGuidance creates workspace guidance in .mcoda docs", async () => {
  await withTempHome(async () => {
    const dir = await setupDir();
    try {
      const mcodaDir = PathHelper.getWorkspaceDir(dir);
      const result = await ensureProjectGuidance(dir, { mcodaDir });
      assert.equal(result.status, "created");
      const content = await fs.readFile(result.path, "utf8");
      assert.ok(content.includes("# Project Guidance"));
      assert.ok(result.path.startsWith(path.join(mcodaDir, "docs")));
    } finally {
      await cleanupDir(dir);
    }
  });
});

test("ensureProjectGuidance keeps existing content unless force is enabled", async () => {
  await withTempHome(async () => {
    const dir = await setupDir();
    try {
      const mcodaDir = PathHelper.getWorkspaceDir(dir);
      const docsDir = path.join(mcodaDir, "docs");
      await fs.mkdir(docsDir, { recursive: true });
      const guidancePath = path.join(docsDir, "project-guidance.md");
      await fs.writeFile(guidancePath, "Custom guidance", "utf8");

      const existing = await ensureProjectGuidance(dir, { mcodaDir });
      assert.equal(existing.status, "existing");
      assert.equal((await fs.readFile(guidancePath, "utf8")).trim(), "Custom guidance");

      const overwritten = await ensureProjectGuidance(dir, { mcodaDir, force: true });
      assert.equal(overwritten.status, "overwritten");
      const updated = await fs.readFile(guidancePath, "utf8");
      assert.ok(updated.includes("# Project Guidance"));
      assert.equal(updated.includes("Custom guidance"), false);
    } finally {
      await cleanupDir(dir);
    }
  });
});

test("normalizeDocType keeps SDS for docs/sds.md path", () => {
  const normalized = normalizeDocType({
    docType: "SDS",
    path: "docs/sds.md",
  });
  assert.equal(normalized.docType, "SDS");
  assert.equal(normalized.downgraded, false);
});

test("normalizeDocType downgrades SDS outside docs/sds without frontmatter", () => {
  const normalized = normalizeDocType({
    docType: "SDS",
    path: "docs/architecture.md",
    content: "# Architecture",
  });
  assert.equal(normalized.docType, "DOC");
  assert.equal(normalized.downgraded, true);
  assert.ok(normalized.reason?.includes("path_not_sds"));
});
