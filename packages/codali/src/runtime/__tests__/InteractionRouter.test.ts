import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionController, type SessionEvent, type SessionControllerOptions } from "../SessionController.js";
import { orchestrationHash, validateOrchestrationConfig, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import type { Provider, ProviderResponse } from "../../providers/ProviderTypes.js";
import { parseInteractionDecision } from "../InteractionRouter.js";
import { registerSecretValue } from "../SecretRedaction.js";
import { DocdexClient } from "../../docdex/DocdexClient.js";
import { ManagedDocdex } from "../../docdex/ManagedDocdex.js";

const base: OrchestrationConfig = { schemaVersion: 1, profile: "test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } }, models: { model: { provider: "local", catalogId: "test", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } }, bindings: { lead: { candidates: ["model"] }, router: { useBinding: "lead" }, reviewer: { useBinding: "lead" } } };
const reply = (content: string): ProviderResponse => ({ message: { role: "assistant", content }, usage: { inputTokens: 300, outputTokens: 20, totalTokens: 320 } });
const decision = (mode: string, text: string) => reply(JSON.stringify({ mode, text }));
const fixture = async (t: test.TestContext, provider: Provider, config = base, runContext?: { deniedTools: string[] }, docdex = false, options: Partial<SessionControllerOptions> = {}) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codali-interaction-")));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-interaction-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  const events: SessionEvent[] = [];
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved: { config, hash: orchestrationHash(config), source: "test" }, provider, docdex, userInstructionsPath: false, runContext, onEvent: e => events.push(e), ...options });
  return { controller, events, root, storage };
};

test("conversation instructions are sourced, bounded and reloaded between turns", async t => {
  let expected = "Use a brief friendly response.";
  const { controller, root, events } = await fixture(t, { name: "fixture", generate: async request => {
    assert.match(request.messages[0].content, /Instruction source: \[codali\]\/AGENTS.md/);
    assert.ok(request.messages[0].content.includes(expected));
    assert.equal(request.tools, undefined);
    return decision("answer", "Hello.");
  } });
  await fs.writeFile(path.join(root, "AGENTS.md"), expected);
  await controller.interact("hello");
  const first = events.filter(event => event.type === "instructions_loaded").at(-1)!.data.bundleHash;
  expected = "Use a brief formal response.";
  await fs.writeFile(path.join(root, "AGENTS.md"), expected);
  await controller.interact("hello again");
  assert.notEqual(events.filter(event => event.type === "instructions_loaded").at(-1)!.data.bundleHash, first);
  assert.equal(controller.state, undefined);
  assert.equal(controller.usageSnapshot().modelCalls, 2);
});

test("native inspection can load a local skill and uses its actual body without expanding authority", async t => {
  let calls = 0;
  const { controller, events, root } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (++calls === 1) { assert.doesNotMatch(request.messages[0].content, /SKILL_BODY_EVIDENCE/); return decision("inspect", "Use the example skill to explain its planning rule."); }
    if (calls === 2) {
      assert.ok(request.tools?.some(tool => tool.name === "skill_load")); assert.doesNotMatch(JSON.stringify(request.messages), /SKILL_BODY_EVIDENCE/);
      return { ...reply(""), toolCalls: [{ id: "load-skill", name: "skill_load", args: { id: "example" } }] };
    }
    assert.match(JSON.stringify(request.messages), /SKILL_BODY_EVIDENCE/);
    assert.ok(!request.tools?.some(tool => tool.name === "run_shell"));
    return reply("The skill requires measurable milestones.");
  } });
  const directory = path.join(root, ".codali", "skills", "example"); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: example\ndescription: Planning rules.\n---\nSKILL_BODY_EVIDENCE: require measurable milestones.");
  assert.match((await controller.interact("Use the example skill to explain its planning rule.")).content, /measurable/);
  assert.ok(events.some(event => event.type === "tool_receipt" && (event.data.receipt as { tool?: string; status?: string })?.tool === "skill_load" && (event.data.receipt as { status?: string }).status === "success"));
  assert.equal(controller.usageSnapshot().toolCalls, 1);
});

