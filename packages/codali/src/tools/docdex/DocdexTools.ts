import type { ToolDefinition } from "../ToolTypes.js";
import type { DocdexClient } from "../../docdex/DocdexClient.js";
import { createDocdexCatalogTools } from "./DocdexCatalogTools.js";

const toOutput = (payload: unknown): { output: string; data: unknown } => ({
  output: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
  data: payload,
});

/**
 * Docdex tools that mutate state (index, memory, profile, repo binding). Every
 * other docdex tool is read-only. Listed as the exception set so a newly added
 * read tool is safe by default and a newly added write tool must be declared.
 */
const DOCDEX_WRITE_TOOLS = new Set([
  "docdex_initialize",
  "docdex_index_rebuild",
  "docdex_index_ingest",
  "docdex_memory_save",
  "docdex_save_preference",
  "docdex_delegate",
  "docdex_diary_write",
]);

/**
 * Docdex is one capability from the orchestrator's point of view, except web
 * research, which is a distinct capability ("current external information")
 * even though docdex happens to serve it.
 */
const docdexCapabilityFor = (name: string): string =>
  name === "docdex_web_research" ? "web" : "docdex";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Whether a docdex search payload actually returned anything usable. Docdex
 * answers with `hits: []` rather than an error when the index has no match, so
 * an empty result is a normal outcome that the waterfall must recognize.
 */
