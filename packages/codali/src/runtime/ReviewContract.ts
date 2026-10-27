import type { Provider, ProviderMessage } from "../providers/ProviderTypes.js";

export interface ReviewContractSource { id: string; text: string }
export interface ReviewContractCheck { sourceId: string; contractQuote: string; expectedBehavior: string }
export type ReviewContractResult = { checks: ReviewContractCheck[] } | { findings: string[] };

export function reviewContractSources(context: {
  goal?: string;
  requirements: readonly { id: string; description: string }[];
  constraints: readonly string[];
  nonGoals: readonly string[];
}): ReviewContractSource[] {
  const separateGoal = context.goal && !context.requirements.some(value => value.description === context.goal);
  return [
    ...(separateGoal ? [{ id: "goal", text: context.goal! }] : []),
    // The current goal may contain the original objective and later steering
    // verbatim. Keep those bytes once; the review still receives every criterion.
    ...context.requirements.filter(value => !separateGoal || !context.goal!.includes(value.description))
      .map(value => ({ id: `requirement:${value.id}`, text: value.description })),
    ...context.constraints.map((text, index) => ({ id: `constraint:${index}`, text })),
    ...context.nonGoals.map((text, index) => ({ id: `nonGoal:${index}`, text })),
  ];
}

const instruction = 'Prepare independent contract checks before seeing implementation, tests, diffs or claimed results. Use only the supplied authoritative sources. This is verification after authorized task execution; distinguish obligations that apply only during earlier planning. Preserve explicit error types, exact messages, schema fields, defaults, boundaries, side-effect rules and temporal/conditional qualifications. Do not invent behavior or relax quoted literals into substring matches. Reply exactly JSON {"checks":[{"sourceId":string,"quoteIndex":integer,"expectedBehavior":string}]}. Each source contains an excerpts array: concatenating its strings in order reconstructs its complete original text without changes. Read them together; excerpt boundaries do not separate or qualify obligations. quoteIndex is the zero-based index of the supporting excerpt in that identified source. Select the index instead of copying or rewriting the quotation; the controller supplies the exact source bytes. When targetSourceIds is supplied, generate checks only for those sources; all supplied sources remain authoritative context for interpreting conditions and qualifications. Include at least one check for every targeted source (every source when no targets are given), and enough checks to cover its distinct obligations. Multiple checks may cite the same excerpt. Keep each expectedBehavior concise; avoid repeating the same obligation. expectedBehavior states a concrete observable check, not an approval. These checks are an aid, never a replacement for the complete original contract. No tools.';

/** Lossless source slices; preserve whitespace and never split a surrogate pair. */
function sourceExcerpts(text: string): string[] {
  const excerpts: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 512, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n", end - 1), text.lastIndexOf(" ", end - 1), text.lastIndexOf("\t", end - 1));
      if (boundary >= offset + 256) end = boundary + 1;
      const last = text.charCodeAt(end - 1);
      if (last >= 0xD800 && last <= 0xDBFF) end--;
    }
    excerpts.push(text.slice(offset, end)); offset = end;
  }
  return excerpts;
}

function validate(value: unknown, sources: readonly ReviewContractSource[]): ReviewContractCheck[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a checklist object");
  const checks = (value as { checks?: unknown }).checks;
  if (!Array.isArray(checks) || !checks.length || checks.length > 256) throw new Error("Expected one to 256 checks");
  const seen = new Set<string>();
  const normalized: ReviewContractCheck[] = [];
  for (const [index, check] of checks.entries()) {
    if (!check || typeof check !== "object" || Array.isArray(check)) throw new Error("Invalid check object");
    const source = sources.find(item => item.id === check.sourceId);
    if (!source) throw new Error("Check " + index + " does not identify a targeted authoritative source");
    let quote: unknown = check.contractQuote;
    if (Object.prototype.hasOwnProperty.call(check, "quoteIndex")) {
      const excerpts = sourceExcerpts(source.text);
      if (!Number.isInteger(check.quoteIndex) || check.quoteIndex < 0 || check.quoteIndex >= excerpts.length) {
        throw new Error("Check " + index + " has an invalid excerpt index");
      }
      quote = excerpts[check.quoteIndex];
      if (Object.prototype.hasOwnProperty.call(check, "contractQuote") && check.contractQuote !== quote) {
        throw new Error("Check " + index + " conflicts with its selected source excerpt");
      }
    }
    // Older provider fixtures/responses remain accepted only with exact quotes.
    if (typeof quote !== "string" || !quote.trim() || quote.length > 2048 || !source.text.includes(quote)) {
      throw new Error("Each check needs an exact quote from its identified source");
    }
    if (typeof check.expectedBehavior !== "string" || !check.expectedBehavior.trim() || check.expectedBehavior.length > 4000) {
      throw new Error("Each check needs a bounded expected behavior");
    }
    seen.add(source.id);
    normalized.push({ sourceId: source.id, contractQuote: quote, expectedBehavior: check.expectedBehavior });
  }
  if (sources.some(source => !seen.has(source.id))) throw new Error("The checklist omitted an authoritative source");
  return normalized;
}

