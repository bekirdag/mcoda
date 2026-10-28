import type { ProviderRequest } from "../providers/ProviderTypes.js";

const FINAL_ANSWER = "Finish this read-only investigation now using the evidence already collected. Answer the user's question in their requested format. Clearly state any missing evidence or unresolved uncertainty; never invent findings or claim an unperformed check. No further tool calls are available in this turn.";

/** Keep room for reporting before spending the remainder on another lookup. */
export function budgetInspection(request: ProviderRequest, remainingTokens: number, remainingCalls: number,
  remainingSteps: number): { request: ProviderRequest; finalizing: boolean } {
  const output = request.maxTokens ?? 1024;
  const estimate = (value: ProviderRequest) => Math.ceil(JSON.stringify({ messages: value.messages, tools: value.tools }).length / 3) + output;
  const finalRequest: ProviderRequest = { ...request, tools: undefined, toolChoice: "none",
    messages: [...request.messages, { role: "system", content: FINAL_ANSWER }] };
  // Allow one bounded 6,000-character result and the next assistant message.
  // Batched/oversized results remain subject to the shared admission gate;
  // this projection never bypasses accounting or raises the configured cap.
  const nextAnswer = estimate(finalRequest) + 2000 + output;
  const finalizing = !request.tools?.length || request.toolChoice === "none" || remainingCalls < 2 || remainingSteps < 2
    || estimate(request) + nextAnswer > remainingTokens;
  return { request: finalizing ? finalRequest : request, finalizing };
}
