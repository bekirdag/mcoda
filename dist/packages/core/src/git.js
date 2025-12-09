import { execSync } from "node:child_process";
import path from "node:path";
import { deriveTaskBranchName } from "@mcoda/db/migration.js";
const runGit = (args, cwd) => {
    const result = execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return result.trim();
};
const gitAvailable = (cwd) => {
    try {
        runGit(["rev-parse", "--is-inside-work-tree"], cwd);
        return true;
    }
    catch {
        return false;
    }
};
const branchExists = (branch, cwd) => {
    try {
        runGit(["rev-parse", "--verify", branch], cwd);
        return true;
    }
    catch {
        return false;
    }
};
const currentBranch = (cwd) => {
    try {
        return runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    }
    catch {
        return "unknown";
    }
};
const detectBaseBranch = (cwd) => {
    if (branchExists("main", cwd))
        return "main";
    if (branchExists("master", cwd))
        return "master";
    return currentBranch(cwd);
};
const ensureBranch = (branch, base, cwd) => {
    if (branchExists(branch, cwd))
        return;
    runGit(["branch", branch, base], cwd);
};
const checkoutBranch = (branch, cwd) => {
    runGit(["checkout", branch], cwd);
};
const stashIfDirty = (cwd) => {
    const status = runGit(["status", "--porcelain"], cwd);
    if (!status.trim())
        return undefined;
    const label = `mcoda-auto-stash-${Date.now()}`;
    runGit(["stash", "push", "-u", "-m", label], cwd);
    return label;
};
export const ensureDeterministicBranches = (options) => {
    const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    if (!gitAvailable(repoRoot)) {
        throw new Error(`Not a git repository: ${repoRoot}`);
    }
    const originalBranch = currentBranch(repoRoot);
    const stashRef = stashIfDirty(repoRoot);
    const baseBranch = detectBaseBranch(repoRoot);
    const integrationBranch = "mcoda-dev";
    ensureBranch(integrationBranch, baseBranch, repoRoot);
    checkoutBranch(integrationBranch, repoRoot);
    const taskBranch = deriveTaskBranchName(options.taskId, { slug: options.slug, reuseBranch: options.reuseBranch });
    ensureBranch(taskBranch, integrationBranch, repoRoot);
    checkoutBranch(taskBranch, repoRoot);
    return { repoRoot, baseBranch, integrationBranch, taskBranch, originalBranch, stashRef };
};