const hasSearchHits = (payload: unknown): boolean => {
  if (!isRecord(payload)) return false;
  for (const key of ["hits", "results", "matches"]) {
    const value = payload[key];
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
};

/**
 * Whether a forced-web search actually discovered anything.
 *
 * Docdex reports web findings under `webDiscovery.discovery.results` and leaves
 * `hits` empty until the fetched pages are indexed, so judging a web result by
 * `hits` alone throws away everything it just found.
 */
const hasWebFindings = (payload: unknown): boolean => {
  if (hasSearchHits(payload)) return true;
  if (!isRecord(payload)) return false;
  const discovery = isRecord(payload.webDiscovery) ? payload.webDiscovery : undefined;
  if (!discovery) return false;
  const inner = isRecord(discovery.discovery) ? discovery.discovery : undefined;
  const results = inner?.results ?? discovery.results;
  if (Array.isArray(results) && results.length > 0) return true;
  const fetches = discovery.fetches;
  return Array.isArray(fetches) && fetches.length > 0;
};

/**
 * Rewrites a path into the repo-relative form docdex accepts.
 *
 * Docdex answers `invalid path` for a leading slash, a `./` prefix, or an
 * absolute path, and a model asked to list a repository reaches for exactly
 * those. That took out every "which files are in X" question: the tool was
 * chosen correctly and then rejected on a formatting detail. Normalising here
 * is the adapter's job — the caller meant the same directory either way.
 *
 * Returns undefined for "the whole repository", which is what docdex wants when
 * no path is given.
 */
export const toRepoRelativePath = (
  value: string | undefined,
  workspaceRoot?: string,
): string | undefined => {
  if (typeof value !== "string") return undefined;
  let candidate = value.trim();
  if (!candidate || candidate === "." || candidate === "./" || candidate === "/") {
    return undefined;
  }
  if (workspaceRoot && candidate.startsWith(workspaceRoot)) {
    candidate = candidate.slice(workspaceRoot.length);
  }
  candidate = candidate.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  return candidate || undefined;
};

/**
 * Stops paying for a quota that is already spent.
 *
 * Web discovery is metered upstream. When the provider answers 402 — or 401,
 * 403, 429 — the answer will not change for the next caller, but nothing
 * remembered that: every question kept asking, and each question asks more than
 * once, because a search that finds nothing locally falls through to the web
 * and a cache hit with no content is retried uncached. Measured upstream at
 * roughly 366 attempts in two hours, about 4,400 a day, which empties a monthly
 * allowance of 5,000 in a little over a day.
 *
 * So the first refusal opens the circuit for everyone until it is due to close.
 * `Retry-After` decides when, since the provider knows and we are guessing;
 * the fallback is deliberately short, because staying closed too long is a
 * self-inflicted outage and reopening early costs one wasted call.
 */
/**
 * Two kinds of refusal, and they deserve different patience.
 *
 * A spent quota or a rejected credential will still be spent and still be
 * rejected in a minute, so the sensible default is long. A rate limit or a
 * service restarting is over in seconds, and blocking for a quarter of an hour
 * because a container was recreated would turn a blip into an outage of our
 * own making.
 *
 * `Retry-After` overrides both, because the provider knows and we are guessing.
 * The upstream gateway now answers a cold start with 503 and a `Retry-After`
 * rather than a bodyless 502, which is precisely the case this handles.
 */
const WEB_EXHAUSTED_STATUSES = new Set([401, 402, 403]);
const WEB_TRANSIENT_STATUSES = new Set([429, 503]);
const DEFAULT_WEB_BACKOFF_MS = 15 * 60_000;
const TRANSIENT_WEB_BACKOFF_MS = 30_000;
const MAX_WEB_BACKOFF_MS = 60 * 60_000;

let webUnavailableUntilMs = 0;
let webUnavailableReason = "";

/** Test seam: forget any open circuit. */
export const resetWebResearchBackoff = (): void => {
  webUnavailableUntilMs = 0;
  webUnavailableReason = "";
};

const retryAfterMsFrom = (error: unknown): number | undefined => {
  const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
  const raw =
    details?.retry_after_ms ??
    details?.retryAfterMs ??
    details?.["retry-after"] ??
    details?.retryAfter;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    // Seconds or milliseconds, depending on who wrote it.
    return raw < 10_000 ? raw * 1000 : raw;
  }
  if (typeof raw === "string") {
    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return undefined;
};

const webRefusalStatus = (error: unknown): number | undefined => {
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  if (status === undefined) return undefined;
  return WEB_EXHAUSTED_STATUSES.has(status) || WEB_TRANSIENT_STATUSES.has(status)
    ? status
    : undefined;
};

const isWebQuotaRefusal = (error: unknown): boolean => webRefusalStatus(error) !== undefined;

const noteWebRefusal = (error: unknown): void => {
  const status = webRefusalStatus(error);
  const fallback = status !== undefined && WEB_TRANSIENT_STATUSES.has(status)
    ? TRANSIENT_WEB_BACKOFF_MS
    : DEFAULT_WEB_BACKOFF_MS;
  const backoff = Math.min(retryAfterMsFrom(error) ?? fallback, MAX_WEB_BACKOFF_MS);
  webUnavailableUntilMs = Date.now() + backoff;
  webUnavailableReason =
    `provider returned ${status ?? "unknown"}; not retrying for ` +
    (backoff < 60_000 ? `${Math.round(backoff / 1000)}s` : `${Math.round(backoff / 60_000)}m`);
};

const webResearchBlocked = (): string | undefined =>
  Date.now() < webUnavailableUntilMs ? webUnavailableReason : undefined;

/**
 * Normalises a query before it costs a metered request.
 *
 * The schema asks for a string and a model can satisfy that with whitespace, or
 * with a whole paragraph of pasted context. Both are rejected upstream, and a
 * rejected request still spends the allowance: measured at the gateway, a third
 * of an hour's traffic was 400s rather than answers.
 *
 * A search query is a phrase. Beyond a couple of hundred characters it is not a
 * query any more, and the useful part is at the front.
 */
const MAX_WEB_QUERY_CHARS = 400;

export const normalizeWebQuery = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > MAX_WEB_QUERY_CHARS
    ? collapsed.slice(0, MAX_WEB_QUERY_CHARS).trimEnd()
    : collapsed;
};

/** Keep web evidence readable inside the smallest native inspection result cap. */
const MAX_WEB_OUTPUT_CHARS = 3_800;

