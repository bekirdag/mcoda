#!/usr/bin/env tsx
import { promises as fs } from "node:fs";
import path from "node:path";
const usage = [
    "Usage: npm run openapi:generate -- [--sds docs/sds/sds.md] [--out openapi/mcoda.yaml] [--version <cli-version>]",
    "",
    "Reads the SDS document and produces a minimal OpenAPI stub with provenance metadata (defaults to package.json version).",
].join("\n");
const parseArgs = (argv, defaultVersion) => {
    let sdsPath = path.join(process.cwd(), "docs", "sds", "sds.md");
    let outPath = path.join(process.cwd(), "openapi", "mcoda.yaml");
    let version = defaultVersion;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--sds":
                sdsPath = path.resolve(argv[i + 1] ?? sdsPath);
                i += 1;
                break;
            case "--out":
                outPath = path.resolve(argv[i + 1] ?? outPath);
                i += 1;
                break;
            case "--version":
                version = argv[i + 1] ?? version;
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
    return { sdsPath, outPath, version };
};
const ensureParentDir = async (filePath) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
};
const readPackageVersion = async () => {
    const pkgPath = path.join(process.cwd(), "package.json");
    try {
        const pkgRaw = await fs.readFile(pkgPath, "utf8");
        const pkg = JSON.parse(pkgRaw);
        return pkg.version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
};
const extractDescription = (sdsContent) => {
    const lines = sdsContent.split(/\r?\n/);
    // Grab the first non-heading paragraph to seed the description.
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (trimmed.startsWith("#"))
            continue;
        return trimmed;
    }
    return "Generated from SDS source document.";
};
const buildOpenApi = (desc, opts) => {
    const relSds = path.relative(process.cwd(), opts.sdsPath);
    const generatedAt = new Date().toISOString();
    return [
        "# mcoda OpenAPI spec (generated stub)",
        "# This file is generated from the SDS; edit SDS and re-run openapi:generate.",
        "openapi: 3.1.0",
        "info:",
        "  title: mcoda API",
        `  version: "${opts.version}"`,
        "  description: |",
        `    ${desc}`,
        "    (Source: " + relSds + ")",
        "x-generated-from:",
        `  sdsPath: ${relSds}`,
        `  generatedAt: ${generatedAt}`,
        "paths: {}",
        "components: {}",
        "",
    ].join("\n");
};
const main = async () => {
    const defaultVersion = await readPackageVersion();
    const options = parseArgs(process.argv.slice(2), defaultVersion);
    const sdsContent = await fs.readFile(options.sdsPath, "utf8");
    const desc = extractDescription(sdsContent);
    const spec = buildOpenApi(desc, options);
    await ensureParentDir(options.outPath);
    await fs.writeFile(options.outPath, spec, "utf8");
    // eslint-disable-next-line no-console
    console.log(`OpenAPI spec generated at ${options.outPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
