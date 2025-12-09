// Lightweight token estimator for logging. Uses a rough characters-per-token heuristic.
export const estimateTokens = (text, charsPerToken = 4) => {
    if (!text)
        return 0;
    const tokens = Math.ceil(text.length / Math.max(charsPerToken, 1));
    return Number.isFinite(tokens) ? tokens : 0;
};