/** Preserve discovery links without treating an unvisited result as fetched evidence. */
const toWebResearchOutput = (payload: unknown): unknown => {
  if (!isRecord(payload) || !isRecord(payload.webDiscovery)) return payload;
  const discovery = payload.webDiscovery;
  const inner = isRecord(discovery.discovery) ? discovery.discovery : discovery;
  const fetches = Array.isArray(discovery.fetches) ? discovery.fetches.filter(isRecord) : [];
  const results = Array.isArray(inner.results) ? inner.results.filter(isRecord) : [];
  // Never truncate a URL into a different citation. Oversized/invalid URLs are omitted.
  const validUrl = (value: unknown): value is string => {
    if (typeof value !== "string" || value.length > 800) return false;
    try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
  };
  const pages = fetches.filter(page => validUrl(page.url))
    .sort((a, b) => Number(b.relevance_score ?? 0) - Number(a.relevance_score ?? 0)).slice(0, 6)
    .map(page => {
      const raw = typeof page.content === "string" ? page.content.trim() : "";
      const body = raw || (typeof page.ai_digested_content === "string" ? page.ai_digested_content : "");
      return { url: page.url as string, content: body.slice(0, 1500),
        evidenceType: raw ? "fetched_excerpt" : "generated_summary", truncated: body.length > 1500 };
    }).filter(page => page.content.length > 0);
  const fetched = new Set(pages.map(page => page.url));
  const discoveries = results.filter(item => validUrl(item.url)).slice(0, 8).map(item => ({
    url: item.url as string, title: typeof item.title === "string" ? item.title.slice(0, 120) : "",
    visited: fetched.has(item.url as string),
  }));
  const output = { query: typeof inner.query === "string" ? inner.query.slice(0, 400) : undefined,
    notice: "Discovery links and generated summaries are leads, not verified primary sources. Open the relevant page to verify claims; cite only URLs actually retrieved.",
    pages, discoveries, truncated: pages.some(page => page.truncated) || pages.length < fetches.length || discoveries.length < results.length };
  // Account for JSON escaping and metadata, retaining valid JSON at the tool-loop cap.
  while (JSON.stringify(output, null, 2).length > MAX_WEB_OUTPUT_CHARS) {
    output.truncated = true;
    const longest = pages.reduce<typeof pages[number] | undefined>((best, page) => !best || page.content.length > best.content.length ? page : best, undefined);
    if (longest && longest.content.length > 200) {
      longest.content = longest.content.slice(0, Math.max(200, longest.content.length - 300)); longest.truncated = true;
    } else if (discoveries.length > 1) discoveries.pop();
    else if (pages.length) pages.pop();
    else if (discoveries.length) discoveries.pop();
    else break;
  }
  // A visited link may have lost its excerpt to the bound; visited still records a real fetch.
  return output;
};

/** Hits to re-snippet. Enough to cover the answer, few enough to stay quick. */
const QUERY_SNIPPET_HITS = 3;
const QUERY_SNIPPET_WINDOW = 8;

/**
 * Replaces each hit's snippet with the part of the file that matches the query.
 *
 * Search returns a window starting at line one, which for a code file is the
 * import block. Asked for the value of a constant, a worker therefore received
 * three files' worth of imports and reported that it could not find the value —
 * correct about what it was given, useless as an answer. The follow-up tools
 * exist (`docdex_open`, `docdex_symbols`) and the tool description recommends
 * them, but a small model reliably searches once and stops, so the first result
 * has to carry the content.
 *
 * Best-effort throughout: a failed re-snippet leaves the original hit alone,
 * because a worse snippet is much better than a failed search.
 */
const withQueryCentredSnippets = async (
  client: DocdexClient,
  query: string,
  payload: unknown,
): Promise<unknown> => {
  if (!isRecord(payload)) return payload;
  const key = ["hits", "results", "matches"].find((candidate) =>
    Array.isArray(payload[candidate]),
  );
  if (!key) return payload;
  const hits = payload[key] as unknown[];
  if (hits.length === 0) return payload;

  const enriched = await Promise.all(
    hits.map(async (hit, index) => {
      if (index >= QUERY_SNIPPET_HITS || !isRecord(hit)) return hit;
      const docId = hit.doc_id ?? hit.docId ?? hit.rel_path ?? hit.relPath;
      if (typeof docId !== "string" || !docId) return hit;
      try {
        const snippet = await client.openSnippet(docId, {
          query,
          window: QUERY_SNIPPET_WINDOW,
        });
        const text = isRecord(snippet) && isRecord(snippet.snippet)
          ? snippet.snippet.text
          : undefined;
        if (typeof text !== "string" || text.trim().length === 0) return hit;
        return { ...hit, snippet: text, snippet_origin: "query_centred" };
      } catch {
        return hit;
      }
    }),
  );

  return { ...payload, [key]: enriched };
};

