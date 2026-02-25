import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PathHelper } from "@mcoda/shared";

export type ProjectGuidance = {
  content: string;
  source: string;
  warnings?: string[];
  stale?: boolean;
  projectKey?: string;
  sdsSource?: string;
  sdsSha256?: string;
  generatedAt?: string;
};

export type EnsureProjectGuidanceOptions = {
  mcodaDir?: string;
  force?: boolean;
  template?: string;
  projectKey?: string;
};

export type EnsureProjectGuidanceResult = {
  path: string;
  status: "created" | "existing" | "overwritten";
  warnings?: string[];
  stale?: boolean;
  source?: "default" | "sds" | "custom";
  projectKey?: string;
  sdsSource?: string;
  sdsSha256?: string;
};

export type ProjectGuidanceLoadOptions = {
  projectKey?: string;
};

type GuidanceFrontmatter = {
  mcodaGuidance: boolean;
  projectKey?: string;
  sdsSource?: string;
  sdsSha256?: string;
  generatedAt?: string;
};

type SdsContext = {
  absolutePath: string;
  relativePath: string;
  content: string;
  hash: string;
};

const QA_DOC_PATTERN = /(^|[\\/])(qa|e2e)([-_/]|$)/i;
const MCODA_DOC_PATTERN = /(^|[\\/])\.mcoda([\\/]|$)/i;
const SDS_DOC_PATTERN = /(^|[\\/])docs[\\/]+sds([\\/]|\.|$)/i;
const FRONTMATTER_BLOCK = /^---[\s\S]*?\n---/;
const SDS_NAME_PATTERN =
  /(^|\/)(sds(?:[-_. ][a-z0-9]+)?|software[-_ ]design(?:[-_ ](?:spec|specification|outline|doc))?|design[-_ ]spec(?:ification)?)(\/|[-_.]|$)/i;
const SDS_PATH_HINT_PATTERN =
  /(^|\/)(docs\/sds|sds\/|software[-_ ]design|design[-_ ]spec|requirements|prd|pdr|rfp|architecture|solution[-_ ]design)/i;
const REQUIRED_GUIDANCE_SECTIONS = [
  "Product Context",
  "Architecture Notes",
  "Coding Constraints",
  "Testing Policy",
  "Operational Notes",
];
const PLACEHOLDER_PATTERNS = [
  /\bdescribe the product domain\b/i,
  /\blist important modules\b/i,
  /\bdocument non-negotiable implementation rules\b/i,
  /\bdefine required test levels\b/i,
  /\badd deployment\/runtime constraints\b/i,
];
const FRONTMATTER_TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const TREE_LIKE_PATTERN = /[├└│]|^\s*[./A-Za-z0-9_-]+\/\s*$/m;
const MARKDOWN_FILE_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);
const DIR_SCAN_EXCLUDES = new Set([
  ".git",
  ".svn",
  ".hg",
  ".mcoda",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "coverage",
]);

const DEFAULT_PROJECT_GUIDANCE_TEMPLATE = [
  "# Project Guidance",
  "",
  "This file is loaded by mcoda agents before task execution/review/QA.",
  "SDS is the source of truth. Keep this guidance concrete and implementation-oriented.",
  "",
  "## Product Context",
  "- Align scope and implementation decisions with the latest SDS.",
  "- Prefer product behavior changes over test-only deltas for implementation tasks.",
  "",
  "## Architecture Notes",
  "- Respect existing module/service boundaries and data contracts.",
  "- Keep new interfaces and schemas backward-compatible unless SDS explicitly changes them.",
  "",
  "## Coding Constraints",
  "- Avoid hardcoded environment-specific values (ports, hosts, secrets, file paths).",
  "- Reuse existing code patterns and adapters before adding new abstractions.",
  "",
  "## Testing Policy",
  "- Run targeted tests for touched behavior, then broader suites when required.",
  "- Ensure implementation changes and tests evolve together.",
  "",
  "## Operational Notes",
  "- Preserve observability and runtime configuration conventions already used by the project.",
  "- Document notable rollout risks and mitigation in task summaries.",
  "",
].join("\n");

