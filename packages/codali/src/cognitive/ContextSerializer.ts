import type {
  ContextBundle,
  ContextFileEntry,
  ContextResearchSummary,
  SerializedContext,
} from "./Types.js";

export interface ContextSerializerOptions {
  mode: "bundle_text" | "json";
  audience?: "librarian" | "builder";
}

const estimateTokens = (content: string): number => Math.max(1, Math.ceil(content.length / 4));

const SECTION_LIMITS = {
  maxSnippetEntries: 6,
  maxSnippetChars: 1_600,
  maxSymbolEntries: 6,
  maxSymbolChars: 1_800,
  maxAstEntries: 4,
  maxAstNodes: 40,
  maxAstChars: 2_200,
  maxMemoryEntries: 6,
  maxMemoryChars: 320,
  maxProfileEntries: 6,
  maxProfileChars: 240,
  maxResearchItems: 6,
  maxResearchChars: 200,
};

const WARNING_GLOSSARY: Record<
  string,
  { severity: "info" | "warn" | "error"; message: string }
> = {
  context_budget_pruned: {
    severity: "warn",
    message: "Some selected files were dropped to satisfy the context budget.",
  },
  context_budget_trimmed: {
    severity: "info",
    message: "Some file content was trimmed in the internal context load.",
  },
  docdex_files_failed: {
    severity: "warn",
    message: "Docdex file listing failed; file hints may be incomplete.",
  },
  docdex_index_empty: {
    severity: "warn",
    message: "Docdex index is empty; search results may be incomplete.",
  },
  docdex_index_stale: {
    severity: "warn",
    message: "Docdex index looks stale; search results may be incomplete.",
  },
  docdex_low_confidence: {
    severity: "info",
    message: "Low-confidence selection; treat context as exploratory.",
  },
  docdex_no_hits: {
    severity: "info",
    message: "Search returned no hits; selection may rely on heuristics.",
  },
  docdex_stats_failed: {
    severity: "warn",
    message: "Docdex stats failed; index status may be unknown.",
  },
  docdex_tree_failed: {
    severity: "warn",
    message: "Repo tree could not be retrieved; repo map may be missing.",
  },
  docdex_symbols_not_applicable: {
    severity: "info",
    message: "Symbols are not applicable for this file type.",
  },
  docdex_ast_not_applicable: {
    severity: "info",
    message: "AST analysis is not applicable for this file type.",
  },
  impact_graph_sparse: {
    severity: "info",
    message: "Impact graph is sparse; dependency info may be incomplete.",
  },
  librarian_companion_candidates: {
    severity: "info",
    message: "Companion files were added based on proximity or hints.",
  },
  memory_conflicts_pruned: {
    severity: "info",
    message: "Conflicting memory entries were pruned.",
  },
  memory_irrelevant_filtered: {
    severity: "info",
    message: "Irrelevant memory entries were filtered out.",
  },
};

const truncateText = (value: string, maxChars: number): string => {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  const marker = "\n/* ...truncated... */\n";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
};

const truncateSummary = (value: string, maxChars: number): string => {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
};

const splitWarning = (warning: string): { code: string; detail?: string } => {
  const separator = warning.indexOf(":");
  if (separator === -1) return { code: warning };
  return { code: warning.slice(0, separator), detail: warning.slice(separator + 1) };
};

const formatFileHeader = (file: ContextFileEntry): string => {
  const role = file.role === "focus" ? "FOCUS FILE" : "PERIPHERY FILE";
  const metadata: string[] = [`slice=${file.sliceStrategy}`, `origin=${file.origin}`];
  if (file.truncated) metadata.push("truncated");
  if (file.warnings?.length) metadata.push(`warnings=${file.warnings.join("|")}`);
  return `=== [${role}] ${file.path} (${metadata.join(", ")}) ===`;
};

const listOrNone = (values: string[] = []): string =>
  values.length ? values.join(", ") : "none";

const uniqueValues = (values: string[]): string[] => Array.from(new Set(values));

