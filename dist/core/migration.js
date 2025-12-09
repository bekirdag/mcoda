import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
const INTEGRATION_BRANCH = "mcoda-dev";
const TASK_BRANCH_PREFIX = "mcoda/task";
const fileExists = async (filePath) => {
    try {
        await access(filePath, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
};
const sanitizeBranchSegment = (value) => value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
export const deriveTaskBranchName = (taskId, options = {}) => {
    if (options.reuseBranch) {
        return options.reuseBranch;
    }
    const base = sanitizeBranchSegment(String(taskId));
    const extra = options.slug ? sanitizeBranchSegment(options.slug) : "";
    const suffix = extra.length > 0 ? [base, extra].filter(Boolean).join("-") : base.length > 0 ? base : "";
    const finalSuffix = suffix.length > 0 ? suffix : "unknown";
    return `${TASK_BRANCH_PREFIX}/${finalSuffix}`;
};
export const getWorkspaceLayout = (workspaceRoot) => {
    const root = path.join(workspaceRoot, ".mcoda");
    return {
        root,
        dbPath: path.join(root, "mcoda.db"),
        jobsDir: path.join(root, "jobs"),
        docsDir: path.join(root, "docs"),
        promptsDir: path.join(root, "prompts"),
        configFiles: [path.join(root, "config.json"), path.join(root, "config.yaml"), path.join(root, "config.yml")],
        gitignorePath: path.join(workspaceRoot, ".gitignore"),
    };
};
export const getGlobalLayout = (homeDir = os.homedir()) => {
    const root = path.join(homeDir, ".mcoda");
    return {
        root,
        dbPath: path.join(root, "mcoda.db"),
        agentsDir: path.join(root, "agents"),
        releasesFile: path.join(root, "releases.json"),
    };
};
export const getLayoutManifest = (workspaceRoot, homeDir = os.homedir()) => ({
    global: getGlobalLayout(homeDir),
    workspace: getWorkspaceLayout(workspaceRoot),
    integrationBranch: INTEGRATION_BRANCH,
    taskBranchPrefix: TASK_BRANCH_PREFIX,
});
const ensureGitignoreHasMcoda = async (gitignorePath) => {
    const gitignoreExists = await fileExists(gitignorePath);
    const entry = ".mcoda/";
    if (!gitignoreExists) {
        await writeFile(gitignorePath, `${entry}\n`, "utf8");
        return true;
    }
    const content = await readFile(gitignorePath, "utf8");
    const lines = content.split(/\r?\n/);
    const alreadyPresent = lines.some((line) => {
        const trimmed = line.trim();
        return trimmed === ".mcoda" || trimmed === entry;
    });
    if (alreadyPresent) {
        return false;
    }
    const needsNewline = content.length > 0 && !content.endsWith("\n");
    const updated = `${content}${needsNewline ? "\n" : ""}${entry}\n`;
    await writeFile(gitignorePath, updated, "utf8");
    return true;
};
const ensureDir = async (dirPath, createdPaths) => {
    const exists = await fileExists(dirPath);
    if (!exists) {
        await mkdir(dirPath, { recursive: true });
        createdPaths.push(dirPath);
    }
};
export const ensureWorkspaceBootstrap = async (workspaceRoot) => {
    const layout = getWorkspaceLayout(workspaceRoot);
    const createdPaths = [];
    await ensureDir(layout.root, createdPaths);
    await ensureDir(layout.jobsDir, createdPaths);
    await ensureDir(layout.docsDir, createdPaths);
    await ensureDir(layout.promptsDir, createdPaths);
    const gitignoreUpdated = await ensureGitignoreHasMcoda(layout.gitignorePath);
    return {
        workspaceRoot,
        createdPaths,
        gitignoreUpdated,
        gitignorePath: layout.gitignorePath,
    };
};
