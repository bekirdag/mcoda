/** Wait for read-only route discovery; never retry a dispatched inference. */
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
