export interface NativeReasoningRequest { reasoning_effort?: string; reasoning_budget_tokens?: number }

/** Preserve explicit none/zero, reject malformed values, and never forward
 * arbitrary request fields into the local runner or its pinned profile. */
export function nativeReasoningRequest(input: Record<string, unknown>): NativeReasoningRequest {
  const result: NativeReasoningRequest = {};
  if (input.reasoning_effort !== undefined) {
    if (typeof input.reasoning_effort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.reasoning_effort)) throw new Error("Invalid reasoning_effort");
    result.reasoning_effort = input.reasoning_effort;
  }
  if (input.reasoning_budget_tokens !== undefined) {
    const value = input.reasoning_budget_tokens;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new Error("Invalid reasoning_budget_tokens");
    result.reasoning_budget_tokens = value;
  }
  return result;
}