const normalizePathSeparators = (value: string): string => value.replace(/\\/g, "/");

const dedupe = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizePathSeparators(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(value);
  }
  return output;
};

const normalizeProjectKey = (value?: string): string | undefined => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || undefined;
};

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

const readTextFile = async (targetPath: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return undefined;
  }
};

const trimSection = (value: string, maxLines = 10): string => {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  return lines.slice(0, maxLines).join("\n");
};

const toBullets = (value: string, maxItems = 6): string[] => {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("```"));
  const bullets: string[] = [];
  for (const line of lines) {
    let normalized = line.replace(/^[-*]\s+/, "").trim();
    normalized = normalized.replace(/^\d+\.\s+/, "").trim();
    if (!normalized) continue;
    if (normalized.length > 180) normalized = `${normalized.slice(0, 177)}...`;
    bullets.push(`- ${normalized}`);
    if (bullets.length >= maxItems) break;
  }
  return bullets;
};

const extractFencedTreeBlock = (content: string): string | undefined => {
  const fenceRegex = /```(?:text|md|markdown|tree)?\s*\n([\s\S]*?)\n```/gi;
  for (const match of content.matchAll(fenceRegex)) {
    const block = (match[1] ?? "").trim();
    if (!block) continue;
    if (!TREE_LIKE_PATTERN.test(block)) continue;
    const normalized = block.split(/\r?\n/).slice(0, 40).join("\n").trim();
    if (normalized) return normalized;
  }
  return undefined;
};

const parseHeadingSections = (content: string): Array<{ heading: string; body: string }> => {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = "";
  let currentBody: string[] = [];
  const flush = () => {
    if (!currentHeading) return;
    sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
  };
  for (const line of lines) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (match) {
      flush();
      currentHeading = match[1]?.trim() ?? "";
      currentBody = [];
      continue;
    }
    if (currentHeading) currentBody.push(line);
  }
  flush();
  return sections;
};

const findSectionByHeading = (
  sections: Array<{ heading: string; body: string }>,
  patterns: RegExp[],
): string | undefined => {
  for (const section of sections) {
    const heading = section.heading.trim();
    if (!heading) continue;
    if (patterns.some((pattern) => pattern.test(heading))) {
      const body = trimSection(section.body, 14);
      if (body) return body;
    }
  }
  return undefined;
};

const extractIntroParagraph = (content: string): string | undefined => {
  const stripped = content
    .replace(FRONTMATTER_BLOCK, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = stripped.find((line) => !line.startsWith("#"));
  if (!first) return undefined;
  if (first.length <= 200) return first;
  return `${first.slice(0, 197)}...`;
};

const buildGuidanceFrontmatter = (metadata: {
  projectKey?: string;
  sdsSource?: string;
  sdsSha256?: string;
  generatedAt?: string;
}): string => {
  const lines = ["---", "mcoda_guidance: true"];
  if (metadata.projectKey) lines.push(`project_key: ${metadata.projectKey}`);
  if (metadata.sdsSource) lines.push(`sds_source: ${metadata.sdsSource}`);
  if (metadata.sdsSha256) lines.push(`sds_sha256: ${metadata.sdsSha256}`);
  if (metadata.generatedAt) lines.push(`generated_at: ${metadata.generatedAt}`);
  lines.push("---");
  return lines.join("\n");
};

const parseFrontmatterPairs = (frontmatter: string): Record<string, string> => {
  const lines = frontmatter
    .split(/\r?\n/)
    .slice(1, -1)
    .map((line) => line.trim())
    .filter(Boolean);
  const pairs: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!key) continue;
    pairs[key] = value;
  }
  return pairs;
};

const extractFrontmatter = (content: string): string | undefined => {
  if (!content) return undefined;
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return undefined;
  const match = trimmed.match(FRONTMATTER_BLOCK);
  return match ? match[0] : undefined;
};

