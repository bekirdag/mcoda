import type { CodaliGatewayClassifierOutput } from "./CodaliGatewayTypes.js";

/**
 * Whether an answer must come from retrieved evidence, or may come from the
 * model itself.
 *
 * Codali was built for questions about things it cannot know — a tenant's Jira,
 * this week's commits, a repository it has never seen — so every answer was
 * required to rest on a tool result. Asked to compose a short poem, it searched
 * the repository, found nothing, and reported that the information could not be
 * verified. Asked a settled geography fact, it retrieved the answer and still
 * hedged.
 *
 * Both modes are necessary and they are not interchangeable:
 *
 * - `grounded` — the answer must be traceable to a source. Anything about the
 *   user's data, this workspace, or the current state of the world.
 * - `open` — the model answers from its own knowledge. Generation and ordinary
 *   reasoning, where there is no source to cite and demanding one produces a
 *   refusal instead of an answer.
 *
 * The default is `grounded`. A wrong `open` invents facts; a wrong `grounded`
 * only wastes a search, so the failure modes are not symmetric and the
 * uncertain case must fall to `grounded`.
 */
export type CodaliGroundingMode = "grounded" | "open";

export interface GroundingDecision {
  mode: CodaliGroundingMode;
  reason: string;
}

export interface GroundingDecisionInput {
  query: string;
  classifier: Pick<
    CodaliGatewayClassifierOutput,
    "needsPrivateData" | "needsFreshData" | "needsDocdex" | "needsAppTools"
  >;
}

/**
 * Verbs that ask for something to be produced rather than looked up.
 *
 * Deliberately anchored to the start of the request: "write a function" is a
 * generation request, while "where does the code write the config file" is a
 * question about this repository that happens to contain the word.
 */
const GENERATION_OPENERS =
  /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(?:write|generate|create|draft|compose|produce|give me|show me an example|make)\b/i;

/**
 * Nouns that mean "the thing in front of us" — the workspace or a live system.
 * Any of these forces `grounded` regardless of the verb, because "write a
 * summary of the README" is not a free composition.
 *
 * Bare communication nouns are deliberately absent. Listing `email` here made
 * "draft a polite email declining a meeting" a lookup against the user's
 * mailbox: the noun names the artifact being written, not data to fetch. A
 * possessive is what distinguishes the two, and that is covered below.
 */
const CONTEXT_NOUNS =
  /\b(?:this repo|this repository|this codebase|this project|the repo|the repository|the codebase|our code|readme|changelog|commit|commits|branch|pull request|jira|github|tenant|workspace|package\.json|\.ts\b|\.js\b|src\/|packages\/)/i;

/**
 * A possessive means the request is about something the user already has, so
 * the answer has to be fetched rather than composed. Kept broad on purpose:
 * over-triggering costs a wasted search, under-triggering answers a question
 * about someone's mailbox from memory.
 */
const POSSESSIVE = /\b(?:my|mine|our|ours|assigned to me|do i have|have i got)\b/i;

/**
 * Phrases asking about the present state of the world, which needs a source.
 *
 * A bare "last" is deliberately absent. Added to catch "when did the rate last
 * change", it also caught a SQL exercise whose text mentioned a rolling window
 * of days, and sent that to web research. Recency has to be
 * asked about, not merely mentioned, so the "last" forms are matched below
 * where a question word anchors them.
 */
const FRESHNESS_NOUNS =
  /\b(?:today|todays|current|currently|latest|most recent|recently|right now|this (?:week|month|year)|as of|news headline|stock price|weather|who is the)\b/i;

/** "when did X last change", "how recently", "what is the newest" — asked about, not mentioned. */
const RECENCY_QUESTION =
  /\b(?:when (?:did|was|has).{0,40}\b(?:last|most recently)\b|how recently|what(?:'s| is) the (?:newest|latest))/i;

export const decideGroundingMode = (
  input: GroundingDecisionInput,
): GroundingDecision => {
  const query = input.query ?? "";
  const classifier = input.classifier;

  // Never answer about someone's own data from memory, whatever the phrasing.
  if (classifier.needsPrivateData) {
    return { mode: "grounded", reason: "request touches private data" };
  }
  if (classifier.needsAppTools) {
    return { mode: "grounded", reason: "request needs product tools" };
  }
  if (CONTEXT_NOUNS.test(query)) {
    return { mode: "grounded", reason: "request names something in the workspace" };
  }
  if (POSSESSIVE.test(query)) {
    return { mode: "grounded", reason: "request is about the user's own data" };
  }
  if (
    FRESHNESS_NOUNS.test(query) ||
    RECENCY_QUESTION.test(query) ||
    classifier.needsFreshData
  ) {
    return { mode: "grounded", reason: "request needs current information" };
  }

  // A generation request with no workspace or freshness anchor has nothing to
  // retrieve. Checked after the anchors above so they always win.
  if (GENERATION_OPENERS.test(query)) {
    return { mode: "open", reason: "generation request with nothing to retrieve" };
  }

  if (!classifier.needsDocdex) {
    return { mode: "open", reason: "classifier found no need for retrieval" };
  }

  return { mode: "grounded", reason: "default" };
};

/**
 * Systems a request has to name before a connector to them is worth offering.
 *
 * A product connector reaches into somebody's account. Offering every one of
 * them to every question invited the planner to pick by surface resemblance:
 * asked who currently runs Microsoft it called `mcp:github:search_users`, and
 * asked for the newest Node.js release it called `get_latest_release`. Both are
 * public facts about a company, and neither is in anyone's account.
 */
const OWNED_SYSTEM_NOUNS =
  /\b(?:github|gitlab|bitbucket|jira|confluence|outlook|teams|calendar|inbox|mailbox|repository|repositories|repo|commit|commits|branch|branches|pull request|merge request|issue|issues|ticket|tickets|workspace|tenant)\b/i;

/**
 * Whether the request is about data the user owns, and so whether the
 * connectors that reach their accounts should be offered at all.
 *
 * Deliberately generous: a wrong "yes" offers a tool the planner may ignore,
 * while a wrong "no" hides the only tool that could have answered. So the
 * classifier's own judgement is honoured first, and either naming the system or
 * claiming the data is enough.
 */
export const requestTouchesOwnData = (
  query: string,
  classifier: Pick<GroundingDecisionInput["classifier"], "needsPrivateData" | "needsAppTools">,
): boolean =>
  classifier.needsPrivateData === true ||
  classifier.needsAppTools === true ||
  POSSESSIVE.test(query ?? "") ||
  OWNED_SYSTEM_NOUNS.test(query ?? "");
