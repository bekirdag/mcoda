/**
 * Resolves relative time expressions to absolute ranges at plan time.
 *
 * "How is Bekir's performance going for the last two weeks?" is only answerable
 * if every worker agrees on what "the last two weeks" means. Left to the model,
 * each task invents its own window, connector queries disagree, and the run is
 * unreproducible — re-running tomorrow silently asks a different question.
 *
 * So the range is computed once, in code, stamped into the trace, and handed to
 * the planner as a fact. Resolution is deliberately conservative: an expression
 * that cannot be resolved unambiguously is left alone rather than guessed at.
 */

export interface AbsoluteRange {
  /** Inclusive ISO-8601 start instant. */
  since: string;
  /** Exclusive ISO-8601 end instant. */
  until: string;
  /** The phrase this range was derived from. */
  phrase: string;
  days: number;
}

export interface TemporalContext {
  /** The instant the run treats as "now". */
  now: string;
  range?: AbsoluteRange;
}

const DAY_MS = 86_400_000;

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  a: 1,
  an: 1,
};

const UNIT_DAYS: Record<string, number> = {
  day: 1,
  days: 1,
  week: 7,
  weeks: 7,
  month: 30,
  months: 30,
  quarter: 91,
  quarters: 91,
  year: 365,
  years: 365,
};

/** Fixed phrases with no quantity, e.g. "yesterday". */
const FIXED_PHRASES: Array<{ pattern: RegExp; days: number }> = [
  { pattern: /\byesterday\b/i, days: 1 },
  { pattern: /\btoday\b/i, days: 1 },
  { pattern: /\bthis week\b/i, days: 7 },
  { pattern: /\blast week\b/i, days: 7 },
  { pattern: /\bthis month\b/i, days: 30 },
  { pattern: /\blast month\b/i, days: 30 },
  { pattern: /\bthis quarter\b/i, days: 91 },
  { pattern: /\blast quarter\b/i, days: 91 },
  { pattern: /\bthis year\b/i, days: 365 },
  { pattern: /\blast year\b/i, days: 365 },
  { pattern: /\brecently\b/i, days: 14 },
];

/**
 * Matches "last two weeks", "past 30 days", "previous 3 months".
 * The quantity may be digits or a small word number.
 */
const QUANTIFIED = /\b(?:last|past|previous|recent)\s+(\d{1,3}|[a-z]+)\s+(day|days|week|weeks|month|months|quarter|quarters|year|years)\b/i;

const parseQuantity = (raw: string): number | undefined => {
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric) && numeric > 0 && numeric <= 999) return numeric;
  return WORD_NUMBERS[raw.toLowerCase()];
};

/**
 * Extracts an absolute range from a query. Returns undefined when the query
 * contains no relative time expression, or one we cannot resolve confidently —
 * a wrong window is worse than no window, because it looks authoritative.
 */
export const resolveRelativeRange = (
  query: string,
  now: Date = new Date(),
): AbsoluteRange | undefined => {
  const quantified = query.match(QUANTIFIED);
  if (quantified) {
    const quantity = parseQuantity(quantified[1] ?? "");
    const unitDays = UNIT_DAYS[(quantified[2] ?? "").toLowerCase()];
    if (quantity && unitDays) {
      const days = quantity * unitDays;
      return {
        since: new Date(now.getTime() - days * DAY_MS).toISOString(),
        until: now.toISOString(),
        phrase: quantified[0],
        days,
      };
    }
  }

  for (const fixed of FIXED_PHRASES) {
    const match = query.match(fixed.pattern);
    if (match) {
      return {
        since: new Date(now.getTime() - fixed.days * DAY_MS).toISOString(),
        until: now.toISOString(),
        phrase: match[0],
        days: fixed.days,
      };
    }
  }

  return undefined;
};

export const buildTemporalContext = (
  query: string,
  now: Date = new Date(),
): TemporalContext => ({
  now: now.toISOString(),
  range: resolveRelativeRange(query, now),
});

/** The lines handed to the planner so every task shares one window. */
export const renderTemporalContext = (context: TemporalContext): string[] => {
  const lines = [`Current time: ${context.now}`];
  if (context.range) {
    lines.push(
      `Resolved time range for "${context.range.phrase}": ${context.range.since} to ${context.range.until} (${context.range.days} days).`,
      "Use these absolute timestamps in every tool call. Do not compute your own dates.",
    );
  } else {
    // Stating the current time invites a model to use it as a range start,
    // which asks for everything since this instant and returns nothing.
    // Observed: `list_commits since=<now>`, a valid call with an empty answer.
    lines.push(
      "The question named no time period. Do not use the current time as a start or end date — that would match nothing.",
      "Omit date filters entirely and let the tool return its most recent results.",
    );
  }
  return lines;
};