const formatSummaryList = (values: string[] | undefined): string => {
  if (!values || values.length === 0) return "none";
  const trimmed = values
    .filter((entry) => entry.trim().length > 0)
    .slice(0, SECTION_LIMITS.maxResearchItems)
    .map((entry) => truncateSummary(entry, SECTION_LIMITS.maxResearchChars));
  const remaining = values.length - trimmed.length;
  if (remaining > 0) {
    return `${trimmed.join(" | ")} (+${remaining} more)`;
  }
  return trimmed.join(" | ");
};

const isTestPath = (value: string): boolean => {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/__tests__/") ||
    normalized.includes("/tests/") ||
    normalized.includes(".test.") ||
    normalized.endsWith(".spec.ts") ||
    normalized.endsWith(".spec.js")
  );
};

const isDocPath = (value: string): boolean => {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  if (normalized.startsWith("docs/")) return true;
  return normalized.endsWith(".md") || normalized.endsWith(".mdx") || normalized.endsWith(".rst");
};

const formatProjectSummary = (bundle: ContextBundle): string[] => {
  const lines: string[] = [];
  const info = bundle.project_info;
  const summary = info?.readme_summary?.trim();
  const readmePath = info?.readme_path;
  lines.push("PROJECT SUMMARY (README):");
  if (readmePath) lines.push(`- Source: ${readmePath}`);
  if (summary) {
    lines.push(summary);
  } else {
    lines.push("Summary unavailable (README not found or empty).");
  }
  lines.push("");
  return lines;
};

const formatRunSummary = (bundle: ContextBundle): string[] => {
  const lines: string[] = [];
  const request = bundle.request?.trim() || "unknown";
  const intentBuckets = bundle.intent?.intents?.join(", ") || "unknown";
  const digest = bundle.request_digest;
  const digestSummary = digest?.summary ?? "not available";
  const digestConfidence = digest?.confidence ?? "unknown";
  const project = bundle.project_info;
  const workspaceRoot = project?.workspace_root ?? "unknown";
  const docs = listOrNone(project?.docs ?? []);
  const manifests = listOrNone(project?.manifests ?? []);
  const fileTypes = listOrNone(project?.file_types ?? []);
  lines.push("RUN SUMMARY:");
  lines.push(`- Repo root: ${workspaceRoot}`);
  lines.push(`- Request (verbatim): ${request}`);
  lines.push(`- Intent buckets: ${intentBuckets}`);
  lines.push(`- Inferred outcome (${digestConfidence}): ${digestSummary}`);
  lines.push(`- Repo docs (purpose hints): ${docs}`);
  lines.push(`- Manifests: ${manifests}`);
  lines.push(`- File types: ${fileTypes}`);
  lines.push("");
  return lines;
};

const formatResearchSummary = (bundle: ContextBundle): string[] => {
  const research = bundle.research;
  if (!research) return [];
  const lines: string[] = [];
  const duration =
    typeof research.duration_ms === "number" ? ` (${research.duration_ms}ms)` : "";
  lines.push("RESEARCH SUMMARY:");
  lines.push(`- Status: ${research.status}${duration}`);
  if (research.tool_usage) {
    lines.push(
      `- Tool usage: search=${research.tool_usage.search}, open/snippet=${research.tool_usage.open_or_snippet}, symbols/ast=${research.tool_usage.symbols_or_ast}, impact=${research.tool_usage.impact}, tree=${research.tool_usage.tree}, dag_export=${research.tool_usage.dag_export}`,
    );
  } else {
    lines.push("- Tool usage: unknown");
  }
  if (research.evidence) {
    lines.push(
      `- Evidence: search_hits=${research.evidence.search_hits}, snippet_count=${research.evidence.snippet_count}, symbol_files=${research.evidence.symbol_files}, ast_files=${research.evidence.ast_files}, impact_files=${research.evidence.impact_files}, impact_edges=${research.evidence.impact_edges}, repo_map=${research.evidence.repo_map ? "yes" : "no"}, dag_summary=${research.evidence.dag_summary ? "yes" : "no"}`,
    );
  } else {
    lines.push("- Evidence: unknown");
  }
  const keyFindings = research.key_findings;
  lines.push(`- Key findings: ${formatSummaryList(keyFindings)}`);
  lines.push(`- Notes: ${formatSummaryList(research.notes)}`);
  const gaps = research.evidence?.gaps;
  lines.push(`- Unresolved gaps: ${formatSummaryList(gaps)}`);
  const warnings = [
    ...(research.warnings ?? []),
    ...(research.evidence?.warnings ?? []),
  ];
  lines.push(`- Warnings: ${formatSummaryList(warnings)}`);
  lines.push("");
  return lines;
};

