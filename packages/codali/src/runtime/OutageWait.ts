// How long a turn waits out a model-service outage before giving up.
/** Waits between retries of a model request that failed before dispatch (about four minutes in total). */
export const PREFLIGHT_RECOVERY_WAITS_MS = [500, 2000, 5000, 15_000, 30_000, 60_000, 60_000, 60_000];
/** The outage waits that fit the host's total (CODALI_MODEL_OUTAGE_WAIT_MS, in
 * milliseconds); all of them when it is unset. */
export const outageWaitsMs = (budget: string | undefined = process.env.CODALI_MODEL_OUTAGE_WAIT_MS): number[] => {
  const total = budget === undefined || budget.trim() === "" ? Infinity : Number(budget);
  if (!(total >= 0)) return PREFLIGHT_RECOVERY_WAITS_MS;
  let waited = 0;
  return PREFLIGHT_RECOVERY_WAITS_MS.filter(wait => (waited += wait) <= total);
};
/** The longest a turn waits out one model-service outage. The ladder alone
 * (about four minutes) lost a three-hour build to a nine-minute relay outage. */
export const MODEL_OUTAGE_WAIT_MS = 30 * 60_000;
/** The wait before outage retry `attempt` (0-based): the ladder, then a minute
 * per retry, while the total stays within the host's budget
 * (CODALI_MODEL_OUTAGE_WAIT_MS), MODEL_OUTAGE_WAIT_MS and half the time the
 * turn has left. Undefined once the outage has used that allowance. */
export const outageWaitMs = (attempt: number, remainingMs = Infinity, budget: string | undefined = process.env.CODALI_MODEL_OUTAGE_WAIT_MS): number | undefined => {
  const parsed = budget === undefined || budget.trim() === "" ? Infinity : Number(budget);
  const cap = Math.min(parsed >= 0 ? parsed : Infinity, MODEL_OUTAGE_WAIT_MS, remainingMs * 0.5);
  let waited = 0;
  for (let index = 0; index <= attempt; index++) {
    const wait = PREFLIGHT_RECOVERY_WAITS_MS[index] ?? 60_000;
    if (waited + wait > cap) return undefined;
    if (index === attempt) return wait;
    waited += wait;
  }
  return undefined;
};

/** How long one model request may stay unanswered before it is abandoned and
 * retried. A request whose connection was lost, or that a scheduler dropped,
 * never returns: a 12-hour build sat on one such review call for 158 minutes
 * and ended unfinished although its work was done.
 *
 * The base allowance is the larger of ten minutes and four times the slowest
 * request this turn has completed, but no more than the request could need at
 * its ceiling on a slow server: two minutes to be scheduled, the prompt read at
 * 1,000 tokens a second and the full output at 25. It doubles with every stall
 * of the same request, without an upper bound short of an hour, so a model
 * slower than those rates is waited for longer each time instead of being cut
 * off at the same point for ever. */
export const modelStallAllowanceMs = (inputTokens: number, maxOutputTokens: number, longestModelMs: number, stalledAttempts = 0): number => {
  const ceiling = 120_000 + Math.max(0, inputTokens) + Math.max(0, maxOutputTokens) * 40;
  const base = Math.max(60_000, Math.min(Math.max(600_000, longestModelMs * 4), ceiling));
  return Math.min(base * 2 ** Math.min(Math.max(0, stalledAttempts), 6), Math.max(base, 3_600_000));
};