test("inspection focuses tool schemas after native selection and can enable another capability", async t => {
  let calls = 0;
  const { controller, events } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (++calls === 1) return decision("inspect", "Read the server clock, then calculate 2+3.");
    const names = request.tools?.map(tool => tool.name) ?? [];
    if (calls === 2) {
      assert.ok(names.includes("server_time") && names.includes("read_file"));
      return { ...reply(""), toolCalls: [{ id: "clock", name: "server_time", args: {} }] };
    }
    assert.ok(!names.includes("read_file") && !names.includes("run_shell"));
    if (calls === 3) {
      assert.ok(names.includes("server_time") && names.includes("tools_enable") && !names.includes("calculate"));
      return { ...reply(""), toolCalls: [{ id: "enable", name: "tools_enable", args: { names: ["calculate"] } }] };
    }
    if (calls === 4) {
      assert.ok(names.includes("calculate"));
      return { ...reply(""), toolCalls: [{ id: "calculate", name: "calculate", args: { expression: "2+3" } }] };
    }
    return reply("The clock was read and the calculated result is 5.");
  } });
  assert.match((await controller.interact("Read the server time and calculate 2+3 using tools.")).content, /result is 5/);
  assert.ok(events.some(event => event.type === "inspection_tools_focused"));
  assert.equal(controller.turnUsageSnapshot().toolCalls, 3);
});

test("automatic history compression preserves user constraints, logs originals and survives resume and fork", async t => {
  const config = structuredClone(base); config.interaction = { historyChars: 1800 };
  const longReply = "Earlier explanation. " + "Detailed background. ".repeat(350) + " Final pending decision.";
  let calls = 0;
  const { controller, events, root, storage } = await fixture(t, { name: "fixture", generate: async request => {
    if (++calls === 1) return decision("answer", longReply);
    const data = JSON.parse(request.messages[1].content);
    assert.ok(data.history.some((message: { role: string; content: string }) => message.role === "user" && message.content === "Never deploy. Keep PostgreSQL; all times are milliseconds."));
    assert.ok(data.history.some((message: { content: string }) => message.content.includes("Full saved source:")));
    return decision("answer", "PostgreSQL, milliseconds, and no deployment.");
  } }, config);
  await controller.interact("Never deploy. Keep PostgreSQL; all times are milliseconds.");
  await controller.interact("What constraints did I give you?");
  assert.equal(calls, 2, "compression must not start an unaccounted model call");
  const event = events.find(event => event.type === "context_compacted")!;
  const source = (event.data.archived as { sha256: string; message: { content: string } }[])[0]; assert.equal(source.message.content, longReply);
  const resumed = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved: { config, hash: orchestrationHash(config), source: "test" }, docdex: false, userInstructionsPath: false,
    provider: { name: "fixture", generate: async () => decision("answer", "Ready.") } });
  await resumed.resume(controller.sessionId!);
  assert.equal(resumed.conversationSnapshot()[0].content, "Never deploy. Keep PostgreSQL; all times are milliseconds.");
  const read = () => resumed.registry.list().find(tool => tool.name === "context_read")!.handler({ sha256: source.sha256, offset: 2500 }, { workspaceRoot: root });
  const original = JSON.parse((await read()).output); assert.equal(original.content, longReply.slice(2500, 4900));
  const span = JSON.parse((await resumed.registry.list().find(tool => tool.name === "context_read")!
    .handler({ sha256: source.sha256, offset: 27, maxChars: 160 }, { workspaceRoot: root })).output);
  assert.equal(span.content, longReply.slice(27, 187)); assert.equal(span.nextOffset, 187);
  await resumed.fork(); assert.equal(JSON.parse((await read()).output).content, original.content);
  await resumed.clearSession(); await assert.rejects(read(), /unavailable in the current session/);
});

