import type { ToolDefinition } from "../ToolTypes.js";
import type { DocdexClient } from "../../docdex/DocdexClient.js";

const toOutput = (payload: unknown): { output: string; data: unknown } => ({
  output: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
  data: payload,
});

export const createDocdexTools = (client: DocdexClient): ToolDefinition[] => [
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
    description: "Search docdex index.",
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
      const result = await client.search(query, { limit });
      return toOutput(result);
    },
  },
  {
    name: "docdex_open",
    description: "Open a file by path or fetch a snippet by doc id.",
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
    description: "Fetch docdex symbols for a file.",
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
    description: "Fetch docdex AST nodes for a file.",
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
    description: "Fetch docdex impact graph for a file.",
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
    description: "Fetch docdex impact diagnostics (dynamic imports).",
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
    description: "Render a folder tree from docdex.",
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
    description: "Fetch docdex profile preferences.",
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
    description: "Recall repo memory from docdex.",
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
    description: "Run docdex web research (requires DOCDEX_WEB_ENABLED=1).",
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
      const result = await client.webResearch(query, { forceWeb, skipLocalSearch, webLimit, noCache });
      return toOutput(result);
    },
  },
  {
    name: "docdex_stats",
    description: "Fetch docdex index stats.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const result = await client.stats();
      return toOutput(result);
    },
  },
  {
    name: "docdex_files",
    description: "List docdex indexed files.",
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
