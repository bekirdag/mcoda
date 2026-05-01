export type AgentNeed =
  | { type: "docdex.search"; query: string; limit?: number }
  | { type: "docdex.open"; path: string; start_line?: number; end_line?: number; head?: number; clamp?: boolean }
  | { type: "docdex.snippet"; doc_id: string; window?: number }
  | { type: "docdex.symbols"; file: string }
  | { type: "docdex.ast"; file: string; max_nodes?: number }
  | { type: "docdex.web"; query: string; force_web?: boolean }
  | { type: "docdex.impact"; file: string }
  | { type: "docdex.impact_diagnostics"; file?: string; limit?: number; offset?: number }
  | { type: "docdex.tree"; path?: string; max_depth?: number; dirs_only?: boolean; include_hidden?: boolean }
  | { type: "docdex.dag_export"; session_id?: string; format?: "json" | "text" | "dot"; max_nodes?: number }
  | { type: "file.read"; path: string }
  | { type: "file.list"; root: string; pattern?: string }
  | { type: "file.diff"; paths?: string[] }
  | {
      type: "agent.delegate";
      role?: "explorer" | "reviewer" | "worker" | "verifier" | "custom";
      goal: string;
      tools?: string[];
      allowed_paths?: string[];
      write_paths?: string[];
      read_only?: boolean;
      max_steps?: number;
      max_tool_calls?: number;
      timeout_ms?: number;
    };

export type AgentRequest = {
  version: "v1";
  role: string;
  request_id: string;
  needs: AgentNeed[];
  context?: {
    summary?: string;
  };
};

export type ParseAgentRequestOptions = {
  defaultRequestId?: string;
};

export type CodaliResponseResult =
  | { type: "docdex.search"; query: string; hits: unknown[] }
  | { type: "docdex.open"; path: string; content: string }
  | { type: "docdex.snippet"; doc_id: string; content: string }
  | { type: "docdex.symbols"; file: string; symbols: unknown }
  | { type: "docdex.ast"; file: string; nodes: unknown }
  | { type: "docdex.web"; query: string; results: unknown[] }
  | { type: "docdex.impact"; file: string; inbound: unknown[]; outbound: unknown[] }
  | { type: "docdex.impact_diagnostics"; file?: string; diagnostics: unknown }
  | { type: "docdex.tree"; tree: string }
  | { type: "docdex.dag_export"; session_id: string; format?: "json" | "text" | "dot"; content: unknown }
  | { type: "file.read"; path: string; content: string }
  | { type: "file.list"; root: string; files: string[] }
  | { type: "file.diff"; paths?: string[]; diff: string }
  | { type: "agent.delegate"; role: string; goal: string; results: unknown[] }
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
      high_confidence?: boolean;
      verification?: {
        schema_version: 1;
        outcome: "verified_passed" | "verified_failed" | "unverified_with_reason";
        reason_codes: string[];
        policy: {
          policy_name: string;
          minimum_checks: number;
          enforce_high_confidence: boolean;
        };
        checks: unknown[];
        totals: {
          configured: number;
          runnable: number;
          attempted: number;
          passed: number;
          failed: number;
          unverified: number;
        };
        touched_files?: string[];
        language_signals?: string[];
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
  | {
      tool: "docdex.open";
      params: { path: string; start_line?: number; end_line?: number; head?: number; clamp?: boolean };
    }
  | { tool: "docdex.snippet"; params: { doc_id: string; window?: number } }
  | { tool: "docdex.symbols"; params: { file: string } }
  | { tool: "docdex.ast"; params: { file: string; max_nodes?: number } }
  | { tool: "docdex.web"; params: { query: string; force_web?: boolean } }
  | { tool: "docdex.impact"; params: { file: string } }
  | { tool: "docdex.impact_diagnostics"; params: { file?: string; limit?: number; offset?: number } }
  | {
      tool: "docdex.tree";
      params: { path?: string; max_depth?: number; dirs_only?: boolean; include_hidden?: boolean };
    }
  | {
      tool: "docdex.dag_export";
      params: { session_id?: string; format?: "json" | "text" | "dot"; max_nodes?: number };
    }
  | { tool: "file.read"; params: { path: string } }
  | { tool: "file.list"; params: { root: string; pattern?: string } }
  | { tool: "file.diff"; params: { paths?: string[] } }
  | {
      tool: "agent.delegate";
      params: {
        role: "explorer" | "reviewer" | "worker" | "verifier" | "custom";
        goal: string;
        tools?: string[];
        allowed_paths?: string[];
        write_paths?: string[];
        read_only?: boolean;
        max_steps?: number;
        max_tool_calls?: number;
        timeout_ms?: number;
      };
    };

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

const parseOptionalNumber = (value?: string): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseOptionalBoolean = (value?: string): boolean | undefined => {
  if (value === undefined) return undefined;
  return value.trim().toLowerCase() === "true";
};

const parseOptionalStringList = (value?: string): string[] | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  const parsed = normalized
    .split(",")
    .map((entry) => parseQuotedValue(entry.trim()))
    .filter(Boolean);
  return parsed.length ? parsed : undefined;
};

