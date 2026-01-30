const stripCodeFences = (input: string): string => {
  const match = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  return input.trim();
};

const stripJsonPrefix = (input: string): string => {
  return input.replace(/^json\s*:/i, "").trim();
};

const findJsonSubstring = (input: string): string | undefined => {
  const startBrace = input.indexOf("{");
  const startBracket = input.indexOf("[");
  const start =
    startBrace === -1
      ? startBracket
      : startBracket === -1
        ? startBrace
        : Math.min(startBrace, startBracket);
  if (start === -1) return undefined;

  for (let end = input.length - 1; end > start; end -= 1) {
    const char = input[end];
    if (char !== "}" && char !== "]") continue;
    const candidate = input.slice(start, end + 1).trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // keep searching shorter candidates
    }
  }
  return undefined;
};

export const normalizePatchOutput = (raw: string): string | undefined => {
  if (!raw) return undefined;
  const fenced = stripCodeFences(raw);
  const stripped = stripJsonPrefix(fenced);
  const direct = stripped.trim();
  if (!direct) return undefined;
  if (direct.startsWith("{") || direct.startsWith("[")) {
    try {
      JSON.parse(direct);
      return direct;
    } catch {
      return findJsonSubstring(direct);
    }
  }
  return findJsonSubstring(direct);
};

export const __test__ = {
  stripCodeFences,
  stripJsonPrefix,
  findJsonSubstring,
};
