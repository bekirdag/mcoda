/** Bounded float-vector transport. Token-array/base64 inputs are deliberately unsupported. */
export interface EmbeddingLimits {
  maxInputItems?: number;
  maxInputChars?: number;
  maxTotalInputChars?: number;
  embeddingDimensions?: number;
}

const bounded = (value: number | undefined, maximum: number): number =>
  Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, maximum) : maximum;

export function validateEmbeddingRequest(
  body: Record<string, unknown>, model: string, limits: EmbeddingLimits = {},
): { model: string; input: string[]; encoding_format: "float"; dimensions?: number } {
  const input = typeof body.input === "string" ? [body.input] : body.input;
  if (!Array.isArray(input) || input.length === 0 || input.length > bounded(limits.maxInputItems, 128)) {
    throw new Error("embeddings input must contain 1..128 strings within the configured batch limit");
  }
  let total = 0;
  for (const text of input) {
    if (typeof text !== "string" || !text.trim() || text.length > bounded(limits.maxInputChars, 8192)) {
      throw new Error("embeddings input must contain nonempty strings within the configured length limit");
    }
    total += text.length;
  }
  if (total > bounded(limits.maxTotalInputChars, 65536)) throw new Error("embeddings input exceeds total character limit");
  if (body.stream !== undefined && body.stream !== false) throw new Error("embeddings streaming is unsupported");
  if (body.encoding_format !== undefined && body.encoding_format !== "float") throw new Error("embeddings requires float encoding");
  if (body.dimensions !== undefined && (!Number.isSafeInteger(body.dimensions) || Number(body.dimensions) < 1 || Number(body.dimensions) > 4096)) {
    throw new Error("embeddings dimensions must be an integer from 1 to 4096");
  }
  if (limits.embeddingDimensions && body.dimensions !== undefined && body.dimensions !== limits.embeddingDimensions) {
    throw new Error("embeddings dimensions do not match the advertised embedding space");
  }
  return { model, input, encoding_format: "float", ...(body.dimensions !== undefined ? { dimensions: Number(body.dimensions) } : {}) };
}

export function validateEmbeddingResponse(
  payload: unknown, count: number, dimensions?: number, expectedModel?: string,
): { object: "list"; model: string; data: { object: "embedding"; index: number; embedding: number[] }[]; usage?: { prompt_tokens: number; total_tokens: number } } {
  const body = payload as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.data) || body.data.length !== count || count < 1 || count > 128) {
    throw new Error("embeddings response count does not match input");
  }
  if (typeof body.model !== "string" || !body.model || (expectedModel && body.model !== expectedModel)) {
    throw new Error("embeddings response model does not match the selected model");
  }
  const seen = new Set<number>();
  let size = dimensions;
  const data = body.data.map((raw: unknown) => {
    const item = raw as Record<string, unknown> | null;
    if (!item || !Number.isSafeInteger(item.index) || Number(item.index) < 0 || Number(item.index) >= count || seen.has(Number(item.index))) {
      throw new Error("embeddings response has an invalid or duplicate index");
    }
    seen.add(Number(item.index));
    if (!Array.isArray(item.embedding) || !item.embedding.length || item.embedding.length > 4096 || item.embedding.some(n => typeof n !== "number" || !Number.isFinite(n))) {
      throw new Error("embeddings response contains an invalid vector");
    }
    size ??= item.embedding.length;
    if (item.embedding.length !== size) throw new Error("embeddings response dimension mismatch");
    return { object: "embedding" as const, index: Number(item.index), embedding: item.embedding as number[] };
  }).sort((a, b) => a.index - b.index);
  const rawUsage = body.usage as Record<string, unknown> | undefined;
  const usage = rawUsage && Number.isSafeInteger(rawUsage.prompt_tokens) && Number(rawUsage.prompt_tokens) >= 0 && Number.isSafeInteger(rawUsage.total_tokens) && Number(rawUsage.total_tokens) >= Number(rawUsage.prompt_tokens)
    ? { prompt_tokens: Number(rawUsage.prompt_tokens), total_tokens: Number(rawUsage.total_tokens) } : undefined;
  return { object: "list", model: body.model, data, ...(usage ? { usage } : {}) };
}
