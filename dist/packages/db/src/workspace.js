import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureWorkspaceBootstrap, getGlobalLayout, getWorkspaceLayout } from "./migration.js";
const fileExists = async (filePath) => {
    try {
        await access(filePath);
        return true;
    }
    catch {
        return false;
    }
};
const looksLikePath = (value) => {
    return path.isAbsolute(value) || value.startsWith(".") || value.includes(path.sep);
};
const findNearestWorkspaceRoot = async (start) => {
    let current = path.resolve(start);
    while (true) {
        const layout = getWorkspaceLayout(current);
        if (await fileExists(layout.workspaceFile)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return null;
};
const findNearestGitRoot = async (start) => {
    let current = path.resolve(start);
    while (true) {
        if (await fileExists(path.join(current, ".git")))
            return current;
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return null;
};
export const resolveWorkspaceContext = async (options = {}) => {
    const start = path.resolve(options.cwd ?? process.cwd());
    const hint = options.explicitWorkspace ?? process.env.MCODA_WORKSPACE;
    let workspaceRoot;
    if (hint) {
        if (!looksLikePath(hint)) {
            throw new Error("Workspace ID resolution is not implemented; provide a path for --workspace or MCODA_WORKSPACE per SDS Section 21.2.2.");
        }
        const hintPath = path.isAbsolute(hint) ? hint : path.resolve(start, hint);
        workspaceRoot = (await findNearestWorkspaceRoot(hintPath)) ?? hintPath;
    }
    else {
        const existing = await findNearestWorkspaceRoot(start);
        if (existing) {
            workspaceRoot = existing;
        }
        else {
            const gitRoot = await findNearestGitRoot(start);
            workspaceRoot = gitRoot ?? start;
        }
    }
    const bootstrap = await ensureWorkspaceBootstrap(workspaceRoot);
    const layout = getWorkspaceLayout(workspaceRoot);
    const homeDir = options.homeDir ?? os.homedir();
    const globalLayout = getGlobalLayout(homeDir);
    const configPath = layout.configFiles[0];
    const globalConfigPath = process.env.MCODA_CONFIG
        ? path.resolve(process.env.MCODA_CONFIG)
        : path.join(globalLayout.root, "config.json");
    const jobsDir = process.env.MCODA_JOBS_DIR
        ? path.resolve(workspaceRoot, process.env.MCODA_JOBS_DIR)
        : layout.jobsDir;
    const cacheDir = process.env.MCODA_CACHE_DIR
        ? path.resolve(workspaceRoot, process.env.MCODA_CACHE_DIR)
        : path.join(globalLayout.root, "cache");
    const globalDbPath = process.env.MCODA_DB_PATH ? path.resolve(process.env.MCODA_DB_PATH) : globalLayout.dbPath;
    return {
        id: bootstrap.identity.id,
        rootDir: workspaceRoot,
        workspaceFile: layout.workspaceFile,
        configPath,
        jobsDir,
        cacheDir,
        workspaceDbPath: layout.dbPath,
        globalDbPath,
        globalConfigPath,
        identity: bootstrap.identity,
    };
};
