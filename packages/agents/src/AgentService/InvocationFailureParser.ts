import {
  extractUsageLimitErrorText,
  parseUsageLimitError,
  ParsedUsageLimitError,
} from "./UsageLimitParser.js";

const NON_RETRYABLE_AUTH_PATTERNS = [
  /invalid[_\s-]*api[_\s-]*key/i,
  /api key.*invalid/i,
  /authentication failed/i,
  /missing api key/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
];

const CONNECTIVITY_PATTERNS = [
  /\boffline\b/i,
  /\bnetwork (?:is )?unreachable\b/i,
  /\binternet (?:is )?(?:down|offline|unavailable)\b/i,
  /\bfetch failed\b/i,
  /\bfailed to fetch\b/i,
  /\bgetaddrinfo\b/i,
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i,
  /\bsocket hang up\b/i,
  /\bconnection (?:reset|refused|closed|failed)\b/i,
];

const TECHNICAL_PATTERNS = [
  /\b(?:500|501|502|503|504)\b/,
  /\binternal server error\b/i,
  /\bbad gateway\b/i,
  /\bservice unavailable\b/i,
  /\bgateway timeout\b/i,
  /\btemporar(?:y|ily) unavailable\b/i,
  /\boverload(?:ed)?\b/i,
  /\bupstream .*?(?:error|failed|timeout)\b/i,
  /\bretry later\b/i,
];

const normalizeSpace = (value: string): string => value.replace(/\s+/g, " ").trim();

export type ParsedInvocationFailure =
  | { kind: "usage_limit"; usageLimit: ParsedUsageLimitError }
  | { kind: "connectivity_issue"; message: string; rawText: string }
  | { kind: "technical_issue"; message: string; rawText: string };

export const parseInvocationFailure = (
  error: unknown,
  nowMs = Date.now(),
): ParsedInvocationFailure | null => {
  const usageLimit = parseUsageLimitError(error, nowMs);
  if (usageLimit) {
    return { kind: "usage_limit", usageLimit };
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  const rawText = normalizeSpace(extractUsageLimitErrorText(error));
  const merged = normalizeSpace([message, rawText].filter(Boolean).join(" "));
  if (!merged) return null;

  if (NON_RETRYABLE_AUTH_PATTERNS.some((pattern) => pattern.test(merged))) {
    return null;
  }

  if (CONNECTIVITY_PATTERNS.some((pattern) => pattern.test(merged))) {
    return { kind: "connectivity_issue", message, rawText: merged };
  }

  if (TECHNICAL_PATTERNS.some((pattern) => pattern.test(merged))) {
    return { kind: "technical_issue", message, rawText: merged };
  }

  return null;
};
