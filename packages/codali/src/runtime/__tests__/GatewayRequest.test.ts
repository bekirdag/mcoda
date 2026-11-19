import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGatewayRequest } from "../GatewayRequest.js";

test("unwraps only unambiguous redundant gateway envelopes", () => {
  const request = { name: "browser_read", args: { snapshotId: "x", query: "y" } };
  assert.deepEqual(normalizeGatewayRequest({ name: "codali", args: request }), request);
  assert.deepEqual(normalizeGatewayRequest({ args: request }), request);
  assert.deepEqual(normalizeGatewayRequest({ name: "codali", args: { args: request } }), request);
  assert.equal(normalizeGatewayRequest(request), request);
});

test("does not discard unknown fields, guess names, alter arguments or unwrap without a bound", () => {
  for (const request of [
    { name: "codali", args: { name: "read_file", args: {} }, extra: true },
    { tool: "read_file", input: {} }, { name: "codali", args: [] },
    { name: "read_file", args: { name: "codali", args: { secret: "not a tool request" } } },
  ]) assert.equal(normalizeGatewayRequest(request), request);
  let request: Record<string, unknown> = { name: "read_file", args: { path: "x" } };
  for (let i = 0; i < 5; i++) request = { name: "codali", args: request };
  assert.equal(normalizeGatewayRequest(request).name, "codali");
  assert.deepEqual(normalizeGatewayRequest(null), {});
});
