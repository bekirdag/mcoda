#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda pdr --rfp <path/to/rfp.md> [--out <path/to/pdr.md>] [--title <title>] [--project <name>] [--overwrite]",
    "",
    "Defaults:",
    "  --out .mcoda/docs/pdr/pdr-<rfp-basename>.md",
    "  --project <current-directory-name>",
].join("\n");
const deriveDefaultOutputPath = (rfpPath) => {
    const base = path.basename(rfpPath, path.extname(rfpPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "docs", "pdr", `pdr-${base}.md`);
};
const parseArgs = (argv) => {
    const args = [...argv];
    let rfpPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let title;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        switch (arg) {
            case "--rfp":
            case "-i": {
                rfpPath = args[i + 1];
                i += 1;
                break;
            }
            case "--out":
            case "-o": {
                outputPath = args[i + 1];
                i += 1;
                break;
            }
            case "--project": {
                project = args[i + 1] ?? project;
                i += 1;
                break;
            }
            case "--title": {
                title = args[i + 1];
                i += 1;
                break;
            }
            case "--overwrite": {
                overwrite = true;
                break;
            }
            case "--help":
            case "-h": {
                // eslint-disable-next-line no-console
                console.log(usage);
                process.exit(0);
                break;
            }
            default:
                break;
        }
    }
    if (!rfpPath) {
        throw new Error("Missing required --rfp <path/to/rfp.md> argument");
    }
    const resolvedRfp = path.resolve(rfpPath);
    const resolvedOut = path.resolve(outputPath ?? deriveDefaultOutputPath(resolvedRfp));
    return {
        rfpPath: resolvedRfp,
        outputPath: resolvedOut,
        overwrite,
        project,
        title,
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
const extractRfpBullets = (rfpContent) => {
    return rfpContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[-*+]\s+/.test(line))
        .map((line) => line.replace(/^[-*+]\s+/, "").trim())
        .filter((line) => line.length > 0)
        .slice(0, 20);
};
const formatBullets = (items, placeholder) => {
    if (items.length === 0) {
        return `- ${placeholder}`;
    }
    return items.map((item) => `- ${item}`).join("\n");
};
const buildPdrContent = (opts, rfpContent) => {
    const now = new Date().toISOString();
    const rfpRel = path.relative(process.cwd(), opts.rfpPath);
    const bullets = extractRfpBullets(rfpContent);
    const fencedRfp = ["```markdown", rfpContent.trimEnd(), "```"].join("\n");
    return [
        `# Product Design Review${opts.title ? `: ${opts.title}` : ""}`,
        "",
        `- Project: ${opts.project}`,
        `- Source RFP: ${rfpRel}`,
        `- Generated: ${now}`,
        "",
        "## Summary",
        "Provide a short narrative of the product direction and what success looks like.",
        "",
        "## Goals",
        formatBullets(bullets, "TODO: extract goals from the RFP"),
        "",
        "## Non-Goals",
        "- TODO: clarify items explicitly out of scope.",
        "",
        "## Functional Scope",
        "- TODO: describe key capabilities and constraints.",
        "",
        "## Non-Functional Requirements",
        "- TODO: performance, reliability, security, compliance expectations.",
        "",
        "## Risks and Mitigations",
        "- TODO: note risks raised in the RFP and proposed mitigations.",
        "",
        "## Open Questions",
        "- TODO: unresolved questions for stakeholders.",
        "",
        "## Acceptance Criteria",
        "- TODO: measurable outcomes for sign-off.",
        "",
        "## Appendix A: Source RFP",
        fencedRfp,
        "",
    ].join("\n");
};
const ensureParentDirectory = async (targetPath) => {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const rfpContent = await fs.readFile(options.rfpPath, "utf8");
    if (!options.overwrite && (await fileExists(options.outputPath))) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    await ensureParentDirectory(options.outputPath);
    const content = buildPdrContent(options, rfpContent);
    await fs.writeFile(options.outputPath, content, "utf8");
    // eslint-disable-next-line no-console
    console.log(`PDR created at ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
