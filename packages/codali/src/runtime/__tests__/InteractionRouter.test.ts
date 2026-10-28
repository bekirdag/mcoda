import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionController, type SessionEvent } from "../SessionController.js";
import { orchestrationHash, validateOrchestrationConfig, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import type { Provider, ProviderResponse } from "../../providers/ProviderTypes.js";
import { parseInteractionDecision } from "../InteractionRouter.js";
import { registerSecretValue } from "../SecretRedaction.js";

const base: OrchestrationConfig = { schemaVersion: 1, profile: "test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } }, models: { model: { provider: "local", catalogId: "test", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } }, bindings: { lead: { candidates: ["model"] }, router: { useBinding: "lead" }, reviewer: { useBinding: "lead" } } };
const reply = (content: string): ProviderResponse => ({ message: { role: "assistant", content }, usage: { inputTokens: 300, outputTokens: 20, totalTokens: 320 } });
const decision = (mode: string, text: string) => reply(JSON.stringify({ mode, text }));
const fixture = async (t: test.TestContext, provider: Provider, config = base, runContext?: { deniedTools: string[] }) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codali-interaction-")));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-interaction-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  const events: SessionEvent[] = [];
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved: { config, hash: orchestrationHash(config), source: "test" }, provider, docdex: false, runContext, onEvent: e => events.push(e) });
  return { controller, events, root, storage };
};

test("hello produces one bounded answer, no work/index/tools, and private complete audit", async t => {
  const secret = "private-eval-credential-12345"; registerSecretValue(secret);
  let calls = 0;
  const { controller, events, root } = await fixture(t, { name: "fixture", generate: async request => {
    calls++; assert.equal(request.tools, undefined); assert.equal(request.maxTokens, 768);
    return decision("answer", "Hello! How can I help?");
  } });
  const result = await controller.interact(`hello ${secret}`);
  assert.equal(result.content, "Hello! How can I help?"); assert.equal(result.mode, "answer"); assert.equal(result.completed, false, "an answer does not certify work completion"); assert.equal(calls, 1);
  assert.equal(controller.state, undefined); assert.equal(controller.usageSnapshot().tokens, 320);
  assert.equal((await controller.store.readSession(controller.sessionId!)).schemaVersion, 2);
  assert.deepEqual(await fs.readdir(root), []);
  assert.ok(!events.some(e => ["index_ready", "tool_intent", "workspace_baseline"].includes(e.type)));
  for (const type of ["interaction_request", "model_request", "model_response", "interaction_result"]) assert.ok(events.some(e => e.type === type), type);
  const transcript = await fs.readFile(path.join(controller.store.storageDir, controller.sessionId!, "transcript.jsonl"), "utf8");
  assert.doesNotMatch(transcript, new RegExp(secret)); assert.match(transcript, /\[redacted\]/);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(controller.store.storageDir, controller.sessionId!, "transcript.jsonl"))).mode & 0o777, 0o600);
});

test("conversation resumes without inventing a goal and supplies history to a follow-up", async t => {
  let calls = 0;
  const { controller } = await fixture(t, { name: "fixture", generate: async request => {
    if (calls++ === 1) {
      const context = JSON.parse(request.messages[1].content);
      assert.equal(context.history[0].content, "Explain promises");
      assert.equal(context.history[1].content, "Would you like an example?");
    }
    return decision("answer", calls === 1 ? "Would you like an example?" : "Here is an example.");
  } });
  await controller.interact("Explain promises"); const id = controller.sessionId!;
  await controller.clearSession(); await controller.resume(id);
  assert.equal(controller.state, undefined);
  await controller.interact("go ahead"); assert.equal(controller.sessionId, id); assert.equal(calls, 2);
});

test("a side question preserves the active goal and its revision", async t => {
  const { controller } = await fixture(t, { name: "fixture", generate: async request => {
    assert.equal(JSON.parse(request.messages[1].content).activeGoal.objective, "Fix timeout handling");
    return decision("answer", "Four.");
  } });
  await controller.start("Fix timeout handling"); const state = structuredClone(controller.state);
  await controller.interact("What is two plus two?"); assert.deepEqual(controller.state, state);
});

