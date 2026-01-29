import type { ProviderMessage } from "../providers/ProviderTypes.js";

export interface BudgetEstimate {
  totalTokens: number;
  systemTokens: number;
  bundleTokens: number;
  historyTokens: number;
}

export const DEFAULT_CHAR_PER_TOKEN = 4;
export const DEFAULT_MODEL_TOKEN_LIMIT = 8192;

export const estimateTokens = (text: string, charPerToken: number = DEFAULT_CHAR_PER_TOKEN): number => {
  if (!text) return 0;
  if (charPerToken <= 0) {
    throw new Error("charPerToken must be greater than zero");
  }
  return Math.ceil(text.length / charPerToken);
};

export const estimateMessagesTokens = (
  messages: ProviderMessage[],
  charPerToken: number = DEFAULT_CHAR_PER_TOKEN,
): number => messages.reduce((total, message) => total + estimateTokens(message.content ?? "", charPerToken), 0);

export const estimateBudget = (input: {
  systemPrompt?: string;
  bundle?: string;
  history?: ProviderMessage[];
  charPerToken?: number;
}): BudgetEstimate => {
  const charPerToken = input.charPerToken ?? DEFAULT_CHAR_PER_TOKEN;
  const systemTokens = estimateTokens(input.systemPrompt ?? "", charPerToken);
  const bundleTokens = estimateTokens(input.bundle ?? "", charPerToken);
  const historyTokens = input.history ? estimateMessagesTokens(input.history, charPerToken) : 0;
  return {
    totalTokens: systemTokens + bundleTokens + historyTokens,
    systemTokens,
    bundleTokens,
    historyTokens,
  };
};

export const resolveModelTokenLimit = (
  model: string,
  overrides: Record<string, number> = {},
  fallback: number = DEFAULT_MODEL_TOKEN_LIMIT,
): number => {
  if (!model) return fallback;
  const direct = overrides[model];
  if (direct) return direct;
  const base = model.split(":")[0];
  const baseMatch = overrides[base];
  if (baseMatch) return baseMatch;
  return fallback;
};
