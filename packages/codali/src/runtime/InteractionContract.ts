/** Bounded, model-extracted presentation constraints. These do not prove correctness. */
export interface InteractionOutputContract {
  format: "text" | "json";
  requiredKeys: string[];
  minWords: number | null;
  maxWords: number | null;
}

export const unconstrainedOutput = (): InteractionOutputContract => ({ format: "text", requiredKeys: [], minWords: null, maxWords: null });

/** Remove only one enclosing JSON fence, never reserialize or reinterpret its values. */
export const normalizeJsonPresentation = (content: string): string => {
  const match = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/u.exec(content);
  if (!match) return content;
  const body = match[1].trim();
  try { JSON.parse(body); } catch { return content; }
  return body;
};

/**
 * True when the request itself plainly demands a JSON-only reply ("Return only
 * JSON", "Respond with JSON only"). The model-extracted contract can miss this:
 * in cycle 5 a fully correct numeric answer arrived in a ```json fence under a
 * text contract and was rejected. Only explicit wording counts.
 */
export const requestDemandsJsonOnly = (request: string): boolean =>
  /\b(?:return|respond|reply|answer|output|give)\b[^.\n]{0,40}?\b(?:only|just)\s+(?:valid\s+|a\s+|the\s+)?json\b/iu.test(request)
  || /\b(?:return|respond|reply|answer|output)\b[^.\n]{0,40}?\bjson\s+only\b/iu.test(request);

/**
 * True when the request plainly demands a reply that is one fenced code block
 * and nothing else ("Return exactly one fenced python code block, ... no
 * prose"). In cycles 2, 4, 5 and 6 Codali wrapped such a block in verification
 * notes the request had ruled out. Only explicit wording counts.
 */
export const requestDemandsCodeBlockOnly = (request: string): boolean =>
  /\b(?:exactly|only|just|a\s+single)\s+one\s+(?:fenced\s+)?(?:[\w+#.-]+\s+)?code\s+block\b|\bonly\s+(?:a|one|the)\s+(?:single\s+)?(?:fenced\s+)?(?:[\w+#.-]+\s+)?code\s+block\b/iu.test(request)
  && /\bno\s+(?:prose|explanations?|commentary|other\s+text)\b|\bnothing\s+else\b/iu.test(request);

/** Keep the one fenced code block unchanged when the answer has exactly one; otherwise return the content as-is. */
export const normalizeCodeBlockPresentation = (content: string): string => {
  const blocks = [...content.matchAll(/^[ \t]*```[^\n`]*\r?\n[\s\S]*?\r?\n[ \t]*```[ \t]*$/gmu)];
  if (blocks.length !== 1 || (content.match(/```/gu) ?? []).length !== 2) return content;
  return blocks[0][0].trim();
};

const LINE_COMMENT: Array<[RegExp, string]> = [
  [/^(?:python3?|py3?|ruby|rb|sh|bash|zsh|shell|yaml|yml|toml|r|perl|pl|makefile|dockerfile|elixir|julia)$/i, "#"],
  [/^(?:javascript|js|jsx|mjs|cjs|typescript|ts|tsx|java|c|h|cpp|c\+\+|cc|cs|csharp|go|golang|rust|rs|swift|kotlin|kt|php|scala|dart|zig)$/i, "//"],
  [/^(?:sql|lua|haskell|hs|ada|plsql)$/i, "--"],
];

/** Put a one-line note from the runtime inside a single fenced code block, as
 * a trailing comment in that block's language. A request for "one code block,
 * no prose" is then still met while the note is kept: appended after the block
 * it broke the format the user asked for (a correct answer lost a tenth of its
 * score to it). Undefined when the language has no known line comment. */
export const noteInsideCodeBlock = (block: string, note: string): string | undefined => {
  const match = /^([ \t]*```([^\n`]*)\r?\n)([\s\S]*?)(\r?\n[ \t]*```[ \t]*)$/u.exec(block);
  const text = note.replace(/\s+/gu, " ").trim();
  if (!match || !text) return undefined;
  const marker = LINE_COMMENT.find(([language]) => language.test(match[2].trim()))?.[1];
  return marker ? `${match[1]}${match[3]}\n\n${marker} ${text}${match[4]}` : undefined;
};

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
