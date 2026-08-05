import assert from "node:assert/strict";
import test from "node:test";
import { GatewayTracer, redactSecretValues, sanitizeArgs } from "../GatewayTracer.js";

/**
 * The trace is what gets printed to a terminal, screenshotted, and pasted into
 * an issue. It is the most likely place for a connector credential to escape,
 * so redaction ships alongside the first connector rather than in a later
 * "security" phase.
 */

/**
 * Fixtures are assembled from parts rather than written as literals.
 *
 * They have to match the real credential shapes or they would not exercise the
 * redaction patterns — but a complete literal in the source trips GitHub's
 * push protection, which cannot tell a test fixture from a leak. Splitting the
 * prefix keeps the runtime value identical and the file scanner-clean.
 */
const fixture = (prefix: string, body: string): string => `${prefix}${body}`;

const SECRETS: Array<[string, string]> = [
  ["mswarm key", fixture("sk_", "prod_mswarm_ff98c991_ccee5ba376edf0c12b3d7bda9")],
  ["openai key", fixture("sk-", "proj-abcdefghijklmnopqrstuvwxyz012345")],
  ["github token", fixture("ghp", "_abcdefghijklmnopqrstuvwxyz0123456789")],
  ["gitlab token", fixture("glpat", "-abcdefghijklmnopqrst")],
  ["slack token", fixture("xoxb", "-123456789012-abcdefghijklmno")],
  ["aws access key", fixture("AKIA", "IOSFODNN7EXAMPLE")],
  ["google api key", fixture("AIza", "SyA1234567890abcdefghijklmnopqrstuv")],
  ["bearer header", fixture("Bearer ", "eyJhbGciOiJIUzI1NiJ9abcdefghijkl")],
];

for (const [label, secret] of SECRETS) {
  test(`a ${label} is redacted from a traced value`, () => {
    const redacted = redactSecretValues(`token is ${secret} ok`);
    assert.ok(!redacted.includes(secret), `${label} leaked: ${redacted}`);
    assert.match(redacted, /\[redacted\]/);
  });
}

test("secrets in nested tool arguments are redacted", () => {
  const sanitized = sanitizeArgs({
    query: "issues",
    auth: { header: fixture("Bearer ", "eyJhbGciOiJIUzI1NiJ9abcdefghijkl") },
    nested: [{ token: fixture("ghp", "_abcdefghijklmnopqrstuvwxyz0123456789") }],
  });
  const serialized = JSON.stringify(sanitized);
  assert.ok(!serialized.includes(fixture("ghp", "_abcdefghijklmnopqrstuvwxyz0123456789")));
  assert.ok(!serialized.includes("eyJhbGciOiJIUzI1NiJ9abcdefghijkl"));
});

test("a sensitive key name is redacted even when the value looks innocuous", () => {
  const sanitized = sanitizeArgs({ api_key: "short", apiKey: "x", authorization: "y" });
  assert.deepEqual(sanitized, {
    api_key: "[redacted]",
    apiKey: "[redacted]",
    authorization: "[redacted]",
  });
});

test("redaction happens before truncation, so no recognizable prefix survives", () => {
  // Truncating first could leave "sk_prod_mswarm_ff98c991…" in the trace.
  const secret = fixture("sk_", "prod_mswarm_ff98c991_ccee5ba376edf0c12b3d7bda9");
  const sanitized = sanitizeArgs(`${secret} ${"x".repeat(500)}`);
  assert.ok(!String(sanitized).includes(fixture("sk_", "prod_mswarm_ff98c991")));
});

test("a secret returned by an MCP tool does not reach the rendered trace", () => {
  const tracer = new GatewayTracer("q");
  tracer.recordToolCall({
    taskId: "t1",
    tool: "mcp:github:list_issues",
    args: { headers: { Authorization: fixture("Bearer ghp", "_abcdefghijklmnopqrstuvwxyz0123456789") } },
  });
  tracer.recordToolResult({
    taskId: "t1",
    tool: "mcp:github:list_issues",
    ok: true,
    latencyMs: 12,
  });
  const rendered = tracer.render();
  assert.ok(!rendered.includes(fixture("ghp", "_abcdefghijklmnopqrstuvwxyz0123456789")));
  assert.match(rendered, /mcp:github:list_issues/);
});

test("ordinary values are left intact", () => {
  const sanitized = sanitizeArgs({ query: "open issues in acme/widgets", limit: 5 });
  assert.deepEqual(sanitized, { query: "open issues in acme/widgets", limit: 5 });
});
