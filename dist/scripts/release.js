import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
const run = (command, args, cwd) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))));
    child.on("error", (error) => reject(error));
});
const gitTag = async () => {
    try {
        const output = await new Promise((resolve, reject) => {
            execFile("git", ["describe", "--tags", "--exact-match"], (err, stdout) => {
                if (err)
                    return reject(err);
                resolve(stdout.trim());
            });
        });
        return output || null;
    }
    catch {
        return null;
    }
};
const parseArgs = (argv) => {
    let tag;
    let dryRun = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--tag") {
            tag = argv[i + 1];
            i += 1;
        }
        else if (arg === "--dry-run") {
            dryRun = true;
        }
    }
    return { tag, dryRun };
};
export const runRelease = async () => {
    const options = parseArgs(process.argv.slice(2));
    const repoRoot = process.cwd();
    const pkgPath = path.join(repoRoot, "package.json");
    const pkgRaw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(pkgRaw);
    const resolvedTag = options.tag ?? process.env.RELEASE_TAG ?? (await gitTag());
    if (!resolvedTag) {
        throw new Error("No release tag provided (--tag) and unable to determine git tag.");
    }
    if (!resolvedTag.startsWith("v")) {
        throw new Error(`Release tag must start with v; received ${resolvedTag}`);
    }
    if (!pkg.version) {
        throw new Error("package.json is missing a version field.");
    }
    const expectedTag = `v${pkg.version}`;
    if (resolvedTag !== expectedTag) {
        throw new Error(`Release tag ${resolvedTag} does not match package version ${pkg.version}`);
    }
    if (pkg.private) {
        throw new Error("package.json is marked private; clear this before publishing.");
    }
    // eslint-disable-next-line no-console
    console.log(`Running release for ${pkg.name ?? "package"} ${pkg.version} (tag ${resolvedTag})`);
    await run("npm", ["run", "build"], repoRoot);
    const publishArgs = ["publish", "--access", "public"];
    if (options.dryRun) {
        publishArgs.push("--dry-run");
    }
    await run("npm", publishArgs, repoRoot);
};
if (import.meta.url === `file://${process.argv[1]}`) {
    runRelease().catch((error) => {
        // eslint-disable-next-line no-console
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
