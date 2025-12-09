#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda update [check|apply] [--latest 0.1.0] [--workspace <name>] [--token-usage <path>] [--runs <path>] [--out .mcoda/update/update-log.md] [--overwrite]",
    "",
    "Prototype updater: checks current version against a provided/latest version and simulates apply.",
].join("\n");
const parseArgs = (argv) => {
    let action = "check";
    let latestVersion;
    let outputPath;
    let overwrite = false;
    let workspace;
    let tokenUsagePath;
    let commandRunPath;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith("--") && (arg === "check" || arg === "apply")) {
            action = arg;
            continue;
        }
        switch (arg) {
            case "--latest":
                latestVersion = argv[i + 1];
                i += 1;
                break;
            case "--workspace":
                workspace = argv[i + 1];
                i += 1;
                break;
            case "--token-usage":
                tokenUsagePath = argv[i + 1];
                i += 1;
                break;
            case "--runs":
                commandRunPath = argv[i + 1];
                i += 1;
                break;
            case "--out":
                outputPath = path.resolve(argv[i + 1] ?? "");
                i += 1;
                break;
            case "--overwrite":
                overwrite = true;
                break;
            case "--help":
            case "-h":
                // eslint-disable-next-line no-console
                console.log(usage);
                process.exit(0);
                break;
            default:
                break;
        }
    }
    return {
        action,
        latestVersion,
        outputPath,
        overwrite,
        workspace,
        tokenUsagePath: path.resolve(tokenUsagePath ?? path.join(process.cwd(), ".mcoda", "token_usage.json")),
        commandRunPath: path.resolve(commandRunPath ?? path.join(process.cwd(), ".mcoda", "command_runs.json")),
    };
};
const ensureDir = async (targetPath) => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
};
const readCurrentVersion = async () => {
    try {
        const pkgPath = path.join(process.cwd(), "package.json");
        const raw = await fs.readFile(pkgPath, "utf8");
        const parsed = JSON.parse(raw);
        return parsed.version ?? null;
    }
    catch {
        return null;
    }
};
const buildText = (current, latest, applied, outputPath) => {
    const now = new Date().toISOString();
    const updateAvailable = current && current !== latest;
    const status = applied ? (updateAvailable ? "applied" : "no-op") : updateAvailable ? "available" : "up-to-date";
    return [
        "# mcoda update",
        "",
        `- Current version: ${current ?? "(unknown)"}`,
        `- Latest version: ${latest}`,
        `- Status: ${status}`,
        `- Generated: ${now}`,
        outputPath ? `- Log file: ${outputPath}` : "",
        "",
        applied && updateAvailable
            ? "Update applied (simulated). In the real flow, this would install the new CLI version."
            : "Use --latest to supply a target version; this helper does not modify package.json.",
        "",
    ]
        .filter(Boolean)
        .join("\n");
};
const writeOutputIfRequested = async (outputPath, content, overwrite) => {
    if (!outputPath)
        return;
    if (!overwrite) {
        try {
            await fs.access(outputPath);
            throw new Error(`Output already exists: ${outputPath}. Re-run with --overwrite to replace it.`);
        }
        catch {
            // ok
        }
    }
    await ensureDir(outputPath);
    await fs.writeFile(outputPath, content, "utf8");
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const current = await readCurrentVersion();
    const latest = options.latestVersion ?? "0.1.0";
    const updateAvailable = current ? current !== latest : true;
    const shouldApply = options.action === "apply" && updateAvailable;
    const text = buildText(current, latest, options.action === "apply", options.outputPath);
    // eslint-disable-next-line no-console
    console.log(text);
    await writeOutputIfRequested(options.outputPath ?? (options.action === "apply" ? path.join(process.cwd(), ".mcoda", "update", "update-log.md") : undefined), text, options.overwrite);
    const now = new Date().toISOString();
    await ensureDir(options.commandRunPath);
    try {
        const commandRunsRaw = await fs.readFile(options.commandRunPath, "utf8");
        const parsed = JSON.parse(commandRunsRaw);
        const next = Array.isArray(parsed) ? parsed : [];
        next.push({
            command: `update:${options.action}`,
            workspace: options.workspace ?? "(unspecified)",
            status: shouldApply ? "applied" : "checked",
            latest,
            current,
            updatedAt: now,
        });
        await fs.writeFile(options.commandRunPath, JSON.stringify(next, null, 2), "utf8");
    }
    catch {
        // best-effort
    }
    try {
        const tokenRuns = await fs.readFile(options.tokenUsagePath, "utf8").then((raw) => JSON.parse(raw)).catch(() => []);
        const arr = Array.isArray(tokenRuns) ? tokenRuns : [];
        arr.push({
            command: `update:${options.action}`,
            workspace: options.workspace ?? "(unspecified)",
            promptTokens: 0,
            completionTokens: 0,
            recordedAt: now,
        });
        await ensureDir(options.tokenUsagePath);
        await fs.writeFile(options.tokenUsagePath, JSON.stringify(arr, null, 2), "utf8");
    }
    catch {
        // best-effort
    }
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