const formatDeliverables = (bundle: ContextBundle): string[] => {
  const lines: string[] = [];
  const request = bundle.request?.trim() || "unknown";
  const digest = bundle.request_digest;
  const digestSummary = digest?.summary ?? "not available";
  const digestConfidence = digest?.confidence ?? "unknown";
  lines.push("WHAT TO DELIVER:");
  lines.push(`- Must satisfy request exactly: ${request}`);
  lines.push(`- Inferred deliverables (${digestConfidence}): ${digestSummary}`);
  lines.push("");
  return lines;
};

const formatAgentProtocol = (): string[] => {
  const lines: string[] = [];
  lines.push("AGENT PROTOCOL (REQUEST MORE CONTEXT):");
  lines.push(
    "- This bundle lists file paths only; request file contents, symbols, AST, impact, or DAG when needed.",
  );
  lines.push("- Use AGENT_REQUEST v1 with one or more needs. Supported needs:");
  lines.push(
    "- docdex.search, docdex.open, docdex.snippet, docdex.symbols, docdex.ast, docdex.impact, docdex.impact_diagnostics, docdex.tree, docdex.dag_export, docdex.web",
  );
  lines.push("- file.read, file.list, file.diff");
  lines.push("- Protocol reference: docs/codali-agent-protocol.md (request via file.read).");
  lines.push("- Docdex tool list: ~/.docdex/agents.md (request via file.read).");
  lines.push("Example AGENT_REQUEST:");
  lines.push("AGENT_REQUEST v1");
  lines.push("role: architect");
  lines.push("request_id: <uuid>");
  lines.push("needs:");
  lines.push("  - type: docdex.search");
  lines.push('    query: "..."');
  lines.push("    limit: 5");
  lines.push("  - type: docdex.open");
  lines.push('    path: "src/..."');
  lines.push("    start_line: 1");
  lines.push("    end_line: 200");
  lines.push("context:");
  lines.push('  summary: "Need file content to finalize plan"');
  lines.push("");
  return lines;
};

const formatContextCoverage = (
  bundle: ContextBundle,
  options: { includeContents: boolean },
): string[] => {
  const lines: string[] = [];
  const files = bundle.files ?? [];
  const focusContent = files.filter((file) => file.role === "focus").map((file) => file.path);
  const peripheryContent = files
    .filter((file) => file.role === "periphery")
    .map((file) => file.path);
  const selection = bundle.selection;
  const focusSelected = selection?.focus ?? [];
  const peripherySelected = selection?.periphery ?? [];
  const missing = bundle.missing?.length ? bundle.missing.join(", ") : "none";
  const warningSummary = bundle.warnings?.length
    ? `${bundle.warnings.length} warnings (see WARNINGS section)`
    : "none";
  const formatValue = (value: number | undefined): string =>
    typeof value === "number" && value >= 0 ? String(value) : "unknown";
  const indexInfo = bundle.index;
  const indexSummary = `docs_indexed=${formatValue(indexInfo?.num_docs)}, last_updated=${formatValue(
    indexInfo?.last_updated_epoch_ms,
  )}`;
  lines.push("CONTEXT COVERAGE:");
  lines.push(`- Focus files (selected): ${listOrNone(focusSelected)}`);
  lines.push(`- Periphery files (selected): ${listOrNone(peripherySelected)}`);
  if (options.includeContents) {
    lines.push(`- Full content included (focus): ${listOrNone(focusContent)}`);
    lines.push(`- Content included (periphery): ${listOrNone(peripheryContent)}`);
  } else {
    lines.push(`- File references included (focus): ${listOrNone(focusContent)}`);
    lines.push(`- File references included (periphery): ${listOrNone(peripheryContent)}`);
    lines.push("- File contents are withheld by default; request via AGENT_REQUEST if needed.");
  }
  lines.push(`- Index status: ${indexSummary}`);
  lines.push(`- Missing data: ${missing}`);
  lines.push(`- Warnings: ${warningSummary}`);
  lines.push("");
  return lines;
};

