#!/usr/bin/env node
import path from "node:path";
import { createWorkspaceService } from "@mcoda/core/services.js";
const usage = [
    "mcoda estimate [--project <KEY>] [--epic <ID>] [--window 10|20|50] [--lane implementation|review|qa|all]",
    "               [--json] [--workspace-root <path>]",
    "",
    "Computes SP/hour from recent task runs (per lane) using workspace DB history.",
].join("\n");
const parseArgs = (argv) => {
    let project;
    let epic;
    let window = 10;
    let lane = "all";
    let json = false;
    let workspaceRoot;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--project":
                project = argv[i + 1];
                i += 1;
                break;
            case "--epic":
                epic = argv[i + 1];
                i += 1;
                break;
            case "--window": {
                const next = Number(argv[i + 1] ?? "10");
                if (next === 10 || next === 20 || next === 50) {
                    window = next;
                }
                i += 1;
                break;
            }
            case "--lane": {
                const next = argv[i + 1];
                if (next === "implementation" || next === "review" || next === "qa" || next === "all") {
                    lane = next;
                }
                i += 1;
                break;
            }
            case "--json":
                json = true;
                break;
            case "--workspace-root":
                workspaceRoot = argv[i + 1];
                i += 1;
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
    return { project, epic, window, lane, json, workspaceRoot };
};
const laneToCommands = (lane) => {
    if (lane === "implementation")
        return ["work-on-tasks"];
    if (lane === "review")
        return ["code-review"];
    if (lane === "qa")
        return ["qa-tasks"];
    return undefined;
};
const calculateLanes = (options, workspaceRoot) => {
    const store = createWorkspaceService({ workspaceRoot });
    return store.then((ws) => {
        const lanes = options.lane === "all" ? ["implementation", "review", "qa"] : [options.lane];
        const results = lanes.map((lane) => {
            const stats = ws.spPerHourForCommands({ window: options.window, commands: laneToCommands(lane), epicId: options.epic });
            return {
                lane,
                storyPointsPerHour: stats.spPerHour,
                sampleSize: stats.sample,
                window: options.window,
            };
        });
        if (options.lane === "all") {
            const aggregate = ws.spPerHourForCommands({ window: options.window, epicId: options.epic });
            results.push({
                lane: "aggregate",
                storyPointsPerHour: aggregate.spPerHour,
                sampleSize: aggregate.sample,
                window: options.window,
            });
        }
        return { results, store: ws };
    });
};
const formatTable = (results) => {
    const header = ["Lane", "SP/h", "Sample", "Window"];
    const rows = results.map((r) => [
        r.lane,
        r.storyPointsPerHour.toFixed(2),
        String(r.sampleSize),
        String(r.window),
    ]);
    const widths = header.map((h, idx) => Math.max(h.length, ...rows.map((r) => r[idx].length)));
    const pad = (value, width) => (value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`);
    const formatRow = (cols) => cols.map((c, idx) => pad(c, widths[idx])).join(" | ");
    return [formatRow(header), formatRow(widths.map((w) => "-".repeat(w))), ...rows.map((r) => formatRow(r))].join("\n");
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    const { results, store } = await calculateLanes(options, workspaceRoot);
    const commandRunId = store.recordCommandRun({
        command: "estimate",
        workspace: workspaceRoot,
        status: "completed",
        updatedAt: new Date().toISOString(),
    });
    store.recordTokenUsage({
        command: "estimate",
        workspace: workspaceRoot,
        commandRunId,
        operationId: "backlog.estimate",
        action: "snapshot",
        promptTokens: 0,
        completionTokens: 0,
    });
    if (options.json) {
        const primary = results.find((r) => r.lane !== "aggregate") ?? results[0];
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
            lane: primary?.lane,
            storyPointsPerHour: primary?.storyPointsPerHour,
            sampleSize: primary?.sampleSize,
            window: primary?.window,
            lanes: results,
            project: options.project,
            epic: options.epic,
        }, null, 2));
        return;
    }
    const projectLabel = options.project ?? path.basename(workspaceRoot);
    const lines = [
        `Estimate for ${projectLabel}`,
        `Workspace: ${workspaceRoot}`,
        `Epic filter: ${options.epic ?? "(none)"}`,
        "",
        formatTable(results),
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