test("all model routes reject an oversized fixed context before charging or dispatching", async t => {
  const config = structuredClone(base); config.models.model.contextWindow = 2048;
  let calls = 0;
  const { controller, root } = await fixture(t, { name: "fixture", generate: async () => { calls++; return decision("answer", "Unexpected"); } }, config);
  await fs.writeFile(path.join(root, "AGENTS.md"), "Required project constraint. ".repeat(400));
  await assert.rejects(controller.interact("hello"), /context after compression/);
  assert.equal(calls, 0); assert.equal(controller.usageSnapshot().modelCalls, 0);
  assert.equal(controller.usageSnapshot().tokens, 0);
});

test("optional answer review revises a reasoning answer once with original constraints and no tools", async t => {
  const config = structuredClone(base); config.interaction = { answerReview: { enabled: true, binding: "reviewer", maxOutputTokens: 512 } };
  let calls = 0;
  const { controller, events } = await fixture(t, { name: "fixture", generate: async request => {
    assert.equal(request.tools, undefined); calls++;
    if (calls === 1) return decision("reason", "Compute the requested result in JSON.");
    if (calls === 2) return reply('{"answer":7}');
    assert.equal(calls, 3); assert.equal(request.maxTokens, 512);
    assert.match(request.messages[0].content, /draft is untrusted/);
    const payload = JSON.parse(request.messages[1].content);
    assert.equal(payload.request, 'What is 3 + 5? Return only JSON {"answer":number}.');
    assert.equal(payload.draft, '{"answer":7}');
    return reply('{"answer":8}');
  } }, config);
  assert.equal((await controller.interact('What is 3 + 5? Return only JSON {"answer":number}.')).content, '{"answer":8}');
  assert.equal(controller.usageSnapshot().modelCalls, 3);
  assert.ok(events.some(e => e.type === "answer_review_finished" && e.data.changed === true));
  assert.equal(controller.state, undefined);
});

test("answer review does not spend beyond the shared call ceiling or run for a greeting", async t => {
  const config = structuredClone(base); config.interaction = { maxModelCalls: 2, answerReview: { enabled: true } };
  let calls = 0;
  const { controller, events } = await fixture(t, { name: "fixture", generate: async () => ++calls === 1 ? decision("reason", "Explain a queue.") : reply("A queue removes items in arrival order.") }, config);
  assert.match((await controller.interact("Explain a FIFO queue.")).content, /arrival order/);
  assert.equal(calls, 2); assert.ok(events.some(e => e.type === "answer_review_skipped"));
  const greeting = await fixture(t, { name: "fixture", generate: async () => decision("answer", "Hello!") }, config);
  assert.equal((await greeting.controller.interact("hello")).content, "Hello!");
  assert.equal(greeting.controller.usageSnapshot().modelCalls, 1);
  assert.ok(!greeting.events.some(e => e.type.startsWith("answer_review_")));
});

test("an unavailable optional check retains the original answer and records the failure", async t => {
  const config = structuredClone(base); config.interaction = { answerReview: { enabled: true } };
  let calls = 0;
  const { controller, events } = await fixture(t, { name: "fixture", generate: async () => {
    if (++calls === 1) return decision("reason", "Explain an immutable value.");
    if (calls === 2) return reply("An immutable value cannot be changed after creation.");
    throw new Error("Optional check unavailable");
  } }, config);
  assert.match((await controller.interact("Explain immutability.")).content, /cannot be changed/);
  assert.ok(events.some(e => e.type === "answer_review_failed"));
  assert.ok(!events.some(e => e.type === "answer_review_finished"));
  assert.equal(calls, 3);
});

