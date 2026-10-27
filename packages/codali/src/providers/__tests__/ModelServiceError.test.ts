import test from "node:test";
import assert from "node:assert/strict";
import { ModelServiceError } from "../ModelServiceError.js";

test("service failures distinguish authentication, entitlement, quota, throttling and outages", async () => {
  for (const [status, code] of [[401, "authentication_failed"], [403, "entitlement_missing"], [402, "quota_exhausted"], [429, "rate_limited"], [503, "service_unavailable"], [404, "model_unavailable"]] as const) {
    const error = await ModelServiceError.fromResponse(new Response('{"message":"secret data"}', { status, headers: { "retry-after": "3" } }));
    assert.equal(error.code, code); assert.equal(error.retryAfterSeconds, 3);
    assert.ok(!error.message.includes("secret data"));
  }
  assert.equal((await ModelServiceError.fromResponse(new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }))).code, "quota_exhausted");
});

test("oversized error responses are cancelled without retaining their body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(16384)); }, cancel() { cancelled = true; } });
  const error = await ModelServiceError.fromResponse(new Response(body, { status: 500 }));
  assert.equal(error.code, "service_unavailable"); assert.equal(cancelled, true);
});

test("native structured-output rejection is distinct from an unavailable service and never exposes response data", async () => {
  const error = await ModelServiceError.fromResponse(new Response(JSON.stringify({ error: {
    type: "structured_output_failed", code: "structured_output_failed", message: "Private model answer and credential must never be logged",
  } }), { status: 502 }));
  assert.equal(error.code, "invalid_response");
  assert.doesNotMatch(error.message, /Private|credential|model answer/);
  assert.equal((await ModelServiceError.fromResponse(new Response('{"error":{"code":"unknown_internal_error"}}', { status: 502 }))).code, "service_unavailable");
});
