import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionController, type SessionEvent } from "../SessionController.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";

for (const rejected of [false, true]) {
  test(`tool attempts after the last model snapshot survive reconciliation and resume (rejected: ${rejected})`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-tool-usage-"));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-tool-usage-state-"));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
    const config: OrchestrationConfig = { schemaVersion: 1, profile: "tool-usage",
      providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
      models: { large: { provider: "local", catalogId: "large", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } },
      bindings: { lead: { candidates: ["large"] } }, effort: { medium: { maxModelCalls: 1 } } };
    const events: SessionEvent[] = [];
    const options = { workspaceRoot: root, storageRoot: storage,
      resolved: { config, hash: orchestrationHash(config), source: "fixture" }, docdex: false, permissions: "workspace" as const };
    let calls = 0;
    const controller = new SessionController({ ...options, onEvent: event => { events.push(event); },
      provider: { name: "fixture", supportsToolCalls: true, generate: async () => {
        calls++;
        return { message: { role: "assistant", content: "" }, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          toolCalls: [{ id: "last-call", name: rejected ? "run_shell" : "work_status",
            args: rejected ? { command: "node", args: ["-e", "throw new Error('unclaimed shell must not execute')"] } : {} }] };
      } } });
    await assert.rejects(controller.run("Inspect the task status without changing the repository."), /This turn reached its model\/token limit/);
    assert.equal(calls, 1);
    const receipts = events.filter(event => event.type === "tool_receipt");
    assert.equal(receipts.length, 1);
    assert.equal((receipts[0].data.receipt as { status: string }).status, rejected ? "failed" : "success");
    const usage = controller.usageSnapshot(); assert.equal(usage.toolCalls, 1); assert.equal(usage.tokens, 15);
    await controller.reconcileUsage(); assert.deepEqual(controller.usageSnapshot(), usage);
    const resumed = new SessionController(options); await resumed.resume(controller.sessionId!);
    assert.deepEqual(resumed.usageSnapshot(), usage);
    await resumed.reconcileUsage(); assert.deepEqual(resumed.usageSnapshot(), usage);
  });
}

for (const scenario of ["smaller-advertised-context", "no-eligible-model", "authentication", "malformed-catalog", "route-observer", "settlement-observer"] as const) {
  test(`undispatched ${scenario} failure releases accounting across resume`, { concurrency: false }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-preflight-"));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-preflight-state-"));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
    const config: OrchestrationConfig = { schemaVersion: 1, profile: "preflight",
      providers: { service: { adapter: "openai-compatible", baseUrl: "https://preflight.test/v1" } },
      models: { large: { provider: "service", catalogId: "large", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } },
      bindings: { lead: { candidates: ["large"] } } };
    const events: SessionEvent[] = []; let dispatches = 0;
    t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") { dispatches++; throw new Error("Inference must not be dispatched"); }
      if (scenario === "authentication") return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
      if (scenario === "malformed-catalog") return Response.json({ data: "invalid" });
      return Response.json({ data: ["no-eligible-model", "settlement-observer"].includes(scenario) ? [] : [{ id: "large", context_window: scenario === "smaller-advertised-context" ? 1024 : 32768 }] });
    });
    const options = { workspaceRoot: root, storageRoot: storage, resolved: { config, hash: orchestrationHash(config), source: "fixture" }, docdex: false };
    const controller = new SessionController({ ...options, onEvent: event => {
      events.push(event);
      if (scenario === "route-observer" && event.type === "model_route") throw new Error("Route observer stopped before dispatch");
      if (scenario === "settlement-observer" && event.type === "model_preflight_failed") throw new Error("Observer stopped after durable refund");
    } });
    const failure = {
      "smaller-advertised-context": /Context budget exceeded/,
      "no-eligible-model": /No eligible configured/,
      authentication: /authentication_failed/,
      "malformed-catalog": /Invalid model catalog/,
      "route-observer": /Route observer stopped/,
      "settlement-observer": /Observer stopped after durable refund/,
    }[scenario];
    await assert.rejects(controller.run("Inspect the repository and preserve the user's original objective."), failure);
    assert.equal(dispatches, 0);
    assert.equal(controller.usageSnapshot().tokens, 0);
    assert.equal(controller.usageSnapshot().modelCalls, 0);
    assert.equal(controller.usageSnapshot().estimated, false);
    assert.ok(events.some(event => event.type === "model_receipt" && event.data.status === "not_dispatched"));
    assert.equal(events.some(event => event.type === "model_receipt" && event.data.status === "outcome_unknown"), false);
    const resumed = new SessionController(options); await resumed.resume(controller.sessionId!);
    assert.deepEqual(resumed.usageSnapshot(), controller.usageSnapshot());
    assert.equal((await resumed.reconcileUsage()).attempted, 0);
    assert.equal(resumed.state?.status, "active");
  });
}