const formatIntent = (bundle: ContextBundle): string[] => {
  const intent = bundle.intent;
  if (!intent) return [];
  const lines: string[] = [];
  lines.push("INTENT:");
  lines.push(`- Buckets: ${intent.intents.join(", ") || "unknown"}`);
  const matchEntries = Object.entries(intent.matches ?? {});
  for (const [bucket, matches] of matchEntries) {
    if (!Array.isArray(matches) || matches.length === 0) continue;
    lines.push(`- ${bucket} matches: ${matches.join(", ")}`);
  }
  lines.push("");
  return lines;
};

const formatProjectInfo = (bundle: ContextBundle): string[] => {
  const info = bundle.project_info;
  if (!info) return [];
  const lines: string[] = [];
  lines.push("PROJECT INFO:");
  if (info.workspace_root) lines.push(`- Workspace root: ${info.workspace_root}`);
  if (info.manifests && info.manifests.length) {
    lines.push(`- Manifests: ${info.manifests.join(", ")}`);
  }
  if (info.readme_path) {
    lines.push(`- README: ${info.readme_path}`);
  }
  if (info.docs && info.docs.length) {
    lines.push(`- Docs: ${info.docs.join(", ")}`);
  }
  if (info.file_types && info.file_types.length) {
    lines.push(`- File types: ${info.file_types.join(", ")}`);
  }
  lines.push("");
  return lines;
};

const formatQueries = (bundle: ContextBundle): string[] => {
  if (!bundle.queries?.length) return [];
  const lines: string[] = [];
  lines.push("QUERIES:");
  for (const query of bundle.queries) {
    lines.push(`- ${query}`);
  }
  lines.push("");
  return lines;
};

const formatQuerySignals = (bundle: ContextBundle): string[] => {
  const signals = bundle.query_signals;
  if (!signals) return [];
  const lines: string[] = [];
  lines.push("QUERY SIGNALS:");
  if (signals.phrases.length) lines.push(`- Phrases: ${signals.phrases.join(", ")}`);
  if (signals.file_tokens.length) lines.push(`- File tokens: ${signals.file_tokens.join(", ")}`);
  if (signals.keyword_phrases.length) lines.push(`- Keyword phrases: ${signals.keyword_phrases.join(", ")}`);
  if (signals.keywords.length) lines.push(`- Keywords: ${signals.keywords.join(", ")}`);
  lines.push("");
  return lines;
};

const formatRequestDigest = (bundle: ContextBundle): string[] => {
  const digest = bundle.request_digest;
  if (!digest) return [];
  const lines: string[] = [];
  lines.push("REQUEST DIGEST:");
  lines.push(`- Summary: ${digest.summary}`);
  lines.push(`- Refined query: ${digest.refined_query}`);
  lines.push(`- Confidence: ${digest.confidence}`);
  if (digest.signals.length) {
    lines.push(`- Signals: ${digest.signals.join(", ")}`);
  }
  if (digest.candidate_files && digest.candidate_files.length) {
    lines.push(`- Candidate files: ${digest.candidate_files.join(", ")}`);
  }
  lines.push("");
  return lines;
};

