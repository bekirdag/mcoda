export type AgentNeed =
  | { type: "docdex.search"; query: string; limit?: number }
  | { type: "docdex.web"; query: string; force_web?: boolean }
  | { type: "docdex.impact"; file: string }
  | { type: "file.read"; path: string }
  | { type: "file.list"; root: string; pattern?: string }
  | { type: "file.diff"; paths?: string[] };

export type AgentRequest = {
  version: "v1";
  role: string;
  request_id: string;
  needs: AgentNeed[];
  context?: {
    summary?: string;
  };
};

export type CodaliResponseResult =
  | { type: "docdex.search"; query: string; hits: unknown[] }
  | { type: "docdex.web"; query: string; results: unknown[] }
  | { type: "docdex.impact"; file: string; inbound: unknown[]; outbound: unknown[] }
  | { type: "file.read"; path: string; content: string }
  | { type: "file.list"; root: string; files: string[] }
  | { type: "file.diff"; paths?: string[]; diff: string }
  | {
      type: "patch.apply_failure";
      error: string;
      patches: string[];
      rollback: { attempted: boolean; ok: boolean; error?: string };
    }
  | {
      type: "critic.result";
      status: "PASS" | "FAIL";
      reasons: string[];
      suggested_fixes?: string[];
      touched_files?: string[];
      plan_targets?: string[];
      guardrail?: {
        disposition: "retryable" | "non_retryable";
        reason_code: string;
      };
    };

export type CodaliResponse = {
  version: "v1";
  request_id: string;
  results: CodaliResponseResult[];
  meta?: {
    repo_root?: string;
    warnings?: string[];
  };
};

export type NormalizedNeed =
  | { tool: "docdex.search"; params: { query: string; limit?: number } }
  | { tool: "docdex.web"; params: { query: string; force_web?: boolean } }
  | { tool: "docdex.impact"; params: { file: string } }
  | { tool: "file.read"; params: { path: string } }
  | { tool: "file.list"; params: { root: string; pattern?: string } }
  | { tool: "file.diff"; params: { paths?: string[] } };

const parseQuotedValue = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseYamlKeyValue = (line: string): { key: string; value: string } | null => {
  const idx = line.indexOf(":");
  if (idx === -1) return null;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  if (!key) return null;
  return { key, value };
};

const coerceNeed = (need: Record<string, string>): AgentNeed => {
  const type = need.type?.trim();
  if (!type) {
    throw new Error("Agent request need missing type");
  }
  if (type === "docdex.search") {
    const query = need.query?.trim();
    if (!query) throw new Error("docdex.search requires query");
    const limit = need.limit ? Number(need.limit) : undefined;
    return { type, query, limit };
  }
  if (type === "docdex.web") {
    const query = need.query?.trim();
    if (!query) throw new Error("docdex.web requires query");
    const force_web = need.force_web === "true";
    return { type, query, force_web };
  }
  if (type === "docdex.impact") {
    const file = need.file?.trim();
    if (!file) throw new Error("docdex.impact requires file");
    return { type, file };
  }
  if (type === "file.read") {
    const path = need.path?.trim();
    if (!path) throw new Error("file.read requires path");
    return { type, path };
  }
  if (type === "file.list") {
    const root = need.root?.trim();
    if (!root) throw new Error("file.list requires root");
    const pattern = need.pattern?.trim();
    return { type, root, pattern: pattern || undefined };
  }
  if (type === "file.diff") {
    const rawPaths = need.paths?.trim();
    const paths = rawPaths
      ? rawPaths
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined;
    return { type, paths };
  }
  throw new Error(`Unsupported need type: ${type}`);
};

export const parseAgentRequest = (input: string): AgentRequest => {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Agent request is empty");
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Partial<AgentRequest>;
    if (!parsed.request_id) throw new Error("Agent request missing request_id");
    if (!parsed.needs || !Array.isArray(parsed.needs) || parsed.needs.length === 0) {
      throw new Error("Agent request needs must be a non-empty array");
    }
    return {
      version: "v1",
      role: parsed.role ?? "unknown",
      request_id: parsed.request_id,
      needs: parsed.needs as AgentNeed[],
      context: parsed.context,
    };
  }

  const lines = trimmed.split(/\r?\n/);
  const header = lines.shift()?.trim();
  if (!header || !/^AGENT_REQUEST\s+v1$/i.test(header)) {
    throw new Error("Agent request missing AGENT_REQUEST v1 header");
  }

  let role = "unknown";
  let request_id = "";
  const needs: AgentNeed[] = [];
  let contextSummary: string | undefined;

  let mode: "none" | "needs" | "context" = "none";
  let currentNeed: Record<string, string> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    if (line.startsWith("needs:")) {
      mode = "needs";
      continue;
    }
    if (line.startsWith("context:")) {
      if (currentNeed) {
        needs.push(coerceNeed(currentNeed));
        currentNeed = null;
      }
      mode = "context";
      continue;
    }

    if (mode === "needs") {
      if (line.trim().startsWith("-")) {
        if (currentNeed) {
          needs.push(coerceNeed(currentNeed));
        }
        currentNeed = {};
        const rest = line.replace(/^\s*-\s*/, "");
        if (rest) {
          const kv = parseYamlKeyValue(rest);
          if (kv) {
            currentNeed[kv.key] = parseQuotedValue(kv.value);
          }
        }
        continue;
      }
      if (currentNeed) {
        const kv = parseYamlKeyValue(line.trim());
        if (kv) {
          currentNeed[kv.key] = parseQuotedValue(kv.value);
        }
        continue;
      }
    }

    if (mode === "context") {
      const kv = parseYamlKeyValue(line.trim());
      if (kv && kv.key === "summary") {
        contextSummary = parseQuotedValue(kv.value);
      }
      continue;
    }

    const kv = parseYamlKeyValue(line.trim());
    if (!kv) continue;
    if (kv.key === "role") role = parseQuotedValue(kv.value);
    if (kv.key === "request_id") request_id = parseQuotedValue(kv.value);
  }

  if (currentNeed) {
    needs.push(coerceNeed(currentNeed));
  }

  if (!request_id) throw new Error("Agent request missing request_id");
  if (needs.length === 0) throw new Error("Agent request needs must be a non-empty array");

  return {
    version: "v1",
    role,
    request_id,
    needs,
    context: contextSummary ? { summary: contextSummary } : undefined,
  };
};

export const normalizeAgentRequest = (request: AgentRequest): NormalizedNeed[] =>
  request.needs.map((need) => {
    if (need.type === "docdex.search") {
      return { tool: "docdex.search", params: { query: need.query, limit: need.limit } };
    }
    if (need.type === "docdex.web") {
      return { tool: "docdex.web", params: { query: need.query, force_web: need.force_web } };
    }
    if (need.type === "docdex.impact") {
      return { tool: "docdex.impact", params: { file: need.file } };
    }
    if (need.type === "file.list") {
      return { tool: "file.list", params: { root: need.root, pattern: need.pattern } };
    }
    if (need.type === "file.diff") {
      return { tool: "file.diff", params: { paths: need.paths } };
    }
    return { tool: "file.read", params: { path: need.path } };
  });
