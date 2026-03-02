import { AgentUsageLimitWindowType } from "@mcoda/shared";

const LIMIT_PATTERNS = [
  /usage[_\s-]*limit/i,
  /usage_limit_reached/i,
  /rate[_\s-]*limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota exceeded/i,
  /retry after/i,
];

const NON_LIMIT_AUTH_PATTERNS = [
  /invalid[_\s-]*api[_\s-]*key/i,
  /api key.*invalid/i,
  /authentication failed/i,
  /missing api key/i,
  /unauthorized/i,
];

const WINDOW_HINTS: Array<{ pattern: RegExp; windowType: AgentUsageLimitWindowType }> = [
  { pattern: /\b(?:5\s*(?:h|hr|hrs|hour|hours)|five[-\s]?hour)\b/i, windowType: "rolling_5h" },
  { pattern: /\b(?:daily|24\s*(?:h|hr|hrs|hour|hours))\b/i, windowType: "daily" },
  { pattern: /\b(?:weekly|7\s*(?:d|day|days))\b/i, windowType: "weekly" },
];

const RELATIVE_RESET_PATTERNS = [
  /retry after\s+([^\n.;]+)/i,
  /try again in\s+([^\n.;]+)/i,
  /resets?\s+in\s+([^\n.;]+)/i,
];

const ISO_LIKE_PATTERN =
  /\b(20\d{2}-\d{2}-\d{2}[tT ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2}| ?UTC| ?GMT)?)\b/g;
const EPOCH_RESET_PATTERN = /\bx-ratelimit-reset(?:-at)?\s*[:=]\s*(\d{10,13})\b/i;
const SHORT_RESET_PATTERN = /\bx-ratelimit-reset-after\s*[:=]\s*(\d+)\b/i;

export type UsageLimitResetSource = "header" | "relative" | "absolute";

export interface ParsedUsageLimitError {
  isUsageLimit: true;
  message: string;
  rawText: string;
  windowTypes: AgentUsageLimitWindowType[];
  resetAt?: string;
  resetAtSource?: UsageLimitResetSource;
}

const normalizeSpace = (value: string): string => value.replace(/\s+/g, " ").trim();

const collectText = (value: unknown, out: string[], depth = 0): void => {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (value instanceof Error) {
    collectText(value.message, out, depth + 1);
    const extra = value as unknown as Record<string, unknown>;
    for (const [key, nested] of Object.entries(extra)) {
      if (key === "message" || key === "name" || key === "stack") continue;
      collectText(nested, out, depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/(error|message|reason|stderr|stdout|detail|details|body)/i.test(key)) {
        collectText(nested, out, depth + 1);
        continue;
      }
      if (depth < 2) {
        collectText(nested, out, depth + 1);
      }
    }
  }
};

const parseDurationMs = (input: string): number | undefined => {
  let totalMs = 0;
  let matched = false;
  const pattern =
    /(\d+)\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  let match: RegExpExecArray | null = pattern.exec(input);
  while (match) {
    const amount = Number.parseInt(match[1] ?? "", 10);
    const unit = (match[2] ?? "").toLowerCase();
    if (Number.isFinite(amount) && amount > 0) {
      matched = true;
      if (unit.startsWith("w")) totalMs += amount * 7 * 24 * 60 * 60 * 1000;
      else if (unit.startsWith("d")) totalMs += amount * 24 * 60 * 60 * 1000;
      else if (unit.startsWith("h")) totalMs += amount * 60 * 60 * 1000;
      else if (unit.startsWith("m")) totalMs += amount * 60 * 1000;
      else if (unit.startsWith("s")) totalMs += amount * 1000;
    }
    match = pattern.exec(input);
  }
  return matched && totalMs > 0 ? totalMs : undefined;
};