const formatSearchResults = (bundle: ContextBundle): string[] => {
  if (!bundle.search_results?.length) return [];
  const lines: string[] = [];
  lines.push("SEARCH RESULTS:");
  for (const result of bundle.search_results) {
    lines.push(`- Query: ${result.query}`);
    if (!result.hits.length) {
      lines.push("  - (no hits)");
      continue;
    }
    for (const hit of result.hits) {
      const label = hit.path ?? hit.doc_id ?? "hit";
      const score = typeof hit.score === "number" ? ` (score: ${hit.score})` : "";
      lines.push(`  - ${label}${score}`);
    }
  }
  lines.push("");
  return lines;
};

const formatRelatedHits = (bundle: ContextBundle): string[] => {
  if (!bundle.search_results?.length || !bundle.selection) return [];
  const selected = new Set(bundle.selection?.all ?? []);
  const allHits = uniqueValues(
    bundle.search_results
      .flatMap((result) => result.hits)
      .map((hit) => hit.path ?? hit.doc_id ?? "")
      .filter((value) => value.length > 0),
  ).filter((path) => !selected.has(path));
  if (allHits.length === 0) return [];

  const testHits = allHits.filter(isTestPath).slice(0, 4);
  const docHits = allHits.filter((path) => !isTestPath(path) && isDocPath(path)).slice(0, 3);
  const otherHits = allHits
    .filter((path) => !isTestPath(path) && !isDocPath(path))
    .slice(0, 3);

  const lines: string[] = [];
  lines.push("RELATED HITS (NOT SELECTED):");
  if (testHits.length) lines.push(`- Tests: ${testHits.join(", ")}`);
  if (docHits.length) lines.push(`- Docs: ${docHits.join(", ")}`);
  if (otherHits.length) lines.push(`- Other: ${otherHits.join(", ")}`);
  lines.push("");
  return lines;
};

const formatFileReferences = (bundle: ContextBundle): string[] => {
  const files = bundle.files ?? [];
  const lines: string[] = [];
  lines.push("FILE REFERENCES (CONTENT WITHHELD):");
  if (files.length === 0) {
    lines.push("- none");
    lines.push("");
    return lines;
  }
  for (const file of files) {
    const role = file.role === "focus" ? "FOCUS" : "PERIPHERY";
    const metadata: string[] = [`slice=${file.sliceStrategy}`, `origin=${file.origin}`];
    if (typeof file.size === "number") metadata.push(`size=${file.size}`);
    if (file.truncated) metadata.push("truncated");
    if (file.warnings?.length) metadata.push(`warnings=${file.warnings.join("|")}`);
    lines.push(`- [${role}] ${file.path} (${metadata.join(", ")})`);
  }
  lines.push("");
  return lines;
};

const formatSymbols = (bundle: ContextBundle): string[] => {
  if (!bundle.symbols?.length) return [];
  const lines: string[] = [];
  lines.push("SYMBOLS:");
  const entries = bundle.symbols.slice(0, SECTION_LIMITS.maxSymbolEntries);
  for (const entry of entries) {
    lines.push(`--- ${entry.path} ---`);
    lines.push(truncateText(entry.summary, SECTION_LIMITS.maxSymbolChars));
    lines.push("");
  }
  if (bundle.symbols.length > SECTION_LIMITS.maxSymbolEntries) {
    lines.push(
      `- Symbol entries truncated: showing ${SECTION_LIMITS.maxSymbolEntries} of ${bundle.symbols.length}.`,
    );
    lines.push("");
  }
  return lines;
};

