import type { ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";

/** A deterministic provider response for lifecycle fixtures, not quality evidence. */
export function contractReviewFixture(request: ProviderRequest): ProviderResponse | undefined {
  if (request.tools?.length || !request.messages[0]?.content.startsWith("Prepare independent contract checks")) return undefined;
  const input = JSON.parse(request.messages[1].content) as { contractSources: { id: string; excerpts: { quoteIndex: number; text: string }[] }[]; targetSourceIds?: string[] };
  const checks = input.contractSources.filter(source => !input.targetSourceIds || input.targetSourceIds.includes(source.id))
    .map(source => ({ sourceId: source.id, quoteIndex: source.excerpts[0].quoteIndex,
    expectedBehavior: source.excerpts[0].text }));
  return { message: { role: "assistant", content: JSON.stringify({ checks }) }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
}

/** A passing review verdict for lifecycle fixtures: for every check in the
 * portion under review it cites text the review input really contains (a
 * source file, else a receipt output, else the proposed answer), so the
 * controller's quotation check accepts it. Not quality evidence. */
export function approvedReview(request: ProviderRequest): string {
  const parsed = request.messages.map(message => { try { return JSON.parse(message.content) as Record<string, any>; } catch { return undefined; } });
  const input = parsed.find(value => value?.contractChecklist);
  if (!input) return '{"passed":true,"findings":[]}';
  const inputs = new Set<string>((input.authoritativeInputs ?? []).map((value: { id: string }) => value.id.replace(/^input:/, "")));
  const usable = (text: unknown): text is string => typeof text === "string" && text.trim().length >= 8 && !/^\[(?:missing|binary|large)/.test(text);
  // A whole source file may be shorter than the minimum quotation; a page may not.
  const whole = (text: unknown): text is string => typeof text === "string" && !!text.trim() && !/^\[(?:missing|binary|large)/.test(text);
  const sources = [...Object.entries(input.source ?? {}).filter(([, text]) => whole(text)),
    ...parsed.flatMap(value => (value?.sourcePages ?? []).filter((page: { offset: number; truncated: boolean; content: string }) =>
      usable(page.content) || (page.offset === 0 && !page.truncated && whole(page.content)))
      .map((page: { path: string; content: string }) => [page.path, page.content]))]
    .filter((entry): entry is [string, string] => !inputs.has(entry[0] as string));
  const receipt = (input.receipts ?? []).find((value: { output?: unknown }) => usable(value.output));
  const evidence: Record<string, unknown> = {};
  for (const check of input.contractChecklist.checks as { id: string; quoteId: string }[]) {
    const sourceId = input.contractChecklist.quotes[check.quoteId]?.sourceId as string | undefined;
    const source = sources.find(([file]) => sourceId !== `delivered:${file}`);
    evidence[check.id] = source ? { path: source[0], quote: source[1].trim().slice(0, 40) }
      : receipt ? { receipt: receipt.id, observed: receipt.output.trim().slice(0, 40) }
      : { summary: String(input.claimedSummary ?? "").trim().slice(0, 40) };
  }
  return JSON.stringify({ passed: true, findings: [], evidence });
}