const parseGuidanceFrontmatter = (content?: string): GuidanceFrontmatter | undefined => {
  if (!content) return undefined;
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return undefined;
  const pairs = parseFrontmatterPairs(frontmatter);
  const markerValue = (pairs.mcoda_guidance ?? "").toLowerCase();
  const mcodaGuidance = FRONTMATTER_TRUE_VALUES.has(markerValue);
  if (!mcodaGuidance) return undefined;
  return {
    mcodaGuidance,
    projectKey: pairs.project_key || undefined,
    sdsSource: pairs.sds_source || undefined,
    sdsSha256: pairs.sds_sha256 || undefined,
    generatedAt: pairs.generated_at || undefined,
  };
};

const hasSdsFrontmatter = (content?: string): boolean => {
  if (!content) return false;
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return false;
  if (/(doc_type|doctype|docType|type)\s*:\s*sds\b/i.test(frontmatter)) return true;
  if (/(tags?|categories)\s*:\s*\[?[^\n]*\bsds\b/i.test(frontmatter)) return true;
  if (/sds\s*:\s*true/i.test(frontmatter)) return true;
  return false;
};

const listMarkdownFiles = async (root: string, maxDepth = 5): Promise<string[]> => {
  const output: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const relative = normalizePathSeparators(path.relative(root, entryPath));
      if (!relative) continue;
      if (entry.isDirectory()) {
        if (DIR_SCAN_EXCLUDES.has(entry.name)) continue;
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!MARKDOWN_FILE_EXTENSIONS.has(ext)) continue;
      output.push(relative);
    }
  };
  await walk(root, 0);
  return output;
};

const defaultSdsCandidates = (workspaceRoot: string, projectKey?: string): string[] => {
  const slug = normalizeProjectKey(projectKey);
  const candidates = [
    "docs/sds.md",
    "docs/sds/sds.md",
    "docs/sds/index.md",
    "docs/software-design-specification.md",
    "sds.md",
  ];
  if (slug) {
    candidates.unshift(`docs/sds/${slug}.md`);
    candidates.unshift(`docs/${slug}-sds.md`);
  }
  return candidates.map((entry) => normalizePathSeparators(path.join(workspaceRoot, entry)));
};

const scoreSdsPath = (relativePath: string, projectKey?: string): number => {
  const normalized = normalizePathSeparators(relativePath).toLowerCase();
  const fileName = path.basename(normalized);
  const project = normalizeProjectKey(projectKey);
  let score = 0;
  if (normalized === "docs/sds.md") score += 120;
  if (normalized === "docs/sds/sds.md") score += 110;
  if (normalized.startsWith("docs/sds/")) score += 90;
  if (SDS_NAME_PATTERN.test(fileName)) score += 40;
  if (SDS_PATH_HINT_PATTERN.test(normalized)) score += 25;
  if (project && normalized.includes(project)) score += 20;
  return score;
};

