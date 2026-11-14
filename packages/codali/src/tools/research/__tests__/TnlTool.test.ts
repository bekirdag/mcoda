import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createTnlTool, inspectTnlCredential } from "../TnlTool.js";
import { ToolRegistry, toolDescriptorFor } from "../../ToolRegistry.js";
import { PermissionGate, permissionKind } from "../../../permissions/PermissionGate.js";

const secret = "tnl_test_codali_credential_123456789";
async function fixture(t: TestContext, handler: http.RequestListener) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-tnl-test-"));
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const credentialFile = path.join(root, "tnl.json");
  const save = async (overrides: Record<string, unknown> = {}) => fs.writeFile(credentialFile, JSON.stringify({ apiKey: secret, baseUrl, expiresAt: "2056-10-29T00:00:00Z", ...overrides }), { mode: 0o600 });
  await save();
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const tool = createTnlTool({ credentialFile, timeoutMs: 1000 }); const registry = new ToolRegistry(); registry.register(tool);
  return { root, server, baseUrl, credentialFile, save, tool, run: (args: unknown, signal?: AbortSignal) => registry.execute(tool.name, args, { workspaceRoot: root, signal }) };
}

test("TNL doctor metadata never sends or exposes a credential and does not claim server verification", async t => {
  let calls = 0; const f = await fixture(t, (_req, res) => { calls++; res.end("{}"); });
  const status = await inspectTnlCredential({ credentialFile: f.credentialFile });
  assert.equal(status.configured, true); assert.equal(status.baseUrl, f.baseUrl);
  assert.equal(status.expiresAt, "2056-10-29T00:00:00Z");
  assert.match(status.verification ?? "", /server access and expiry enforcement are not checked/);
  assert.equal(JSON.stringify(status).includes(secret), false);
  await f.save({ expiresAt: "2020-01-01T00:00:00Z" });
  const expired = await inspectTnlCredential({ credentialFile: f.credentialFile });
  assert.equal(expired.configured, false); assert.match(expired.message ?? "", /expired/);
  assert.equal(calls, 0);
});

test("TNL reads use bound credentials, preserve evidence and never return the secret", async t => {
  let requested = "";
  const f = await fixture(t, (req, res) => {
    assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, `Bearer ${secret}`); requested = req.url!;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "e1", title: secret, publishedAt: "2026-10-28T12:00:00Z", verificationState: "contested", sources: [{ url: "https://example.org/source", publishedAt: "2026-10-28T11:00:00Z" }], claims: [{ text: "unconfirmed", confidence: 0.3 }] }], lastSyncAt: "2026-10-29T01:00:00Z", page: { next_cursor: "next" } }));
  });
  const result = await f.run({ operation: "search", query: "energy & prices", country: "Japan", limit: 2, baseUrl: "https://attacker.invalid", apiKey: "model_override" });
  assert.equal(result.ok, true, result.error?.message); assert.equal(result.output.includes(secret), false);
  const data = JSON.parse(result.output); assert.equal(data.evidence.data[0].title, "[redacted]");
  assert.equal(data.evidence.data[0].verificationState, "contested"); assert.equal(data.evidence.data[0].sources[0].url, "https://example.org/source");
  assert.equal(data.evidence.lastSyncAt, "2026-10-29T01:00:00Z"); assert.equal(data.evidence.page.next_cursor, "next");
  const url = new URL(requested, f.baseUrl); assert.equal(url.pathname, "/v1/search"); assert.equal(url.searchParams.get("q"), "energy & prices"); assert.equal(url.searchParams.get("sort"), "pipeline"); assert.equal(url.searchParams.get("page_size"), "2");
});

