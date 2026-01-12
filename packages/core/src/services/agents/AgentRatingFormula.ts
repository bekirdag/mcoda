export type RatingBudgets = {
  costUsd: number;
  durationSeconds: number;
  iterations: number;
};

export type RatingWeights = {
  quality: number;
  cost: number;
  time: number;
  iterations: number;
};

export type RunScoreInput = {
  qualityScore: number;
  totalCost: number;
  durationSeconds: number;
  iterations: number;
  budgets?: Partial<RatingBudgets>;
  weights?: Partial<RatingWeights>;
};

export const DEFAULT_RATING_WEIGHTS: RatingWeights = {
  quality: 1.0,
  cost: 0.15,
  time: 0.1,
  iterations: 0.2,
};

export const DEFAULT_RATING_BUDGETS: RatingBudgets = {
  costUsd: 0.05,
  durationSeconds: 600,
  iterations: 2,
};

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));

const safeDivide = (value: number, denom: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(denom) || denom <= 0) return 0;
  return value / denom;
};

export const normalizeScore = (value: number, maxValue = 10): number => clamp(safeDivide(value, maxValue));

export const normalizeBudget = (value: number, budget: number): number => clamp(safeDivide(value, budget));

export const computeRunScore = (input: RunScoreInput): number => {
  const weights = { ...DEFAULT_RATING_WEIGHTS, ...(input.weights ?? {}) };
  const budgets = { ...DEFAULT_RATING_BUDGETS, ...(input.budgets ?? {}) };
  const qualityNorm = normalizeScore(input.qualityScore, 10);
  const costNorm = normalizeBudget(input.totalCost, budgets.costUsd);
  const timeNorm = normalizeBudget(input.durationSeconds, budgets.durationSeconds);
  const iterNorm = normalizeBudget(input.iterations, budgets.iterations);
  const weighted =
    weights.quality * qualityNorm -
    weights.cost * costNorm -
    weights.time * timeNorm -
    weights.iterations * iterNorm;
  return Math.round(clamp(weighted, 0, 1) * 1000) / 100; // 0-10 with 2 decimal precision
};

export const updateEmaRating = (current: number, score: number, alpha: number): number => {
  if (!Number.isFinite(current)) return score;
  if (!Number.isFinite(score)) return current;
  const safeAlpha = clamp(alpha, 0, 1);
  const next = current + safeAlpha * (score - current);
  return Math.round(next * 100) / 100;
};

export const computeAlpha = (windowSize: number): number => {
  const size = Math.max(1, windowSize);
  return 2 / (size + 1);
};
