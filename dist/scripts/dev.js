import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
const readPackageJson = async (pkgPath) => {
    try {
        const raw = await fs.readFile(pkgPath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
const discoverDevTargets = async (repoRoot) => {
    const targets = [];
    const rootPkg = await readPackageJson(path.join(repoRoot, "package.json"));
    if (rootPkg?.scripts?.dev) {
        targets.push({ dir: repoRoot, name: rootPkg.name ?? "root", args: ["run", "dev"] });
    }
    const packagesRoot = path.join(repoRoot, "packages");
    let entries = [];
    try {
        entries = await fs.readdir(packagesRoot, { withFileTypes: true });
    }
    catch {
        // packages/ may not exist yet; ignore.
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const dir = path.join(packagesRoot, entry.name);
        const pkgJsonPath = path.join(dir, "package.json");
        const pkg = await readPackageJson(pkgJsonPath);
        if (pkg?.scripts?.dev) {
            targets.push({
                dir,
                name: pkg.name ?? entry.name,
                args: ["run", "dev"],
            });
        }
    }
    return targets;
};
const startProcess = (target) => {
    const child = spawn("npm", target.args, {
        cwd: target.dir,
        stdio: "inherit",
    });
    return child;
};
export const runDev = async () => {
    const repoRoot = process.cwd();
    const targets = await discoverDevTargets(repoRoot);
    if (targets.length === 0) {
        // eslint-disable-next-line no-console
        console.log("No dev scripts found in root or packages/. Add a `dev` script to start watchers.");
        return;
    }
    // eslint-disable-next-line no-console
    console.log(`Starting dev scripts for: ${targets.map((t) => t.name).join(", ")}`);
    const children = targets.map(startProcess);
    let settled = false;
    let running = children.length;
    const cleanup = () => {
        for (const child of children) {
            if (!child.killed) {
                child.kill("SIGTERM");
            }
        }
    };
    await new Promise((resolve, reject) => {
        const onSignal = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve();
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        children.forEach((child, index) => {
            child.on("exit", (code) => {
                if (settled)
                    return;
                running -= 1;
                if (code && code !== 0) {
                    settled = true;
                    cleanup();
                    reject(new Error(`Dev target ${targets[index]?.name ?? index} exited with code ${code}`));
                    return;
                }
                if (running === 0) {
                    settled = true;
                    resolve();
                }
            });
            child.on("error", (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                reject(error);
            });
        });
    });
};
if (import.meta.url === `file://${process.argv[1]}`) {
    runDev().catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error);
        process.exitCode = 1;
    });
}
