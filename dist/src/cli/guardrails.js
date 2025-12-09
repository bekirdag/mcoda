#!/usr/bin/env node
import path from "node:path";
import { hasGuardrailFailures, runGuardrails, defaultGuardrailSuite } from "../core/guardrails.js";
const parseArgs = (argv) => {
    let workspaceRoot = process.cwd();
    let json = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--workspace" || arg === "-w") {
            const next = argv[i + 1];
            if (!next) {
                throw new Error("--workspace requires a path");
            }
            workspaceRoot = path.resolve(next);
            i += 1;
        }
        else if (arg === "--json") {
            json = true;
        }
    }
    return { workspaceRoot, json };
};
const formatText = (results) => {
    const lines = results.map((result) => {
        const status = `${result.status.toUpperCase()} (${result.severity})`;
        return `- [${result.id}] ${status}: ${result.message}${result.remediation ? ` | Fix: ${result.remediation}` : ""}`;
    });
    return lines.join("\n");
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const results = await runGuardrails(defaultGuardrailSuite, {
        repoRoot: process.cwd(),
        workspaceRoot: options.workspaceRoot,
    });
    if (options.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ results }, null, 2));
    }
    else {
        // eslint-disable-next-line no-console
        console.log(formatText(results));
    }
    if (hasGuardrailFailures(results)) {
        process.exitCode = 1;
    }
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