/** Bounded specification-only batches and one format repair per batch, through
 * the same accounted provider as review. Every call retains all authoritative
 * sources; implementation, test expectations and tools are never sent. */
export async function prepareReviewContract(options: {
  provider: Provider;
  sources: readonly ReviewContractSource[];
  maxInputChars: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<ReviewContractResult> {
  const reject = (message: string): ReviewContractResult => ({ findings: [message] });
  if (!options.sources.length || options.sources.length > 256 || new Set(options.sources.map(source => source.id)).size !== options.sources.length
    || options.sources.some(source => !source.id.trim() || !source.text.trim())) {
    return reject("Contract review requires distinct, nonempty authoritative sources; acceptance is not established.");
  }
  const batches: ReviewContractSource[][] = []; let batch: ReviewContractSource[] = []; let chars = 0;
  const targetChars = Math.max(1024, Math.floor((options.maxOutputTokens ?? 4096) / 2));
  for (const source of options.sources) {
    if (batch.length && chars + source.text.length > targetChars) { batches.push(batch); batch = []; chars = 0; }
    batch.push(source); chars += source.text.length;
  }
  if (batch.length) batches.push(batch);
  if (batches.length > 16) return reject("Contract preparation requires too many bounded batches. Split the task or select a larger compatible reviewer; acceptance is not established.");
  const contractSources = options.sources.map(source => ({ id: source.id, excerpts: sourceExcerpts(source.text) }));
  const checks: ReviewContractCheck[] = [];
  for (const targets of batches) {
    const messages: ProviderMessage[] = [
      { role: "system", content: instruction },
      { role: "user", content: JSON.stringify({ contractSources,
        ...(batches.length > 1 ? { targetSourceIds: targets.map(source => source.id) } : {}) }) },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      options.signal?.throwIfAborted();
      if (JSON.stringify(messages).length > options.maxInputChars) {
        return reject("Required contract checks exceed the configured review context. Split the task or select a larger compatible reviewer; acceptance is not established.");
      }
      // Parse locally so malformed output and usage reach the accounted caller.
      const response = await options.provider.generate({ messages, signal: options.signal, maxTokens: options.maxOutputTokens ?? 4096 });
      options.signal?.throwIfAborted();
      if (response.toolCalls?.length || response.message.toolCalls?.length) return reject("Contract preparation returned an unsupported tool call; acceptance is not established.");
      try { checks.push(...validate(JSON.parse(response.message.content), targets)); break; }
      catch (error) {
        const detail = error instanceof SyntaxError ? "Response is not valid JSON" : error instanceof Error ? error.message : "Invalid checklist";
        if (attempt === 1) return reject(`Contract preparation failed validation: ${detail}. Acceptance is not established.`);
        messages.push({ role: "assistant", content: response.message.content });
        messages.push({ role: "user", content: `Return a corrected complete checklist for the same targets using the original sources. Validation failure: ${detail}. Preserve every original obligation; do not return an acceptance verdict.` });
      }
    }
    if (checks.length > 256) return reject("Contract preparation exceeded the bounded checklist size; acceptance is not established.");
  }
  return { checks };
}
