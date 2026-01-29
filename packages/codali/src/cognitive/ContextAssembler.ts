import type { DocdexClient } from "../docdex/DocdexClient.js";
import type { Provider } from "../providers/ProviderTypes.js";
import { expandQueriesWithProvider, extractQueries } from "./QueryExtraction.js";
import { extractPreferences } from "./PreferenceExtraction.js";
import { selectContextFiles } from "./ContextSelector.js";
import { ContextFileLoader } from "./ContextFileLoader.js";
import { ContextRedactor } from "./ContextRedactor.js";
import { serializeContext } from "./ContextSerializer.js";
import type { ContextManager } from "./ContextManager.js";
import type {
  ContextBundle,
  ContextFileEntry,
  ContextImpactSummary,
  ContextImpactDiagnostics,
  ContextSnippet,
  ContextSymbolSummary,
  ContextAstSummary,
  LaneScope,
} from "./Types.js";

export interface ContextAssemblerOptions {
  maxQueries?: number;
  maxHitsPerQuery?: number;
  snippetWindow?: number;
  impactMaxDepth?: number;
  impactMaxEdges?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  tokenBudget?: number;
  includeRepoMap?: boolean;
  includeImpact?: boolean;
  includeSnippets?: boolean;
  workspaceRoot?: string;
  readStrategy?: "docdex" | "fs";
  focusMaxFileBytes?: number;
  peripheryMaxBytes?: number;
  skeletonizeLargeFiles?: boolean;
  serializationMode?: "bundle_text" | "json";
  redactSecrets?: boolean;
  redactPatterns?: string[];
  ignoreFilesFrom?: string[];
  queryProvider?: Provider;
  queryTemperature?: number;
  agentId?: string;
  contextManager?: ContextManager;
  laneScope?: Omit<LaneScope, "role" | "ephemeral">;
}