const formatAst = (bundle: ContextBundle): string[] => {
  if (!bundle.ast?.length) return [];
  const focusPaths = new Set(
    (bundle.files ?? []).filter((file) => file.role === "focus").map((file) => file.path),
  );
  const hasFocus = focusPaths.size > 0;
  const astEntries = hasFocus
    ? bundle.ast.filter((entry) => focusPaths.has(entry.path))
    : bundle.ast;
  if (astEntries.length === 0) return [];
  const lines: string[] = [];
  lines.push("AST:");
  const entries = astEntries.slice(0, SECTION_LIMITS.maxAstEntries);
  for (const entry of entries) {
    const nodes = entry.nodes.slice(0, SECTION_LIMITS.maxAstNodes);
    const astText = truncateText(JSON.stringify(nodes, null, 2), SECTION_LIMITS.maxAstChars);
    lines.push(`--- ${entry.path} ---`);
    lines.push(astText);
    if (entry.nodes.length > SECTION_LIMITS.maxAstNodes) {
      lines.push(
        `/* node list truncated: showing ${SECTION_LIMITS.maxAstNodes} of ${entry.nodes.length} */`,
      );
    }
    lines.push("");
  }
  if (astEntries.length > SECTION_LIMITS.maxAstEntries) {
    lines.push(`- AST entries truncated: showing ${SECTION_LIMITS.maxAstEntries} of ${astEntries.length}.`);
    lines.push("");
  }
  return lines;
};

const formatImpact = (bundle: ContextBundle): string[] => {
  if (!bundle.impact?.length) return [];
  const lines: string[] = [];
  lines.push("IMPACT GRAPH:");
  for (const entry of bundle.impact) {
    lines.push(`- ${entry.file}`);
    lines.push(`  - inbound: ${entry.inbound.join(", ") || "none"}`);
    lines.push(`  - outbound: ${entry.outbound.join(", ") || "none"}`);
  }
  lines.push("");
  return lines;
};

const formatDagSummary = (bundle: ContextBundle): string[] => {
  if (!bundle.dag_summary) return [];
  const lines: string[] = [];
  lines.push("DAG REASONING:");
  const summary = bundle.dag_summary;
  const parts = summary.split(/\r?\n/).map((line) => line.trim());
  const sessionLine = parts.find((line) => line.startsWith("session_id:"));
  const nodesLine = parts.find((line) => line.startsWith("nodes:"));
  const edgesLine = parts.find((line) => line.startsWith("edges:"));
  if (nodesLine || edgesLine) {
    const compact = [sessionLine, nodesLine, edgesLine].filter(Boolean).join(" ");
    lines.push(`${compact} (full DAG omitted; see logs if needed)`);
  } else {
    lines.push(truncateText(summary, 800));
  }
  lines.push("");
  return lines;
};

const formatMemory = (bundle: ContextBundle): string[] => {
  if (!bundle.memory?.length) return [];
  const lines: string[] = [];
  lines.push("REPO MEMORY:");
  for (const entry of bundle.memory.slice(0, SECTION_LIMITS.maxMemoryEntries)) {
    lines.push(`- ${truncateText(entry.text, SECTION_LIMITS.maxMemoryChars)}`);
  }
  if (bundle.memory.length > SECTION_LIMITS.maxMemoryEntries) {
    lines.push(`- (additional memory entries omitted: ${bundle.memory.length - SECTION_LIMITS.maxMemoryEntries})`);
  }
  lines.push("");
  return lines;
};

const formatEpisodicMemory = (bundle: ContextBundle): string[] => {
  if (!bundle.episodic_memory?.length) return [];
  const lines: string[] = [];
  lines.push("PAST SUCCESSFUL RUNS (EPISODIC MEMORY):");
  for (const entry of bundle.episodic_memory) {
    lines.push(`- Intent: ${entry.intent}`);
    lines.push(`  Plan: ${entry.plan.replace(/\n/g, "\\n")}`);
  }
  lines.push("");
  return lines;
};

const formatGoldenExamples = (bundle: ContextBundle): string[] => {
  if (!bundle.golden_examples?.length) return [];
  const lines: string[] = [];
  lines.push("GOLDEN EXAMPLES (Follow these patterns):");
  for (const entry of bundle.golden_examples) {
    lines.push(`- Intent: ${entry.intent}`);
    lines.push(`  Patch: ${entry.patch.replace(/\n/g, "\\n").slice(0, 500)}...`);
  }
  lines.push("");
  return lines;
};

