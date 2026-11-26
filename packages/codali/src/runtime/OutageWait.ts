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
/** The longest one model-service outage is waited out when the turn itself has
 * no time limit (an interactive session, an open-ended build). Outages happen
 * in real use: a node restarts, a host runs out of memory, a gateway queue
 * backs up. The 30 minutes allowed before (and half the turn's remaining
 * time) ended long builds on outages they could have outlasted. Six hours by
 * default; CODALI_MODEL_OUTAGE_WAIT_MS raises or lowers it. */
export const MODEL_OUTAGE_WAIT_MS = 6 * 3_600_000;
/** Time kept back before a turn's limit, so the turn can still hand over what
 * it has (a draft, a status report) when the service is still down then. */
export const OUTAGE_DELIVERY_RESERVE_MS = 90_000;
/** The wait before outage retry `attempt` (0-based): the ladder, then a minute
 * per retry. The total stays within the host's budget (CODALI_MODEL_OUTAGE_WAIT_MS,
 * default MODEL_OUTAGE_WAIT_MS) and within the turn's remaining time less
 * OUTAGE_DELIVERY_RESERVE_MS. Undefined once the outage has used that allowance. */
export const outageWaitMs = (attempt: number, remainingMs = Infinity, budget: string | undefined = process.env.CODALI_MODEL_OUTAGE_WAIT_MS): number | undefined => {
  const parsed = budget === undefined || budget.trim() === "" ? MODEL_OUTAGE_WAIT_MS : Number(budget);
  const cap = Math.min(parsed >= 0 ? parsed : MODEL_OUTAGE_WAIT_MS, remainingMs - OUTAGE_DELIVERY_RESERVE_MS);
  let waited = 0;
  for (let index = 0; index <= attempt; index++) {
    const wait = PREFLIGHT_RECOVERY_WAITS_MS[index] ?? 60_000;
    if (waited + wait > cap) return undefined;
    if (index === attempt) return wait;
    waited += wait;
  }
  return undefined;
};

/** Compute the next delay from actual elapsed outage time. A server-directed
 * delay must fit in full, including the time reserved for the final response. */
export const outageRetryDelayMs = (attempt: number, remainingMs: number, elapsedMs: number, retryAfterSeconds: number, injected: boolean, budget = process.env.CODALI_MODEL_OUTAGE_WAIT_MS): number | undefined => {
  const parsed = budget?.trim() ? Number(budget) : MODEL_OUTAGE_WAIT_MS;
  const allowance = Number.isFinite(parsed) && parsed >= 0 ? parsed : MODEL_OUTAGE_WAIT_MS;
  const step = injected ? [500, 2000][attempt] : PREFLIGHT_RECOVERY_WAITS_MS[attempt] ?? 60_000;
  if (step === undefined) return undefined;
  const wait = Math.max(step, retryAfterSeconds * 1000);
  // Interactive turns default to 90 seconds. Preserve a quick retry on those
  // turns while leaving the full delivery reserve on long-running requests.
  const reserveMs = Math.min(OUTAGE_DELIVERY_RESERVE_MS, remainingMs / 2);
  const available = Math.min(allowance - elapsedMs, remainingMs - reserveMs);
  if (injected && retryAfterSeconds > 2) return undefined;
  return wait <= available ? wait : undefined;
};

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "ECONNABORTED",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED"]);

/** Whether an error says the model service could not be reached at all (as
 * opposed to a refusal it gave). A dropped stream ("terminated"), a failed
 * connection ("fetch failed") and their low-level codes all count; so does a
 * timed-out catalog request, which only means the gateway did not answer. */
export const transportOutage = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    if (current instanceof TypeError && /^(?:fetch failed|terminated|network error)$/i.test(String(current.message))) return true;
    if (current instanceof Error && current.message === "Service request timed out") return true;
  }
  return false;
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

/** How long a request that is streaming its generation may go without
 * producing anything more before it counts as stalled. Wall-clock time alone
 * cannot tell a live long generation from a lost request, so the full
 * allowance above stays in force until the first generated chunk. Once output
 * arrives the timer is reset by every chunk, and only a stream that stops for
 * this long is abandoned: two minutes, or three times the slowest answered
 * request when longer, never more than the full allowance. A lost request
 * that was streaming is then given up in minutes instead of after the full
 * allowance (ten minutes or more), while a live generation is never cut
 * however long it runs. */
export const modelStreamGapAllowanceMs = (fullAllowanceMs: number, longestModelMs: number): number =>
  Math.min(fullAllowanceMs, Math.max(STREAM_STALL_GAP_MS, longestModelMs * 3));
/** The shortest silence after which a streaming request counts as stalled. */
export const STREAM_STALL_GAP_MS = 120_000;