test("TNL refuses expired, insecure, origin-mismatched and missing credentials before HTTP", async t => {
  let calls = 0; const f = await fixture(t, (_, res) => { calls++; res.end('{}'); });
  await f.save({ expiresAt: "2020-01-01T00:00:00Z" }); assert.equal((await f.run({ operation: "entities" })).ok, false);
  await f.save();
  if (process.platform !== "win32") { await fs.chmod(f.credentialFile, 0o644); assert.equal((await f.run({ operation: "entities" })).ok, false); await fs.chmod(f.credentialFile, 0o600); }
  const mismatch = createTnlTool({ credentialFile: f.credentialFile, baseUrl: "https://elsewhere.invalid" });
  await assert.rejects(mismatch.handler({ operation: "entities" }, { workspaceRoot: f.root }), /private credential/);
  await fs.rm(f.credentialFile); assert.equal((await f.run({ operation: "entities" })).ok, false); assert.equal(calls, 0);
});

test("TNL never follows redirects with credentials", async t => {
  let redirected = 0;
  const f = await fixture(t, (req, res) => { if (req.url === "/stolen") redirected++; res.writeHead(302, { location: "/stolen" }); res.end(); });
  assert.equal((await f.run({ operation: "entities" })).ok, false); assert.equal(redirected, 0);
});

test("TNL forbids noncatalog paths, mutation, bulk reads and reversed date ranges", async t => {
  let calls = 0; const f = await fixture(t, (_, res) => { calls++; res.end('{}'); });
  for (const args of [{ operation: "delete" }, { operation: "story", id: ".." }, { operation: "data_query", resource: "../me" }, { operation: "data_query", resource: "countries", filters: { all: "1" } }, { operation: "search", query: "news", publishedSince: "2026-10-29", publishedUntil: "2026-10-01" }]) {
    assert.equal((await f.run(args)).ok, false);
  }
  assert.equal(calls, 0);
});

test("TNL data queries preserve redistribution and send only bounded catalog filters", async t => {
  let requested = ""; const f = await fixture(t, (req, res) => { requested = req.url!; res.end(JSON.stringify({ data: [], redistribution: "internal_only", next_cursor: null })); });
  const result = await f.run({ operation: "data_query", resource: "countries/trade", filters: { country: "Japan" }, limit: 3 });
  assert.equal(result.ok, true, result.error?.message); const url = new URL(requested, f.baseUrl);
  assert.equal(url.pathname, "/v1/data/countries/trade"); assert.equal(url.searchParams.get("country"), "Japan"); assert.equal(url.searchParams.get("limit"), "3");
  assert.equal(JSON.parse(result.output).evidence.redistribution, "internal_only");
});

test("TNL bounds large results while retaining source metadata", async t => {
  const f = await fixture(t, (_, res) => res.end(JSON.stringify({ body: "x".repeat(90000), sources: [{ url: "https://example.org/evidence" }], publishedAt: "2026-10-28", data: Array.from({ length: 100 }, () => ({ title: "x".repeat(2000) })) })));
  const result = await f.run({ operation: "story", id: "one" }); assert.equal(result.ok, true, result.error?.message);
  const data = JSON.parse(result.output); assert.equal(data.truncated, true); assert.ok(result.output.length < 24000); assert.equal(data.evidence.sources[0].url, "https://example.org/evidence");
});

test("TNL errors do not become evidence and cancellation prevents requests", async t => {
  let calls = 0; const f = await fixture(t, (_, res) => { calls++; res.writeHead(429); res.end(secret); });
  const result = await f.run({ operation: "entities" }); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes(secret), false); assert.match(result.error!.message, /HTTP 429/);
  const abort = new AbortController(); abort.abort(Error("stop TNL")); await assert.rejects(f.run({ operation: "entities" }, abort.signal), /stop TNL/); assert.equal(calls, 1);
});

test("TNL obeys web permissions and explicit tool denials", async () => {
  const descriptor = toolDescriptorFor(createTnlTool()); assert.equal(permissionKind(descriptor), "web");
  await assert.rejects(new PermissionGate("workspace").authorize(descriptor, {}), /Permission/);
  await new PermissionGate("workspace", undefined, { allowWeb: true }).authorize(descriptor, {});
  await assert.rejects(new PermissionGate("workspace", undefined, { allowWeb: true, deniedTools: [descriptor.name] }).authorize(descriptor, {}), /explicitly denied/);
});