const formatProfile = (bundle: ContextBundle): string[] => {
  if (!bundle.profile?.length) return [];
  const lines: string[] = [];
  lines.push("USER PROFILE:");
  for (const entry of bundle.profile.slice(0, SECTION_LIMITS.maxProfileEntries)) {
    lines.push(`- ${truncateText(entry.content, SECTION_LIMITS.maxProfileChars)}`);
  }
  if (bundle.profile.length > SECTION_LIMITS.maxProfileEntries) {
    lines.push(`- (additional profile entries omitted: ${bundle.profile.length - SECTION_LIMITS.maxProfileEntries})`);
  }
  lines.push("");
  return lines;
};

const formatIndexInfo = (bundle: ContextBundle): string[] => {
  if (!bundle.index) return [];
  const lines: string[] = [];
  const formatValue = (value: number): string =>
    value < 0 ? "unknown" : String(value);
  lines.push("INDEX INFO:");
  lines.push(`- Docs indexed: ${formatValue(bundle.index.num_docs)}`);
  lines.push(`- Last updated: ${formatValue(bundle.index.last_updated_epoch_ms)}`);
  lines.push("");
  return lines;
};

const formatWarnings = (bundle: ContextBundle): string[] => {
  if (!bundle.warnings?.length) return [];
  const lines: string[] = [];
  lines.push("WARNINGS:");
  for (const warning of bundle.warnings) {
    const { code, detail } = splitWarning(warning);
    const entry = WARNING_GLOSSARY[code];
    if (entry) {
      const detailLabel = detail ? ` (${detail})` : "";
      lines.push(`- [${entry.severity}] ${code}${detailLabel}: ${entry.message}`);
    } else {
      lines.push(`- ${warning}`);
    }
  }
  lines.push("");
  return lines;
};

const filterPolicyWarnings = (warnings: string[] = []): string[] =>
  warnings.filter((warning) => !warning.startsWith("write_policy_"));

const sanitizeResearchSummary = (
  summary?: ContextResearchSummary,
): ContextResearchSummary | undefined => {
  if (!summary) return undefined;
  const toolUsage = summary.tool_usage ? { ...summary.tool_usage } : undefined;
  const evidence = summary.evidence
    ? {
        ...summary.evidence,
        warnings: summary.evidence.warnings?.filter(Boolean),
        gaps: summary.evidence.gaps?.filter(Boolean),
      }
    : undefined;
  return {
    ...summary,
    key_findings: summary.key_findings?.filter(Boolean),
    tool_usage: toolUsage,
    evidence,
    warnings: summary.warnings?.filter(Boolean),
    notes: summary.notes?.filter(Boolean),
  };
};

export const sanitizeContextBundleForOutput = (bundle: ContextBundle): ContextBundle => {
  const sanitized: ContextBundle = { ...bundle };
  delete sanitized.allow_write_paths;
  delete sanitized.read_only_paths;
  sanitized.warnings = filterPolicyWarnings(bundle.warnings);
  sanitized.research = sanitizeResearchSummary(bundle.research);
  return sanitized;
};

