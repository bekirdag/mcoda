import test from "node:test";
import assert from "node:assert/strict";
import { capacityRetryDelayMs, generateWithCapacityWait, isCapacityRefusal } from "../ModelCapacityWait.js";
import { ModelServiceError } from "../ModelServiceError.js";

const busy = () => new ModelServiceError("rate_limited", 409, 2, false, "capacity_busy");

test("only explicit capacity refusals wait, with a bounded backoff", () => {
  assert.equal(isCapacityRefusal(busy()), true);
  assert.equal(isCapacityRefusal(new ModelServiceError("rate_limited", 429)), true);
  assert.equal(isCapacityRefusal(new ModelServiceError("service_unavailable", 503)), false);
  assert.equal(isCapacityRefusal(new Error("boom")), false);
  const fixed = () => 0.5;
  assert.equal(capacityRetryDelayMs(busy(), 0, 0, 60_000, fixed), 2000);
  assert.equal(capacityRetryDelayMs(busy(), 20, 0, 3_600_000, fixed), 60_000);
  assert.equal(capacityRetryDelayMs(busy(), 3, 59_000, 60_000, fixed), undefined, "stops at the wait ceiling");
  assert.equal(capacityRetryDelayMs(new ModelServiceError("rate_limited", 429, 120), 0, 0), undefined, "long Retry-After stays a refusal");
});

test("generate waits through refusals and surfaces other errors at once", async () => {
  let calls = 0; const waits: number[] = [];
  const response = await generateWithCapacityWait(async () => { if (++calls < 3) throw busy(); return { message: { role: "assistant", content: "ok" } }; },
    { messages: [] }, { maxWaitMs: 60_000, onWait: details => { waits.push(details.attempt); } });
  assert.equal(response.message.content, "ok"); assert.equal(calls, 3); assert.deepEqual(waits, [1, 2]);
  await assert.rejects(generateWithCapacityWait(async () => { throw new ModelServiceError("authentication_failed", 401); }, { messages: [] }), ModelServiceError);
});