const hasSdsContentSignals = (content: string, relativePath: string): boolean => {
  if (SDS_DOC_PATTERN.test(relativePath)) return true;
  if (hasSdsFrontmatter(content)) return true;
  if (/^\s*#\s*(software\s+design\s+specification|sds)\b/im.test(content)) return true;
  if (/\bnon-functional requirements\b/i.test(content)) return true;
  if (/\bfolder tree\b/i.test(content)) return true;
  return false;
};

const findSdsContext = async (workspaceRoot: string, projectKey?: string): Promise<SdsContext | undefined> => {
  const preferred = defaultSdsCandidates(workspaceRoot, projectKey);
  const docsRoot = path.join(workspaceRoot, "docs");
  const markdownFiles = await listMarkdownFiles(docsRoot, 6).catch(() => []);
  const fuzzyAbsolute = markdownFiles
    .filter((file) => SDS_NAME_PATTERN.test(file) || SDS_PATH_HINT_PATTERN.test(file))
    .map((file) => path.join(docsRoot, file));
  const candidates = dedupe([...preferred, ...fuzzyAbsolute]);
  let best: { context: SdsContext; score: number } | undefined;
  for (const absolutePath of candidates) {
    const content = await readTextFile(absolutePath);
    if (!content) continue;
    const relativePath = normalizePathSeparators(path.relative(workspaceRoot, absolutePath));
    let score = scoreSdsPath(relativePath, projectKey);
    if (hasSdsContentSignals(content, relativePath)) score += 50;
    if (score <= 0) continue;
    const context: SdsContext = {
      absolutePath,
      relativePath,
      content,
      hash: sha256(content),
    };
    if (!best || score > best.score) {
      best = { context, score };
    }
  }
  return best?.context;
};

const buildSdsDerivedTemplate = (sds: SdsContext, projectKey?: string): string => {
  const sections = parseHeadingSections(sds.content);
  const intro = extractIntroParagraph(sds.content);
  const productContext =
    findSectionByHeading(sections, [/overview/i, /introduction/i, /scope/i, /goals?/i, /product/i]) ?? intro ?? "";
  const architecture = findSectionByHeading(sections, [/architecture/i, /services?/i, /components?/i, /modules?/i]);
  const constraints = findSectionByHeading(sections, [/constraints?/i, /security/i, /compliance/i, /standards?/i]);
  const testing = findSectionByHeading(sections, [/testing/i, /\bqa\b/i, /verification/i, /validation/i]);
  const operations = findSectionByHeading(
    sections,
    [/operations?/i, /deployment/i, /runbook/i, /observability/i, /monitoring/i],
  );
  const folderSection = findSectionByHeading(sections, [/folder tree/i, /repo structure/i, /project structure/i]);
  const treeBlock = extractFencedTreeBlock(folderSection ?? sds.content);
  const generatedAt = new Date().toISOString();
  const frontmatter = buildGuidanceFrontmatter({
    projectKey: normalizeProjectKey(projectKey),
    sdsSource: sds.relativePath,
    sdsSha256: sds.hash,
    generatedAt,
  });
  const productBullets = toBullets(productContext || `SDS source: ${sds.relativePath}`);
  const architectureBullets = toBullets(
    architecture || "Follow the module and service boundaries specified in the SDS architecture section.",
  );
  const constraintsBullets = toBullets(
    constraints ||
      "Do not add undocumented dependencies. Keep interfaces, schemas, and naming aligned with SDS and OpenAPI artifacts.",
  );
  const testingBullets = toBullets(
    testing ||
      "For every implementation change, update tests that cover behavior and regression risk, then run the smallest relevant suite before broad test runs.",
  );
  const operationsBullets = toBullets(
    operations ||
      "Keep runtime configuration environment-driven, avoid hardcoded ports/hosts, and preserve existing logging/telemetry conventions.",
  );
  const lines = [
    frontmatter,
    "",
    "# Project Guidance",
    "",
    `This guidance is generated from SDS source \`${sds.relativePath}\` and is intended to keep implementation/review/QA aligned.`,
    "",
    "## Product Context",
    ...(productBullets.length > 0 ? productBullets : [`- SDS source: ${sds.relativePath}`]),
    "",
    "## Architecture Notes",
    ...(architectureBullets.length > 0
      ? architectureBullets
      : ["- Follow SDS-defined service boundaries and data contracts."]),
    "",
    "## Coding Constraints",
    ...(constraintsBullets.length > 0
      ? constraintsBullets
      : ["- Match SDS/OpenAPI contracts and avoid introducing undocumented behavior."]),
    "",
    "## Testing Policy",
    ...(testingBullets.length > 0 ? testingBullets : ["- Run targeted tests first, then broader suites where relevant."]),
    "",
    "## Operational Notes",
    ...(operationsBullets.length > 0
      ? operationsBullets
      : ["- Keep runtime settings configurable and align with existing deployment/observability practices."]),
    "",
    "## Folder Tree Baseline",
    treeBlock ? "```text" : `- Refer to folder tree defined in \`${sds.relativePath}\`.`,
    ...(treeBlock ? [treeBlock, "```"] : []),
    "",
  ];
  return lines.join("\n");
};

const validateGuidanceContent = (content: string): string[] => {
  const warnings: string[] = [];
  for (const section of REQUIRED_GUIDANCE_SECTIONS) {
    const matcher = new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "im");
    if (!matcher.test(content)) {
      warnings.push(`missing_section:${section}`);
    }
  }
  for (const placeholder of PLACEHOLDER_PATTERNS) {
    if (placeholder.test(content)) {
      warnings.push("placeholder_text_detected");
      break;
    }
  }
  return warnings;
};

