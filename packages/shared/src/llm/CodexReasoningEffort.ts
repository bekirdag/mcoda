/**
 * Reasoning efforts codex-cli accepts for `model_reasoning_effort`.
 *
 * Ordered weakest to strongest. The order is load-bearing: callers that need to
 * cap an effort at a model's ceiling compare ranks rather than enumerate the
 * values above it.
 *
 * This mirrors codex-cli's own ReasoningEffort enum
 * (Minimal|Low|Medium|High|XHigh|Max|Ultra). Verified against codex-cli 0.147.0:
 * `codex exec -m gpt-5.6-sol -c model_reasoning_effort=ultra` reports
 * `reasoning effort: ultra` in the session header and completes normally, and
 * a value outside the enum is rejected upstream with
 * "[reasoning.effort] [invalid_enum_value]".
 */
export const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export const isCodexReasoningEffort = (value: string): value is CodexReasoningEffort =>
  (CODEX_REASONING_EFFORTS as readonly string[]).includes(value);

/** Returns the canonical effort, or undefined when the value is not one codex accepts. */
export const normalizeCodexReasoningEffort = (
  raw: string | undefined,
): CodexReasoningEffort | undefined => {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  return isCodexReasoningEffort(normalized) ? normalized : undefined;
};

/** Position in CODEX_REASONING_EFFORTS; higher means more reasoning. */
export const codexReasoningEffortRank = (effort: CodexReasoningEffort): number =>
  CODEX_REASONING_EFFORTS.indexOf(effort);
