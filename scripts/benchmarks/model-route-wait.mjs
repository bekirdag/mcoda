/**
 * Prove a binding can take work. A healthy catalog entry is not enough: during
 * the 2026-11-09 capacity outage discovery passed while every dispatch was
 * refused, and three benchmark cases were consumed with no inference.
 */
export async function probeModelDispatch(provider, signal, timeoutMs = 150000) {
  await provider.generate({
    messages: [{ role: 'user', content: 'Reply with exactly: READY' }],
    maxTokens: 64, temperature: 0,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
}

/** Wait until the probe passes, before any attempt exists; never retry a benchmark attempt's inference. */
export async function waitForModelRoute({ probe, signal, onState, delayMs = 15000, sleep }) {
  let waiting = false;
  for (;;) {
    signal.throwIfAborted();
    let ready = false;
    try { await probe(signal); ready = true; }
    catch { signal.throwIfAborted(); }
    if (ready) {
      if (waiting) await onState({ type: 'model_route_ready' });
      return;
    }
    if (!waiting) {
      waiting = true;
      await onState({ type: 'model_route_wait' });
    }
    await sleep(delayMs, signal);
  }
}
