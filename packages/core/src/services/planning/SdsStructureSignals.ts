const DIRECT_PATH_TOKEN_PATTERN =
  /(^|[\s`"'([{<])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?=$|[\s`"')\]}>.,;:!?])/g;
const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{1,10}$/i;
const TOP_LEVEL_STRUCTURE_PATTERN = /^[a-z][a-z0-9._-]{1,80}$/i;
const TREE_CHILD_PATTERN = /^((?:[│ ]{4}| {4})*)(?:├── |└── )(.+?)\s*$/;
const NEGATED_PATH_LINE_PATTERN =
  /\b(no|not|never|without|exclude(?:s|d|ing)?|non-goal|out of scope|not part of|outside the .* target layout)\b/i;
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

const normalizeLineComment = (value: string): string => value.replace(/\s+#.*$/, "").trimEnd();

export const isStructuredFilePath = (value: string): boolean => FILE_EXTENSION_PATTERN.test(value);

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
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    paths.push(candidate);
  };

  for (const treePath of extractTreePaths(content, limit)) {
    add(treePath);
    if (paths.length >= limit) return paths;
  }

  for (const match of content.matchAll(DIRECT_PATH_TOKEN_PATTERN)) {
    const line = typeof match.index === "number" ? lineAtOffset(content, match.index) : "";
    if (NEGATED_PATH_LINE_PATTERN.test(line)) continue;
    const candidate = normalizeStructuredPathToken(match[2] ?? "");
    add(candidate);
    if (paths.length >= limit) break;
  }

  return paths.slice(0, limit);
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
