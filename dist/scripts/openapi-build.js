#!/usr/bin/env tsx
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
const usage = [
    "Usage: npm run openapi:build -- [--spec openapi/mcoda.yaml] [--out openapi/generated/types/index.ts]",
    "",
    "Parses the OpenAPI spec, extracts x-mcoda metadata, and writes typed DTOs + operation maps.",
].join("\n");
const parseArgs = (argv) => {
    let specPath = path.join(process.cwd(), "openapi", "mcoda.yaml");
    let outPath = path.join(process.cwd(), "openapi", "generated", "types", "index.ts");
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case "--spec":
                specPath = path.resolve(argv[i + 1] ?? specPath);
                i += 1;
                break;
            case "--out":
                outPath = path.resolve(argv[i + 1] ?? outPath);
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
    return { specPath, outPath };
};
const ensureDir = async (filePath) => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
};
const refName = (ref) => ref.split("/").pop() ?? "unknown";
const renderTsType = (schema) => {
    if (!schema)
        return "unknown";
    if (schema.$ref)
        return refName(schema.$ref);
    if (schema.enum && Array.isArray(schema.enum)) {
        return schema.enum.map((v) => (typeof v === "number" ? v : `"${v}"`)).join(" | ");
    }
    switch (schema.type) {
        case "string":
            return "string";
        case "integer":
        case "number":
            return "number";
        case "boolean":
            return "boolean";
        case "array":
            return `${renderTsType(schema.items)}[]`;
        case "object": {
            const props = schema.properties ?? {};
            const required = new Set(schema.required ?? []);
            const lines = Object.entries(props).map(([name, propSchema]) => {
                const optional = required.has(name) ? "" : "?";
                return `${name}${optional}: ${renderTsType(propSchema)};`;
            });
            return lines.length ? `{ ${lines.join(" ")} }` : "Record<string, unknown>";
        }
        default:
            return "unknown";
    }
};
const renderSchema = (name, schema) => {
    if (schema.enum && Array.isArray(schema.enum)) {
        return `export type ${name} = ${renderTsType(schema)};\n`;
    }
    if (schema.type === "object" || schema.properties) {
        const props = schema.properties ?? {};
        const required = new Set(schema.required ?? []);
        const lines = Object.entries(props).map(([propName, propSchema]) => {
            const optional = required.has(propName) ? "" : "?";
            return `  ${propName}${optional}: ${renderTsType(propSchema)};`;
        });
        const body = lines.length ? lines.join("\n") : "  [key: string]: unknown;";
        return [`export interface ${name} {`, body, "}\n"].join("\n");
    }
    if (schema.type === "array") {
        return `export type ${name} = ${renderTsType(schema)};\n`;
    }
    return `export type ${name} = ${renderTsType(schema)};\n`;
};
const buildSchemas = (schemas) => {
    const blocks = [];
    for (const [name, schema] of Object.entries(schemas)) {
        blocks.push(renderSchema(name, schema));
    }
    return blocks.join("\n");
};
const normalizeStringArray = (value) => {
    if (!value)
        return [];
    if (Array.isArray(value))
        return value.map((v) => String(v));
    return [String(value)];
};
const buildOperations = (paths) => {
    const operations = [];
    for (const [pathKey, methods] of Object.entries(paths ?? {})) {
        for (const [method, op] of Object.entries(methods ?? {})) {
            const mcodaLegacy = op["x-mcoda"] ?? {};
            const mcodaCli = op["x-mcoda-cli"] ?? {};
            const mcodaPrompts = op["x-mcoda-prompts"] ?? mcodaLegacy.prompts ?? {};
            const mcodaTools = op["x-mcoda-tools"] ?? mcodaLegacy.tools;
            const mcodaRequiredContext = op["x-mcoda-required-context"] ?? mcodaLegacy.requiredContext;
            const mcodaAgentCaps = op["x-mcoda-agent-capabilities"] ?? mcodaLegacy.agentCapabilities;
            operations.push({
                operationId: op.operationId ?? `${method}:${pathKey}`,
                method: method.toUpperCase(),
                path: pathKey,
                summary: op.summary,
                command: mcodaCli.name ?? mcodaLegacy.command ?? op.operationId ?? `${method}:${pathKey}`,
                lane: mcodaCli.lane ?? mcodaLegacy.lane,
                taskType: mcodaCli.taskType ?? mcodaLegacy.taskType,
                outputShape: mcodaCli.outputShape ?? mcodaLegacy.outputShape,
                tags: normalizeStringArray(op.tags),
                prompts: mcodaPrompts,
                tools: normalizeStringArray(mcodaTools),
                requiredContext: normalizeStringArray(mcodaRequiredContext),
                agentCapabilities: normalizeStringArray(mcodaAgentCaps),
                jobType: op["x-mcoda-job-type"] ?? mcodaLegacy.jobType,
                docdexProfile: op["x-mcoda-docdex-profile"] ?? mcodaLegacy.docdexProfile,
            });
        }
    }
    return operations;
};
const buildOperationsSection = (operations) => {
    const serialized = JSON.stringify(operations, null, 2);
    return [
        "export interface McodaPromptSet { job?: string; character?: string; command?: string; [key: string]: string | undefined; }",
        "export interface McodaOperationMeta {",
        "  operationId: string;",
        "  method: string;",
        "  path: string;",
        "  summary?: string;",
        "  command: string;",
        "  lane?: string;",
        "  taskType?: string;",
        "  outputShape?: string;",
        "  tags: string[];",
        "  prompts: McodaPromptSet;",
        "  tools: string[];",
        "  requiredContext: string[];",
        "  agentCapabilities: string[];",
        "  jobType?: string;",
        "  docdexProfile?: string;",
        "}",
        "",
        `export const mcodaOperations: McodaOperationMeta[] = ${serialized};`,
        "",
        "export type McodaCommand = typeof mcodaOperations[number][\"command\"];",
        "export const mcodaCommands: McodaCommand[] = Array.from(new Set(mcodaOperations.map((op) => op.command))) as McodaCommand[];",
        "export const mcodaOperationByCommand: Record<string, McodaOperationMeta[]> = mcodaOperations.reduce((acc, op) => {",
        "  if (!acc[op.command]) acc[op.command] = [];",
        "  acc[op.command].push(op);",
        "  return acc;",
        "} , {} as Record<string, McodaOperationMeta[]>);",
        "",
    ].join("\n");
};
const buildFile = (schemas, operations) => {
    return [
        "/* eslint-disable */",
        "// AUTO-GENERATED by scripts/openapi-build.ts. DO NOT EDIT.",
        "",
        buildOperationsSection(operations),
        "// Schemas",
        buildSchemas(schemas),
    ].join("\n");
};
const main = async () => {
    const options = parseArgs(process.argv.slice(2));
    const raw = await fs.readFile(options.specPath, "utf8");
    const spec = YAML.parse(raw);
    const operations = buildOperations(spec.paths ?? {});
    const schemas = spec.components?.schemas ?? {};
    const output = buildFile(schemas, operations);
    await ensureDir(options.outPath);
    await fs.writeFile(options.outPath, output, "utf8");
    // eslint-disable-next-line no-console
    console.log(`Generated OpenAPI types at ${options.outPath}`);
};
main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
