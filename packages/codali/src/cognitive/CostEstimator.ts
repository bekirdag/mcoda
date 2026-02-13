import type { ProviderUsage } from "../providers/ProviderTypes.js";

export type PricingSpec = {
  inputPer1K?: number;
  outputPer1K?: number;
  per1K?: number;
};

export type PricingOverrides = Record<string, PricingSpec>;

export interface PricingResolution {
  pricing?: PricingSpec;
  source?: string;
}

export interface CostEstimate {
  charCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  estimatedCost?: number;
  pricingSource?: string;
}

const DEFAULT_OUTPUT_RATIO = 0.25;

export const resolvePricing = (
  overrides: PricingOverrides,
  provider: string,
  model: string,
): PricingResolution => {
  const candidates = [
    `${provider}:${model}`,
    model,
    provider,
    "default",
  ];
  for (const key of candidates) {
    const pricing = overrides[key];
    if (pricing) {
      return { pricing, source: key };
    }
  }
  return {};
};

const computeCost = (
  inputTokens: number,
  outputTokens: number,
  pricing?: PricingSpec,
): number | undefined => {
  if (!pricing) return undefined;
  if (pricing.per1K !== undefined) {
    return ((inputTokens + outputTokens) / 1000) * pricing.per1K;
  }
  if (pricing.inputPer1K !== undefined || pricing.outputPer1K !== undefined) {
    const inputRate = pricing.inputPer1K ?? 0;
    const outputRate = pricing.outputPer1K ?? 0;
    return (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate;
  }
  return undefined;
};

export const estimateCostFromChars = (
  charCount: number,
  charPerToken: number,
  pricing?: PricingSpec,
  pricingSource?: string,
  outputTokenRatio: number = DEFAULT_OUTPUT_RATIO,
): CostEstimate => {
  if (charPerToken <= 0) {
    throw new Error("charPerToken must be greater than zero");
  }
  const estimatedInputTokens = Math.ceil(charCount / charPerToken);
  const estimatedOutputTokens = Math.ceil(estimatedInputTokens * outputTokenRatio);
  const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
  const estimatedCost = computeCost(estimatedInputTokens, estimatedOutputTokens, pricing);
  return {
    charCount,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens,
    estimatedCost,
    pricingSource,
  };
};

export const estimateCostFromUsage = (
  usage: ProviderUsage | undefined,
  pricing?: PricingSpec,
): number | undefined => {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? Math.max((usage.totalTokens ?? 0) - inputTokens, 0);
  return computeCost(inputTokens, outputTokens, pricing);
};