const detectGuidanceStaleness = async (
  workspaceRoot: string,
  content: string,
): Promise<{ stale: boolean; warnings: string[]; metadata?: GuidanceFrontmatter }> => {
  const metadata = parseGuidanceFrontmatter(content);
  if (!metadata) {
    return { stale: false, warnings: [] };
  }
  const warnings: string[] = [];
  if (!metadata.sdsSource || !metadata.sdsSha256) {
    warnings.push("guidance_missing_sds_metadata");
    return { stale: false, warnings, metadata };
  }
  const absoluteSource = path.isAbsolute(metadata.sdsSource)
    ? metadata.sdsSource
    : path.join(workspaceRoot, metadata.sdsSource);
  const sourceContent = await readTextFile(absoluteSource);
  if (!sourceContent) {
    warnings.push(`guidance_sds_source_missing:${metadata.sdsSource}`);
    return { stale: true, warnings, metadata };
  }
  const currentHash = sha256(sourceContent);
  if (currentHash !== metadata.sdsSha256) {
    warnings.push(`guidance_stale_sds_hash:${metadata.sdsSource}`);
    return { stale: true, warnings, metadata };
  }
  return { stale: false, warnings, metadata };
};

const resolveGuidanceTemplate = async (
  workspaceRoot: string,
  options: EnsureProjectGuidanceOptions,
): Promise<{ template: string; source: "default" | "sds" | "custom"; sds?: SdsContext }> => {
  if (options.template && options.template.trim()) {
    return { template: options.template.trim(), source: "custom" };
  }
  const sds = await findSdsContext(workspaceRoot, options.projectKey);
  if (sds) {
    return { template: buildSdsDerivedTemplate(sds, options.projectKey), source: "sds", sds };
  }
  return { template: getDefaultProjectGuidanceTemplate().trim(), source: "default" };
};

export const getDefaultProjectGuidanceTemplate = (): string => DEFAULT_PROJECT_GUIDANCE_TEMPLATE;

export const resolveWorkspaceProjectGuidancePath = (
  workspaceRoot: string,
  mcodaDir?: string,
  projectKey?: string,
): string => {
  const resolvedMcodaDir = mcodaDir ?? PathHelper.getWorkspaceDir(workspaceRoot);
  const normalizedProject = normalizeProjectKey(projectKey);
  if (normalizedProject) {
    return path.join(resolvedMcodaDir, "docs", "projects", normalizedProject, "project-guidance.md");
  }
  return path.join(resolvedMcodaDir, "docs", "project-guidance.md");
};

const guidanceCandidates = (workspaceRoot: string, mcodaDir?: string, projectKey?: string): string[] => {
  const normalizedProject = normalizeProjectKey(projectKey);
  const repoProjectPath = normalizedProject
    ? path.join(workspaceRoot, "docs", "projects", normalizedProject, "project-guidance.md")
    : undefined;
  return dedupe(
    [
      resolveWorkspaceProjectGuidancePath(workspaceRoot, mcodaDir, normalizedProject),
      resolveWorkspaceProjectGuidancePath(workspaceRoot, mcodaDir),
      repoProjectPath,
      path.join(workspaceRoot, "docs", "project-guidance.md"),
    ].filter((entry): entry is string => Boolean(entry)),
  );
};

export const isDocContextExcluded = (value: string | undefined, allowQaDocs = false): boolean => {
  if (!value) return false;
  const normalized = value.replace(/\\/g, "/");
  if (MCODA_DOC_PATTERN.test(normalized)) return true;
  if (!allowQaDocs && QA_DOC_PATTERN.test(normalized)) return true;
  return false;
};