test("invalid router output has only one repair and never starts execution", async t => {
  let calls = 0;
  const { controller, events, root } = await fixture(t, { name: "fixture", generate: async () => { calls++; return reply('{"mode":"execute","text":false}'); } });
  await assert.rejects(controller.interact("hello"), /couldn't reliably understand/);
  assert.equal(calls, 2); assert.equal(controller.state, undefined); assert.deepEqual(await fs.readdir(root), []);
  assert.ok(events.some(e => e.type === "interaction_failed"));
});

test("detailed answers use a prepared brief with the untouched original and no tools", async t => {
  let calls = 0;
  const { controller } = await fixture(t, { name: "fixture", generate: async request => {
    assert.equal(request.tools, undefined);
    if (calls++ === 0) return decision("reason", "Compare the isolation levels using a rigorous schedule.");
    const brief = JSON.parse(request.messages[1].content);
    assert.equal(brief.originalRequest, "Compare isolation levels. Keep it under 300 words.");
    assert.match(brief.preparedBrief, /rigorous/); return reply("A carefully reasoned answer.");
  } });
  assert.equal((await controller.interact("Compare isolation levels. Keep it under 300 words.")).content, "A carefully reasoned answer.");
  assert.equal(calls, 2); assert.equal(controller.state, undefined);
});

test("repository questions can read files but cannot write, run shell or create tasks", async t => {
  let calls = 0;
  const { controller, root } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (calls++ === 0) return decision("inspect", "Read notes.txt and report its value without edits.");
    assert.ok(request.tools?.some(tool => tool.name === "read_file"));
    assert.ok(!request.tools?.some(tool => tool.name.startsWith("work_") || ["write_file", "run_shell"].includes(tool.name)));
    if (calls === 2) return { ...reply(""), toolCalls: [{ id: "read-1", name: "read_file", args: { path: "notes.txt" } }] };
    assert.match(JSON.stringify(request.messages), /forty two/); return reply("notes.txt says forty two.");
  } });
  await fs.writeFile(path.join(root, "notes.txt"), "forty two");
  assert.match((await controller.interact("What does notes.txt say? Don't edit it.")).content, /forty two/);
  assert.equal(controller.state, undefined); assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "forty two");
});

test("configured interaction bindings apply to both explanation and inspection", async t => {
  for (const mode of ["reason", "inspect"] as const) {
    const config = structuredClone(base);
    config.bindings.dispatch = { useBinding: "lead" };
    config.bindings.analyst = { useBinding: "lead" };
    config.interaction = { routerBinding: "dispatch", answerBinding: "analyst" };
    let calls = 0;
    const { controller, events } = await fixture(t, { name: "fixture", supportsToolCalls: true,
      generate: async () => calls++ === 0 ? decision(mode, "Answer the user's question.") : reply("The requested answer.") }, config);
    const result = await controller.interact("Answer my question without making changes.");
    assert.equal(result.mode, mode);
    assert.equal(result.content, "The requested answer.");
    assert.equal(controller.state, undefined);
    assert.deepEqual(events.filter(event => event.type === "model_request").map(event => event.data.binding),
      ["dispatch", "analyst"], `${mode} must use the configured answering binding`);
  }
});

test("later turns have fresh budgets without losing cumulative usage", async t => {
  const config = structuredClone(base); config.interaction = { maxModelCalls: 1, maxTotalTokens: 2000 };
  const { controller } = await fixture(t, { name: "fixture", generate: async () => decision("answer", "Hello.") }, config);
  await controller.interact("hello"); await controller.interact("thanks");
  assert.equal(controller.usageSnapshot().modelCalls, 2); assert.equal(controller.usageSnapshot().tokens, 640);
  assert.equal(controller.turnUsageSnapshot().modelCalls, 1); assert.equal(controller.turnUsageSnapshot().tokens, 320);
});

