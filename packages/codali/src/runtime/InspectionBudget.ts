import type { ProviderRequest } from "../providers/ProviderTypes.js";

const FINAL_ANSWER = "Finish this read-only investigation now using the evidence already collected. Answer the user's question in their requested format. Clearly state any missing evidence or unresolved uncertainty; never invent findings or claim an unperformed check. No further tool calls are available in this turn.";

/** Keep room for reporting before spending the remainder on another lookup. */
export function budgetInspection(request: ProviderRequest, remainingTokens: number, remainingCalls: number,
  remainingSteps: number, maxToolResultChars = 6000, finalSystemPrompt?: string): { request: ProviderRequest; finalizing: boolean; finalAnswerTokens: number } {
  const output = request.maxTokens ?? 1024;
  const estimate = (value: ProviderRequest) => Math.ceil(JSON.stringify({ messages: value.messages, tools: value.tools }).length / 3) + (value.maxTokens ?? output);
  const finalRequest: ProviderRequest = { ...request, tools: undefined, toolChoice: "none",
    messages: [...(finalSystemPrompt === undefined ? request.messages : request.messages.map((message, index) =>
      index === 0 && message.role === "system" ? { ...message, content: finalSystemPrompt } : message)), { role: "system", content: FINAL_ANSWER }] };
  // Use the actual tool-loop result cap, not the largest possible lookup.
  // Batched/oversized results remain subject to the shared admission gate;
  // this projection never bypasses accounting or raises the configured cap.
  const nextAnswer = estimate(finalRequest) + Math.ceil(maxToolResultChars / 3);
  // A tool-selection call normally needs fewer output tokens than a final
  // answer. Lower its ceiling when that retains an evidence-gathering round;
  // the final answer keeps the configured ceiling and the shared cap is fixed.
  let next = request;
  for (const ceiling of [512, 256]) {
    if (estimate(next) + nextAnswer + (next.maxTokens ?? output) <= remainingTokens) break;
    if ((next.maxTokens ?? output) > ceiling) next = { ...request, maxTokens: ceiling };
  }
  const finalizing = !request.tools?.length || request.toolChoice === "none" || remainingCalls < 2 || remainingSteps < 2
    || estimate(next) + nextAnswer + (next.maxTokens ?? output) > remainingTokens;
  return { request: finalizing ? finalRequest : next, finalizing, finalAnswerTokens: finalizing ? 0 : nextAnswer + (next.maxTokens ?? output) };
}