const coerceNeed = (need: Record<string, string>): AgentNeed => {
  const type = need.type?.trim();
  if (!type) {
    throw new Error("Agent request need missing type");
  }
  if (type === "docdex.search") {
    const query = need.query?.trim();
    if (!query) throw new Error("docdex.search requires query");
    const limit = parseOptionalNumber(need.limit);
    return { type, query, limit };
  }
  if (type === "docdex.open") {
    const path = need.path?.trim();
    if (!path) throw new Error("docdex.open requires path");
    const start_line = parseOptionalNumber(need.start_line);
    const end_line = parseOptionalNumber(need.end_line);
    const head = parseOptionalNumber(need.head);
    const clamp = parseOptionalBoolean(need.clamp);
    return { type, path, start_line, end_line, head, clamp };
  }
  if (type === "docdex.snippet") {
    const doc_id = need.doc_id?.trim();
    if (!doc_id) throw new Error("docdex.snippet requires doc_id");
    const window = parseOptionalNumber(need.window);
    return { type, doc_id, window };
  }
  if (type === "docdex.symbols") {
    const file = need.file?.trim();
    if (!file) throw new Error("docdex.symbols requires file");
    return { type, file };
  }
  if (type === "docdex.ast") {
    const file = need.file?.trim();
    if (!file) throw new Error("docdex.ast requires file");
    const max_nodes = parseOptionalNumber(need.max_nodes);
    return { type, file, max_nodes };
  }
  if (type === "docdex.web") {
    const query = need.query?.trim();
    if (!query) throw new Error("docdex.web requires query");
    const force_web = parseOptionalBoolean(need.force_web);
    return { type, query, force_web };
  }
  if (type === "docdex.impact") {
    const file = need.file?.trim();
    if (!file) throw new Error("docdex.impact requires file");
    return { type, file };
  }
  if (type === "docdex.impact_diagnostics") {
    const file = need.file?.trim();
    const limit = parseOptionalNumber(need.limit);
    const offset = parseOptionalNumber(need.offset);
    return { type, file: file || undefined, limit, offset };
  }
  if (type === "docdex.tree") {
    const path = need.path?.trim();
    const max_depth = parseOptionalNumber(need.max_depth);
    const dirs_only = parseOptionalBoolean(need.dirs_only);
    const include_hidden = parseOptionalBoolean(need.include_hidden);
    return { type, path: path || undefined, max_depth, dirs_only, include_hidden };
  }
  if (type === "docdex.dag_export") {
    const session_id = need.session_id?.trim();
    const formatValue = need.format?.trim();
    const format =
      formatValue && ["json", "text", "dot"].includes(formatValue)
        ? (formatValue as "json" | "text" | "dot")
        : undefined;
    if (formatValue && !format) {
      throw new Error("docdex.dag_export format must be json, text, or dot");
    }
    const max_nodes = parseOptionalNumber(need.max_nodes);
    return { type, session_id: session_id || undefined, format, max_nodes };
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
  if (type === "agent.delegate") {
    const goal = need.goal?.trim();
    if (!goal) throw new Error("agent.delegate requires goal");
    const roleValue = need.role?.trim();
    const role =
      roleValue && ["explorer", "reviewer", "worker", "verifier", "custom"].includes(roleValue)
        ? (roleValue as "explorer" | "reviewer" | "worker" | "verifier" | "custom")
        : undefined;
    if (roleValue && !role) {
      throw new Error("agent.delegate role must be explorer, reviewer, worker, verifier, or custom");
    }
    return {
      type,
      role,
      goal,
      tools: parseOptionalStringList(need.tools),
      allowed_paths: parseOptionalStringList(need.allowed_paths),
      write_paths: parseOptionalStringList(need.write_paths),
      read_only: parseOptionalBoolean(need.read_only),
      max_steps: parseOptionalNumber(need.max_steps),
      max_tool_calls: parseOptionalNumber(need.max_tool_calls),
      timeout_ms: parseOptionalNumber(need.timeout_ms),
    };
  }
  throw new Error(`Unsupported need type: ${type}`);
};

export const parseAgentRequest = (input: string, options: ParseAgentRequestOptions = {}): AgentRequest => {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Agent request is empty");
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Partial<AgentRequest>;
    if (!parsed.request_id && !options.defaultRequestId) throw new Error("Agent request missing request_id");
    if (!parsed.needs || !Array.isArray(parsed.needs) || parsed.needs.length === 0) {
      throw new Error("Agent request needs must be a non-empty array");
    }
    return {
      version: "v1",
      role: parsed.role ?? "unknown",
      request_id: parsed.request_id ?? options.defaultRequestId!,
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
    const trimmedLine = line.trim();
    const isTopLevel = !/^\s/.test(rawLine);

    if (trimmedLine.startsWith("needs:")) {
      mode = "needs";
      continue;
    }
    if (trimmedLine.startsWith("context:")) {
      if (currentNeed) {
        needs.push(coerceNeed(currentNeed));
        currentNeed = null;
      }
      mode = "context";
      continue;
    }

    if (isTopLevel) {
      const kv = parseYamlKeyValue(trimmedLine);
      if (kv && (kv.key === "role" || kv.key === "request_id")) {
        if (currentNeed) {
          needs.push(coerceNeed(currentNeed));
          currentNeed = null;
        }
        if (kv.key === "role") role = parseQuotedValue(kv.value);
        if (kv.key === "request_id") request_id = parseQuotedValue(kv.value);
        continue;
      }
    }

    if (mode === "needs") {
      if (trimmedLine.startsWith("-")) {
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
        const kv = parseYamlKeyValue(trimmedLine);
        if (kv) {
          currentNeed[kv.key] = parseQuotedValue(kv.value);
        }
        continue;
      }
    }

    if (mode === "context") {
      const kv = parseYamlKeyValue(trimmedLine);
      if (kv && kv.key === "summary") {
        contextSummary = parseQuotedValue(kv.value);
      }
      continue;
    }

    const kv = parseYamlKeyValue(trimmedLine);
    if (!kv) continue;
    if (kv.key === "role") role = parseQuotedValue(kv.value);
    if (kv.key === "request_id") request_id = parseQuotedValue(kv.value);
  }

  if (currentNeed) {
    needs.push(coerceNeed(currentNeed));
  }

  if (!request_id) {
    if (!options.defaultRequestId) throw new Error("Agent request missing request_id");
    request_id = options.defaultRequestId;
  }
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
    if (need.type === "docdex.open") {
      return {
        tool: "docdex.open",
        params: {
          path: need.path,
          start_line: need.start_line,
          end_line: need.end_line,
          head: need.head,
          clamp: need.clamp,
        },
      };
    }
    if (need.type === "docdex.snippet") {
      return { tool: "docdex.snippet", params: { doc_id: need.doc_id, window: need.window } };
    }
    if (need.type === "docdex.symbols") {
      return { tool: "docdex.symbols", params: { file: need.file } };
    }
    if (need.type === "docdex.ast") {
      return { tool: "docdex.ast", params: { file: need.file, max_nodes: need.max_nodes } };
    }
    if (need.type === "docdex.web") {
      return { tool: "docdex.web", params: { query: need.query, force_web: need.force_web } };
    }
    if (need.type === "docdex.impact") {
      return { tool: "docdex.impact", params: { file: need.file } };
    }
    if (need.type === "docdex.impact_diagnostics") {
      return {
        tool: "docdex.impact_diagnostics",
        params: { file: need.file, limit: need.limit, offset: need.offset },
      };
    }
    if (need.type === "docdex.tree") {
      return {
        tool: "docdex.tree",
        params: {
          path: need.path,
          max_depth: need.max_depth,
          dirs_only: need.dirs_only,
          include_hidden: need.include_hidden,
        },
      };
    }
    if (need.type === "docdex.dag_export") {
      return {
        tool: "docdex.dag_export",
        params: { session_id: need.session_id, format: need.format, max_nodes: need.max_nodes },
      };
    }
    if (need.type === "file.list") {
      return { tool: "file.list", params: { root: need.root, pattern: need.pattern } };
    }
    if (need.type === "file.diff") {
      return { tool: "file.diff", params: { paths: need.paths } };
    }
    if (need.type === "agent.delegate") {
      return {
        tool: "agent.delegate",
        params: {
          role: need.role ?? "explorer",
          goal: need.goal,
          tools: need.tools,
          allowed_paths: need.allowed_paths,
          write_paths: need.write_paths,
          read_only: need.read_only,
          max_steps: need.max_steps,
          max_tool_calls: need.max_tool_calls,
          timeout_ms: need.timeout_ms,
        },
      };
    }
    return { tool: "file.read", params: { path: need.path } };
  });