for (const scenario of ["older-unknown-call", "settlement-before-usage-snapshot"] as const) {
  test(`resume restores accounting across ${scenario}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-usage-replay-"));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-usage-replay-state-"));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
    const config: OrchestrationConfig = { schemaVersion: 1, profile: "replay", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
      models: { large: { provider: "local", catalogId: "large", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048 } }, bindings: { lead: { candidates: ["large"] } } };
    const options = { workspaceRoot: root, storageRoot: storage, resolved: { config, hash: orchestrationHash(config), source: "fixture" }, docdex: false };
    const controller = new SessionController(options); await controller.start("Retain accounting");
    const usage = { modelCalls: scenario === "older-unknown-call" ? 2 : 1, toolCalls: 0, tokens: scenario === "older-unknown-call" ? 117 : 17, inputTokens: 10, outputTokens: 7, estimated: false };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    if (scenario === "older-unknown-call") events.push({ type: "model_intent", data: { id: "lost", reservedTokens: 100 } },
      { type: "model_receipt", data: { id: "lost", status: "outcome_unknown", reservedTokens: 100 } });
    events.push({ type: "model_intent", data: { id: "done", reservedTokens: 100 } });
    if (scenario === "settlement-before-usage-snapshot") events.push({ type: "usage", data: { usage: { ...usage, tokens: 100, inputTokens: 0, outputTokens: 0, estimated: true } } });
    events.push({ type: "model_receipt", data: { id: "done", status: "completed", usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17, estimated: false },
      ...(scenario === "settlement-before-usage-snapshot" ? { sessionUsage: usage } : {}) } });
    if (scenario === "older-unknown-call") events.push({ type: "usage", data: { usage } });
    for (const [index, event] of events.entries()) await controller.store.appendTranscript(controller.sessionId!, { type: "note", data: { event: {
      schemaVersion: 1, id: `event-${index}`, sessionId: controller.sessionId, sequence: index + 3, at: new Date().toISOString(), ...event
    } } });
    const resumed = new SessionController(options); await resumed.resume(controller.sessionId!);
    assert.deepEqual(resumed.usageSnapshot(), { ...usage, estimated: scenario === "older-unknown-call" });
  });
}

for (const outcome of ["completed", "missing", "active", "partial", "truncated", "failed-counted", "observer-crash"] as const) {
  test(`authenticated usage reconciliation after a lost connection: ${outcome}`, { concurrency: false }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-usage-reconcile-"));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-usage-reconcile-state-"));
    const oldKey = process.env.CODALI_USAGE_FIXTURE_KEY; process.env.CODALI_USAGE_FIXTURE_KEY = "fixture-accounting-key";
    t.after(async () => { if (oldKey === undefined) delete process.env.CODALI_USAGE_FIXTURE_KEY; else process.env.CODALI_USAGE_FIXTURE_KEY = oldKey;
      await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
    const config: OrchestrationConfig = { schemaVersion: 1, profile: "accounting", providers: { service: { adapter: "mswarm", baseUrl: "https://usage.test/v1/swarm/self-hosted/openai", credentialRef: "env:CODALI_USAGE_FIXTURE_KEY" } },
      models: { large: { provider: "service", catalogId: "large", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } }, bindings: { lead: { candidates: ["large"] } } };
    const resolved = { config, hash: orchestrationHash(config), source: "fixture" };
    const events: SessionEvent[] = []; let requestId = ""; let lookups = 0; let dispatches = 0;
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/agents")) return Response.json({ agents: [{ slug: "large", health_status: "healthy", supports_tools: true }] });
      if (init?.method === "POST") { dispatches++; requestId = new Headers(init.headers).get("x-request-id")!; throw new Error("Connection lost after dispatch"); }
      assert.equal(new URL(String(url)).pathname, `/v1/swarm/self-hosted/requests/${requestId}/receipts`);
      assert.equal(new Headers(init?.headers).get("x-api-key"), "fixture-accounting-key"); lookups++;
      if (outcome === "missing") return Response.json({ error: { code: "not_found", message: "Receipt unavailable" } }, { status: 404 });
      return Response.json({ schema_version: 1, client_request_id: requestId, truncated: outcome === "truncated", invocations: [{ id: "shi_remote",
        status: outcome === "active" ? "started" : outcome === "failed-counted" ? "failed" : "success", operation: "chat.completions",
        usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: outcome === "partial" ? null : 17 } }] });
    });
    const options = { workspaceRoot: root, storageRoot: storage, resolved, docdex: false, permissions: "workspace" as const };
    const controller = new SessionController({ ...options, onEvent: event => {
      events.push(event); if (event.type === "model_usage_reconciled" && outcome === "observer-crash") throw new Error("Observer failed after durable settlement");
    } });
    await assert.rejects(controller.run("Inspect the repository and explain its purpose."), /Connection lost/);
    assert.equal(dispatches, 1); const reserved = controller.usageSnapshot(); assert.equal(reserved.estimated, true); assert.ok(reserved.tokens > 17);
    const settled = ["completed", "failed-counted", "observer-crash"].includes(outcome);
    if (outcome === "observer-crash") await assert.rejects(controller.reconcileUsage(), /Observer failed/);
    else assert.equal((await controller.reconcileUsage()).confirmed, settled ? 1 : 0);
    if (settled) {
      // Re-reading the durable ledger also repairs in-memory state after an
      // observer throws between committed settlement and the caller receiving it.
      assert.equal((await controller.reconcileUsage()).attempted, 0);
      assert.equal(controller.usageSnapshot().tokens, 17); assert.equal(controller.usageSnapshot().estimated, false);
      assert.equal(lookups, 1); assert.equal(controller.state?.status, "active");
      assert.equal(events.filter(event => event.type === "model_usage_reconciled").length, 1);
    } else assert.deepEqual(controller.usageSnapshot(), reserved);
    const resumed = new SessionController(options); await resumed.resume(controller.sessionId!);
    assert.deepEqual(resumed.usageSnapshot(), controller.usageSnapshot());
    assert.equal(dispatches, 1); assert.equal(controller.busy, false);
  });
}