test("inspection uses its last shared model call to answer from real tool evidence", async t => {
  const config = structuredClone(base); config.interaction = { maxModelCalls: 3, maxInspectionSteps: 6, maxTotalTokens: 16000 };
  let calls = 0;
  const { controller, root } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (++calls === 1) return decision("inspect", "Read notes.txt and name the owner.");
    if (calls === 2) {
      assert.ok(request.tools?.some(tool => tool.name === "read_file"));
      return { ...reply(""), toolCalls: [{ id: "owner", name: "read_file", args: { path: "notes.txt" } }] };
    }
    assert.equal(calls, 3); assert.equal(request.tools, undefined); assert.equal(request.toolChoice, "none");
    assert.match(JSON.stringify(request.messages), /Owner: Iris/);
    assert.match(request.messages.at(-1)!.content, /missing evidence/);
    return reply("Iris owns this project (notes.txt).");
  } }, config);
  await fs.writeFile(path.join(root, "notes.txt"), "Owner: Iris\n");
  assert.match((await controller.interact("Who is the owner in notes.txt?")).content, /Iris/);
  assert.equal(controller.usageSnapshot().modelCalls, 3);
  assert.equal(controller.usageSnapshot().toolCalls, 1);
  assert.ok(controller.usageSnapshot().tokens <= 16000);
});

test("status and live usage retain estimated accounting for an unresolved earlier response", async t => {
  let calls = 0;
  const { controller, events } = await fixture(t, { name: "fixture", generate: async () => {
    if (++calls === 1) throw new Error("Invalid response after dispatch");
    return decision("answer", "Hello.");
  } });
  await assert.rejects(controller.interact("hello"), /Invalid response after dispatch/);
  const usage = controller.status().usage as { tokens: number; estimated: boolean };
  assert.ok(usage.tokens > 0); assert.equal(usage.estimated, true);
  assert.deepEqual(usage, controller.usageSnapshot());
  usage.tokens = 0; assert.ok(controller.usageSnapshot().tokens > 0, "status must not expose mutable accounting");
  assert.equal((await controller.interact("hello again")).content, "Hello.");
  assert.equal((controller.status().usage as { estimated: boolean }).estimated, true);
  assert.equal((events.filter(e => e.type === "usage").at(-1)!.data.usage as { estimated: boolean }).estimated, true);
});

test("optional calculator uses real receipts and leaves the final shared call for answering", async t => {
  const config = structuredClone(base); config.interaction = { calculator: true, maxModelCalls: 3 };
  let calls = 0;
  const { controller, events } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (++calls === 1) {
      assert.equal(request.tools, undefined);
      assert.match(request.messages[0].content, /reason mode can use a bounded numeric calculate tool/);
      return decision("reason", "Calculate the weighted mean.");
    }
    if (calls === 2) {
      assert.deepEqual(request.tools?.map(tool => tool.name), ["calculate"]);
      return { ...reply(""), toolCalls: [{ id: "weighted", name: "calculate", args: { expression: "(17*3+29*2)/(3+2)" } }] };
    }
    assert.equal(calls, 3); assert.equal(request.tools, undefined); assert.equal(request.toolChoice, "none");
    assert.match(JSON.stringify(request.messages), /21.8/);
    return reply('{"answer":21.8}');
  } }, config);
  assert.equal((await controller.interact('Find the mean of 17 with weight 3 and 29 with weight 2. Return JSON {"answer":number}.')).content, '{"answer":21.8}');
  assert.equal(controller.state, undefined);
  assert.equal(controller.usageSnapshot().modelCalls, 3);
  assert.equal(controller.usageSnapshot().toolCalls, 1);
  assert.ok(events.some(e => e.type === "tool_receipt" && (e.data.receipt as { tool: string; status: string }).tool === "calculate" && (e.data.receipt as { status: string }).status === "success"));
  assert.ok(!events.some(e => e.type === "index_ready"));
});