export const normalizeDocType = (params: {
  docType?: string;
  path?: string;
  title?: string;
  content?: string;
}): { docType: string; downgraded: boolean; reason?: string } => {
  const raw = (params.docType ?? "DOC").trim();
  const normalizedType = raw ? raw.toUpperCase() : "DOC";
  if (normalizedType !== "SDS") {
    return { docType: normalizedType || "DOC", downgraded: false };
  }
  const pathValue = params.path ?? params.title ?? "";
  const normalizedPath = pathValue.replace(/\\/g, "/");
  const inSdsPath = SDS_DOC_PATTERN.test(normalizedPath);
  const frontmatter = hasSdsFrontmatter(params.content);
  if (inSdsPath || frontmatter) {
    return { docType: "SDS", downgraded: false };
  }
  const reason = [inSdsPath ? null : "path_not_sds", frontmatter ? null : "frontmatter_missing"].filter(Boolean).join("|");
  return { docType: "DOC", downgraded: true, reason: reason || "not_sds" };
};

export const loadProjectGuidance = async (
  workspaceRoot: string,
  mcodaDir?: string,
  options: ProjectGuidanceLoadOptions = {},
): Promise<ProjectGuidance | null> => {
  const candidates = guidanceCandidates(workspaceRoot, mcodaDir, options.projectKey);
  for (const candidate of candidates) {
    try {
      const content = (await fs.readFile(candidate, "utf8")).trim();
      if (!content) continue;
      const validationWarnings = validateGuidanceContent(content);
      const staleness = await detectGuidanceStaleness(workspaceRoot, content);
      const metadata = staleness.metadata;
      const warnings = [...validationWarnings, ...staleness.warnings];
      return {
        content,
        source: candidate,
        warnings: warnings.length > 0 ? warnings : undefined,
        stale: staleness.stale,
        projectKey: metadata?.projectKey,
        sdsSource: metadata?.sdsSource,
        sdsSha256: metadata?.sdsSha256,
        generatedAt: metadata?.generatedAt,
      };
    } catch {
      // ignore missing file
    }
  }
  console.warn(`[project-guidance] no project guidance found; searched: ${candidates.join(", ")}`);
  return null;
};

export const ensureProjectGuidance = async (
  workspaceRoot: string,
  options: EnsureProjectGuidanceOptions = {},
): Promise<EnsureProjectGuidanceResult> => {
  const normalizedProject = normalizeProjectKey(options.projectKey);
  const targetPath = resolveWorkspaceProjectGuidancePath(workspaceRoot, options.mcodaDir, normalizedProject);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const force = Boolean(options.force);
  const resolvedTemplate = await resolveGuidanceTemplate(workspaceRoot, options);
  const template = resolvedTemplate.template.trim();
  const payload = template.length > 0 ? `${template}\n` : "";
  let existed = false;
  try {
    await fs.access(targetPath);
    existed = true;
  } catch {
    existed = false;
  }

  if (existed && !force) {
    try {
      const existing = (await fs.readFile(targetPath, "utf8")).trim();
      if (existing.length > 0) {
        const validationWarnings = validateGuidanceContent(existing);
        const staleness = await detectGuidanceStaleness(workspaceRoot, existing);
        const warnings = [...validationWarnings, ...staleness.warnings];
        const metadata = staleness.metadata;
        if (staleness.stale && metadata?.mcodaGuidance) {
          await fs.writeFile(targetPath, payload, "utf8");
          return {
            path: targetPath,
            status: "overwritten",
            warnings: warnings.length > 0 ? warnings : undefined,
            stale: true,
            source: resolvedTemplate.source,
            projectKey: normalizedProject,
            sdsSource: resolvedTemplate.sds?.relativePath,
            sdsSha256: resolvedTemplate.sds?.hash,
          };
        }
        return {
          path: targetPath,
          status: "existing",
          warnings: warnings.length > 0 ? warnings : undefined,
          stale: staleness.stale,
          source: metadata?.mcodaGuidance ? "sds" : "custom",
          projectKey: metadata?.projectKey,
          sdsSource: metadata?.sdsSource,
          sdsSha256: metadata?.sdsSha256,
        };
      }
    } catch {
      // fall through and write template
    }
  }

  await fs.writeFile(targetPath, payload, "utf8");
  return {
    path: targetPath,
    status: existed ? "overwritten" : "created",
    source: resolvedTemplate.source,
    projectKey: normalizedProject,
    sdsSource: resolvedTemplate.sds?.relativePath,
    sdsSha256: resolvedTemplate.sds?.hash,
  };
};
