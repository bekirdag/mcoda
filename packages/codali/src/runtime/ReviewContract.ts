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
  return [
    ...(context.goal && !context.requirements.some(value => value.description === context.goal) ? [{ id: "goal", text: context.goal }] : []),
    ...context.requirements.map(value => ({ id: `requirement:${value.id}`, text: value.description })),
    ...context.constraints.map((text, index) => ({ id: `constraint:${index}`, text })),
    ...context.nonGoals.map((text, index) => ({ id: `nonGoal:${index}`, text })),
  ];
}

const instruction = 'Prepare independent contract checks before seeing implementation, tests, diffs or claimed results. Use only the supplied authoritative sources. This is verification after authorized task execution; distinguish obligations that apply only during earlier planning. Preserve explicit error types, exact messages, schema fields, defaults, boundaries, side-effect rules and temporal/conditional qualifications. Do not invent behavior or relax quoted literals into substring matches. Reply exactly JSON {"checks":[{"sourceId":string,"contractQuote":string,"expectedBehavior":string}]}. Include at least one check for every source, and enough checks to cover its distinct obligations. sourceId must identify a supplied source; contractQuote must be a nonempty verbatim excerpt of that same source (prefer at most 512 characters). expectedBehavior states a concrete observable check, not an approval. These checks are an aid, never a replacement for the complete original contract. No tools.';

function validate(value: unknown, sources: readonly ReviewContractSource[]): ReviewContractCheck[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a checklist object");
  const checks = (value as { checks?: unknown }).checks;
  if (!Array.isArray(checks) || !checks.length || checks.length > 256) throw new Error("Expected one to 256 checks");
  const seen = new Set<string>();
  for (const check of checks) {
    if (!check || typeof check !== "object" || Array.isArray(check)) throw new Error("Invalid check object");
    const source = sources.find(item => item.id === check.sourceId);
    if (!source || typeof check.contractQuote !== "string" || !check.contractQuote.trim()
      || check.contractQuote.length > 2048 || !source.text.includes(check.contractQuote)) {
      throw new Error("Each check needs an exact quote from its identified source");
    }
    if (typeof check.expectedBehavior !== "string" || !check.expectedBehavior.trim() || check.expectedBehavior.length > 4000) {
      throw new Error("Each check needs a bounded expected behavior");
    }
    seen.add(source.id);
  }
  if (sources.some(source => !seen.has(source.id))) throw new Error("The checklist omitted an authoritative source");
  return checks.map(({ sourceId, contractQuote, expectedBehavior }) => ({ sourceId, contractQuote, expectedBehavior }));
}

/** One specification-only call and at most one format repair, through the same
 * accounted provider as review. No source, test expectations or tools are sent. */
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
  const messages: ProviderMessage[] = [
    { role: "system", content: instruction },
    { role: "user", content: JSON.stringify({ contractSources: options.sources }) },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    options.signal?.throwIfAborted();
    if (JSON.stringify(messages).length > options.maxInputChars) {
      return reject("Required contract checks exceed the configured review context. Split the task or select a larger compatible reviewer; acceptance is not established.");
    }
    // Parse the protocol here so malformed model output and its usage reach the
    // accounted caller instead of becoming a native structured-output HTTP error.
    const response = await options.provider.generate({ messages, signal: options.signal, maxTokens: options.maxOutputTokens ?? 4096 });
    options.signal?.throwIfAborted();
    if (response.toolCalls?.length || response.message.toolCalls?.length) return reject("Contract preparation returned an unsupported tool call; acceptance is not established.");
    try { return { checks: validate(JSON.parse(response.message.content), options.sources) }; }
    catch (error) {
      if (attempt === 1) return reject(`Contract preparation failed validation: ${error instanceof Error ? error.message : String(error)}. Acceptance is not established.`);
      messages.push({ role: "assistant", content: response.message.content });
      messages.push({ role: "user", content: `Return a corrected complete checklist using the original sources. Validation failure: ${error instanceof Error ? error.message : String(error)}. Preserve every original obligation; do not return an acceptance verdict.` });
    }
  }
  return reject("Contract preparation did not establish review evidence.");
}