test("calculator is not exposed for greetings or when repository policy denies it", async t => {
  const config = structuredClone(base); config.interaction = { calculator: true };
  const hello = await fixture(t, { name: "fixture", generate: async request => {
    assert.equal(request.tools, undefined); return decision("answer", "Hello!");
  } }, config);
  await hello.controller.interact("hello");
  assert.equal(hello.controller.usageSnapshot().modelCalls, 1);
  assert.equal(hello.controller.usageSnapshot().toolCalls, 0);
  let calls = 0;
  const denied = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (++calls === 1) return decision("reason", "Compute three plus five.");
    assert.ok(!request.tools?.length);
    return reply("8");
  } }, config, { deniedTools: ["calculate"] });
  assert.equal((await denied.controller.interact("What is three plus five?")).content, "8");
  assert.equal(denied.controller.usageSnapshot().toolCalls, 0);
});

test("calculator remains usable after two unknown requests without erasing their reservations", async t => {
  const config = structuredClone(base); config.interaction = { calculator: true, maxOutputTokens: 1024 };
  let calls = 0;
  const { controller, events } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (++calls <= 2) throw new Error("Unknown remote outcome");
    if (calls === 3) return decision("reason", "Use the calculator to compute the requested expression.");
    if (calls === 4) {
      assert.ok(request.tools?.some(tool => tool.name === "calculate"));
      assert.equal(request.maxTokens, 1024);
      return { ...reply(""), toolCalls: [{ id: "calculate-recovery", name: "calculate", args: { expression: "(17*6+23*4)/10" } }] };
    }
    assert.match(JSON.stringify(request.messages), /19.4/); return reply('{"answer":19.4}');
  } }, config);
  await assert.rejects(controller.interact("Hello"), /Unknown remote outcome/);
  await assert.rejects(controller.interact("Remember Juniper"), /Unknown remote outcome/);
  const reserved = controller.usageSnapshot().tokens;
  assert.equal((await controller.interact('Use the calculator for (17*6+23*4)/10. Return JSON {"answer":number}.')).content, '{"answer":19.4}');
  assert.equal(controller.turnUsageSnapshot().tokens, reserved + 3 * 320);
  assert.equal(controller.usageSnapshot().estimated, true);
  assert.equal(controller.usageSnapshot().modelCalls, 5);
  assert.ok(events.some(e => e.type === "usage_recovery"));
});

for (const allow of [false, true]) test(`native Docdex web calls require permission before daemon startup (${allow})`, async t => {
  const config = structuredClone(base);
  config.models.embed = { provider: "local", catalogId: "embed", revision: "sha256:fixture", operations: ["embeddings"], contextWindow: 8192, maxOutputTokens: 1,
    embeddingDimensions: 2, embedding: { queryPrefix: "q:", documentPrefix: "d:", normalization: "l2", pooling: "mean" } };
  config.bindings.embedding = { candidates: ["embed"], embeddingSpace: "web-test" };
  let approved = false, calls = 0;
  const start = t.mock.method(ManagedDocdex.prototype, "start", async () => {
    assert.equal(approved, true);
    return new DocdexClient({ baseUrl: "http://127.0.0.1:1", repoRoot: "/fixture", localSearchOnly: true });
  });
  t.mock.method(DocdexClient.prototype, "waitForIndex", async () => ({ num_docs: 1 }));
  const web = t.mock.method(DocdexClient.prototype, "webResearch", async () => ({ web_context: [{ url: "https://example.org/source", content: "Verified external fact" }] }));
  const { controller, events } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (++calls === 1) return decision("inspect", "Use Docdex to research the requested fact and cite its source.");
    if (calls === 2) {
      assert.ok(request.tools?.some(tool => tool.name === "docdex_web_research"));
      return { ...reply(""), toolCalls: [{ id: "web", name: "docdex_web_research", args: { query: "external fact" } }] };
    }
    assert.match(JSON.stringify(request.messages), allow ? /example.org/ : /denied by user/);
    return reply(allow ? "Verified external fact: https://example.org/source" : "Web access was denied.");
  } }, config, undefined, true, { approve: async request => { assert.equal(request.kind, "web"); approved = allow; return { allow }; } });
  await controller.interact("Use Docdex to research an external fact and cite it.");
  assert.equal(start.mock.callCount(), allow ? 1 : 0); assert.equal(web.mock.callCount(), allow ? 1 : 0);
  assert.ok(events.some(e => e.type === "tool_receipt" && (e.data.receipt as { status: string }).status === (allow ? "success" : "failed")));
  assert.equal(controller.state, undefined);
});

