import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

type CommandCapabilities = { required?: string[] };

const FALLBACK_CAPABILITIES: Record<string, string[]> = {
  "create-tasks": ["plan"],
  "refine-tasks": ["plan"],
  "work-on-tasks": ["code_write"],
  "code-review": ["code_review"],
  "qa-tasks": ["qa_interpretation"],
  pdr: ["docdex_query"],
  sds: ["docdex_query"],
  "openapi-from-docs": ["docdex_query"],
  "order-tasks": ["plan"],
};

const COMMAND_ALIASES: Record<string, string[]> = {
  "create-tasks": ["create_tasks", "create tasks"],
  "refine-tasks": ["refine_tasks", "refine tasks"],
  "work-on-tasks": ["work_on_tasks", "work on tasks"],
  "code-review": ["code_review", "code review"],
  "qa-tasks": ["qa_tasks", "qa tasks"],
  "order-tasks": ["tasks:order", "order_tasks", "tasks order"],
  pdr: ["docs:pdr:generate", "docs-pdr-generate", "pdr-generate", "docs-pdr"],
  sds: ["docs:sds:generate", "docs-sds-generate", "sds-generate", "docs-sds"],
  "openapi-from-docs": ["openapi", "openapi_from_docs", "openapi-from-docs"],
};

type CommandMetadataCache = {
  byCommand: Map<string, CommandCapabilities>;
  knownCommands: Set<string>;
  docdexScopes: Set<string>;
  qaProfiles: Set<string>;
};

let cache: CommandMetadataCache | null = null;

const tryResolveOpenapiPath = (): string | undefined => {
  if (process.env.MCODA_OPENAPI_PATH) return process.env.MCODA_OPENAPI_PATH;
  const cwdCandidate = path.resolve(process.cwd(), "openapi", "mcoda.yaml");
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = path.resolve(here, "../../../../openapi/mcoda.yaml");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* ignore */
  }
  return undefined;
};

const loadOpenapiSpec = (): any | undefined => {
  const openapiPath = tryResolveOpenapiPath();
  if (!openapiPath) return undefined;
  try {
    const raw = fs.readFileSync(openapiPath, "utf8");
    return YAML.parse(raw);
  } catch {
    return undefined;
  }
};

const normalize = (value: string): string => value.trim().toLowerCase().replace(/[_\s]+/g, "-");

const extractFromSpec = (spec: any): CommandMetadataCache => {
  const byCommand = new Map<string, CommandCapabilities>();
  const docdexScopes = new Set<string>();
  const qaProfiles = new Set<string>();
  if (!spec) {
    return { byCommand, knownCommands: new Set<string>(), docdexScopes, qaProfiles };
  }
  const ext = spec["x-mcoda-command-capabilities"] as Record<string, any> | undefined;
  if (ext) {
    for (const [key, value] of Object.entries(ext)) {
      const canonical = normalize(key);
      const required = Array.isArray((value as any)?.required) ? (value as any).required.map(String) : [];
      byCommand.set(canonical, { required });
    }
  }
  // As a fallback, also scan operations with x-mcoda-cli.name metadata.
  const paths = spec.paths ?? {};
  for (const [, operations] of Object.entries(paths as Record<string, any>)) {
    for (const op of Object.values(operations as Record<string, any>)) {
      const docdex = (op as any)?.["x-mcoda-docdex-profile"] as string | undefined;
      if (docdex) {
        docdexScopes.add(normalize(docdex));
      }
      const cliName = (op as any)?.["x-mcoda-cli.name"] as string | undefined;
      if (!cliName) continue;
      const required = Array.isArray((op as any)?.["x-mcoda-required-capabilities"])
        ? ((op as any)["x-mcoda-required-capabilities"] as string[])
        : [];
      const canonical = normalize(cliName);
      const existing = byCommand.get(canonical);
      byCommand.set(canonical, { required: required.length ? required : existing?.required });
    }
  }
  const knownCommands = new Set(byCommand.keys());

  const docdexExt = spec["x-mcoda-docdex-profiles"] as string[] | undefined;
  if (Array.isArray(docdexExt)) {
    docdexExt.forEach((scope) => docdexScopes.add(normalize(scope)));
  }
  const qaExt = spec["x-mcoda-qa-profiles"] as string[] | undefined;
  if (Array.isArray(qaExt)) {
    qaExt.forEach((profile) => qaProfiles.add(normalize(profile)));
  }
  // If QA profiles are modeled as an enum in components, capture those too.
  const qaEnum = (spec?.components?.schemas?.QaProfileName?.enum ?? []) as string[];
  qaEnum.forEach((profile) => qaProfiles.add(normalize(profile)));

  return { byCommand, knownCommands, docdexScopes, qaProfiles };
};

const ensureCache = (): CommandMetadataCache => {
  if (cache) return cache;
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

export const canonicalizeCommandName = (commandName: string): string => {
  const normalized = normalize(commandName);
  const { knownCommands } = ensureCache();
  if (knownCommands.has(normalized)) return normalized;
  for (const [canonical, aliases] of Object.entries(COMMAND_ALIASES)) {
    if (normalize(canonical) === normalized) return canonical;
    if (aliases.some((alias) => normalize(alias) === normalized)) return canonical;
  }
  return normalized;
};

export const getCommandRequiredCapabilities = (commandName: string): string[] => {
  const canonical = canonicalizeCommandName(commandName);
  const { byCommand } = ensureCache();
  return byCommand.get(canonical)?.required ?? [];
};

export const getKnownCommands = (): string[] => {
  const { knownCommands } = ensureCache();
  return Array.from(knownCommands).sort();
};

export const getKnownDocdexScopes = (): string[] => {
  const { docdexScopes } = ensureCache();
  return Array.from(docdexScopes).sort();
};

export const getKnownQaProfiles = (): string[] => {
  const { qaProfiles } = ensureCache();
  return Array.from(qaProfiles).sort();
};