const parseIsoLikeDate = (candidate: string): number | undefined => {
  const normalized = candidate.replace(/\bUTC\b/i, "Z").replace(/\bGMT\b/i, "Z").replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

interface ResetTimestampCandidate {
  timestampMs: number;
  source: UsageLimitResetSource;
}

const resolveResetTimestamp = (text: string, nowMs: number): ResetTimestampCandidate | undefined => {
  const candidates: ResetTimestampCandidate[] = [];

  const epochMatch = EPOCH_RESET_PATTERN.exec(text);
  if (epochMatch?.[1]) {
    const raw = Number.parseInt(epochMatch[1], 10);
    if (Number.isFinite(raw) && raw > 0) {
      candidates.push({
        timestampMs: raw > 1_000_000_000_000 ? raw : raw * 1000,
        source: "header",
      });
    }
  }

  const shortMatch = SHORT_RESET_PATTERN.exec(text);
  if (shortMatch?.[1]) {
    const seconds = Number.parseInt(shortMatch[1], 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      candidates.push({
        timestampMs: nowMs + seconds * 1000,
        source: "header",
      });
    }
  }

  for (const pattern of RELATIVE_RESET_PATTERNS) {
    const match = pattern.exec(text);
    const durationText = match?.[1];
    if (!durationText) continue;
    const durationMs = parseDurationMs(durationText);
    if (durationMs && durationMs > 0) {
      candidates.push({
        timestampMs: nowMs + durationMs,
        source: "relative",
      });
    }
  }

  ISO_LIKE_PATTERN.lastIndex = 0;
  let isoMatch: RegExpExecArray | null = ISO_LIKE_PATTERN.exec(text);
  while (isoMatch) {
    const ts = parseIsoLikeDate(isoMatch[1] ?? "");
    if (Number.isFinite(ts)) {
      candidates.push({
        timestampMs: ts as number,
        source: "absolute",
      });
    }
    isoMatch = ISO_LIKE_PATTERN.exec(text);
  }

  const future = candidates.filter(
    (candidate) => Number.isFinite(candidate.timestampMs) && candidate.timestampMs > nowMs,
  );
  if (!future.length) return undefined;
  future.sort((left, right) => left.timestampMs - right.timestampMs);
  return future[0];
};

const inferWindowTypes = (text: string): AgentUsageLimitWindowType[] => {
  const set = new Set<AgentUsageLimitWindowType>();
  for (const hint of WINDOW_HINTS) {
    if (hint.pattern.test(text)) {
      set.add(hint.windowType);
    }
  }
  if (!set.size) {
    set.add("other");
  }
  return Array.from(set);
};

export const extractUsageLimitErrorText = (error: unknown): string => {
  const parts: string[] = [];
  collectText(error, parts);
  return normalizeSpace(parts.join(" "));
};

export const parseUsageLimitError = (error: unknown, nowMs = Date.now()): ParsedUsageLimitError | null => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const rawText = extractUsageLimitErrorText(error);
  const messageLower = message.trim().toLowerCase();
  const rawLower = rawText.trim().toLowerCase();
  const text = normalizeSpace(
    rawText && rawLower.includes(messageLower) ? rawText : `${message} ${rawText}`,
  );
  if (!text) return null;
  const looksLikeLimit = LIMIT_PATTERNS.some((pattern) => pattern.test(text));
  if (!looksLikeLimit) return null;

  const looksLikeOnlyNonLimitAuth =
    NON_LIMIT_AUTH_PATTERNS.some((pattern) => pattern.test(text)) &&
    !/(usage[_\s-]*limit|rate[_\s-]*limit|too many requests|\b429\b)/i.test(text);
  if (looksLikeOnlyNonLimitAuth) {
    return null;
  }

  const reset = resolveResetTimestamp(text, nowMs);
  const windowTypes = inferWindowTypes(text);
  return {
    isUsageLimit: true,
    message,
    rawText: text,
    windowTypes,
    resetAt: reset ? new Date(reset.timestampMs).toISOString() : undefined,
    resetAtSource: reset?.source,
  };
};