test("nested Docdex inference cannot spend the call or token reserve needed for the final answer", async t => {
  const config = structuredClone(base); config.interaction = { maxModelCalls: 4, maxTotalTokens: 16000 };
  config.models.embed = { provider: "local", catalogId: "embed", revision: "sha256:fixture", operations: ["embeddings"], contextWindow: 8192, maxOutputTokens: 1,
    embeddingDimensions: 2, embedding: { queryPrefix: "q:", documentPrefix: "d:", normalization: "l2", pooling: "mean" } };
  config.bindings.embedding = { candidates: ["embed"], embeddingSpace: "web-test" };
  let nested: Provider, calls = 0, nestedCalls = 0;
  t.mock.method(ManagedDocdex.prototype, "start", async function (this: ManagedDocdex) {
    nested = (this as unknown as { options: { provider: Provider } }).options.provider;
    return new DocdexClient({ baseUrl: "http://127.0.0.1:1", repoRoot: "/fixture", localSearchOnly: true });
  });
  t.mock.method(DocdexClient.prototype, "waitForIndex", async () => ({ num_docs: 1 }));
  t.mock.method(DocdexClient.prototype, "webResearch", async () => {
    await assert.rejects(nested.generate({ messages: [{ role: "user", content: "nested " + "x".repeat(40000) }], maxTokens: 2048 }), /final-answer reserve/);
    await nested.generate({ messages: [{ role: "user", content: "nested bounded classification" }], maxTokens: 64 });
    await assert.rejects(nested.generate({ messages: [{ role: "user", content: "nested optional summary" }], maxTokens: 64 }), /final-answer reserve/);
    return { web_context: [{ url: "https://example.org/primary", content: "The observed value is 27." }] };
  });
  const { controller, events } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    calls++;
    if (request.messages[0].content.startsWith("nested")) { nestedCalls++; return reply('{"category":"general"}'); }
    if (calls === 1) return decision("inspect", "Look up the value with Docdex.");
    if (calls === 2) return { ...reply(""), toolCalls: [{ id: "web", name: "docdex_web_research", args: { query: "observed value" } }] };
    assert.equal(request.tools, undefined); assert.equal(calls, 4); assert.match(JSON.stringify(request.messages), /observed value is 27/);
    return reply("27, from https://example.org/primary");
  } }, config, undefined, true, { allowWeb: true });
  assert.match((await controller.interact("Use Docdex web research to find the observed value.")).content, /27/);
  assert.equal(calls, 4); assert.equal(nestedCalls, 1); assert.equal(controller.usageSnapshot().modelCalls, 4);
  assert.equal(events.filter(event => event.type === "docdex_inference_skipped").length, 2);
  assert.ok(controller.usageSnapshot().tokens <= 16000);
});

test("answer review receives actual calculator evidence without additional tool access", async t => {
  const config = structuredClone(base); config.interaction = { calculator: true, answerReview: { enabled: true } };
  let calls = 0;
  const { controller } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (++calls === 1) return decision("reason", "Calculate three plus five.");
    if (calls === 2) return { ...reply(""), toolCalls: [{ id: "sum", name: "calculate", args: { expression: "3+5" } }] };
    if (calls === 3) return reply("8");
    assert.equal(calls, 4); assert.equal(request.tools, undefined);
    const payload = JSON.parse(request.messages[1].content);
    assert.ok(payload.calculationEvidence.some((m: { role: string }) => m.role === "tool"));
    assert.match(JSON.stringify(payload.calculationEvidence), /3\+5/);
    assert.match(JSON.stringify(payload.calculationEvidence), /result/);
    return reply("8");
  } }, config);
  assert.equal((await controller.interact("What is three plus five?")).content, "8");
  assert.equal(controller.usageSnapshot().modelCalls, 4);
});