const withDocdexMetadata = (tools: ToolDefinition[]): ToolDefinition[] =>
  tools.map((tool) => ({
    ...tool,
    readOnly: tool.readOnly ?? !DOCDEX_WRITE_TOOLS.has(tool.name),
    capability: tool.capability ?? docdexCapabilityFor(tool.name),
  }));

/**
 * Judges whether search results actually answer the question.
 *
 * Needed because presence is not relevance. The local index returns *something*
 * for almost any query — "GDP of France 2025" scores 29.07 against this
 * repository, higher than "gateway planner class" at 14.35, because a test
 * fixture happens to contain the phrase. A score threshold would therefore be
 * both arbitrary and wrong, and keyword rules ("if the query mentions GDP, go
 * to the web") are exactly the hardcoding this project rules out.
 *
 * So the judgement is delegated to a model: cheap, generic, and it degrades to
 * the old presence-based behaviour when no judge is supplied.
 */
export type RelevanceJudge = (input: {
  query: string;
  results: unknown;
}) => Promise<boolean>;

export interface DocdexToolOptions {
  /** Include the versioned, explicitly classified standard MCP catalog. */
  includeCatalog?: boolean;
  judgeRelevance?: RelevanceJudge;
  /** Terminal clients authorize web research as a separate operation. */
  allowSearchWebFallback?: boolean;
}

export const createDocdexTools = (
  client: DocdexClient,
  options: DocdexToolOptions = {},
): ToolDefinition[] => {
  const tools = withDocdexMetadata([...docdexToolDefinitions(client, options), ...continuityTools(client)]);
  return options.includeCatalog ? [...tools, ...createDocdexCatalogTools(client, new Set(tools.map(tool => tool.name)))] : tools;
};

