import type { ContextBundle, ContextFileEntry, SerializedContext } from "./Types.js";

export interface ContextSerializerOptions {
  mode: "bundle_text" | "json";
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
};

const truncateText = (value: string, maxChars: number): string => {
  if (maxChars <= 0 || value.length <= maxChars) return value;
  const marker = "\n/* ...truncated... */\n";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
};

const formatFileHeader = (file: ContextFileEntry): string => {
  const role = file.role === "focus" ? "FOCUS FILE" : "DEPENDENCY";
  const detail = file.truncated ? "TRUNCATED" : "FULL";
  return `=== [${role}] ${file.path} (${detail}) ===`;
};

const listOrNone = (values: string[] = []): string =>
  values.length ? values.join(", ") : "none";

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

const formatContextCoverage = (bundle: ContextBundle): string[] => {
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
  lines.push(`- Full content included (focus): ${listOrNone(focusContent)}`);
  lines.push(`- Content included (periphery): ${listOrNone(peripheryContent)}`);
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
  const lines: string[] = [];
  lines.push("AST:");
  const entries = bundle.ast.slice(0, SECTION_LIMITS.maxAstEntries);
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
  if (bundle.ast.length > SECTION_LIMITS.maxAstEntries) {
    lines.push(`- AST entries truncated: showing ${SECTION_LIMITS.maxAstEntries} of ${bundle.ast.length}.`);
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
  lines.push(bundle.dag_summary);
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

const filterPolicyWarnings = (warnings: string[] = []): string[] =>
  warnings.filter((warning) => !warning.startsWith("write_policy_"));

export const sanitizeContextBundleForOutput = (bundle: ContextBundle): ContextBundle => {
  const sanitized: ContextBundle = { ...bundle };
  delete sanitized.allow_write_paths;
  delete sanitized.read_only_paths;
  sanitized.warnings = filterPolicyWarnings(bundle.warnings);
  return sanitized;
};

export const serializeContext = (
  bundle: ContextBundle,
  options: ContextSerializerOptions,
): SerializedContext => {
  if (options.mode === "json") {
    const files = bundle.files ?? [];
    const focusFiles = files.filter((file) => file.role === "focus").length;
    const peripheryFiles = files.filter((file) => file.role === "periphery").length;
    const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
    return {
      mode: "json",
      content: JSON.stringify(bundle, null, 2),
      token_estimate: estimateTokens(JSON.stringify(bundle)),
      stats: { focus_files: focusFiles, periphery_files: peripheryFiles, total_bytes: totalBytes },
    };
  }

  const lines: string[] = [];
  lines.push("CODALI LIBRARIAN CONTEXT");
  lines.push("");
  lines.push(...formatRunSummary(bundle));
  lines.push("USER REQUEST:");
  lines.push(bundle.request);
  lines.push("");
  lines.push(...formatDeliverables(bundle));
  lines.push(...formatContextCoverage(bundle));
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
  if (bundle.repo_map_raw) {
    if (bundle.repo_map && bundle.repo_map !== bundle.repo_map_raw) {
      lines.push("REPO MAP (COMPACT VIEW):");
      lines.push(bundle.repo_map);
      lines.push("");
      lines.push("REPO MAP (FULL):");
      lines.push(bundle.repo_map_raw);
      lines.push("");
    } else {
      lines.push("REPO MAP:");
      lines.push(bundle.repo_map_raw);
      lines.push("");
    }
  } else if (bundle.repo_map) {
    lines.push("REPO MAP:");
    lines.push(bundle.repo_map);
    lines.push("");
  }
  const files = bundle.files ?? [];
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
      lines.push(`- Snippet entries truncated: showing ${SECTION_LIMITS.maxSnippetEntries} of ${bundle.snippets.length}.`);
      lines.push("");
    }
  }
  lines.push(...formatSymbols(bundle));
  lines.push(...formatAst(bundle));
  lines.push(...formatImpact(bundle));
  lines.push(...formatDagSummary(bundle));
  lines.push(...formatMemory(bundle));
  lines.push(...formatEpisodicMemory(bundle));
  lines.push(...formatGoldenExamples(bundle));
  lines.push(...formatProfile(bundle));
  lines.push(...formatIndexInfo(bundle));
  if (bundle.missing && bundle.missing.length) {
    lines.push("MISSING DATA:");
    for (const entry of bundle.missing) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }
  if (bundle.warnings.length) {
    lines.push(`WARNINGS: ${bundle.warnings.join(", ")}`);
  }
  if (bundle.impact_diagnostics.length) {
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
    content: lines.join("\n"),
    token_estimate: estimateTokens(lines.join("\n")),
    stats: { focus_files: focusFiles, periphery_files: peripheryFiles, total_bytes: totalBytes },
  };
};
