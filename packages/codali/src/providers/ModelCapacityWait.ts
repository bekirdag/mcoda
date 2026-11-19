import { setTimeout as delay } from "node:timers/promises";
import { ModelServiceError } from "./ModelServiceError.js";
import type { ProviderRequest, ProviderResponse } from "./ProviderTypes.js";

export const MODEL_CAPACITY_WAIT_MS = 30 * 60_000;
const MAX_HONORED_RETRY_AFTER_SECONDS = 30;
const MAX_BACKOFF_MS = 60_000;

/** An explicit shared-pool refusal: the service rejected the request before any
 * inference ran, so it costs nothing and waiting is the correct response. */
export const isCapacityRefusal = (error: unknown): error is ModelServiceError => error instanceof ModelServiceError
  && error.code === "rate_limited" && (error.responseReason === "capacity_busy" || error.status === 429);

/** Delay before the next capacity retry, or undefined when waiting should stop.
 * Long Retry-After values remain refusals rather than silent multi-minute stalls. */
export function capacityRetryDelayMs(error: unknown, attempt: number, waitedMs: number, maxWaitMs = MODEL_CAPACITY_WAIT_MS, random = Math.random): number | undefined {
  if (!isCapacityRefusal(error)) return undefined;
  const retryAfter = error.retryAfterSeconds ?? 0;
  if (retryAfter > MAX_HONORED_RETRY_AFTER_SECONDS) return undefined;
  const backoff = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** Math.min(attempt, 10)) * (0.75 + random() * 0.5);
  const waitMs = Math.round(Math.max(backoff, retryAfter * 1000));
  return waitedMs + waitMs > maxWaitMs ? undefined : waitMs;
}

/** Shared capacity policy for callers without Codali's session recovery, so a
 * comparison arm is not failed by contention the other arm waits through. */
export async function generateWithCapacityWait(generate: (request: ProviderRequest) => Promise<ProviderResponse>, request: ProviderRequest,
  options: { maxWaitMs?: number; onWait?: (details: { attempt: number; waitMs: number; waitedMs: number; error: ModelServiceError }) => void | Promise<void> } = {}): Promise<ProviderResponse> {
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    try { return await generate(request); }
    catch (error) {
      const waitMs = capacityRetryDelayMs(error, attempt, waitedMs, options.maxWaitMs);
      if (waitMs === undefined) throw error;
      request.signal?.throwIfAborted();
      await options.onWait?.({ attempt: attempt + 1, waitMs, waitedMs, error: error as ModelServiceError });
      await delay(waitMs, undefined, { signal: request.signal });
      waitedMs += waitMs;
    }
  }
}
