const DIRECT_PATH_TOKEN_PATTERN =
  /(^|[\s`"'([{<])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?=$|[\s`"')\]}>.,;:!?])/g;
const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{1,10}$/i;
const TOP_LEVEL_STRUCTURE_PATTERN = /^[a-z][a-z0-9._-]{1,80}$/i;
const TREE_CHILD_PATTERN = /^((?:[│ ]{4}| {4})*)(?:├── |└── )(.+?)\s*$/;
const NEGATED_PATH_LINE_PATTERN =
  /\b(no|not|never|without|exclude(?:s|d|ing)?|non-goal|out of scope|not part of|outside the .* target layout)\b/i;
const MANAGED_PREFLIGHT_BLOCK_PATTERN =
  /<!--\s*mcoda:sds-preflight:start\s*-->[\s\S]*?<!--\s*mcoda:sds-preflight:end\s*-->\s*/gi;
const SUPPORT_STRUCTURE_ROOTS = new Set(["docs", "fixtures", "policies", "policy", "runbooks", "pdr", "sds"]);
const ACTION_ONLY_PATH_SEGMENTS = new Set([
  "add",
  "browse",
  "create",
  "delete",
  "edit",
  "list",
  "manage",
  "read",
  "remove",
  "submit",
  "update",
  "view",
  "write",
]);
const NON_IMPLEMENTATION_HEADING_PATTERN =
  /\b(software design specification|system design specification|\bsds\b|revision history|table of contents|purpose|scope|definitions?|abbreviations?|glossary|references?|appendix|document control|authors?)\b/i;
const LIKELY_IMPLEMENTATION_HEADING_PATTERN =
  /\b(architecture|runtime|interface|interfaces|entity|entities|service|services|module|modules|component|components|pipeline|workflow|api|endpoint|schema|model|feature|store|database|ingestion|training|inference|ui|frontend|backend|ops|observability|security|deployment|solver|integration|testing|validation|contract|index|mapping|registry|cache|queue|event|job|task|migration|controller|router|policy)\b/i;
const IMPLEMENTATION_PATH_HINT_SEGMENTS = new Set([
  "api",
  "app",
  "apps",
  "bin",
  "cli",
  "cmd",
  "component",
  "components",
  "controller",
  "controllers",
  "data",
  "db",
  "deploy",
  "deployment",
  "deployments",
  "handler",
  "handlers",
  "infra",
  "integration",
  "internal",
  "job",
  "jobs",
  "lib",
  "libs",
  "migration",
  "migrations",
  "model",
  "models",
  "module",
  "modules",
  "ops",
  "page",
  "pages",
  "route",
  "routes",
  "schema",
  "schemas",
  "script",
  "scripts",
  "server",
  "servers",
  "service",
  "services",
  "spec",
  "specs",
  "src",
  "test",
  "tests",
  "ui",
  "web",
  "worker",
  "workers",
]);
const HEADING_NOISE_TOKENS = new Set(["and", "for", "from", "into", "the", "with"]);

const normalizeLineComment = (value: string): string => value.replace(/\s+#.*$/, "").trimEnd();
const unique = (items: string[]): string[] => Array.from(new Set(items.filter(Boolean)));

const stripDecorators = (value: string): string =>
  value
    .replace(/[`*_]/g, " ")
    .replace(/^[\s>:\-[\]().]+/, "")
    .replace(/\s+/g, " ")
    .trim();

const extractHeadingNumberPath = (heading: string): string[] => {
  const match = stripDecorators(heading).match(/^(\d+(?:\.\d+)*)\.?(?:\s+|$)/);
  return (match?.[1] ?? "")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
};

const computeSignalScanLimit = (limit: number): number => {
  if (limit <= 0) return 0;
  return Math.max(limit * 4, limit + 12);
};

export const isStructuredFilePath = (value: string): boolean => FILE_EXTENSION_PATTERN.test(value);

export const stripManagedSdsPreflightBlock = (value: string | undefined): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return value;
  const sanitized = value.replace(MANAGED_PREFLIGHT_BLOCK_PATTERN, "").replace(/\n{3,}/g, "\n\n").trim();
  return sanitized.length > 0 ? sanitized : undefined;
};

export const normalizeHeadingCandidate = (value: string): string => {
  const cleaned = stripDecorators(value).replace(/^\d+(?:\.\d+)*\.?\s+/, "").trim();
  return cleaned.length > 0 ? cleaned : stripDecorators(value);
};

export const headingLooksImplementationRelevant = (heading: string): boolean => {
  const normalized = normalizeHeadingCandidate(heading).toLowerCase();
  if (!normalized || normalized.length < 3) return false;
  if (normalized === "roles" || normalized === "role matrix" || normalized === "actors") return false;
  if (NON_IMPLEMENTATION_HEADING_PATTERN.test(normalized)) return false;
  if (LIKELY_IMPLEMENTATION_HEADING_PATTERN.test(normalized)) return true;
  const sectionMatch = heading.trim().match(/^(\d+)(?:\.\d+)*\.?(?:\s+|$)/);
  if (sectionMatch) {
    const major = Number.parseInt(sectionMatch[1] ?? "", 10);
    if (Number.isFinite(major) && major >= 3) return true;
  }
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9.-]+/g, ""))
    .filter((token) => token.length >= 4 && !HEADING_NOISE_TOKENS.has(token));
  return tokens.length >= 2;
};

export const pruneParentImplementationHeadings = (headings: string[]): string[] => {
  const numbered = headings.map((heading) => ({
    heading,
    numberPath: extractHeadingNumberPath(heading),
  }));
  return headings.filter((heading, index) => {
    const current = numbered[index];
    if (!current || current.numberPath.length === 0) return true;
    return !numbered.some((candidate, candidateIndex) => {
      if (candidateIndex === index) return false;
      if (candidate.numberPath.length <= current.numberPath.length) return false;
      return current.numberPath.every((segment, segmentIndex) => candidate.numberPath[segmentIndex] === segment);
    });
  });
};

export const normalizeStructuredPathToken = (value: string): string | undefined => {
  const raw = value.replace(/\t/g, "    ").replace(/\\/g, "/");
  const hadTrailingSlash = /\/\s*$/.test(raw);
  const normalized = normalizeLineComment(raw)
    .trim()
    .replace(/^[./]+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!normalized) return undefined;
  if (normalized.length > 240) return undefined;
  if (normalized.includes("://")) return undefined;
  if (/[\u0000-\u001f]/.test(normalized)) return undefined;
  if (normalized.includes("...") || normalized.includes("*")) return undefined;
  const parts = normalized
    .replace(/\/+$/, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.some((part) => part === "." || part === "..")) return undefined;
  if (!parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part))) return undefined;
  if (parts.length === 1) {
    const token = parts[0]!;
    if (isStructuredFilePath(token)) return token;
    if (hadTrailingSlash && TOP_LEVEL_STRUCTURE_PATTERN.test(token)) return token;
    return undefined;
  }
  return parts.join("/");
};

export const normalizeFolderEntry = (entry: string): string | undefined =>
  normalizeStructuredPathToken(stripDecorators(entry).replace(/^\.\//, "").replace(/\/+$/, ""));

const extractTreePaths = (content: string, limit: number): string[] => {
  const results: string[] = [];
  const seen = new Set<string>();
  let stack: string[] = [];
  let treeBase: string[] = [];
  const add = (candidate: string | undefined) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    results.push(candidate);
  };

  for (const rawLine of content.split(/\r?\n/)) {
    if (results.length >= limit) break;
    const line = rawLine.replace(/\t/g, "    ");
    const trimmed = line.trim();
    if (!trimmed) {
      stack = [];
      treeBase = [];
      continue;
    }
    if (/^```/.test(trimmed)) {
      stack = [];
      treeBase = [];
      continue;
    }

    const withoutComment = normalizeLineComment(line);
    const childMatch = withoutComment.match(TREE_CHILD_PATTERN);
    if (childMatch) {
      const depth = Math.floor((childMatch[1]?.length ?? 0) / 4);
      const token = normalizeStructuredPathToken(childMatch[2] ?? "");
      if (!token) continue;
      const baseDepth = treeBase.length > 0 ? treeBase.length + depth : depth;
      const base = stack.slice(0, Math.max(0, baseDepth));
      stack = [...base, ...token.split("/")];
      add(stack.join("/"));
      continue;
    }

    const rootToken = normalizeStructuredPathToken(trimmed);
    if (rootToken) {
      stack = rootToken.split("/");
      treeBase = [...stack];
      add(rootToken);
      continue;
    }

    stack = [];
    treeBase = [];
  }

  return results;
};

const lineAtOffset = (content: string, offset: number): string => {
  const start = content.lastIndexOf("\n", offset);
  const end = content.indexOf("\n", offset);
  return content.slice(start === -1 ? 0 : start + 1, end === -1 ? content.length : end);
};

export const extractStructuredPaths = (content: string, limit: number): string[] => {
  if (!content || limit <= 0) return [];
  const sanitizedContent = stripManagedSdsPreflightBlock(content) ?? "";
  if (!sanitizedContent) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    paths.push(candidate);
  };

  for (const treePath of extractTreePaths(sanitizedContent, limit)) {
    add(treePath);
    if (paths.length >= limit) return paths;
  }

  for (const match of sanitizedContent.matchAll(DIRECT_PATH_TOKEN_PATTERN)) {
    const line = typeof match.index === "number" ? lineAtOffset(sanitizedContent, match.index) : "";
    if (NEGATED_PATH_LINE_PATTERN.test(line)) continue;
    const candidate = normalizeStructuredPathToken(match[2] ?? "");
    add(candidate);
    if (paths.length >= limit) break;
  }

  return paths.slice(0, limit);
};

export const extractMarkdownHeadings = (content: string, limit: number): string[] => {
  if (!content || limit <= 0) return [];
  const sanitizedContent = stripManagedSdsPreflightBlock(content) ?? "";
  if (!sanitizedContent) return [];
  const lines = sanitizedContent.split(/\r?\n/);
  const headings: string[] = [];
  const seen = new Set<string>();
  const pushHeading = (rawValue: string | undefined) => {
    const heading = rawValue?.replace(/#+$/, "").replace(/[`*_]/g, "").trim();
    if (!heading) return;
    const normalized = heading.replace(/\s+/g, " ").toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    headings.push(heading);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    const hashHeading = line.match(/^#{1,6}\s+(.+)$/);
    if (hashHeading) {
      pushHeading(hashHeading[1]);
    } else if (
      index + 1 < lines.length &&
      /^[=-]{3,}\s*$/.test((lines[index + 1] ?? "").trim()) &&
      !line.startsWith("-") &&
      !line.startsWith("*")
    ) {
      pushHeading(line);
    } else {
      const numberedHeading = line.match(/^(\d+(?:\.\d+)+)\s+(.+)$/);
      if (numberedHeading) {
        const headingText = `${numberedHeading[1]} ${numberedHeading[2]}`.trim();
        if (/[a-z]/i.test(headingText)) pushHeading(headingText);
      }
    }
    if (headings.length >= limit) break;
  }
  return headings;
};

const looksLikePseudoActionPath = (candidate: string): boolean => {
  if (!candidate || isStructuredFilePath(candidate)) return false;
  const parts = candidate
    .toLowerCase()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return false;
  return parts.every((part) => ACTION_ONLY_PATH_SEGMENTS.has(part));
};

export const folderEntryLooksRepoRelevant = (entry: string): boolean => {
  const normalized = normalizeFolderEntry(entry);
  if (!normalized) return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  if (isStructuredFilePath(normalized)) {
    const root = normalized.split("/")[0]?.toLowerCase();
    return !root || !SUPPORT_STRUCTURE_ROOTS.has(root);
  }
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  if (segments.length < 2) return false;
  const root = segments[0]!;
  if (SUPPORT_STRUCTURE_ROOTS.has(root)) return false;
  if (segments.some((segment) => IMPLEMENTATION_PATH_HINT_SEGMENTS.has(segment))) return true;
  return segments.some((segment) => segment.length >= 3);
};

export const filterImplementationStructuredPaths = (paths: string[]): string[] => {
  const normalized = Array.from(
    new Set(
      paths
        .map((candidate) => normalizeStructuredPathToken(candidate))
        .filter((value): value is string => Boolean(value))
        .filter((candidate) => !looksLikePseudoActionPath(candidate)),
    ),
  );
  const hasImplementationTree = normalized.some((candidate) => {
    const root = candidate.split("/")[0]?.toLowerCase();
    return Boolean(root) && !SUPPORT_STRUCTURE_ROOTS.has(root) && candidate.includes("/");
  });
  return normalized.filter((candidate) => {
    const root = candidate.split("/")[0]?.toLowerCase();
    if (!root) return false;
    if (SUPPORT_STRUCTURE_ROOTS.has(root)) return !hasImplementationTree;
    if (candidate.includes("/")) return true;
    if (isStructuredFilePath(candidate)) return true;
    if (!hasImplementationTree) return true;
    return normalized.some((other) => other !== candidate && other.startsWith(`${candidate}/`));
  });
};

export interface SdsImplementationSignals {
  rawSectionHeadings: string[];
  rawFolderEntries: string[];
  sectionHeadings: string[];
  folderEntries: string[];
  skippedHeadingSignals: number;
  skippedFolderSignals: number;
}

export const collectSdsImplementationSignals = (
  content: string,
  options: { headingLimit: number; folderLimit: number },
): SdsImplementationSignals => {
  const headingScanLimit = computeSignalScanLimit(options.headingLimit);
  const folderScanLimit = computeSignalScanLimit(options.folderLimit);
  const rawSectionHeadings =
    options.headingLimit > 0 ? extractMarkdownHeadings(content, headingScanLimit) : [];
  const filteredSectionHeadings = unique(rawSectionHeadings.filter((heading) => headingLooksImplementationRelevant(heading)));
  const sectionHeadings = unique(
    pruneParentImplementationHeadings(filteredSectionHeadings).map((heading) => normalizeHeadingCandidate(heading)),
  ).slice(0, Math.max(0, options.headingLimit));
  const rawFolderEntries =
    options.folderLimit > 0
      ? unique(filterImplementationStructuredPaths(extractStructuredPaths(content, folderScanLimit)))
      : [];
  const folderEntries = unique(
    rawFolderEntries
      .map((entry) => normalizeFolderEntry(entry))
      .filter((entry): entry is string => Boolean(entry))
      .filter((entry) => folderEntryLooksRepoRelevant(entry)),
  ).slice(0, Math.max(0, options.folderLimit));
  return {
    rawSectionHeadings,
    rawFolderEntries,
    sectionHeadings,
    folderEntries,
    skippedHeadingSignals: Math.max(0, rawSectionHeadings.length - sectionHeadings.length),
    skippedFolderSignals: Math.max(0, rawFolderEntries.length - folderEntries.length),
  };
};
