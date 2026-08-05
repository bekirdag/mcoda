import type { CodaliContextPack, CodaliGatewayRequest } from "./CodaliGatewayTypes.js";
import type { CodaliGatewayStoredArtifact } from "./CodaliGatewayStore.js";
import type { CodaliArtifactRef } from "./CodaliGatewayTypes.js";

/**
 * The finishing step every run passes through.
 *
 * Skipping the large synthesizer for a simple factual lookup is sensible;
 * skipping *normalization* is not. Without one consistent finisher each tool
 * shapes its own output, citations quietly disappear, units go unlabelled, and
 * raw tool error strings leak to end users. So there is no path from a tool
 * result to a caller that does not come through here.
 *
 * Three modes:
 *
 *   - `deterministic` — one clean, well-attributed result. Formatted in code,
 *     no model call. This is what makes a simple lookup cheap.
 *   - `synthesizer`   — multiple, conflicting, or unstructured sources. Needs
 *     the large model to reconcile them.
 *   - `artifact`      — media. The artifact is the answer; prose only frames it.
 */

export type FinalizerMode = "deterministic" | "synthesizer" | "artifact";

export interface FinalizerDecision {
  mode: FinalizerMode;
  reason: string;
}

export interface FinalizerDecisionInput {
  request: CodaliGatewayRequest;
  contextPack: CodaliContextPack;
  artifacts: readonly CodaliArtifactRef[];
  /**
   * Set when the router judged this a direct lookup — a question whose answer
   * *is* the retrieved fact, rather than something that must be reasoned from
   * it. Required for the deterministic path.
   */
  directLookup?: boolean;
}

/**
 * A single high-confidence fact from one source, with nothing contradicting it
 * and nothing known to be missing, does not need a large model to restate it.
 */
const DETERMINISTIC_MIN_CONFIDENCE = 0.85;

export const decideFinalizerMode = (
  input: FinalizerDecisionInput,
): FinalizerDecision => {
  if (input.artifacts.length > 0) {
    return { mode: "artifact", reason: "run produced artifacts" };
  }

  // An explicit response schema means the caller wants structured output that
  // a deterministic formatter cannot invent. Always synthesize.
  if (input.request.response?.schema) {
    return { mode: "synthesizer", reason: "caller supplied a response schema" };
  }

  // The deterministic formatter restates a retrieved claim; it cannot reason.
  // "One high-confidence fact exists" is not sufficient grounds to use it —
  // the question "why is X failing?" may rest on a single solid fact and still
  // need real synthesis. So the router must have judged this a direct lookup.
  if (!input.directLookup) {
    return { mode: "synthesizer", reason: "not a direct lookup" };
  }

  const facts = input.contextPack.decisionFacts;
  if (facts.length !== 1) {
    return {
      mode: "synthesizer",
      reason: facts.length === 0 ? "no decision facts" : "multiple decision facts",
    };
  }
  if (input.contextPack.contradictions.length > 0) {
    return { mode: "synthesizer", reason: "contradictory evidence" };
  }
  if (input.contextPack.missingInformation.length > 0) {
    return { mode: "synthesizer", reason: "known missing information" };
  }
  if ((facts[0]?.confidence ?? 0) < DETERMINISTIC_MIN_CONFIDENCE) {
    return { mode: "synthesizer", reason: "single fact below confidence threshold" };
  }

  return { mode: "deterministic", reason: "single high-confidence fact" };
};

/**
 * Formats a single fact without a model call. Deliberately conservative: it
 * restates the claim and attributes it. It never paraphrases, because
 * paraphrasing without a model is how meaning gets lost.
 */
export const formatDeterministicAnswer = (contextPack: CodaliContextPack): string => {
  const fact = contextPack.decisionFacts[0];
  if (!fact) return "";
  const attribution = fact.sourceTitle ?? fact.sourceUri ?? fact.sourceId;
  const claim = fact.summary?.trim() || fact.claim.trim();
  return attribution ? `${claim}\n\nSource: ${attribution} [${fact.id}]` : claim;
};

/**
 * Frames artifacts as the answer. The artifact reference carries the payload;
 * this is only the surrounding text.
 */
export const formatArtifactAnswer = (
  artifacts: readonly CodaliArtifactRef[],
  existingAnswer?: string,
): string => {
  const framed = existingAnswer?.trim();
  const lines = artifacts.map((artifact) => {
    const location = artifact.path ?? artifact.uri ?? artifact.id;
    return `- ${artifact.type}: ${location}`;
  });
  const header = artifacts.length === 1 ? "Generated artifact:" : "Generated artifacts:";
  return [framed, framed ? "" : undefined, header, ...lines]
    .filter((line) => line !== undefined)
    .join("\n");
};

export const artifactRefsFromStored = (
  artifacts: readonly CodaliGatewayStoredArtifact[],
): CodaliArtifactRef[] =>
  artifacts.map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    uri: artifact.uri,
    path: artifact.path,
    model: artifact.model,
    taskId: artifact.taskId,
    mimeType:
      typeof artifact.metadata?.mimeType === "string"
        ? artifact.metadata.mimeType
        : undefined,
    metadata: artifact.metadata,
  }));
