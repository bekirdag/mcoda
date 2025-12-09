#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda create-tasks --input <path/to/pdr-or-sds.md> [--out .mcoda/tasks/tasks-<name>.md] [--project <name>] [--max 12] [--job-id <id>] [--checkpoint <path>] [--token-usage <path>] [--runs <path>] [--resume] [--overwrite]",
    "",
    "Scaffolds a tasks list from a PDR/SDS (bullet headlines) into .mcoda/tasks/ for prototyping.",
].join("\n");
const deriveDefaultOutputPath = (inputPath) => {
    const base = path.basename(inputPath, path.extname(inputPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "tasks", `tasks-${base}.md`);
};
const defaultJobId = () => `create-tasks-${Date.now()}`;
const defaultCheckpointPath = (jobId) => path.join(process.cwd(), ".mcoda", "jobs", jobId, "checkpoint.json");
const defaultTokenUsagePath = () => path.join(process.cwd(), ".mcoda", "token_usage.json");
const defaultCommandRunPath = () => path.join(process.cwd(), ".mcoda", "command_runs.json");
const parseArgs = (argv) => {
    let inputPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let max = 12;
    let jobId;
    let checkpointPath;
    let resume = false;
    let tokenUsagePath;
    let commandRunPath;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--input":
            case "-i":
                inputPath = argv[i + 1];
                i += 1;
                break;
            case "--out":
            case "-o":
                outputPath = argv[i + 1];
                i += 1;
                break;
            case "--project":
                project = argv[i + 1] ?? project;
                i += 1;
                break;
            case "--max":
                max = Number(argv[i + 1] ?? max);
                i += 1;
                break;
            case "--job-id":
                jobId = argv[i + 1];
                i += 1;
                break;
            case "--checkpoint":
                checkpointPath = argv[i + 1];
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
            case "--resume":
                resume = true;
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
    if (!inputPath) {
        throw new Error("Missing required --input <path/to/pdr-or-sds.md> argument");
    }
    const resolvedInput = path.resolve(inputPath);
    const resolvedOut = path.resolve(outputPath ?? deriveDefaultOutputPath(resolvedInput));
    const resolvedJobId = jobId ?? defaultJobId();
    return {
        inputPath: resolvedInput,
        outputPath: resolvedOut,
        overwrite,
        project,
        max,
        jobId: resolvedJobId,
        checkpointPath: path.resolve(checkpointPath ?? defaultCheckpointPath(resolvedJobId)),
        resume,
        tokenUsagePath: path.resolve(tokenUsagePath ?? defaultTokenUsagePath()),
        commandRunPath: path.resolve(commandRunPath ?? defaultCommandRunPath()),
    };
};
const fileExists = async (filePath) => {
    try {
        await fs.stat(filePath);
        return true;
    }
    catch {
        return false;
    }
};
const extractBullets = (content, limit) => {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[-*+]\s+/.test(line))
        .map((line) => line.replace(/^[-*+]\s+/, "").trim())
        .filter((line) => line.length > 0)
        .slice(0, Math.max(1, limit));
};
const truncate = (value, maxLen) => {
    if (value.length <= maxLen)
        return value;
    return `${value.slice(0, maxLen - 3)}...`;
};
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const buildTasksContent = (opts, sourceContent) => {
    const now = new Date().toISOString();
    const sourceRel = path.relative(process.cwd(), opts.inputPath);
    const bullets = extractBullets(sourceContent, opts.max);
    const rows = bullets.map((text, index) => {
        const id = `TASK-${index + 1}`;
        const title = truncate(text, 70);
        return `| ${id} | ${title.replace(/\|/g, "\\|")} | not_started | TBD | Derived from: ${truncate(text, 80).replace(/\|/g, "\\|")} |`;
    });
    const table = [
        "| ID | Title | Status | Estimate (SP) | Notes |",
        "| --- | --- | --- | --- | --- |",
        rows.length > 0 ? rows.join("\n") : "| TASK-1 | Placeholder task | not_started | TBD | Add tasks based on the PDR/SDS |",
    ].join("\n");
    return [
        `# Tasks for ${opts.project}`,
        "",
        `- Source doc: ${sourceRel}`,
        `- Generated: ${now}`,
        `- Max tasks: ${opts.max}`,
        "",
        "## Tasks",
        table,
        "",
        "## Next Steps",
        "- Refine titles/descriptions and add dependencies.",
        "- Set estimates (SP) and assign owners.",
        "- Feed into mcoda workflow (refine-tasks, work-on-tasks, etc.).",
        "",
        "## Appendix A: Source document",
        fence(sourceContent),
        "",
    ].join("\n");
};
const ensureParentDirectory = async (targetPath) => {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
};
const readCheckpoint = async (checkpointPath) => {
    try {
        const raw = await fs.readFile(checkpointPath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
const writeCheckpoint = async (checkpointPath, checkpoint) => {
    await ensureParentDirectory(checkpointPath);
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");
};
const appendJsonArray = async (filePath, record) => {
    try {
        await ensureParentDirectory(filePath);
        let existing = [];
        try {
            const raw = await fs.readFile(filePath, "utf8");
            existing = JSON.parse(raw);
        }
        catch {
            existing = [];
        }
        existing.push(record);
        await fs.writeFile(filePath, JSON.stringify(existing, null, 2), "utf8");
    }
    catch {
        // best-effort; do not block the command
    }
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const sourceContent = await fs.readFile(options.inputPath, "utf8");
    if (!options.overwrite && (await fileExists(options.outputPath))) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    if (options.resume) {
        const checkpoint = await readCheckpoint(options.checkpointPath);
        if (checkpoint) {
            // eslint-disable-next-line no-console
            console.log(`Resuming job ${checkpoint.jobId} from stage ${checkpoint.stage}`);
        }
    }
    await ensureParentDirectory(options.outputPath);
    const content = buildTasksContent(options, sourceContent);
    await fs.writeFile(options.outputPath, content, "utf8");
    const now = new Date().toISOString();
    const checkpoint = {
        jobId: options.jobId,
        command: "create-tasks",
        stage: "persisted",
        outputPath: options.outputPath,
        updatedAt: now,
    };
    await writeCheckpoint(options.checkpointPath, checkpoint);
    await appendJsonArray(options.commandRunPath, {
        command: "create-tasks",
        jobId: options.jobId,
        status: "succeeded",
        outputPath: options.outputPath,
        updatedAt: now,
    });
    await appendJsonArray(options.tokenUsagePath, {
        command: "create-tasks",
        jobId: options.jobId,
        promptTokens: 0,
        completionTokens: 0,
        recordedAt: now,
    });
    // eslint-disable-next-line no-console
    console.log(`Tasks draft created at ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
