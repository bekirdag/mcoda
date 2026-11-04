/** Bounded, model-extracted presentation constraints. These do not prove correctness. */
export interface InteractionOutputContract {
  format: "text" | "json";
  requiredKeys: string[];
  minWords: number | null;
  maxWords: number | null;
}

export const unconstrainedOutput = (): InteractionOutputContract => ({ format: "text", requiredKeys: [], minWords: null, maxWords: null });

export const outputContractSchema = {
  type: "object", additionalProperties: false, required: ["format", "requiredKeys", "minWords", "maxWords"],
  properties: {
    format: { type: "string", enum: ["text", "json"] },
    requiredKeys: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 128 } },
    minWords: { type: ["integer", "null"], minimum: 0, maximum: 20000 },
    maxWords: { type: ["integer", "null"], minimum: 0, maximum: 20000 },
  },
};

export const parseOutputContract = (value: unknown): InteractionOutputContract => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Output contract must be an object");
  const object = value as Record<string, unknown>;
  const { format, requiredKeys, minWords, maxWords } = object;
  const bound = (v: unknown): v is number | null => v === null || typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 20000;
  if (Object.keys(object).length !== 4 || Object.keys(object).some(key => !["format", "requiredKeys", "minWords", "maxWords"].includes(key)) ||
      !["text", "json"].includes(String(format)) || typeof format !== "string" ||
      !Array.isArray(requiredKeys) || requiredKeys.length > 32 || requiredKeys.some(key => typeof key !== "string" || !key.length || key.length > 128) ||
      new Set(requiredKeys).size !== requiredKeys.length || format === "text" && requiredKeys.length > 0 ||
      !bound(minWords) || !bound(maxWords) || minWords !== null && maxWords !== null && minWords > maxWords) {
    throw new Error("Invalid output contract: expected format, unique requiredKeys and consistent nullable word bounds");
  }
  return { format: format as InteractionOutputContract["format"], requiredKeys: [...requiredKeys], minWords, maxWords };
};

/** JSON syntax/top-level keys and whitespace-separated word counts only; never rewrites content. */
export const validateInteractionOutput = (content: string, contract: InteractionOutputContract): string[] => {
  const text = content.trim();
  if (!text) return ["The answer is empty"];
  const violations: string[] = [];
  if (contract.format === "json") {
    try {
      const value: unknown = JSON.parse(text);
      for (const key of contract.requiredKeys) {
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, key)) violations.push(`Missing required JSON field ${JSON.stringify(key)}`);
      }
    } catch { violations.push("Return only valid JSON, without prose or Markdown fences"); }
  }
  const words = text.split(/\s+/u).length;
  if (contract.minWords !== null && words < contract.minWords) violations.push(`Answer has ${words} words; minimum is ${contract.minWords}`);
  if (contract.maxWords !== null && words > contract.maxWords) violations.push(`Answer has ${words} words; maximum is ${contract.maxWords}`);
  return violations;
};
