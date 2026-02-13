import path from "node:path";
import { promises as fs } from "node:fs";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import {
  DocArtifactKind,
  DocArtifactRecord,
  DocArtifactVariant,
  DocgenArtifactInventory,
} from "./DocgenRunContext.js";

export type BuildDocInventoryInput = {
  workspace: WorkspaceResolution;
  preferred?: { pdrPath?: string; sdsPath?: string };
};

const META_SUFFIX = ".meta.json";
const DRAFT_SUFFIX = "-first-draft.md";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
const JSON_EXTENSIONS = new Set([".json"]);
const SQL_EXTENSIONS = new Set([".sql"]);
const ENV_EXTENSIONS = new Set([".env"]);
const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
]);

const shouldIgnoreFile = (filePath: string): boolean => {
  const baseName = path.basename(filePath);
  if (baseName.endsWith(META_SUFFIX)) return true;
  if (baseName.endsWith(DRAFT_SUFFIX)) return true;
  return false;
};

const normalizePath = (filePath: string): string => path.resolve(filePath);

const isMarkdown = (filePath: string): boolean => MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());

const isYamlOrJson = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase();
  return YAML_EXTENSIONS.has(ext) || JSON_EXTENSIONS.has(ext);
};

const isSql = (filePath: string): boolean => SQL_EXTENSIONS.has(path.extname(filePath).toLowerCase());

const isEnvExample = (filePath: string): boolean =>
  path.basename(filePath).toLowerCase() === ".env.example" ||
  (ENV_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && filePath.toLowerCase().endsWith(".env.example"));

const matchesSegment = (filePath: string, segment: string): boolean => {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return normalized.includes(`/${segment}/`);
};

const isPdrPath = (filePath: string): boolean => {
  if (!isMarkdown(filePath)) return false;
  return /(^|[\\/._-])pdr([\\/._-]|$)/i.test(filePath);
};

const isSdsPath = (filePath: string): boolean => {
  if (!isMarkdown(filePath)) return false;
  return /(^|[\\/._-])sds([\\/._-]|$)/i.test(filePath);
};

const isOpenApiPath = (filePath: string): boolean => {
  if (!isYamlOrJson(filePath)) return false;
  return /openapi/i.test(filePath) || matchesSegment(filePath, "openapi");
};

const getOpenApiVariant = (filePath: string): DocArtifactVariant => {
  const lower = filePath.toLowerCase();
  if (/(^|[\\/._-])admin([\\/._-]|$)/.test(lower)) return "admin";
  return "primary";
};

const isDeploymentPath = (filePath: string): boolean => {
  const lower = filePath.toLowerCase();
  if (lower.includes("docker-compose")) return true;
  if (lower.endsWith("kustomization.yaml") || lower.endsWith("kustomization.yml")) return true;
  if (matchesSegment(filePath, "deploy") || matchesSegment(filePath, "deployment")) return true;
  if (matchesSegment(filePath, "infra") || matchesSegment(filePath, "k8s")) return true;
  if (isEnvExample(filePath)) return true;
  return false;
};

const collectFilesRecursively = async (target: string): Promise<string[]> => {
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) return [target];
  const entries = await fs.readdir(target, { withFileTypes: true });
  const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
  const results: string[] = [];
  for (const entry of sorted) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      results.push(...(await collectFilesRecursively(entryPath)));
    } else {
      results.push(entryPath);
    }
  }
  return results;
};

const readMetaIfExists = async (filePath: string): Promise<{
  docdexId?: string;
  segments?: string[];
  projectKey?: string;
}> => {
  const metaPath = `${filePath}${META_SUFFIX}`;
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      docdexId: typeof parsed.docdexId === "string" ? parsed.docdexId : undefined,
      segments: Array.isArray(parsed.segments)
        ? parsed.segments.filter((item) => typeof item === "string") as string[]
        : undefined,
      projectKey: typeof parsed.projectKey === "string" ? parsed.projectKey : undefined,
    };
  } catch {
    return {};
  }
};

const buildRecord = async (
  kind: DocArtifactKind,
  filePath: string,
  variant?: DocArtifactVariant,
): Promise<DocArtifactRecord> => {
  const stat = await fs.stat(filePath);
  const meta = await readMetaIfExists(filePath);
  return {
    kind,
    path: filePath,
    variant,
    meta: {
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      docdexId: meta.docdexId,
      segments: meta.segments,
      projectKey: meta.projectKey,
    },
  };
};

