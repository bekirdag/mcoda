import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
const FALLBACK_CAPABILITIES = {
    "create-tasks": ["plan"],
    "refine-tasks": ["plan"],
    "work-on-tasks": ["code_write"],
    "code-review": ["code_review"],
    "qa-tasks": [],
    "agent-rating": [],
    pdr: ["docdex_query"],
    sds: ["docdex_query"],
    "openapi-from-docs": ["docdex_query"],
    "order-tasks": ["plan"],
    "gateway-agent": ["plan", "docdex_query"],
};
const COMMAND_ALIASES = {
    "create-tasks": ["create_tasks", "create tasks"],
    "refine-tasks": ["refine_tasks", "refine tasks", "refine-task"],
    "work-on-tasks": ["work_on_tasks", "work on tasks"],
    "code-review": ["code_review", "code review"],
    "qa-tasks": ["qa_tasks", "qa tasks"],
    "agent-rating": ["agent_rating", "agent rating"],
    "order-tasks": ["tasks:order", "order_tasks", "tasks order"],
    pdr: ["docs:pdr:generate", "docs-pdr-generate", "pdr-generate", "docs-pdr"],
    sds: ["docs:sds:generate", "docs-sds-generate", "sds-generate", "docs-sds"],
    "openapi-from-docs": ["openapi", "openapi_from_docs", "openapi-from-docs"],
    "gateway-agent": ["gateway", "gateway agent", "gateway_agent"],
};
let cache = null;
const tryResolveOpenapiPath = () => {
    if (process.env.MCODA_OPENAPI_PATH)
        return process.env.MCODA_OPENAPI_PATH;
    const cwdCandidate = path.resolve(process.cwd(), "openapi", "mcoda.yaml");
    if (fs.existsSync(cwdCandidate))
        return cwdCandidate;
    try {
        const here = fileURLToPath(import.meta.url);
        const candidate = path.resolve(here, "../../../../openapi/mcoda.yaml");
        if (fs.existsSync(candidate))
            return candidate;
    }
    catch {
        /* ignore */
    }
    return undefined;
};
const loadOpenapiSpec = () => {
    const openapiPath = tryResolveOpenapiPath();
    if (!openapiPath)
        return undefined;
    try {
        const raw = fs.readFileSync(openapiPath, "utf8");
        return YAML.parse(raw);
    }
    catch {
        return undefined;
    }
};
const normalize = (value) => value.trim().toLowerCase().replace(/[_\s]+/g, "-");
const extractFromSpec = (spec) => {
    const byCommand = new Map();
    const docdexScopes = new Set();
    const qaProfiles = new Set();
    if (!spec) {
        return { byCommand, knownCommands: new Set(), docdexScopes, qaProfiles };
    }
    const ext = spec["x-mcoda-command-capabilities"];
    if (ext) {
        for (const [key, value] of Object.entries(ext)) {
            const canonical = normalize(key);
            const required = Array.isArray(value?.required) ? value.required.map(String) : [];
            byCommand.set(canonical, { required });
        }
    }
    // As a fallback, also scan operations with x-mcoda-cli.name metadata.
    const paths = spec.paths ?? {};
    for (const [, operations] of Object.entries(paths)) {
        for (const op of Object.values(operations)) {
            const docdex = op?.["x-mcoda-docdex-profile"];
            if (docdex) {
                docdexScopes.add(normalize(docdex));
            }
            const cliName = op?.["x-mcoda-cli.name"];
            if (!cliName)
                continue;
            const required = Array.isArray(op?.["x-mcoda-required-capabilities"])
                ? op["x-mcoda-required-capabilities"]
                : [];
            const canonical = normalize(cliName);
            const existing = byCommand.get(canonical);
            byCommand.set(canonical, { required: required.length ? required : existing?.required });
        }
    }
    const knownCommands = new Set(byCommand.keys());
    const docdexExt = spec["x-mcoda-docdex-profiles"];
    if (Array.isArray(docdexExt)) {
        docdexExt.forEach((scope) => docdexScopes.add(normalize(scope)));
    }
    const qaExt = spec["x-mcoda-qa-profiles"];
    if (Array.isArray(qaExt)) {
        qaExt.forEach((profile) => qaProfiles.add(normalize(profile)));
    }
    // If QA profiles are modeled as an enum in components, capture those too.
    const qaEnum = (spec?.components?.schemas?.QaProfileName?.enum ?? []);
    qaEnum.forEach((profile) => qaProfiles.add(normalize(profile)));
    return { byCommand, knownCommands, docdexScopes, qaProfiles };
};
const ensureCache = () => {
    if (cache)
        return cache;
    const spec = loadOpenapiSpec();
    cache = extractFromSpec(spec);
    // Seed fallback commands if spec was missing or incomplete.
    for (const [cmd, caps] of Object.entries(FALLBACK_CAPABILITIES)) {
        const canonical = normalize(cmd);
        if (!cache.byCommand.has(canonical)) {
            cache.byCommand.set(canonical, { required: caps });
        }
        cache.knownCommands.add(canonical);
    }
    return cache;
};
export const canonicalizeCommandName = (commandName) => {
    const normalized = normalize(commandName);
    const { knownCommands } = ensureCache();
    if (knownCommands.has(normalized))
        return normalized;
    for (const [canonical, aliases] of Object.entries(COMMAND_ALIASES)) {
        if (normalize(canonical) === normalized)
            return canonical;
        if (aliases.some((alias) => normalize(alias) === normalized))
            return canonical;
    }
    return normalized;
};
export const getCommandRequiredCapabilities = (commandName) => {
    const canonical = canonicalizeCommandName(commandName);
    const { byCommand } = ensureCache();
    return byCommand.get(canonical)?.required ?? [];
};
export const getKnownCommands = () => {
    const { knownCommands } = ensureCache();
    return Array.from(knownCommands).sort();
};
export const getKnownDocdexScopes = () => {
    const { docdexScopes } = ensureCache();
    return Array.from(docdexScopes).sort();
};
export const getKnownQaProfiles = () => {
    const { qaProfiles } = ensureCache();
    return Array.from(qaProfiles).sort();
};
