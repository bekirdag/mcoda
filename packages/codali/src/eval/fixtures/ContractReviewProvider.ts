import type { ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";

/** A deterministic provider response for lifecycle fixtures, not quality evidence. */
export function contractReviewFixture(request: ProviderRequest): ProviderResponse | undefined {
  if (request.tools?.length || !request.messages[0]?.content.startsWith("Prepare independent contract checks")) return undefined;
  const input = JSON.parse(request.messages[1].content) as { contractSources: { id: string; text: string }[]; targetSourceIds?: string[] };
  const checks = input.contractSources.filter(source => !input.targetSourceIds || input.targetSourceIds.includes(source.id))
    .map(source => ({ sourceId: source.id, contractQuote: source.text.slice(0, 512),
    expectedBehavior: source.text.slice(0, 512) }));
  return { message: { role: "assistant", content: JSON.stringify({ checks }) }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
}
