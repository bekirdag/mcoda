export type DocdexGuidanceOptions = {
  contextLabel: string;
  includeHeading?: boolean;
  includeFallback?: boolean;
};

const DOCDEX_QUERY_EXAMPLE =
  "`docdexd search --repo <workspaceRoot> --query \"<query>\"` or `DOCDEX_REPO=<workspaceRoot> docdexd search --query \"<query>\"`";

export const buildDocdexUsageGuidance = ({
  contextLabel,
  includeHeading = false,
  includeFallback = true,
}: DocdexGuidanceOptions): string => {
  const lines: string[] = [];
  if (includeHeading) {
    lines.push("## Docdex Usage (required)");
  }
  lines.push("Docdex context is injected by mcoda; do not run docdexd directly.");
  lines.push(
    `If more context is needed, list the exact docdex queries in ${contextLabel} and always scope to the repo (example: ${DOCDEX_QUERY_EXAMPLE}).`,
  );
  const fallback = includeFallback ? " and fall back to local docs." : ".";
  lines.push(`If docdex is unavailable or returns no results, say so in ${contextLabel}${fallback}`);
  return lines.join("\n");
};
