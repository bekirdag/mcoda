import type { ToolDefinition } from "../ToolTypes.js";
import type { DocdexClient } from "../../docdex/DocdexClient.js";

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
 * Whether a web-research payload carries anything quotable. Docdex answers a
 * cache hit with discovery metadata only, which reads as success but gives a
 * model nothing to cite.
 */
const hasWebContent = (payload: unknown): boolean => {
  if (!isRecord(payload)) return false;
  for (const key of ["web_context", "webContext", "hits", "results"]) {
    const value = payload[key];
    if (Array.isArray(value) && value.length > 0) return true;
  }
  return false;
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
  judgeRelevance?: RelevanceJudge;
}

export const createDocdexTools = (
  client: DocdexClient,
  options: DocdexToolOptions = {},
): ToolDefinition[] => withDocdexMetadata(docdexToolDefinitions(client, options));

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
      "Searches locally first and falls back to the web when the local index has nothing relevant, " +
      "so this is the default tool for both repo questions and general external questions. " +
      "Returns file paths, doc ids, and a snippet from the START of each file — usually imports, " +
      "not the part that answers the question. To explain what something does, follow up with " +
      "docdex_symbols for its signature or docdex_open for the relevant lines.",
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

      if (!localAnswers) {
        try {
          const web = await client.search(query, { limit, forceWeb: true });
          if (hasWebFindings(web)) {
            return toOutput(web);
          }
        } catch {
          // Web discovery being unavailable must not fail a local search that
          // simply found nothing. Return the local (empty) result instead.
        }
      }

      return toOutput(local);
    },
  },
  {
    name: "docdex_open",
    description: "Read an exact slice of a file, either by repo-relative path or by a doc id returned from a search. Use after a search has identified a target rather than guessing paths.",
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
        const result = await client.openFile(path, { startLine, endLine, head, clamp });
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
      "classes, methods, exported constants. Use after docdex_search to find out what a file " +
      "actually contains, since search snippets only show the file's opening lines.",
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
    description: "Render the repository folder tree with build output and vendor directories excluded. Use to orient in an unfamiliar repo instead of listing directories manually.",
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
    handler: async (args) => {
      const { path, maxDepth, dirsOnly, includeHidden, extraExcludes } = args as {
        path?: string;
        maxDepth?: number;
        dirsOnly?: boolean;
        includeHidden?: boolean;
        extraExcludes?: string[];
      };
      const result = await client.tree({ path, maxDepth, dirsOnly, includeHidden, extraExcludes });
      return toOutput(result);
    },
  },
  {
    name: "docdex_open_file",
    description: "Open a file by path via docdex (MCP).",
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
      const result = await client.openFile(path, { startLine, endLine, head, clamp });
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
        webLimit: { type: "number" },
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
      let result = await client.webResearch(query, { forceWeb, skipLocalSearch, webLimit, noCache });

      // A cache hit returns discovery metadata with no page content at all —
      // no web_context, no hits — so the run sees that a search happened and
      // nothing it can quote. Retrying uncached fetches the pages the cache
      // was standing in for.
      if (!noCache && !hasWebContent(result)) {
        try {
          const fresh = await client.webResearch(query, {
            forceWeb,
            skipLocalSearch,
            webLimit,
            noCache: true,
          });
          if (hasWebContent(fresh)) {
            result = fresh;
          }
        } catch {
          // Keep the cached response rather than failing a search that worked.
        }
      }

      return toOutput(result);
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
