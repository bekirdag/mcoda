import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WorkspaceResolver,
  cleanupWorkspaceStateDirs,
  resolveDocgenStatePath,
} from "../WorkspaceManager.js";
import { PathHelper } from "@mcoda/shared";

const uuidRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanupTempDir = async (dir: string): Promise<void> => {
  const attempts = process.platform === "win32" ? 5 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (process.platform !== "win32") {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
        throw error;
      }
      await wait(100 * (attempt + 1));
    }
  }
};

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-ws-"));
  try {
    await fn(dir);
  } finally {
    await cleanupTempDir(dir);
  }
};

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-home-"));
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
    await cleanupTempDir(tempHome);
  }
};

test("rejects explicit workspace paths that do not exist", async () => {
  const missing = path.join(os.tmpdir(), `mcoda-missing-${Date.now()}`);
  await assert.rejects(
    () => WorkspaceResolver.resolveWorkspace({ explicitWorkspace: missing }),
    /Workspace path .* not found/,
  );
});

test("rejects explicit workspace ids without registry support", async () => {
  const fakeId = "123e4567-e89b-12d3-a456-426614174000";
  await assert.rejects(
    () => WorkspaceResolver.resolveWorkspace({ explicitWorkspace: fakeId }),
    /Workspace id .* not recognized/,
  );
});

test("migrates legacy workspace id to UUID and preserves legacy ids", async () => {
  await withTempHome(async () => {
    await withTempDir(async (dir) => {
      const legacyDir = path.join(dir, ".mcoda");
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(
        path.join(legacyDir, "workspace.json"),
        JSON.stringify({ id: "legacy-id" }, null, 2),
        "utf8",
      );

      const resolved = await WorkspaceResolver.resolveWorkspace({ explicitWorkspace: dir });
      const globalDir = PathHelper.getWorkspaceDir(dir);
      const payload = JSON.parse(await fs.readFile(path.join(globalDir, "workspace.json"), "utf8"));

      assert.match(payload.id, uuidRegex);
      assert.ok(payload.legacyIds.includes("legacy-id"));
      assert.ok(payload.legacyIds.includes(dir));
      assert.equal(resolved.workspaceId, payload.id);
      assert.equal(resolved.mcodaDir, globalDir);
      assert.ok(resolved.legacyWorkspaceIds.includes("legacy-id"));
      assert.ok(resolved.legacyWorkspaceIds.includes(dir));
    });
  });
});

test("cleanupWorkspaceStateDirs relocates legacy state dirs and preserves config", async () => {
  await withTempHome(async () => {
    await withTempDir(async (dir) => {
      const legacyDir = path.join(dir, ".mcoda");
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(
        path.join(legacyDir, "config.json"),
        JSON.stringify({ projectKey: "demo" }, null, 2),
        "utf8",
      );
      await fs.writeFile(path.join(legacyDir, "state.json"), "legacy-state", "utf8");

      const mcodaDir = PathHelper.getWorkspaceDir(dir);
      const warnings = await cleanupWorkspaceStateDirs({ workspaceRoot: dir, mcodaDir });

      assert.ok(warnings.some((warning) => warning.includes("Relocated legacy state directory")));
      await assert.rejects(() => fs.access(legacyDir));

      const configPath = path.join(mcodaDir, "config.json");
      const copiedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
      assert.equal(copiedConfig.projectKey, "demo");

      const legacyRoot = path.join(mcodaDir, "legacy");
      const entries = await fs.readdir(legacyRoot);
      assert.ok(entries.some((entry) => entry.startsWith("mcoda")));
    });
  });
});

test("resolveDocgenStatePath redirects output outside .mcoda to workspace state", async () => {
  await withTempHome(async () => {
    await withTempDir(async (dir) => {
      const mcodaDir = PathHelper.getWorkspaceDir(dir);
      const outputPath = path.join(path.parse(os.tmpdir()).root, "mcoda-docs", "out.md");
      const result = resolveDocgenStatePath({
        outputPath,
        mcodaDir,
        jobId: "job-123",
        commandName: "docs-pdr-generate",
      });

      assert.ok(PathHelper.isPathInside(mcodaDir, result.statePath));
      assert.ok(
        result.statePath.endsWith(
          path.join("state", "docgen", "docs-pdr-generate", "job-123", "out.md"),
        ),
      );
      assert.equal(result.warnings.length, 1);
      assert.ok(result.warnings[0]?.includes(outputPath));
    });
  });
});

test("resolveDocgenStatePath preserves output already inside .mcoda", async () => {
  await withTempHome(async () => {
    await withTempDir(async (dir) => {
      const mcodaDir = PathHelper.getWorkspaceDir(dir);
      const outputPath = path.join(
        mcodaDir,
        "state",
        "docgen",
        "docs-pdr-generate",
        "job-123",
        "out.md",
      );
      const result = resolveDocgenStatePath({
        outputPath,
        mcodaDir,
        jobId: "job-123",
        commandName: "docs-pdr-generate",
      });

      assert.equal(result.statePath, outputPath);
      assert.equal(result.warnings.length, 0);
    });
  });
});