export const serializeContext = (
  bundle: ContextBundle,
  options: ContextSerializerOptions,
): SerializedContext => {
  const audience = options.audience ?? "builder";
  if (options.mode === "json") {
    const files = bundle.files ?? [];
    const focusFiles = files.filter((file) => file.role === "focus").length;
    const peripheryFiles = files.filter((file) => file.role === "periphery").length;
    const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
    return {
      mode: "json",
      audience,
      content: JSON.stringify(bundle, null, 2),
      token_estimate: estimateTokens(JSON.stringify(bundle)),
      stats: { focus_files: focusFiles, periphery_files: peripheryFiles, total_bytes: totalBytes },
    };
  }

  const includeContents = audience === "builder";
  const lines: string[] = [];
  lines.push("CODALI LIBRARIAN CONTEXT");
  lines.push("");
  lines.push(...formatProjectSummary(bundle));
  lines.push(...formatRunSummary(bundle));
  lines.push(...formatResearchSummary(bundle));
  lines.push("USER REQUEST:");
  lines.push(bundle.request);
  lines.push("");
  lines.push(...formatDeliverables(bundle));
  lines.push(...formatContextCoverage(bundle, { includeContents }));
  if (!includeContents) {
    lines.push(...formatAgentProtocol());
  }
  lines.push(...formatIntent(bundle));
  lines.push(...formatProjectInfo(bundle));
  lines.push(...formatQueries(bundle));
  lines.push(...formatQuerySignals(bundle));
  lines.push(...formatRequestDigest(bundle));
  lines.push(...formatSearchResults(bundle));
  if (bundle.selection) {
    const focus = bundle.selection.focus.join(", ") || "none";
    const periphery = bundle.selection.periphery.join(", ") || "none";
    lines.push("SELECTION:");
    lines.push(`- Focus files: ${focus}`);
    lines.push(`- Periphery files: ${periphery}`);
    lines.push(`- Low confidence: ${bundle.selection.low_confidence ? "yes" : "no"}`);
    lines.push("");
  }
  lines.push(...formatRelatedHits(bundle));
  if (bundle.repo_map_raw) {
    lines.push("REPO MAP:");
    lines.push(bundle.repo_map_raw);
    lines.push("");
  } else if (bundle.repo_map) {
    lines.push("REPO MAP:");
    lines.push(bundle.repo_map);
    lines.push("");
  }
  const files = bundle.files ?? [];
  if (includeContents) {
    for (const file of files) {
      lines.push(formatFileHeader(file));
      lines.push(file.content);
      lines.push("");
    }
    if (files.length === 0) {
      lines.push("NO FILE CONTENT AVAILABLE");
      lines.push("");
    }
    if (bundle.snippets.length) {
      lines.push("SNIPPETS:");
      for (const snippet of bundle.snippets.slice(0, SECTION_LIMITS.maxSnippetEntries)) {
        const label = snippet.path ?? snippet.doc_id ?? "snippet";
        lines.push(`--- ${label} ---`);
        lines.push(truncateText(snippet.content, SECTION_LIMITS.maxSnippetChars));
        lines.push("");
      }
      if (bundle.snippets.length > SECTION_LIMITS.maxSnippetEntries) {
        lines.push(
          `- Snippet entries truncated: showing ${SECTION_LIMITS.maxSnippetEntries} of ${bundle.snippets.length}.`,
        );
        lines.push("");
      }
    }
    lines.push(...formatSymbols(bundle));
    lines.push(...formatAst(bundle));
    lines.push(...formatImpact(bundle));
    lines.push(...formatDagSummary(bundle));
  } else {
    lines.push(...formatFileReferences(bundle));
  }
  lines.push(...formatMemory(bundle));
  lines.push(...formatEpisodicMemory(bundle));
  lines.push(...formatGoldenExamples(bundle));
  lines.push(...formatProfile(bundle));
  lines.push(...formatIndexInfo(bundle));
  lines.push(...formatWarnings(bundle));
  if (bundle.missing && bundle.missing.length) {
    lines.push("MISSING DATA:");
    for (const entry of bundle.missing) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }
  if (includeContents && bundle.impact_diagnostics.length) {
    lines.push("IMPACT DIAGNOSTICS:");
    for (const entry of bundle.impact_diagnostics) {
      lines.push(`- ${entry.file}: ${JSON.stringify(entry.diagnostics)}`);
    }
  }
  lines.push("");
  lines.push("END OF CONTEXT");

  const focusFiles = files.filter((file) => file.role === "focus").length;
  const peripheryFiles = files.filter((file) => file.role === "periphery").length;
  const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
  return {
    mode: "bundle_text",
    audience,
    content: lines.join("\n"),
    token_estimate: estimateTokens(lines.join("\n")),
    stats: { focus_files: focusFiles, periphery_files: peripheryFiles, total_bytes: totalBytes },
  };
};
