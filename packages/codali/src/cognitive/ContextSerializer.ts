import type { ContextBundle, ContextFileEntry, SerializedContext } from "./Types.js";

export interface ContextSerializerOptions {
  mode: "bundle_text" | "json";
}

const estimateTokens = (content: string): number => Math.max(1, Math.ceil(content.length / 4));

const formatFileHeader = (file: ContextFileEntry): string => {
  const role = file.role === "focus" ? "FOCUS FILE" : "DEPENDENCY";
  const detail = file.truncated ? "TRUNCATED" : "FULL";
  return `=== [${role}] ${file.path} (${detail}) ===`;
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
  lines.push("USER REQUEST:");
  lines.push(bundle.request);
  lines.push("");
  if (bundle.selection) {
    const focus = bundle.selection.focus.join(", ") || "none";
    const periphery = bundle.selection.periphery.join(", ") || "none";
    lines.push("SELECTION:");
    lines.push(`- Focus files: ${focus}`);
    lines.push(`- Periphery files: ${periphery}`);
    lines.push("");
  }
  lines.push("CONTEXT:");
  if ((bundle.allow_write_paths?.length ?? 0) > 0 || (bundle.read_only_paths?.length ?? 0) > 0) {
    const hasAllow = (bundle.allow_write_paths?.length ?? 0) > 0;
    const hasReadOnly = (bundle.read_only_paths?.length ?? 0) > 0;
    const allowList = hasAllow
      ? bundle.allow_write_paths!.join(", ")
      : hasReadOnly
        ? "all (except read-only)"
        : "unspecified";
    const readOnlyList = hasReadOnly ? bundle.read_only_paths!.join(", ") : "none";
    lines.push("WRITE POLICY:");
    lines.push(`- Allowed write paths: ${allowList}`);
    lines.push(`- Read-only paths: ${readOnlyList}`);
    lines.push("");
  }
  if (bundle.repo_map) {
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
  if (bundle.snippets.length) {
    lines.push("SNIPPETS:");
    for (const snippet of bundle.snippets) {
      const label = snippet.path ?? snippet.doc_id ?? "snippet";
      lines.push(`--- ${label} ---`);
      lines.push(snippet.content);
      lines.push("");
    }
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
