#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWorkspaceService } from "@mcoda/core/services.js";
const usage = [
    "mcoda update [check|apply] [--latest 0.1.0] [--workspace <name>] [--out .mcoda/update/update-log.md] [--overwrite]",
    "",
    "Prototype updater: checks current version against a provided/latest version and simulates apply (telemetry stored in workspace DB).",
].join("\n");
const parseArgs = (argv) => {
    let action = "check";
    let latestVersion;
    let outputPath;
    let overwrite = false;
    let workspace;
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
    const workspaceStore = await createWorkspaceService();
    const current = await readCurrentVersion();
    const latest = options.latestVersion ?? "0.1.0";
    const updateAvailable = current ? current !== latest : true;
    const shouldApply = options.action === "apply" && updateAvailable;
    const text = buildText(current, latest, options.action === "apply", options.outputPath);
    // eslint-disable-next-line no-console
    console.log(text);
    await writeOutputIfRequested(options.outputPath ?? (options.action === "apply" ? path.join(process.cwd(), ".mcoda", "update", "update-log.md") : undefined), text, options.overwrite);
    const now = new Date().toISOString();
    const status = "completed";
    const summary = shouldApply ? "Update applied" : "Update check completed";
    workspaceStore.recordCommandRun({
        command: `update:${options.action}`,
        workspace: options.workspace ?? process.cwd(),
        status,
        summary,
        outputPath: options.outputPath,
        updatedAt: now,
    });
    workspaceStore.recordTokenUsage({
        command: `update:${options.action}`,
        workspace: options.workspace ?? process.cwd(),
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
