#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "mcoda sds --pdr <path/to/pdr.md> [--docs path1 path2 ...] [--out <path/to/sds.md>] [--title <title>] [--project <name>] [--overwrite]",
    "",
    "Defaults:",
    "  --out .mcoda/docs/sds/sds-<pdr-basename>.md",
    "  --project <current-directory-name>",
].join("\n");
const deriveDefaultOutputPath = (pdrPath) => {
    const base = path.basename(pdrPath, path.extname(pdrPath)) || "draft";
    return path.join(process.cwd(), ".mcoda", "docs", "sds", `sds-${base}.md`);
};
const parseArgs = (argv) => {
    const args = [...argv];
    let pdrPath;
    let outputPath;
    let overwrite = false;
    let project = path.basename(process.cwd());
    let title;
    const extraDocs = [];
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        switch (arg) {
            case "--pdr":
            case "-i": {
                pdrPath = args[i + 1];
                i += 1;
                break;
            }
            case "--docs": {
                const maybeDoc = args[i + 1];
                if (maybeDoc && !maybeDoc.startsWith("--")) {
                    extraDocs.push(maybeDoc);
                    i += 1;
                }
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
    if (!pdrPath) {
        throw new Error("Missing required --pdr <path/to/pdr.md> argument");
    }
    const resolvedPdr = path.resolve(pdrPath);
    const resolvedOut = path.resolve(outputPath ?? deriveDefaultOutputPath(resolvedPdr));
    const resolvedDocs = extraDocs.map((doc) => path.resolve(doc));
    return {
        pdrPath: resolvedPdr,
        extraDocs: resolvedDocs,
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
const extractBullets = (content) => {
    return content
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
const fence = (content, info = "markdown") => {
    return ["```" + info, content.trimEnd(), "```"].join("\n");
};
const readExtraDocs = async (paths) => {
    const docs = [];
    for (const docPath of paths) {
        const content = await fs.readFile(docPath, "utf8");
        docs.push({ path: docPath, content });
    }
    return docs;
};
const buildSdsContent = async (opts, pdrContent) => {
    const now = new Date().toISOString();
    const pdrRel = path.relative(process.cwd(), opts.pdrPath);
    const bullets = extractBullets(pdrContent);
    const extraDocs = await readExtraDocs(opts.extraDocs);
    const extraDocsList = extraDocs.length > 0
        ? extraDocs.map((doc) => `- ${path.relative(process.cwd(), doc.path)}`).join("\n")
        : "- (none provided)";
    const extraDocsAppendix = extraDocs.length === 0
        ? ""
        : extraDocs
            .map((doc, index) => {
            const label = `Appendix ${String.fromCharCode(66 + index)}: ${path.basename(doc.path)}`;
            return [label, "", fence(doc.content), ""].join("\n");
        })
            .join("\n");
    return [
        `# Software Design Specification${opts.title ? `: ${opts.title}` : ""}`,
        "",
        `- Project: ${opts.project}`,
        `- Source PDR: ${pdrRel}`,
        `- Additional docs:`,
        extraDocsList,
        `- Generated: ${now}`,
        "",
        "## 1. Overview",
        "Summarize the product, target users, and success criteria.",
        "",
        "## 2. Goals",
        formatBullets(bullets, "TODO: extract goals from the PDR"),
        "",
        "## 3. Non-Goals",
        "- TODO: explicitly list exclusions.",
        "",
        "## 4. Functional Scope",
        "- TODO: capabilities, flows, acceptance criteria.",
        "",
        "## 5. Architecture & Components",
        "- TODO: proposed architecture, components, data flow.",
        "",
        "## 6. Interfaces & Contracts",
        "- TODO: APIs, inputs/outputs, schemas, OpenAPI references.",
        "",
        "## 7. Non-Functional Requirements",
        "- TODO: performance, reliability, security, compliance.",
        "",
        "## 8. Risks and Mitigations",
        "- TODO: risks carried over from PDR and new ones.",
        "",
        "## 9. Open Questions",
        "- TODO: unresolved questions before implementation.",
        "",
        "## 10. Acceptance Criteria",
        "- TODO: measurable outcomes for sign-off.",
        "",
        "## Appendix A: Source PDR",
        fence(pdrContent),
        "",
        extraDocsAppendix,
    ].join("\n");
};
const ensureParentDirectory = async (targetPath) => {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const pdrContent = await fs.readFile(options.pdrPath, "utf8");
    if (!options.overwrite && (await fileExists(options.outputPath))) {
        throw new Error(`Output already exists: ${options.outputPath}. Re-run with --overwrite to replace it.`);
    }
    await ensureParentDirectory(options.outputPath);
    const content = await buildSdsContent(options, pdrContent);
    await fs.writeFile(options.outputPath, content, "utf8");
    // eslint-disable-next-line no-console
    console.log(`SDS created at ${options.outputPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
