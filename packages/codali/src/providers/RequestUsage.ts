import type { ProviderUsage } from "./ProviderTypes.js";

export interface RequestUsageReceipt {
  requestId: string;
  complete: boolean;
  invocationIds: string[];
  usage?: Required<ProviderUsage>;
  reason?: string;
}

/** A partial page, active attempt or absent counter cannot settle a reservation. */
export function parseRequestUsage(requestId: string, payload: unknown): RequestUsageReceipt {
  const value = payload as Record<string, unknown> | null;
  if (!value || value.schema_version !== 1 || value.client_request_id !== requestId ||
      typeof value.truncated !== "boolean" || !Array.isArray(value.invocations) ||
      value.invocations.length === 0 || value.invocations.length > 16) throw new Error("Invalid request usage receipt");
  const ids = new Set<string>(); let complete = !value.truncated;
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const valid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  for (const item of value.invocations) {
    const row = item as Record<string, unknown> | null;
    if (!row || typeof row.id !== "string" || !row.id || row.id.length > 256 || ids.has(row.id) ||
        row.operation !== "chat.completions" || !["reserved", "queued", "leased", "started", "success", "failed", "timeout"].includes(String(row.status))) {
      throw new Error("Invalid request usage invocation");
    }
    ids.add(row.id);
    const tokens = row.usage as Record<string, unknown> | null;
    if (!["success", "failed", "timeout"].includes(String(row.status)) || !tokens ||
        !valid(tokens.prompt_tokens) || !valid(tokens.completion_tokens) || !valid(tokens.total_tokens) ||
        tokens.total_tokens < tokens.prompt_tokens + tokens.completion_tokens) { complete = false; continue; }
    usage.inputTokens += tokens.prompt_tokens; usage.outputTokens += tokens.completion_tokens; usage.totalTokens += tokens.total_tokens;
  }
  if (!Object.values(usage).every(valid)) throw new Error("Request usage exceeds safe accounting bounds");
  return { requestId, complete, invocationIds: [...ids], ...(complete ? { usage } : { reason: "Server receipt is incomplete, active, or has unreported usage" }) };
}
