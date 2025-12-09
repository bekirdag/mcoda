import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveTaskBranchName, ensureWorkspaceBootstrap, getLayoutManifest, getWorkspaceLayout, } from "../src/core/migration.js";
const makeTempRepo = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mcoda-migration-"));
    mkdirSync(path.join(dir, "openapi"), { recursive: true });
    mkdirSync(path.join(dir, "src"), { recursive: true });
    return dir;
};
describe("migration rules (SDS Section 3)", () => {
    let repoRoot;
    afterEach(() => {
        if (repoRoot) {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });
    it("derives deterministic task branch names with mcoda prefix", () => {
        expect(deriveTaskBranchName(42)).toBe("mcoda/task/42");
        expect(deriveTaskBranchName("ABC-123", { slug: "Add login!" })).toBe("mcoda/task/abc-123-add-login");
    });
    it("reuses provided branch names on reruns", () => {
        expect(deriveTaskBranchName(1, { reuseBranch: "mcoda/task/custom" })).toBe("mcoda/task/custom");
    });
    it("exposes layout manifest for global and workspace roots", () => {
        repoRoot = makeTempRepo();
        const manifest = getLayoutManifest(repoRoot);
        expect(manifest.workspace.root).toBe(path.join(repoRoot, ".mcoda"));
        expect(manifest.workspace.jobsDir).toBe(path.join(repoRoot, ".mcoda", "jobs"));
        expect(manifest.global.root).toBe(path.join(os.homedir(), ".mcoda"));
        expect(manifest.integrationBranch).toBe("mcoda-dev");
        expect(manifest.taskBranchPrefix).toBe("mcoda/task");
    });
    it("bootstraps workspace layout and appends .mcoda to .gitignore", async () => {
        repoRoot = makeTempRepo();
        const layout = getWorkspaceLayout(repoRoot);
        const result = await ensureWorkspaceBootstrap(repoRoot);
        expect(result.createdPaths).toEqual(expect.arrayContaining([layout.root, layout.jobsDir, layout.docsDir, layout.promptsDir]));
        const gitignore = readFileSync(layout.gitignorePath, "utf8");
        const mcodaLines = gitignore.split(/\r?\n/).filter((line) => line.trim() === ".mcoda/" || line.trim() === ".mcoda");
        expect(mcodaLines).toHaveLength(1);
        expect(statSync(layout.root).isDirectory()).toBe(true);
        expect(statSync(layout.jobsDir).isDirectory()).toBe(true);
    });
    it("does not duplicate .mcoda entries on repeated bootstrap", async () => {
        repoRoot = makeTempRepo();
        await ensureWorkspaceBootstrap(repoRoot);
        await ensureWorkspaceBootstrap(repoRoot);
        const gitignorePath = path.join(repoRoot, ".gitignore");
        const lines = readFileSync(gitignorePath, "utf8")
            .split(/\r?\n/)
            .filter((line) => line.trim() === ".mcoda/" || line.trim() === ".mcoda");
        expect(lines).toHaveLength(1);
    });
});