test("read-only inspection still enforces host tool restrictions", async t => {
  let calls = 0;
  const { controller, root } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (calls++ === 0) return decision("inspect", "Read notes.txt.");
    if (calls === 2) return { ...reply(""), toolCalls: [{ id: "read", name: "read_file", args: { path: "notes.txt" } }] };
    assert.match(JSON.stringify(request.messages), /excluded by the host or repository policy/);
    assert.doesNotMatch(JSON.stringify(request.messages), /restricted-fixture-content/);
    return reply("The host policy does not allow reading that file.");
  } }, base, { deniedTools: ["read_file"] });
  await fs.writeFile(path.join(root, "notes.txt"), "restricted-fixture-content");
  assert.match((await controller.interact("Read notes.txt")).content, /does not allow/);
  assert.equal(controller.state, undefined);
});

test("cancel returns promptly even for an abort-ignoring router; late output cannot execute", async t => {
  let finish!: (response: ProviderResponse) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const { controller, events } = await fixture(t, { name: "fixture", generate: async () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  const pending = controller.interact("hello"); await started; controller.cancel();
  await assert.rejects(pending, /Cancelled/); assert.equal(controller.busy, false);
  finish(decision("execute", "Write hello.txt")); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(controller.state, undefined); assert.ok(!events.some(e => e.type === "interaction_route"));
  assert.ok(controller.usageSnapshot().estimated);
});

test("oversized input is logged and rejected before inference", async t => {
  const config = structuredClone(base); config.interaction = { maxInputChars: 100 };
  const { controller, events } = await fixture(t, { name: "fixture", generate: async () => { throw new Error("must not call"); } }, config);
  await assert.rejects(controller.interact("x".repeat(101)), /character interaction limit/);
  assert.ok(events.some(e => e.type === "interaction_request")); assert.ok(events.some(e => e.type === "interaction_failed"));
  assert.equal(controller.usageSnapshot().modelCalls, 0);
});

test("routing config rejects unavailable bindings and invalid budgets", () => {
  assert.throws(() => validateOrchestrationConfig({ ...base, interaction: { routerBinding: "missing" } }), /unavailable binding/);
  assert.throws(() => validateOrchestrationConfig({ ...base, interaction: { timeoutMs: 0 } }), /positive integer/);
  assert.throws(() => parseInteractionDecision('{"mode":"execute","text":"edit","permission":"all"}'), /invalid decision/);
});

test("a contextual action preserves the original conversation and still requires the work completion gate", async t => {
  let phase = 0;
  const { controller, events } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (phase++ === 0) return decision("answer", "I can create notes.txt containing violet when you ask me to proceed.");
    if (phase === 2) return decision("execute", "Create notes.txt containing violet.");
    assert.ok(request.tools?.some(tool => tool.name === "work_claim"));
    assert.match(JSON.stringify(request.messages), /go ahead/);
    assert.match(JSON.stringify(request.messages), /create notes.txt containing violet/i);
    if (phase === 3) return { ...reply(""), toolCalls: [{ id: "block", name: "work_block", args: { taskId: "T1", reason: "Fixture stops before editing." } }] };
    return reply("Fixture has not completed the action.");
  } });
  await controller.interact("Describe how you could create notes.txt containing violet; do not create it yet.");
  const result = await controller.interact("go ahead");
  assert.equal(result.completed, false); assert.equal(controller.state?.status, "blocked");
  assert.match(controller.state!.originalObjective, /go ahead/); assert.match(controller.state!.originalObjective, /notes.txt/);
  assert.ok(events.some(e => e.type === "interaction_result" && e.data.mode === "execute" && e.data.completed === false));
});

test("interrupted conversation-to-work initialization resumes the original action", async t => {
  const { controller } = await fixture(t, { name: "fixture", generate: async () => decision("execute", "Create notes.txt containing violet.") });
  const original = controller.store.initializeWork.bind(controller.store);
  t.mock.method(controller.store, "initializeWork", async () => { throw new Error("Simulated initialization interruption"); });
  await assert.rejects(controller.interact("Create notes.txt containing violet."), /initialization interruption/);
  const id = controller.sessionId!;
  assert.equal((await controller.store.readSession(id)).kind, "work");
  t.mock.method(controller.store, "initializeWork", original);
  await controller.resume(id);
  assert.equal(controller.state?.originalObjective, "Create notes.txt containing violet.");
});