const toStringPayload = (payload: unknown): string => {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

const collectHits = (result: unknown): Array<{ doc_id?: string; path?: string }> => {
  if (!result || typeof result !== "object") return [];
  const hits = (result as { hits?: Array<{ doc_id?: string; path?: string }> }).hits;
  if (!Array.isArray(hits)) return [];
  return hits;
};

const extractFileHints = (result: unknown): string[] => {
  if (!result || typeof result !== "object") return [];
  const record = result as {
    results?: Array<{ rel_path?: string; path?: string }>;
    files?: string[];
  };
  if (Array.isArray(record.files)) {
    return record.files.filter((entry) => typeof entry === "string" && entry.length > 0);
  }
  if (!Array.isArray(record.results)) return [];
  return record.results
    .map((entry) => entry.rel_path ?? entry.path)
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
};

const uniqueValues = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const estimateTokens = (content: string, provided?: number): number => {
  if (typeof provided === "number" && Number.isFinite(provided)) return provided;
  return Math.max(1, Math.ceil(content.length / 4));
};

const truncateWithMarker = (content: string, maxBytes: number): string => {
  if (content.length <= maxBytes) return content;
  const marker = "\n/* ...truncated... */\n";
  if (maxBytes <= marker.length) {
    return content.slice(0, maxBytes);
  }
  return `${content.slice(0, maxBytes - marker.length)}${marker}`;
};

const applyContextBudget = (
  files: ContextFileEntry[],
  maxTotalBytes: number,
  tokenBudget: number,
): {
  files: ContextFileEntry[];
  droppedPaths: string[];
  trimmed: boolean;
  totalBytes: number;
  totalTokens: number;
} => {
  const maxBytes = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : 0;
  const maxTokens = Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : 0;
  const clone = files.map((file) => ({
    ...file,
    warnings: file.warnings ? [...file.warnings] : undefined,
  }));
  const droppedPaths: string[] = [];
  let trimmed = false;

  const totals = () => {
    const totalBytes = clone.reduce((sum, entry) => sum + entry.content.length, 0);
    const totalTokens = clone.reduce(
      (sum, entry) => sum + estimateTokens(entry.content, entry.token_estimate),
      0,
    );
    return { totalBytes, totalTokens };
  };

  const overBudget = () => {
    const { totalBytes, totalTokens } = totals();
    if (maxBytes && totalBytes > maxBytes) return true;
    if (maxTokens && totalTokens > maxTokens) return true;
    return false;
  };

  const dropPeriphery = () => {
    const index = [...clone].reverse().findIndex((entry) => entry.role === "periphery");
    if (index === -1) return false;
    const removeIndex = clone.length - 1 - index;
    const [removed] = clone.splice(removeIndex, 1);
    if (removed) {
      droppedPaths.push(removed.path);
      trimmed = true;
    }
    return true;
  };

  while (overBudget() && dropPeriphery()) {
    // drop periphery until within budget
  }

  let guard = 0;
  while (overBudget() && clone.length > 0 && guard < clone.length * 4) {
    const { totalBytes, totalTokens } = totals();
    const bytesOver = maxBytes ? Math.max(0, totalBytes - maxBytes) : 0;
    const tokensOver = maxTokens ? Math.max(0, totalTokens - maxTokens) : 0;
    const reduceBy = Math.max(bytesOver, tokensOver * 4);
    if (reduceBy <= 0) break;
    const index = clone.length - 1;
    const entry = clone[index];
    const targetLength = Math.max(1, entry.content.length - reduceBy);
    if (targetLength >= entry.content.length) break;
    const updatedContent = truncateWithMarker(entry.content, targetLength);
    clone[index] = {
      ...entry,
      content: updatedContent,
      truncated: true,
      sliceStrategy: "budget_trim",
      token_estimate: estimateTokens(updatedContent),
      warnings: entry.warnings?.includes("budget_trim")
        ? entry.warnings
        : [...(entry.warnings ?? []), "budget_trim"],
    };
    trimmed = true;
    guard += 1;
  }

  const { totalBytes, totalTokens } = totals();
  return { files: clone, droppedPaths, trimmed, totalBytes, totalTokens };
};

type ContextAssemblerResolvedOptions = Required<
  Omit<ContextAssemblerOptions, "queryProvider" | "queryTemperature" | "agentId" | "contextManager" | "laneScope">
>;

export class ContextAssembler {
  private client: DocdexClient;
  private options: ContextAssemblerResolvedOptions;
  private queryProvider?: Provider;
  private queryTemperature?: number;
  private agentId?: string;
  private contextManager?: ContextManager;
  private laneScope?: Omit<LaneScope, "role" | "ephemeral">;

  constructor(client: DocdexClient, options: ContextAssemblerOptions = {}) {
    this.client = client;
    this.options = {
      maxQueries: options.maxQueries ?? 3,
      maxHitsPerQuery: options.maxHitsPerQuery ?? 3,
      snippetWindow: options.snippetWindow ?? 120,
      impactMaxDepth: options.impactMaxDepth ?? 2,
      impactMaxEdges: options.impactMaxEdges ?? 80,
      maxFiles: options.maxFiles ?? 8,
      maxTotalBytes: options.maxTotalBytes ?? 40_000,
      tokenBudget: options.tokenBudget ?? 120_000,
      includeRepoMap: options.includeRepoMap ?? true,
      includeImpact: options.includeImpact ?? true,
      includeSnippets: options.includeSnippets ?? true,
      workspaceRoot: options.workspaceRoot ?? process.cwd(),
      readStrategy: options.readStrategy ?? "docdex",
      focusMaxFileBytes: options.focusMaxFileBytes ?? 12_000,
      peripheryMaxBytes: options.peripheryMaxBytes ?? 4_000,
      skeletonizeLargeFiles: options.skeletonizeLargeFiles ?? true,
      serializationMode: options.serializationMode ?? "json",
      redactSecrets: options.redactSecrets ?? false,
      redactPatterns: options.redactPatterns ?? [],
      ignoreFilesFrom: options.ignoreFilesFrom ?? [],
    };
    this.queryProvider = options.queryProvider;
    this.queryTemperature = options.queryTemperature;
    this.agentId = options.agentId;
    this.contextManager = options.contextManager;
    this.laneScope = options.laneScope;
  }

  async assemble(
    request: string,
    options: {
      additionalQueries?: string[];
      preferredFiles?: string[];
      recentFiles?: string[];
    } = {},
  ): Promise<ContextBundle> {
    const warnings: string[] = [];
    const pushWarning = (warning: string): void => {
      if (!warnings.includes(warning)) warnings.push(warning);
    };
    const baseQueries = extractQueries(request, this.options.maxQueries);
    const supplementalQueries = uniqueValues(options.additionalQueries ?? []);
    let queries = uniqueValues([...supplementalQueries, ...baseQueries]).slice(
      0,
      Math.max(1, this.options.maxQueries),
    );
    const preferencesDetected = extractPreferences(request);
    const preferredFiles = uniqueValues(options.preferredFiles ?? []);
    const recentFiles = uniqueValues(options.recentFiles ?? []);
    const contextManager = this.contextManager;
    const laneScope = this.laneScope;

    try {
      await this.client.healthCheck();
    } catch (error) {
      pushWarning("docdex_unavailable");
      return {
        request,
        queries,
        snippets: [],
        symbols: [],
        ast: [],
        impact: [],
        impact_diagnostics: [],
        memory: [],
        preferences_detected: preferencesDetected,
        profile: [],
        index: { last_updated_epoch_ms: 0, num_docs: 0 },
        warnings,
      };
    }
    if (!this.client.getRepoId()) {
      const repoRoot = this.client.getRepoRoot();
      if (repoRoot) {
        const rootUri = repoRoot.startsWith("file://") ? repoRoot : `file://${repoRoot}`;
        try {
          await this.client.initialize(rootUri);
        } catch {
          pushWarning("docdex_initialize_failed");
        }
      }
    }
    let stats: unknown = { last_updated_epoch_ms: 0, num_docs: 0 };
    try {
      stats = await this.client.stats();
    } catch {
      pushWarning("docdex_stats_failed");
    }
    let fileHints: string[] = [];
    try {
      const filesResult = await this.client.files(20, 0);
      fileHints = extractFileHints(filesResult);
    } catch {
      pushWarning("docdex_files_failed");
    }

    const runSearch = async (queriesToUse: string[]) => {
      const hitList: Array<{ doc_id?: string; path?: string }> = [];
      let searchSucceeded = false;
      for (const query of queriesToUse) {
        try {
          const result = await this.client.search(query, { limit: this.options.maxHitsPerQuery });
          hitList.push(...collectHits(result));
          searchSucceeded = true;
        } catch {
          pushWarning("docdex_search_failed");
        }
      }
      return { hitList, searchSucceeded };
    };

    const initialSearch = await runSearch(queries);
    let hitList = initialSearch.hitList;
    let searchSucceeded = initialSearch.searchSucceeded;

    let uniqueHits = hitList.filter((hit, index, self) => {
      const key = `${hit.doc_id ?? ""}:${hit.path ?? ""}`;
      return self.findIndex((entry) => `${entry.doc_id ?? ""}:${entry.path ?? ""}` === key) === index;
    });

    const lowHitThreshold = Math.min(2, this.options.maxHitsPerQuery);
    const shouldExpandQueries =
      uniqueHits.length < lowHitThreshold || !searchSucceeded || queries.length === 0;
    const queryProvider = this.queryProvider;
    if (queryProvider && shouldExpandQueries) {
      const baseQueries = [...queries];
      let laneId: string | undefined;
      if (contextManager) {
        const lane = await contextManager.getLane({
          ...(laneScope ?? {}),
          role: "librarian",
          ephemeral: true,
        });
        laneId = lane.id;
        await contextManager.append(
          laneId,
          {
            role: "user",
            content: JSON.stringify(
              {
                request,
                base_queries: baseQueries,
                max_queries: this.options.maxQueries,
                file_hints: fileHints,
              },
              null,
              2,
            ),
          },
          { role: "librarian", persisted: false },
        );
      }
      try {
        const expanded = await expandQueriesWithProvider(
          queryProvider,
          request,
          baseQueries,
          this.options.maxQueries,
          this.queryTemperature,
          fileHints,
        );
        if (laneId && contextManager) {
          await contextManager.append(
            laneId,
            {
              role: "assistant",
              content: JSON.stringify({ expanded_queries: expanded }, null, 2),
            },
            { role: "librarian", persisted: false },
          );
        }
        if (expanded.length > 0) {
          queries = uniqueValues(expanded).slice(0, Math.max(1, this.options.maxQueries));
          const expandedSearch = await runSearch(queries);
          hitList = expandedSearch.hitList;
          searchSucceeded = expandedSearch.searchSucceeded;
          uniqueHits = hitList.filter((hit, index, self) => {
            const key = `${hit.doc_id ?? ""}:${hit.path ?? ""}`;
            return self.findIndex((entry) => `${entry.doc_id ?? ""}:${entry.path ?? ""}` === key) === index;
          });
        }
      } catch (error) {
        if (laneId && contextManager) {
          await contextManager.append(
            laneId,
            {
              role: "assistant",
              content: `Query expansion failed: ${error instanceof Error ? error.message : String(error)}`,
            },
            { role: "librarian", persisted: false },
          );
        }
        warnings.push("query_expansion_failed");
      }
    }

    const snippets: ContextSnippet[] = [];
    if (this.options.includeSnippets) {
      for (const hit of uniqueHits) {
        if (!hit.doc_id) continue;
        try {
          const snippetResult = await this.client.openSnippet(hit.doc_id, { window: this.options.snippetWindow });
          snippets.push({
            doc_id: hit.doc_id,
            path: hit.path,
            content: toStringPayload(snippetResult),
          });
        } catch {
          pushWarning(`docdex_snippet_failed:${hit.doc_id}`);
        }
      }
    }

    const filePaths = Array.from(
      new Set([
        ...uniqueHits
          .map((hit) => hit.path)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
        ...preferredFiles,
        ...recentFiles,
      ]),
    );

    const symbols: ContextSymbolSummary[] = [];
    const ast: ContextAstSummary[] = [];
    const impact: ContextImpactSummary[] = [];
    const impactDiagnostics: ContextImpactDiagnostics[] = [];
    for (const file of filePaths) {
      try {
        const symbolsResult = await this.client.symbols(file);
        symbols.push({ path: file, summary: toStringPayload(symbolsResult) });
      } catch {
        pushWarning(`docdex_symbols_failed:${file}`);
      }

      try {
        const astResult = await this.client.ast(file);
        const nodes = (astResult as { nodes?: unknown[] } | undefined)?.nodes ?? [];
        ast.push({ path: file, nodes });
      } catch {
        pushWarning(`docdex_ast_failed:${file}`);
      }

      if (this.options.includeImpact) {
        try {
          const impactResult = await this.client.impactGraph(file, {
            maxDepth: this.options.impactMaxDepth,
            maxEdges: this.options.impactMaxEdges,
          });
          const inbound = (impactResult as { inbound?: string[] } | undefined)?.inbound ?? [];
          const outbound = (impactResult as { outbound?: string[] } | undefined)?.outbound ?? [];
          impact.push({ file, inbound, outbound });
          if (!inbound.length && !outbound.length) {
            warnings.push(`impact_graph_sparse:${file}`);
            try {
              const diagnostics = await this.client.impactDiagnostics({ file, limit: 20 });
              impactDiagnostics.push({ file, diagnostics });
            } catch {
              warnings.push(`impact_diagnostics_failed:${file}`);
            }
          }
        } catch {
          pushWarning(`docdex_impact_failed:${file}`);
        }
      }
    }

    let selection = selectContextFiles(
      {
        hits: uniqueHits,
        impact,
        recentFiles,
        preferredFiles,
      },
      { maxFiles: this.options.maxFiles, minHitCount: Math.min(2, this.options.maxHitsPerQuery) },
    );
    if (selection.low_confidence) {
      warnings.push("docdex_low_confidence");
    }

    let repoMap: string | undefined;
    if (this.options.includeRepoMap && (selection.low_confidence || uniqueHits.length === 0)) {
      const clientWithTree = this.client as unknown as { tree?: (options?: unknown) => Promise<unknown> };
      if (typeof clientWithTree.tree === "function") {
        try {
          const treeResult = await clientWithTree.tree({ maxDepth: 3 });
          repoMap = toStringPayload(treeResult);
        } catch {
          pushWarning("docdex_tree_failed");
        }
      }
    }
    if (this.options.includeRepoMap && !repoMap) {
      const entries: string[] = [];
      const seen = new Set<string>();
      for (const entry of symbols) {
        if (!entry.path || seen.has(entry.path)) continue;
        seen.add(entry.path);
        entries.push(`## ${entry.path}\n${entry.summary}`);
        if (entries.length >= 20) break;
      }
      if (entries.length < 20 && fileHints.length > 0) {
        const remaining = fileHints.filter((file) => !seen.has(file)).slice(0, 20 - entries.length);
        for (const file of remaining) {
          try {
            const symbolsResult = await this.client.symbols(file);
            entries.push(`## ${file}\n${toStringPayload(symbolsResult)}`);
          } catch {
            pushWarning(`docdex_symbols_failed:${file}`);
          }
        }
      }
      if (entries.length > 0) {
        repoMap = entries.join("\n\n");
      }
    }

    let contextFiles: ContextBundle["files"] | undefined;
    let redactionInfo: ContextBundle["redaction"] | undefined;
    if (selection.all.length > 0) {
      let redactor: ContextRedactor | undefined;
      if (this.options.redactSecrets && (this.options.redactPatterns.length || this.options.ignoreFilesFrom.length)) {
        redactor = new ContextRedactor({
          workspaceRoot: this.options.workspaceRoot,
          ignoreFilesFrom: this.options.ignoreFilesFrom,
          redactPatterns: this.options.redactPatterns,
        });
        await redactor.loadIgnoreMatchers();
      }
      const loader = new ContextFileLoader(this.client, {
        workspaceRoot: this.options.workspaceRoot,
        readStrategy: this.options.readStrategy,
        focusMaxFileBytes: this.options.focusMaxFileBytes,
        peripheryMaxBytes: this.options.peripheryMaxBytes,
        skeletonizeLargeFiles: this.options.skeletonizeLargeFiles,
        redactor,
      });
      const focusEntries = await loader.loadFocus(selection.focus);
      const peripheryEntries = await loader.loadPeriphery(selection.periphery);
      contextFiles = [...focusEntries, ...peripheryEntries];
      const budgetResult = applyContextBudget(
        contextFiles,
        this.options.maxTotalBytes,
        this.options.tokenBudget,
      );
      contextFiles = budgetResult.files;
      if (budgetResult.droppedPaths.length > 0 && selection) {
        const included = new Set(contextFiles.map((entry) => entry.path));
        selection = {
          ...selection,
          focus: selection.focus.filter((path) => included.has(path)),
          periphery: selection.periphery.filter((path) => included.has(path)),
          all: selection.all.filter((path) => included.has(path)),
        };
        warnings.push("context_budget_pruned");
      }
      if (budgetResult.trimmed) {
        warnings.push("context_budget_trimmed");
      }
      if (loader.redactionCount > 0 || loader.ignoredPaths.length > 0) {
        redactionInfo = {
          count: loader.redactionCount,
          ignored: loader.ignoredPaths,
        };
      }
    }

    let memoryItems: Array<{ content?: string }> = [];
    try {
      const memoryResult = await this.client.memoryRecall(request, 5);
      memoryItems = (memoryResult as { results?: Array<{ content?: string }> } | undefined)?.results ?? [];
    } catch {
      pushWarning("docdex_memory_recall_failed");
    }
    const memory = memoryItems
      .map((item) => item.content)
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .map((text) => ({ text, source: "repo" }));

    let profileEntries: Array<{ content?: string }> = [];
    try {
      const profileResult = await this.client.getProfile(this.agentId);
      profileEntries =
        (profileResult as { preferences?: Array<{ content?: string }> } | undefined)?.preferences ?? [];
    } catch {
      pushWarning("docdex_profile_failed");
    }
    const profile = profileEntries
      .map((entry) => entry.content)
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .map((content) => ({ content, source: "agent" }));

    const indexInfo = {
      last_updated_epoch_ms: (stats as { last_updated_epoch_ms?: number }).last_updated_epoch_ms ?? 0,
      num_docs: (stats as { num_docs?: number }).num_docs ?? 0,
    };
    if (indexInfo.num_docs === 0) {
      warnings.push("docdex_index_empty");
    }
    if (indexInfo.last_updated_epoch_ms === 0) {
      pushWarning("docdex_index_stale");
    }
    if (indexInfo.num_docs === 0 || indexInfo.last_updated_epoch_ms === 0) {
      const clientWithRebuild = this.client as unknown as { indexRebuild?: () => Promise<unknown> };
      if (typeof clientWithRebuild.indexRebuild === "function") {
        void clientWithRebuild.indexRebuild().catch(() => {
          pushWarning("docdex_index_rebuild_failed");
        });
      }
    }

    if (!uniqueHits.length) {
      if (!searchSucceeded) {
        pushWarning("docdex_search_failed");
      } else {
        pushWarning("docdex_no_hits");
      }
    }

    const bundle: ContextBundle = {
      request,
      queries,
      snippets,
      symbols,
      ast,
      impact,
      impact_diagnostics: impactDiagnostics,
      repo_map: repoMap,
      selection,
      files: contextFiles,
      redaction: redactionInfo,
      memory,
      preferences_detected: preferencesDetected,
      profile,
      index: indexInfo,
      warnings,
    };
    if ((contextFiles && contextFiles.length > 0) || repoMap) {
      bundle.serialized = serializeContext(bundle, { mode: this.options.serializationMode });
    }
    return bundle;
  }
}