const continuityTools = (client: DocdexClient): ToolDefinition[] => {
  const single = (name: string, description: string, key: string, call: (value: string) => Promise<unknown>): ToolDefinition => ({
    name, description, inputSchema: { type: "object", properties: { [key]: { type: "string", minLength: 1, maxLength: 12000 } }, required: [key], additionalProperties: false },
    handler: async args => toOutput(await call((args as Record<string, string>)[key])),
  });
  return [
    single("docdex_wakeup", "Read bounded continuity context for this repository and agent. Canonical goal and authorization remain authoritative.", "query", query => client.wakeup(query)),
    single("docdex_conversation_search", "Find source-linked prior conversation records in this repository.", "query", query => client.conversationSearch(query)),
    single("docdex_conversation_read", "Read a prior repository conversation by its returned session ID.", "sessionId", id => client.conversationRead(id)),
    single("docdex_kg_query", "Inspect temporal knowledge-graph facts and provenance for this repository.", "query", query => client.knowledgeQuery(query)),
    single("docdex_diary_write", "Save a concise durable handoff with the current goal, observed outcome and next action. Requires memory-write permission.", "content", content => client.diaryWrite(content)),
    { name: "docdex_diary_read", description: "Read the agent's recent durable repository handoffs.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, handler: async () => toOutput(await client.diaryRead()) },
  ];
};

const docdexToolDefinitions = (
  client: DocdexClient,
  options: DocdexToolOptions,
): ToolDefinition[] => [
  {
    name: "docdex_health",
    description: "Check docdex healthz endpoint.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const ok = await client.healthCheck();
      return toOutput({ ok });
    },
  },
  {
    name: "docdex_initialize",
    description: "Initialize docdex repo binding.",
    inputSchema: {
      type: "object",
      required: ["rootUri"],
      properties: {
        rootUri: { type: "string" },
      },
    },
    handler: async (args) => {
      const { rootUri } = args as { rootUri: string };
      const result = await client.initialize(rootUri);
      return toOutput(result);
    },
  },
  {
    name: "docdex_search",
    description:
      "Search the indexed repository and organizational memory for code, docs, and prior decisions. " +
      (options.allowSearchWebFallback === false
        ? "This tool searches the local repository only; use an advertised web research tool for external information. "
        : "Searches locally first and falls back to the web when the local index has nothing relevant. ") +
      "Returns file paths, doc ids, and for the top results a snippet taken from the part of the " +
      "file that matches the query. For more of a file, follow up with docdex_symbols for its " +
      "signatures or docdex_open for a specific range of lines.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
    },
    handler: async (args) => {
      const { query, limit } = args as { query: string; limit?: number };
      const local = await client.search(query, { limit });

      // The local-then-web waterfall lives here, inside the search tool, rather
      // than in the orchestrator. The orchestrator should only have to know
      // "search"; whether an answer comes from the repository index or the
      // public web is an implementation detail of searching. Putting this
      // decision in the router would make it special-case logic that every new
      // question type has to be taught.
      let localAnswers = hasSearchHits(local);

      // Hits alone do not mean the question was answered. Ask a model whether
      // they are actually relevant before settling for them.
      if (localAnswers && options.judgeRelevance) {
        try {
          localAnswers = await options.judgeRelevance({ query, results: local });
        } catch {
          // A judge that fails must not block a search that already succeeded.
        }
      }

      const webQuery = normalizeWebQuery(query);
      if (options.allowSearchWebFallback !== false && !localAnswers && webQuery && !webResearchBlocked()) {
        try {
          const web = await client.search(webQuery, { limit, forceWeb: true });
          if (hasWebFindings(web)) {
            return toOutput(web);
          }
        } catch (error) {
          // Web discovery being unavailable must not fail a local search that
          // simply found nothing. Return the local (empty) result instead — and
          // remember a refusal, because every search would otherwise pay to
          // rediscover it.
          if (isWebQuotaRefusal(error)) noteWebRefusal(error);
        }
      }

      return toOutput(await withQueryCentredSnippets(client, query, local));
    },
  },
  {
    name: "docdex_open",
    description: "Read a file slice by repo-relative path or search doc id. Path ranges clamp to file bounds by default and return the actual line range; set clamp:false to require an exact range. Use head when the file length is unknown.",
    inputSchema: {
      type: "object",
      properties: {
        docId: { type: "string" },
        path: { type: "string" },
        window: { type: "number" },
        textOnly: { type: "boolean" },
        startLine: { type: "number" },
        endLine: { type: "number" },
        head: { type: "number" },
        clamp: { type: "boolean" },
      },
    },
    handler: async (args) => {
      const { docId, path, window, textOnly, startLine, endLine, head, clamp } = args as {
        docId?: string;
        path?: string;
        window?: number;
        textOnly?: boolean;
        startLine?: number;
        endLine?: number;
        head?: number;
        clamp?: boolean;
      };
      if (path) {
        const result = await client.openFile(path, { startLine, endLine, head, clamp: clamp ?? true });
        return toOutput(result);
      }
      if (!docId) {
        throw new Error("docdex_open requires either docId or path");
      }
      const result = await client.openSnippet(docId, { window, textOnly });
      return toOutput(result);
    },
  },
  {
    name: "docdex_symbols",
    description:
      "List the definitions in a file with their exact signatures and line numbers — functions, " +
      "classes, methods, exported constants. Use after docdex_search for exact structure beyond its bounded excerpts.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
      },
    },
    handler: async (args) => {
      const { path } = args as { path: string };
      const result = await client.symbols(path);
      return toOutput(result);
    },
  },
  {
    name: "docdex_ast",
    description: "Query a file's syntax tree for precise structure: class and function definitions, call sites, imports. More exact than text search when the question is structural.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        maxNodes: { type: "number" },
      },
    },
    handler: async (args) => {
      const { path, maxNodes } = args as { path: string; maxNodes?: number };
      const result = await client.ast(path, maxNodes);
      return toOutput(result);
    },
  },
  {
    name: "docdex_impact_graph",
    description: "Show what depends on a file and what it depends on. Answers \"what breaks if this changes\" and identifies the blast radius of an edit.",
    inputSchema: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string" },
        maxDepth: { type: "number" },
        maxEdges: { type: "number" },
        edgeTypes: { type: "array", items: { type: "string" } },
      },
    },
    handler: async (args) => {
      const { file, maxDepth, maxEdges, edgeTypes } = args as {
        file: string;
        maxDepth?: number;
        maxEdges?: number;
        edgeTypes?: string[];
      };
      const result = await client.impactGraph(file, { maxDepth, maxEdges, edgeTypes });
      return toOutput(result);
    },
  },
  {
    name: "docdex_impact_diagnostics",
    description: "List unresolved or dynamic imports that the dependency graph could not follow, so gaps in impact analysis are visible rather than silent.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
    handler: async (args) => {
      const { file, limit, offset } = args as { file?: string; limit?: number; offset?: number };
      const result = await client.impactDiagnostics({ file, limit, offset });
      return toOutput(result);
    },
  },
  {
    name: "docdex_dag_export",
    description: "Export docdex DAG for a session.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        format: { type: "string" },
        maxNodes: { type: "number" },
      },
    },
    handler: async (args) => {
      const { sessionId, format, maxNodes } = args as {
        sessionId: string;
        format?: "json" | "text" | "dot";
        maxNodes?: number;
      };
      const result = await client.dagExport(sessionId, { format, maxNodes });
      return toOutput(result);
    },
  },
  {
    name: "docdex_tree",
    description: "List the files and folders in the repository, or under one directory, with build output and vendor directories excluded. This is the tool for \"which files are in X\" and \"what packages exist\" — a text search ranks files by content and will not enumerate them.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxDepth: { type: "number" },
        dirsOnly: { type: "boolean" },
        includeHidden: { type: "boolean" },
        extraExcludes: { type: "array", items: { type: "string" } },
      },
    },
    handler: async (args, context) => {
      const { path, maxDepth, dirsOnly, includeHidden, extraExcludes } = args as {
        path?: string;
        maxDepth?: number;
        dirsOnly?: boolean;
        includeHidden?: boolean;
        extraExcludes?: string[];
      };
      const scoped = toRepoRelativePath(path, context?.workspaceRoot);
      const options = { maxDepth, dirsOnly, includeHidden, extraExcludes };
      try {
        return toOutput(await client.tree({ path: scoped, ...options }));
      } catch (error) {
        // Docdex fails a directory that does not exist, and a model asked to
        // list a repository guesses names — "mcoda", "monorepo", "root". The
        // request was still "show me what is here", so answer that from the
        // top rather than returning nothing.
        if (!scoped) throw error;
        return toOutput(await client.tree(options));
      }
    },
  },
  {
    name: "docdex_open_file",
    description: "Open a file by path via docdex (MCP). Ranges clamp to file bounds by default and return the actual line range; set clamp:false to require an exact range.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
        head: { type: "number" },
        clamp: { type: "boolean" },
      },
    },
    handler: async (args) => {
      const { path, startLine, endLine, head, clamp } = args as {
        path: string;
        startLine?: number;
        endLine?: number;
        head?: number;
        clamp?: boolean;
      };
      const result = await client.openFile(path, { startLine, endLine, head, clamp: clamp ?? true });
      return toOutput(result);
    },
  },
  {
    name: "docdex_memory_save",
    description: "Store repo memory in docdex.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
      },
    },
    handler: async (args) => {
      const { text } = args as { text: string };
      const result = await client.memorySave(text);
      return toOutput(result);
    },
  },
  {
    name: "docdex_get_profile",
    description: "Read stored global preferences and constraints that should shape the answer, such as style rules or disallowed libraries.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
      },
    },
    handler: async (args) => {
      const { agentId } = args as { agentId?: string };
      const result = await client.getProfile(agentId);
      return toOutput(result);
    },
  },
  {
    name: "docdex_save_preference",
    description: "Save a docdex profile preference.",
    inputSchema: {
      type: "object",
      required: ["agentId", "category", "content"],
      properties: {
        agentId: { type: "string" },
        category: { type: "string" },
        content: { type: "string" },
      },
    },
    handler: async (args) => {
      const { agentId, category, content } = args as { agentId: string; category: string; content: string };
      const result = await client.savePreference(agentId, category, content);
      return toOutput(result);
    },
  },
  {
    name: "docdex_memory_recall",
    description: "Recall durable facts previously recorded about this repository - architectural decisions, gotchas, where things live.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        topK: { type: "number" },
      },
    },
    handler: async (args) => {
      const { query, topK } = args as { query: string; topK?: number };
      const result = await client.memoryRecall(query, topK);
      return toOutput(result);
    },
  },
  {
    name: "docdex_web_research",
    description: "Search the public web for current external information: facts, news, third-party documentation, anything not in this repository. Returns sourced results with URLs.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        forceWeb: { type: "boolean" },
        skipLocalSearch: { type: "boolean" },
        webLimit: { type: "integer", minimum: 1, maximum: 5 },
        noCache: { type: "boolean" },
      },
    },
    handler: async (args) => {
      const { query, forceWeb, skipLocalSearch, webLimit, noCache } = args as {
        query: string;
        forceWeb?: boolean;
        skipLocalSearch?: boolean;
        webLimit?: number;
        noCache?: boolean;
      };
      // This tool means "go and look outside". Left to default, docdex searches
      // the local index first and returns whatever it holds, so a question about
      // a central bank's interest rate came back sourced to this repository's
      // own documentation. Anything genuinely local is what `docdex_search` is
      // for; a caller can still ask for the mixed behaviour explicitly.
      const normalizedQuery = normalizeWebQuery(query);
      if (!normalizedQuery) {
        // Spending a metered request to be told this is malformed helps nobody.
        return toOutput({ query, pages: [], unavailable: "empty query" });
      }
      const blocked = webResearchBlocked();
      if (blocked) {
        // Answering "the web is unavailable" costs nothing; asking again costs
        // a request from an allowance that is already spent.
        return toOutput({ query, pages: [], unavailable: blocked });
      }
      let result;
      try {
        result = await client.webResearch(normalizedQuery, {
          forceWeb: forceWeb ?? true,
          skipLocalSearch: skipLocalSearch ?? true,
          webLimit: webLimit ?? 3,
          noCache,
        });
      } catch (error) {
        if (isWebQuotaRefusal(error)) {
          noteWebRefusal(error);
          return toOutput({ query, pages: [], unavailable: webResearchBlocked() });
        }
        throw error;
      }

      // An empty/unavailable result is still an outcome. Do not spend a second
      // metered search inside one tool receipt; a deliberate noCache retry must
      // be a new native call, subject to the normal step and permission budget.
      return toOutput(toWebResearchOutput(result));
    },
  },
  {
    name: "docdex_chat_context",
    description: "Ask docdex OpenAI-compatible chat with repo/profile/wake-up context.",
    inputSchema: {
      type: "object",
      required: ["messages"],
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            required: ["role", "content"],
            properties: {
              role: { type: "string" },
              content: {
                anyOf: [
                  { type: "string" },
                  { type: "array", items: { type: "object" } },
                ],
              },
              name: { type: "string" },
              tool_call_id: { type: "string" },
            },
          },
        },
        model: { type: "string" },
        maxTokens: { type: "number" },
        temperature: { type: "number" },
        docdex: { type: "object" },
      },
    },
    handler: async (args) => {
      const { messages, model, maxTokens, temperature, docdex } = args as {
        messages: Array<{
          role: string;
          content: string | Array<Record<string, unknown>>;
          name?: string;
          tool_call_id?: string;
        }>;
        model?: string;
        maxTokens?: number;
        temperature?: number;
        docdex?: Record<string, unknown>;
      };
      const result = await client.chatContext(messages, { model, maxTokens, temperature, docdex });
      return toOutput(result);
    },
  },
  {
    name: "docdex_rerank",
    description: "Rerank candidate hits using docdex optional rerank flow.",
    inputSchema: {
      type: "object",
      required: ["query", "candidates"],
      properties: {
        query: { type: "string" },
        candidates: { type: "array", items: { type: "object" } },
        limit: { type: "number" },
      },
    },
    handler: async (args) => {
      const { query, candidates, limit } = args as {
        query: string;
        candidates: unknown[];
        limit?: number;
      };
      const result = await client.rerank(query, candidates, limit);
      return toOutput(result);
    },
  },
  {
    name: "docdex_batch_search",
    description: "Run several related search queries in one call. Use when a question decomposes into multiple independent lookups, to save round trips.",
    inputSchema: {
      type: "object",
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        includeLibs: { type: "boolean" },
      },
    },
    handler: async (args) => {
      const { queries, limit, includeLibs } = args as {
        queries: string[];
        limit?: number;
        includeLibs?: boolean;
      };
      const result = await client.batchSearch(queries, { limit, includeLibs });
      return toOutput(result);
    },
  },
  {
    name: "docdex_capabilities",
    description: "Probe optional docdex retrieval capability support and cache per run.",
    inputSchema: {
      type: "object",
      properties: {
        forceRefresh: { type: "boolean" },
      },
    },
    handler: async (args) => {
      const { forceRefresh } = (args as { forceRefresh?: boolean }) ?? {};
      const result = await client.getCapabilities(forceRefresh ?? false);
      return toOutput(result);
    },
  },
  {
    name: "docdex_stats",
    description: "Report index size and when it was last updated. Use to detect a stale index before trusting a negative search result.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const result = await client.stats();
      return toOutput(result);
    },
  },
  {
    name: "docdex_files",
    description: "List the files currently present in the index, to confirm coverage before concluding that something does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
    handler: async (args) => {
      const { limit, offset } = (args as { limit?: number; offset?: number }) ?? {};
      const result = await client.files(limit, offset);
      return toOutput(result);
    },
  },
  {
    name: "docdex_repo_inspect",
    description: "Inspect docdex repo mapping.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const result = await client.repoInspect();
      return toOutput(result);
    },
  },
  {
    name: "docdex_index_rebuild",
    description: "Rebuild docdex index.",
    inputSchema: {
      type: "object",
      properties: {
        libsSources: { type: "string" },
      },
    },
    handler: async (args) => {
      const { libsSources } = args as { libsSources?: string };
      const result = await client.indexRebuild(libsSources);
      return toOutput(result);
    },
  },
  {
    name: "docdex_index_ingest",
    description: "Ingest a single file into the docdex index.",
    inputSchema: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string" },
      },
    },
    handler: async (args) => {
      const { file } = args as { file: string };
      const result = await client.indexIngest(file);
      return toOutput(result);
    },
  },
  {
    name: "docdex_delegate",
    description: "Run a local completion via docdex delegation.",
    inputSchema: {
      type: "object",
      required: ["taskType", "instruction", "context"],
      properties: {
        taskType: { type: "string" },
        instruction: { type: "string" },
        context: { type: "string" },
        agent: { type: "string" },
        maxTokens: { type: "number" },
        timeoutMs: { type: "number" },
        mode: { type: "string" },
        maxContextChars: { type: "number" },
      },
    },
    handler: async (args) => {
      const {
        taskType,
        instruction,
        context,
        agent,
        maxTokens,
        timeoutMs,
        mode,
        maxContextChars,
      } = args as {
        taskType: string;
        instruction: string;
        context: string;
        agent?: string;
        maxTokens?: number;
        timeoutMs?: number;
        mode?: string;
        maxContextChars?: number;
      };
      const result = await client.delegate({
        task_type: taskType,
        instruction,
        context,
        agent,
        max_tokens: maxTokens,
        timeout_ms: timeoutMs,
        mode,
        max_context_chars: maxContextChars,
      });
      return toOutput(result);
    },
  },
  {
    name: "docdex_hooks_validate",
    description: "Run docdex validation hooks for a list of files.",
    inputSchema: {
      type: "object",
      required: ["files"],
      properties: {
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: async (args) => {
      const { files } = args as { files: string[] };
      const result = await client.hooksValidate(files);
      return toOutput(result);
    },
  },
];