const sortByPath = <T extends { path: string }>(items: T[]): T[] =>
  items.slice().sort((a, b) => a.path.localeCompare(b.path));

const pickPreferred = (items: DocArtifactRecord[], preferredPath?: string): DocArtifactRecord | undefined => {
  if (preferredPath) {
    const normalizedPreferred = normalizePath(preferredPath);
    const match = items.find((item) => normalizePath(item.path) === normalizedPreferred);
    if (match) return match;
  }
  const sorted = sortByPath(items);
  return sorted[0];
};

const pickSql = (items: DocArtifactRecord[]): DocArtifactRecord | undefined => {
  if (items.length === 0) return undefined;
  const schema = items.find((item) => path.basename(item.path).toLowerCase() === "schema.sql");
  return schema ?? sortByPath(items)[0];
};

const resolveCandidates = async (workspace: WorkspaceResolution): Promise<string[]> => {
  const workspaceRoot = workspace.workspaceRoot;
  const candidates = [
    path.join(workspace.mcodaDir, "docs"),
    path.join(workspaceRoot, "docs"),
    path.join(workspaceRoot, "openapi"),
    path.join(workspaceRoot, "openapi.yaml"),
    path.join(workspaceRoot, "openapi.yml"),
    path.join(workspaceRoot, "openapi.json"),
    path.join(workspaceRoot, "sql"),
    path.join(workspaceRoot, "db"),
    path.join(workspaceRoot, "schema.sql"),
    path.join(workspaceRoot, "deploy"),
    path.join(workspaceRoot, "deployment"),
    path.join(workspaceRoot, "infra"),
    path.join(workspaceRoot, "k8s"),
    path.join(workspaceRoot, "docker-compose.yml"),
    path.join(workspaceRoot, "docker-compose.yaml"),
    path.join(workspaceRoot, ".env.example"),
  ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() || stat.isDirectory()) {
        existing.push(candidate);
      }
    } catch {
      // skip missing candidates
    }
  }
  return existing;
};

export const buildDocInventory = async (input: BuildDocInventoryInput): Promise<DocgenArtifactInventory> => {
  const candidates = await resolveCandidates(input.workspace);
  const files: string[] = [];
  for (const candidate of candidates) {
    const collected = await collectFilesRecursively(candidate);
    files.push(...collected);
  }
  const uniqueFiles = Array.from(new Set(files))
    .filter((filePath) => !shouldIgnoreFile(filePath))
    .filter((filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      return (
        MARKDOWN_EXTENSIONS.has(ext) ||
        YAML_EXTENSIONS.has(ext) ||
        JSON_EXTENSIONS.has(ext) ||
        SQL_EXTENSIONS.has(ext) ||
        isEnvExample(filePath)
      );
    })
    .sort((a, b) => a.localeCompare(b));

  const pdrRecords: DocArtifactRecord[] = [];
  const sdsRecords: DocArtifactRecord[] = [];
  const openapiRecords: DocArtifactRecord[] = [];
  const sqlRecords: DocArtifactRecord[] = [];
  const blueprintRecords: DocArtifactRecord[] = [];

  for (const filePath of uniqueFiles) {
    if (isPdrPath(filePath)) {
      pdrRecords.push(await buildRecord("pdr", filePath));
      continue;
    }
    if (isSdsPath(filePath)) {
      sdsRecords.push(await buildRecord("sds", filePath));
      continue;
    }
    if (isOpenApiPath(filePath)) {
      openapiRecords.push(await buildRecord("openapi", filePath, getOpenApiVariant(filePath)));
      continue;
    }
    if (isSql(filePath)) {
      sqlRecords.push(await buildRecord("sql", filePath));
      continue;
    }
    if (isDeploymentPath(filePath)) {
      blueprintRecords.push(await buildRecord("deployment", filePath));
    }
  }

  return {
    pdr: pickPreferred(pdrRecords, input.preferred?.pdrPath),
    sds: pickPreferred(sdsRecords, input.preferred?.sdsPath),
    openapi: sortByPath(openapiRecords),
    sql: pickSql(sqlRecords),
    blueprints: sortByPath(blueprintRecords),
  };
};