test("answer review configuration rejects unavailable bindings and excessive output", () => {
  for (const answerReview of [{ enabled: "yes" }, { enabled: true, binding: "missing" }, { enabled: true, maxOutputTokens: 4097 }, { enabled: true, bypassPermissions: true }]) {
    assert.throws(() => validateOrchestrationConfig({ ...base, interaction: { answerReview } }));
  }
  for (const calculator of ["true", 1, {}, null]) assert.throws(() => validateOrchestrationConfig({ ...base, interaction: { calculator } }));
  assert.equal(validateOrchestrationConfig({ ...base, interaction: { calculator: true } }).interaction?.calculator, true);
});

test("configured native dispatcher schema is sent on the initial request and repair, without weakening parsing", async t => {
  const config = structuredClone(base); config.interaction = { routerResponseFormat: "json_schema" };
  let calls = 0;
  const { controller, events } = await fixture(t, { name: "fixture", generate: async request => {
    assert.equal(request.responseFormat?.type, "json_schema");
    const envelope = request.responseFormat!.schema! as { strict: boolean; schema: { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> } };
    assert.equal(envelope.strict, true); assert.equal(envelope.schema.additionalProperties, false);
    assert.deepEqual(envelope.schema.required, ["mode", "text"]);
    if (++calls === 1) return reply('{"mode":"write","answer":"not a valid dispatch"}');
    return decision("answer", "Hello!");
  } }, config);
  assert.equal((await controller.interact("hello")).content, "Hello!");
  assert.equal(calls, 2); assert.ok(events.some(e => e.type === "interaction_route_invalid"));
  assert.equal(controller.state, undefined);
  assert.throws(() => validateOrchestrationConfig({ ...base, interaction: { routerResponseFormat: "invented" } }));
});

test("Docdex inspection starts only on an authorized Docdex call and exposes no mutations", async t => {
  const start = t.mock.method(DocdexClient.prototype, "waitForIndex", async () => ({ num_docs: 1 }));
  const search = t.mock.method(DocdexClient.prototype, "search", async (query: string) => {
    assert.equal(query, "owner"); return { hits: [{ path: "notes.txt", snippet: "Owner: Iris" }] };
  });
  let calls = 0;
  const { controller, events } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    calls++;
    if (calls === 1) return decision("answer", "Hello.");
    if (calls === 2) return decision("inspect", "Find the owner in repository notes.");
    assert.ok(request.tools?.some(tool => tool.name === "docdex_search"));
    assert.match(request.tools!.find(tool => tool.name === "docdex_search")!.description ?? "", /local repository only/);
    assert.ok(!request.tools?.some(tool => ["docdex_memory_save", "docdex_initialize", "docdex_index_rebuild", "docdex_delegate", "run_shell", "write_file"].includes(tool.name)));
    if (calls === 3) return { ...reply(""), toolCalls: [{ id: "search-owner", name: "docdex_search", args: { query: "owner" } }] };
    assert.match(JSON.stringify(request.messages), /Owner: Iris/); return reply("The owner is Iris, according to notes.txt.");
  } }, base, undefined, true);
  await controller.interact("hello"); assert.equal(start.mock.callCount(), 0);
  assert.match((await controller.interact("Who owns this project?")).content, /Iris/);
  assert.equal(start.mock.callCount(), 1); assert.equal(search.mock.callCount(), 1);
  assert.ok(events.some(event => event.type === "index_ready" && event.data.mode === "inspection"));
  assert.equal(controller.state, undefined);
});

