import test from "node:test";
import assert from "node:assert/strict";
import { ModelServiceError } from "../ModelServiceError.js";

test("a relay preserves throttling without exposing input or proving zero usage", () => {
  const error = ModelServiceError.fromRelayError({ code: "rate_limited", message: "private prompt and token secret" });
  assert.ok(error instanceof ModelServiceError);
  assert.equal(error.code, "rate_limited");
  assert.equal(error.status, 200);
  assert.equal(error.nativeContextRefused, false);
  assert.doesNotMatch(error.message, /private prompt|token secret/);
  assert.equal(ModelServiceError.fromRelayError({ code: "unknown_code" }), undefined);
});

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

test("native context refusals retain a safe classification without quoting the upstream body", async () => {
  const messages = [
    "request exceeds the context window: prompt (33012 tokens) leaves no room to answer in the context (32768); requests are never truncated",
    'request exceeds the context window: prompt (32000 tokens) + max tokens (8192) exceeds the context (32768); requests are never truncated. Send a smaller max_tokens (at most 752 here), or add "fit_max_tokens": true to the model\'s strata-<model>.json to shorten it to the room left (#545)',
  ];
  for (const message of messages) {
    const error = await ModelServiceError.fromResponse(Response.json({ error: { type: "invalid_request_error", message } }, { status: 400 }));
    assert.equal(error.code, "context_length_exceeded");
    assert.equal(error.nativeContextRefused, true);
    assert.doesNotMatch(error.message, /33012|32000|strata-/);
  }
  for (const [status, message] of [[500, messages[0]], [400, `Private user text: ${messages[0]}`], [400, "request exceeds the context window: private prompt"]] as const) {
    const error = await ModelServiceError.fromResponse(Response.json({ error: { type: "invalid_request_error", message } }, { status }));
    assert.notEqual(error.code, "context_length_exceeded");
    assert.equal(error.nativeContextRefused, false);
    assert.doesNotMatch(error.message, /Private|private prompt/);
  }
  const explicit = await ModelServiceError.fromResponse(Response.json({ error: { code: "context_length_exceeded", message: "secret" } }, { status: 400 }));
  assert.equal(explicit.code, "context_length_exceeded");
  assert.equal(explicit.nativeContextRefused, false, "a code alone does not prove native pre-generation refusal");
  assert.equal(ModelServiceError.fromRelayError({ code: "context_length_exceeded" })?.nativeContextRefused, false);
  assert.doesNotMatch(explicit.message, /secret/);
});
