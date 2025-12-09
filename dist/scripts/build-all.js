import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
const run = (command, args, cwd) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => {
        if (code === 0) {
            resolve();
        }
        else {
            reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
        }
    });
    child.on("error", (error) => reject(error));
});
const readPackageJson = async (pkgPath) => {
    try {
        const raw = await fs.readFile(pkgPath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
const findPackagesWithBuild = async (repoRoot) => {
    const packagesRoot = path.join(repoRoot, "packages");
    let entries;
    try {
        entries = await fs.readdir(packagesRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const results = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const dir = path.join(packagesRoot, entry.name);
        const pkgJsonPath = path.join(dir, "package.json");
        const pkg = await readPackageJson(pkgJsonPath);
        const hasBuild = Boolean(pkg?.scripts?.build);
        results.push({ dir, name: pkg?.name ?? entry.name, hasBuild });
    }
    return results;
};
export const runBuildAll = async () => {
    const repoRoot = process.cwd();
    const rootPkg = await readPackageJson(path.join(repoRoot, "package.json"));
    const packages = await findPackagesWithBuild(repoRoot);
    const buildTargets = [];
    if (rootPkg?.scripts?.build) {
        buildTargets.push({ dir: repoRoot, name: rootPkg.name ?? "root", args: ["run", "build"] });
    }
    for (const pkg of packages) {
        if (pkg.hasBuild) {
            buildTargets.push({
                dir: pkg.dir,
                name: pkg.name,
                args: ["run", "build"],
            });
        }
    }
    if (buildTargets.length === 0) {
        // eslint-disable-next-line no-console
        console.log("No build scripts found in root or packages/. Nothing to build.");
        return;
    }
    for (const target of buildTargets) {
        // eslint-disable-next-line no-console
        console.log(`Building ${target.name} (${target.dir})...`);
        await run("npm", target.args, target.dir);
    }
};
if (import.meta.url === `file://${process.argv[1]}`) {
    runBuildAll().catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error);
        process.exitCode = 1;
    });
}