test("host-denied Docdex calls never start indexing or reach the daemon", async t => {
  const start = t.mock.method(DocdexClient.prototype, "waitForIndex", async () => { throw new Error("must not start"); });
  let calls = 0;
  const { controller } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (calls++ === 0) return decision("inspect", "Find the repository owner.");
    if (calls === 2) return { ...reply(""), toolCalls: [{ id: "search-denied", name: "docdex_search", args: { query: "owner" } }] };
    assert.match(JSON.stringify(request.messages), /excluded by the host or repository policy/);
    return reply("Repository search is not permitted.");
  } }, base, { deniedTools: ["docdex_search"] }, true);
  await controller.interact("Find the project owner"); assert.equal(start.mock.callCount(), 0);
});

test("inspection discovers extra read tools without enabling mutations or widening host permissions", async t => {
  const start = t.mock.method(DocdexClient.prototype, "waitForIndex", async () => ({ num_docs: 1 }));
  t.mock.method(DocdexClient.prototype, "stats", async () => ({ num_docs: 37 }));
  let calls = 0;
  const { controller } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    calls++;
    if (calls === 1) return decision("inspect", "Inspect the repository tree without changes.");
    if (calls === 2) {
      assert.ok(!request.tools?.some(tool => tool.name === "docdex_stats"));
      return { ...reply(""), toolCalls: [{ id: "discover", name: "tools_discover", args: {} }] };
    }
    if (calls === 3) {
      assert.match(JSON.stringify(request.messages), /docdex_stats/);
      return { ...reply(""), toolCalls: [{ id: "bad-enable", name: "tools_enable", args: { names: ["docdex_stats", "write_file"] } }] };
    }
    if (calls === 4) {
      assert.ok(!request.tools?.some(tool => tool.name === "docdex_stats"));
      assert.match(JSON.stringify(request.messages), /Only permitted read-only tools/);
      return { ...reply(""), toolCalls: [{ id: "enable", name: "tools_enable", args: { names: ["docdex_stats"] } }] };
    }
    if (calls === 5) {
      assert.ok(request.tools?.some(tool => tool.name === "docdex_stats"));
      assert.ok(!request.tools?.some(tool => tool.name === "write_file"));
      return { ...reply(""), toolCalls: [{ id: "tree", name: "docdex_stats", args: {} }] };
    }
    assert.match(JSON.stringify(request.messages), /num_docs/); return reply("The index contains 37 documents.");
  } }, base, undefined, true);
  assert.match((await controller.interact("Show the source tree using Docdex.")).content, /37/);
  assert.equal(start.mock.callCount(), 1); assert.equal(controller.state, undefined);
});

test("failed Docdex preparation leaves ordinary read-only investigation available", async t => {
  const start = t.mock.method(DocdexClient.prototype, "waitForIndex", async () => { throw new Error("fixture daemon unavailable"); });
  let calls = 0;
  const { controller, root } = await fixture(t, { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (calls++ === 0) return decision("inspect", "Read the repository owner.");
    if (calls === 2) return { ...reply(""), toolCalls: [{ id: "search-offline", name: "docdex_search", args: { query: "owner" } }] };
    if (calls === 3) {
      assert.match(JSON.stringify(request.messages), /Docdex could not be prepared/);
      return { ...reply(""), toolCalls: [{ id: "file-fallback", name: "read_file", args: { path: "notes.txt" } }] };
    }
    assert.match(JSON.stringify(request.messages), /Owner: Vera/); return reply("notes.txt names Vera. Docdex was unavailable.");
  } }, base, undefined, true);
  await fs.writeFile(path.join(root, "notes.txt"), "Owner: Vera");
  assert.match((await controller.interact("Find the owner in the project")).content, /Vera/);
  assert.equal(start.mock.callCount(), 1); assert.equal(controller.state, undefined);
});

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
