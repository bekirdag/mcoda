import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionController, type SessionEvent } from "../SessionController.js";
import type { Provider, ProviderResponse } from "../../providers/ProviderTypes.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import type { ProjectTaskAuthority, ProjectTaskSnapshot } from "@mcoda/shared";

const config: OrchestrationConfig = { schemaVersion: 1, profile: "test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } }, models: { model: { provider: "local", catalogId: "test", revision: "1", operations: ["chat.completions"], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } }, bindings: { lead: { candidates: ["model"] }, reviewer: { useBinding: "lead" } } };
const resolved = { config, hash: orchestrationHash(config), source: "test" };
const reply = (content: string): ProviderResponse => ({ message: { role: "assistant", content }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } });
const call = (name: string, args: unknown): ProviderResponse => ({ ...reply(""), toolCalls: [{ id: `${name}-${Math.random()}`, name, args }] });

test("model receipts separate helper and review usage and link each completed call to its intent", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-role-usage-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-role-usage-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  const candidate = structuredClone(config); candidate.bindings.helper = { useBinding: "lead" };
  let step = 0; let attemptId = ""; const events: SessionEvent[] = [];
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) {
      const payload = JSON.parse(request.messages.at(-1)!.content);
      return payload.task === "extract" ? reply('{"result":"four","sources":["provided-capsule"],"uncertainties":[]}') : reply('{"passed":true,"findings":[]}');
    }
    const previous = () => [...request.messages].reverse().find(message => message.role === "tool")!.content;
    switch (step++) {
      case 0: return call("work_claim", { taskId: "T1" });
      case 1: attemptId = JSON.parse(previous()).attemptId; return call("delegate_helper", { task: "extract", instruction: "Extract the stated answer.", context: "Two plus two is four.", sources: ["provided-capsule"] });
      case 2: assert.match(previous(), /four/); return call("work_verify", { taskId: "T1", attemptId, invocationIds: [], summary: "Two plus two equals four." });
      case 3: return call("work_complete", {});
      default: throw new Error("No further model call is needed.");
    }
  } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved: { config: candidate, hash: orchestrationHash(candidate), source: "fixture" }, provider, docdex: false, permissions: "workspace", onEvent: event => { events.push(event); } });
  assert.equal((await controller.run("Use a bounded helper to extract the supplied arithmetic answer, validate it and report it.")).completed, true);
  const intents = events.filter(event => event.type === "model_intent").map(event => event.data.id);
  const receipts = events.filter(event => event.type === "model_receipt").map(event => event.data);
  assert.equal(receipts.length, 6); assert.deepEqual(receipts.map(receipt => receipt.id), intents);
  assert.equal(receipts.filter(receipt => receipt.binding === "helper").length, 1);
  assert.equal(receipts.filter(receipt => receipt.binding === "reviewer").length, 1);
  for (const receipt of receipts) { assert.equal(receipt.status, "completed"); assert.deepEqual(receipt.usage, { inputTokens: 10, outputTokens: 10, totalTokens: 20, estimated: false }); }
  assert.equal(controller.usageSnapshot().tokens, 120);
});

for (const outcome of ["cancel_after_response", "transport_failure"] as const) {
  test(`model usage receipts retain accounting across ${outcome}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-usage-outcome-"));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-usage-outcome-state-"));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
    const events: SessionEvent[] = []; let controller: SessionController;
    const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async () => {
      if (outcome === "transport_failure") throw new Error("Connection lost after dispatch");
      controller.cancel(); return reply("Response arrived after cancellation.");
    } };
    const options = { workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "workspace" as const };
    controller = new SessionController({ ...options, onEvent: event => { events.push(event); } });
    await assert.rejects(controller.run("Explain a small arithmetic example."), outcome === "transport_failure" ? /Connection lost/ : /Cancelled/);
    const receipt = events.find(event => event.type === "model_receipt")!.data;
    assert.equal(receipt.status, outcome === "transport_failure" ? "outcome_unknown" : "completed");
    assert.equal(controller.usageSnapshot().modelCalls, 1);
    if (outcome === "transport_failure") {
      assert.equal(receipt.usage, undefined); assert.ok(Number(receipt.reservedTokens) > 20);
      assert.equal(controller.usageSnapshot().estimated, true);
    } else {
      assert.deepEqual(receipt.usage, { inputTokens: 10, outputTokens: 10, totalTokens: 20, estimated: false });
      assert.equal(controller.usageSnapshot().tokens, 20); assert.equal(controller.usageSnapshot().estimated, false);
    }
    const resumed = new SessionController(options); await resumed.resume(controller.sessionId!);
    assert.deepEqual(resumed.usageSnapshot(), controller.usageSnapshot());
  });
}

test("task review isolates sibling code, preserves read dependencies, and still rejects incomplete integration", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-review-scope-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-review-scope-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, "value.mjs"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.mjs'; test('value is two',()=>assert.equal(value,2));\n");
  await fs.writeFile(path.join(root, "api.mjs"), "export const format = 'plain text';\n");
  await fs.writeFile(path.join(root, "notes.txt"), "old\n");
  const objective = "Set value to two, document its plain text format in notes.txt, and produce DELIVERY.md.";
  let step = 0; let attemptId = ""; let validation = ""; const reviewed: string[] = []; const events: SessionEvent[] = [];
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) {
      const input = JSON.parse(request.messages.at(-1)!.content); reviewed.push(input.task.id);
      assert.equal(input.task.status, "running");
      if (input.task.id === "B") {
        assert.equal(input.reviewScope, "assigned_task"); assert.equal(input.goal, undefined);
        assert.deepEqual(input.requirements.map((value: { id: string }) => value.id), ["R3"]);
        assert.deepEqual(input.changedPaths, ["notes.txt"]); assert.deepEqual(input.otherTaskChangedPaths, ["value.mjs"]);
        assert.equal(input.source["value.mjs"], undefined); assert.equal(input.source["value.test.mjs"], undefined);
        assert.match(input.source["api.mjs"], /plain text/); assert.equal(input.sourceRoles["api.mjs"], "read_only_context");
        assert.match(input.diff, /notes.txt/); assert.doesNotMatch(input.diff, /value.mjs/);
        assert.ok(input.deferredRequirements.some((value: { id: string }) => value.id === "R1"));
      }
      if (input.task.id === "integration") {
        assert.equal(input.reviewScope, "whole_goal"); assert.equal(input.goal, objective);
        assert.deepEqual(input.changedPaths, ["value.mjs", "notes.txt"]);
        assert.match(input.source["value.test.mjs"], /value is two/);
        return reply('{"passed":false,"findings":["DELIVERY.md is still missing."]}');
      }
      return reply('{"passed":true,"findings":[]}');
    }
    const previous = () => [...request.messages].reverse().find(message => message.role === "tool")!.content;
    switch (step++) {
      case 0: return call("work_refine", { requirements: [{ id: "R2", description: "Set the exported value to two." }, { id: "R3", description: "Document the API format in notes.txt." }], constraints: [], nonGoals: [], tasks: [
        { id: "A", title: "Update value", requirementIds: ["R2"], dependsOn: [], allowedPaths: ["value.mjs", "value.test.mjs"] },
        { id: "B", title: "Document format", requirementIds: ["R3"], dependsOn: ["A"], allowedPaths: ["notes.txt"] },
        { id: "integration", title: "Integrate delivery", requirementIds: ["R1"], dependsOn: ["B"], allowedPaths: ["DELIVERY.md"] },
      ] });
      case 1: return call("work_claim", { taskId: "A" });
      case 2: attemptId = JSON.parse(previous()).attemptId; return call("read_file", { path: "value.mjs" });
      case 3: return call("write_file", { path: "value.mjs", content: "export const value = 2;\n" });
      case 4: return call("run_shell", { command: "node", args: ["--test", "value.test.mjs"] });
      case 5: validation = previous().match(/receiptRef=(receipt:[a-f0-9]{8})/)![1]; return call("work_verify", { taskId: "A", attemptId, invocationIds: [validation], summary: "Value is two and the existing test passes." });
      case 6: assert.equal(JSON.parse(previous()).verified, true); return call("work_claim", { taskId: "B" });
      case 7: attemptId = JSON.parse(previous()).attemptId; return call("read_file", { path: "api.mjs" });
      case 8: return call("read_file", { path: "notes.txt" });
      case 9: return call("write_file", { path: "notes.txt", content: "The API uses plain text.\n" });
      case 10: return call("work_verify", { taskId: "B", attemptId, invocationIds: [], summary: "Documented the API's plain text format." });
      case 11: assert.equal(JSON.parse(previous()).verified, true); return call("work_claim", { taskId: "integration" });
      case 12: attemptId = JSON.parse(previous()).attemptId; return call("work_verify", { taskId: "integration", attemptId, invocationIds: [validation], summary: "Inspect the entire delivery." });
      case 13: assert.match(previous(), /stale/); return call("run_shell", { command: "node", args: ["--test", "value.test.mjs"] });
      case 14: validation = previous().match(/receiptRef=(receipt:[a-f0-9]{8})/)![1]; return call("work_verify", { taskId: "integration", attemptId, invocationIds: [validation], summary: "Inspect the entire delivery." });
      case 15: assert.equal(JSON.parse(previous()).verified, false); assert.match(previous(), /DELIVERY.md/); return call("work_complete", {});
      case 16: assert.match(previous(), /work remains/); return call("work_block", { taskId: "integration", reason: "Fixture ends with a deliberately missing delivery artifact." });
      default: return reply("Integration remains incomplete.");
    }
  } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "workspace", onEvent: event => { events.push(event); } });
  if (!controller.isolation.available) { t.skip(controller.isolation.reason); return; }
  assert.equal((await controller.run(objective)).completed, false);
  assert.deepEqual(reviewed, ["A", "B", "integration"]);
  const reads = events.filter(event => event.type === "tool_intent").map(event => event.data.receipt as { tool: string; args: { path?: string }; taskId?: string; attemptId?: string });
  const dependencyRead = reads.find(receipt => receipt.tool === "read_file" && receipt.args.path === "api.mjs");
  assert.equal(dependencyRead?.taskId, "B"); assert.ok(dependencyRead?.attemptId);
  assert.equal(controller.state?.requirements.length, 3);
});

for (const changeBytes of [true, false]) {
  test(`unfinished-response guard resets only after changed task files: ${changeBytes}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-final-progress-"));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-final-progress-state-"));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
    await fs.writeFile(path.join(root, "notes.txt"), "0\n");
    let step = 0; let attemptId = ""; const events: SessionEvent[] = [];
    const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
      if (request.responseFormat?.type === "json" && !request.tools?.length) return reply('{"passed":true,"findings":[]}');
      const index = step++;
      if (index === 0) return call("work_claim", { taskId: "T1", allowedPaths: ["notes.txt"] });
      if (index === 1) attemptId = JSON.parse([...request.messages].reverse().find(message => message.role === "tool")!.content).attemptId;
      if (index <= 15) {
        const round = Math.floor((index - 1) / 3);
        switch ((index - 1) % 3) {
          case 0: return call("read_file", { path: "notes.txt" });
          case 1: return reply("I will continue with the next update.");
          default: return call("write_file", { path: "notes.txt", content: `${changeBytes ? round + 1 : 0}\n` });
        }
      }
      if (index === 16) return call("work_verify", { taskId: "T1", attemptId, invocationIds: [], summary: "Updated notes.txt to five." });
      if (index === 17) return call("work_complete", {});
      throw new Error("Unexpected extra model call");
    } };
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "workspace", onEvent: event => { events.push(event); } });
    if (changeBytes) {
      assert.equal((await controller.run("Update notes.txt to contain five as the digit 5 followed by a newline.")).completed, true);
      assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "5\n");
      assert.equal(events.filter(event => event.type === "progress_resumed").length, 5);
    } else {
      await assert.rejects(controller.run("Update notes.txt to contain five as the digit 5 followed by a newline."), /repeatedly stopped with unmet criteria/);
      assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "0\n");
      assert.equal(events.filter(event => event.type === "progress_resumed").length, 0);
      assert.equal(controller.state?.status, "active");
    }
  });
}

test("native reasoning preflight refusal refunds the terminal reservation and survives resume", { concurrency: false }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-native-preflight-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-native-preflight-state-"));
  const originalFetch = globalThis.fetch; const originalKey = process.env.CODALI_NATIVE_TEST_KEY;
  process.env.CODALI_NATIVE_TEST_KEY = "fixture-native-credential";
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CODALI_NATIVE_TEST_KEY; else process.env.CODALI_NATIVE_TEST_KEY = originalKey;
    await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true });
  });
  const candidate = structuredClone(config);
  candidate.providers.local = { adapter: "mswarm", baseUrl: "https://models.test/v1/swarm/self-hosted/openai", credentialRef: "env:CODALI_NATIVE_TEST_KEY" };
  candidate.models.model.reasoning = { high: { reasoning_effort: "high", reasoning_budget_tokens: 1024 } };
  const selected = { config: candidate, hash: orchestrationHash(candidate), source: "fixture" };
  let dispatched = 0; const events: SessionEvent[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") { dispatched++; throw new Error("Inference must not be dispatched"); }
    return String(url).endsWith("/agents") ? Response.json({ agents: [{ slug: "test", supports_tools: true }] })
      : Response.json({ data: [{ id: "test", supports_reasoning: true }] });
  };
  const options = { workspaceRoot: root, storageRoot: storage, resolved: selected, docdex: false as const, permissions: "plan" as const, effort: "high" as const };
  const controller = new SessionController({ ...options, onEvent: event => { events.push(event); } });
  await assert.rejects(controller.run("Plan a small source change using native reasoning."), /Native reasoning transport is unavailable/);
  assert.equal(dispatched, 0);
  assert.deepEqual(controller.usageSnapshot(), { modelCalls: 0, toolCalls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, estimated: false });
  assert.ok(events.some(event => event.type === "model_preflight_failed" && event.data.inferenceDispatched === false));
  const receipt = events.find(event => event.type === "model_receipt")!.data;
  assert.equal(receipt.status, "not_dispatched");
  assert.deepEqual(receipt.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false });
  const resumed = new SessionController(options); await resumed.resume(controller.sessionId!);
  assert.deepEqual(resumed.usageSnapshot(), controller.usageSnapshot());
});

test("successful npm --silent test receipts verify changed code and page newest-first without another test run", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-validation-flags-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-validation-flags-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "src/value.mjs"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "test/value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('updated value',()=>assert.equal(value,2));\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node --test test/value.test.mjs" } }));
  let step = 0; let attemptId = ""; let validationReceipt = ""; let reviews = 0;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) {
      reviews++; const input = JSON.parse(request.messages.at(-1)!.content);
      assert.match(input.source["test/value.test.mjs"], /updated value/);
      assert.deepEqual(input.changedPaths, ["src/value.mjs"]);
      return reply('{"passed":true,"findings":[]}');
    }
    const previous = () => [...request.messages].reverse().find(message => message.role === "tool")!.content;
    switch (step++) {
      case 0: return call("work_claim", { taskId: "T1", allowedPaths: ["src/value.mjs", "test/value.test.mjs"] });
      case 1: attemptId = JSON.parse(previous()).attemptId; return call("read_file", { path: "src/value.mjs" });
      case 2: return call("write_file", { path: "src/value.mjs", content: "export const value = 2;\n" });
      case 3: return call("run_shell", { command: "node", args: ["--version"] });
      case 4: return call("run_shell", { command: "npm", args: ["--silent", "test"] });
      case 5: assert.match(previous(), /# pass 1/); return call("work_status", { receiptsOnly: true, receiptTools: ["run_shell"], limit: 1 });
      case 6: {
        const page = JSON.parse(previous()); assert.equal(page.totalReceipts, 2); assert.equal(page.nextReceiptOffset, 1);
        assert.equal(page.receipts.length, 1); assert.deepEqual(page.receipts[0].args, { command: "npm", args: ["--silent", "test"] });
        assert.deepEqual(page.receipts[0].validation, { recognized: true, current: true }); validationReceipt = page.receipts[0].receiptRef;
        return call("work_status", { receiptsOnly: true, receiptTools: ["run_shell"], offset: 1, limit: 1 });
      }
      case 7: {
        const page = JSON.parse(previous()); assert.equal(page.nextReceiptOffset, null); assert.equal(page.receipts[0].validation.recognized, false);
        return call("work_verify", { taskId: "T1", attemptId, invocationIds: [validationReceipt], summary: "Updated value to two; npm --silent test passed the actual test." });
      }
      case 8: return call("work_complete", {});
      default: return reply("Updated value to two and verified its test.");
    }
  } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "workspace" });
  if (!controller.isolation.available) { t.skip(controller.isolation.reason); return; }
  assert.equal((await controller.run("Set the exported value to two and run the existing test.")).completed, true);
  assert.equal(reviews, 1); assert.equal(step, 9);
});

test("passing an existing test cannot bypass an explicit test-addition requirement even with an approving reviewer", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-required-tests-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-required-tests-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "src/value.mjs"), "export const value = 1;\n");
  const originalTests = "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('value',()=>assert.equal(value,2));\n";
  await fs.writeFile(path.join(root, "test/value.test.mjs"), originalTests);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node --test test/value.test.mjs" } }));
  let step = 0; let attemptId = ""; let receipt = ""; let reviews = 0;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) {
      reviews++; const review = JSON.parse(request.messages.at(-1)!.content);
      assert.ok(review.changedPaths.includes("test/value.test.mjs"));
      assert.match(review.source["test/value.test.mjs"], /numeric public value/);
      return reply('{"passed":true,"findings":[]}');
    }
    const previous = () => [...request.messages].reverse().find(message => message.role === "tool")!.content;
    switch (step++) {
      case 0: return call("work_claim", { taskId: "T1", allowedPaths: ["src/value.mjs", "test/value.test.mjs"] });
      case 1: attemptId = JSON.parse(previous()).attemptId; return call("read_file", { path: "src/value.mjs" });
      case 2: return call("write_file", { path: "src/value.mjs", content: "export const value = 2;\n" });
      case 3: return call("run_shell", { command: "npm", args: ["--silent", "test"] });
      case 4: assert.match(previous(), /# pass 1/); return call("work_status", { receiptsOnly: true, receiptTools: ["run_shell"], limit: 1 });
      case 5: receipt = JSON.parse(previous()).receipts[0].receiptRef; return call("work_verify", { taskId: "T1", attemptId, invocationIds: [receipt], summary: "Implemented and tested everything." });
      case 6: assert.match(previous(), /no test source has changed/); assert.equal(reviews, 0); return call("read_file", { path: "test/value.test.mjs" });
      case 7: return call("write_file", { path: "test/value.test.mjs", content: `${originalTests}test('numeric public value',()=>assert.equal(typeof value,'number'));\n` });
      case 8: return call("run_shell", { command: "npm", args: ["--silent", "test"] });
      case 9: assert.match(previous(), /# pass 2/); return call("work_status", { receiptsOnly: true, receiptTools: ["run_shell"], limit: 1 });
      case 10: receipt = JSON.parse(previous()).receipts[0].receiptRef; return call("work_verify", { taskId: "T1", attemptId, invocationIds: [receipt], summary: "Implemented the value and added a numeric type regression test; both pass." });
      case 11: return call("work_complete", {});
      default: return reply("Implemented and added the requested coverage.");
    }
  } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "workspace" });
  if (!controller.isolation.available) { t.skip(controller.isolation.reason); return; }
  assert.equal((await controller.run("Set the exported value to two and add meaningful public tests in test/value.test.mjs. Run the tests and preserve package.json.")).completed, true);
  assert.equal(reviews, 1); assert.equal(step, 12);
});

test("a successful check that changes source cannot certify the changed bytes", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-check-inputs-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-check-inputs-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "src/value.mjs"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "test/value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs'; import {value} from '../src/value.mjs'; test('checks then rewrites',()=>{assert.equal(value,2);writeFileSync(new URL('../src/value.mjs',import.meta.url),'export const value = 3;\\n');});\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node --test test/value.test.mjs" } }));
  let step = 0; let attemptId = ""; let reviews = 0;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) { reviews++; return reply('{"passed":true,"findings":[]}'); }
    const previous = () => [...request.messages].reverse().find(message => message.role === "tool")!.content;
    switch (step++) {
      case 0: return call("work_claim", { taskId: "T1", allowedPaths: ["src/value.mjs"] });
      case 1: attemptId = JSON.parse(previous()).attemptId; return call("read_file", { path: "src/value.mjs" });
      case 2: return call("write_file", { path: "src/value.mjs", content: "export const value = 2;\n" });
      case 3: return call("read_file", { path: "src/value.mjs" });
      case 4: return call("run_shell", { command: "npm", args: ["--silent", "test"], writePaths: ["src/value.mjs"] });
      case 5: assert.match(previous(), /# pass 1/); return call("work_status", { receiptsOnly: true, receiptTools: ["run_shell"] });
      case 6: {
        const receipt = JSON.parse(previous()).receipts[0]; assert.deepEqual(receipt.validation, { recognized: true, current: false });
        return call("work_verify", { taskId: "T1", attemptId, invocationIds: [receipt.receiptRef], summary: "The check passed." });
      }
      case 7: assert.match(previous(), /Validation receipt is stale/); return call("work_block", { taskId: "T1", reason: "The test rewrites source after its assertion; inspect before accepting the output." });
      default: return reply("Verification is blocked by changed test inputs.");
    }
  } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "workspace" });
  if (!controller.isolation.available) { t.skip(controller.isolation.reason); return; }
  assert.equal((await controller.run("Update the value to two and verify it.")).completed, false);
  assert.equal(reviews, 0); assert.equal(controller.state?.evidence.length, 0);
  assert.equal(await fs.readFile(path.join(root, "src/value.mjs"), "utf8"), "export const value = 3;\n");
});

test("the latest failed check survives conversation compaction and a new controller", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-check-memory-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-check-memory-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  const marker = "PERSISTED_CHECK_FAILURE_X";
  await fs.writeFile(path.join(root, "value.test.mjs"), `import test from 'node:test'; import assert from 'node:assert/strict'; for(let i=0;i<18;i++)test('earlier successful validation case '+i,()=>assert.equal(1,1)); test('late failure',()=>assert.fail('${marker}'));\n`);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node --test value.test.mjs" } }));
  for (let i = 1; i <= 10; i++) await fs.writeFile(path.join(root, `notes-${i}.txt`), `User-owned note ${i}\n`);
  let step = 0;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (step === 0) { step++; return call("work_claim", { taskId: "T1", allowedPaths: ["value.test.mjs"] }); }
    if (step === 1) { step++; return call("run_shell", { command: "npm", args: ["--silent", "test"] }); }
    if (step === 2) assert.match([...request.messages].reverse().find(message => message.role === "tool")!.content, new RegExp(marker));
    if (step++ < 10) return call("read_file", { path: `notes-${step}.txt` });
    if (step === 11) {
      assert.ok(!request.messages.some(message => message.role === "tool" && message.content.includes(marker)), "old failed output must have left the conversation window");
      assert.ok(request.messages.some(message => message.role === "system" && message.content.includes(marker) && message.content.includes('"status":"failed"')), request.messages.find(message => message.role === "system")?.content.split("Latest validation receipt")[1]?.split("Retrieved memory")[0]);
      return call("work_block", { taskId: "T1", reason: "Preserve the failed check for a later diagnostic turn." });
    }
    return reply("Failed check retained.");
  } };
  const options = { workspaceRoot: root, storageRoot: storage, resolved, docdex: false as const, permissions: "workspace" as const };
  const first = new SessionController({ ...options, provider });
  if (!first.isolation.available) { t.skip(first.isolation.reason); return; }
  assert.equal((await first.run("Diagnose the failing check without claiming success.")).completed, false);
  await first.compact();
  let resumedCalls = 0;
  const resumed = new SessionController({ ...options, provider: { name: "fixture", supportsToolCalls: true, generate: async request => {
    assert.ok(!request.messages.some(message => message.role === "tool" && message.content.includes(marker)));
    assert.ok(request.messages.some(message => message.role === "system" && message.content.includes(marker) && message.content.includes('"status":"failed"')));
    return resumedCalls++ === 0 ? call("work_block", { taskId: "T1", reason: "The recorded failing check still needs repair." }) : reply("Failure remains open.");
  } } });
  await resumed.resume(first.sessionId!);
  assert.equal((await resumed.run()).completed, false); assert.equal(resumedCalls, 2);
});

test("workspace aliases pin the same canonical session identity", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codali-session-alias-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace"); const alias = path.join(parent, "alias");
  await fs.mkdir(root); await fs.symlink(root, alias);
  const options = { resolved, docdex: false, storageRoot: path.join(parent, "state") };
  const direct = new SessionController({ ...options, workspaceRoot: root });
  const aliased = new SessionController({ ...options, workspaceRoot: alias });
  assert.equal(aliased.workspaceRoot, await fs.realpath(root));
  assert.equal(direct.workspaceRoot, aliased.workspaceRoot);
  await aliased.start("Inspect the workspace");
});

test("initial scoped claim retains criteria and rejects traversal or later scope replacement atomically", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-scoped-claim-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-scoped-claim-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, "notes.txt"), "four");
  let step = 0; let attemptId = ""; let controller: SessionController;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) return reply('{"passed":true,"findings":[]}');
    const previous = () => [...request.messages].reverse().find(message => message.role === "tool")!.content;
    switch (step++) {
      case 0: return call("work_claim", { taskId: "T1", allowedPaths: ["../outside"] });
      case 1:
        assert.match(previous(), /invalid path/); assert.equal(controller.state?.planRevision, 1);
        return call("work_claim", { taskId: "T1", allowedPaths: ["notes.txt"] });
      case 2:
        attemptId = JSON.parse(previous()).attemptId; assert.deepEqual(JSON.parse(previous()).requirementIds, ["R1"]);
        return call("work_claim", { taskId: "T1", allowedPaths: ["."] });
      case 3:
        assert.match(previous(), /initial unscoped task/); assert.deepEqual(controller.state?.tasks[0].allowedPaths, ["notes.txt"]);
        assert.equal(controller.state?.tasks[0].attemptId, attemptId); assert.equal(controller.state?.planRevision, 2);
        return call("read_file", { path: "notes.txt" });
      case 4:
        return call("work_verify", { taskId: "T1", attemptId, invocationIds: [previous().match(/receiptRef=(receipt:[a-f0-9]{8})/)![1]], summary: "The note says four." });
      case 5: return call("work_complete", {});
      default: return reply("The note says four.");
    }
  } };
  controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false });
  assert.equal((await controller.run("Read notes.txt and report its value.")).completed, true);
  assert.equal(controller.state?.requirements.length, 1); assert.equal(controller.state?.originalObjective, "Read notes.txt and report its value.");
});

test("later findings reopen verified work and fence dependent tool attempts without losing the goal", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-reopen-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-reopen-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  let step = 0; let firstAttempt = ""; let repairAttempt = ""; let oldDependent = "";
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) return reply('{"passed":true,"findings":[]}');
    const previous = () => [...request.messages].reverse().find(message => message.role === "tool")!.content;
    switch (step++) {
      case 0: return call("work_refine", { requirements: [{ id: "R2", description: "Explain the arithmetic" }], constraints: [], nonGoals: [],
        tasks: [{ id: "T1", title: "Calculate", requirementIds: ["R2"], dependsOn: [], allowedPaths: [] }, { id: "T2", title: "Check answer", requirementIds: ["R1"], dependsOn: ["T1"], allowedPaths: [] }] });
      case 1: return call("work_claim", { taskId: "T1" });
      case 2: firstAttempt = JSON.parse(previous()).attemptId; return call("work_verify", { taskId: "T1", attemptId: firstAttempt, invocationIds: [], summary: "Two plus two equals four." });
      case 3: return call("work_claim", { taskId: "T2" });
      case 4:
        oldDependent = JSON.parse(previous()).attemptId;
        assert.ok(request.tools?.some(tool => tool.name === "work_reopen"));
        return call("work_reopen", { taskId: "T1", reason: "The first explanation omitted why the addition is valid." });
      case 5:
        assert.doesNotMatch(previous(), /^ERROR/, previous());
        assert.deepEqual(JSON.parse(previous()).reopened, ["T1", "T2"]);
        return call("work_claim", { taskId: "T1" });
      case 6:
        repairAttempt = JSON.parse(previous()).attemptId; assert.notEqual(repairAttempt, firstAttempt);
        return call("work_verify", { taskId: "T1", attemptId: firstAttempt, invocationIds: [], summary: "Late stale result" });
      case 7:
        assert.match(previous(), /[Ss]tale/);
        return call("work_verify", { taskId: "T1", attemptId: repairAttempt, invocationIds: [], summary: "Combining two groups of two yields four items." });
      case 8: return call("work_claim", { taskId: "T2" });
      case 9:
        assert.notEqual(JSON.parse(previous()).attemptId, oldDependent);
        return call("work_verify", { taskId: "T2", attemptId: JSON.parse(previous()).attemptId, invocationIds: [], summary: "The corrected arithmetic and final answer are four." });
      case 10: return call("work_complete", {});
      default: return reply("Four, with the explanation checked.");
    }
  } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false });
  const result = await controller.run("Explain and check two plus two.");
  assert.equal(result.completed, true); assert.equal(controller.state?.originalObjective, "Explain and check two plus two.");
  assert.equal(controller.state?.requirements.length, 2); assert.equal(controller.state?.tasks.length, 2);
  assert.ok(controller.state!.checkpoints.some(checkpoint => /Reopened verified task T1/.test(checkpoint.note)));
  assert.equal(controller.state?.evidence.filter(e => e.kind === "review").length, 3);
});

test("budget exhaustion can finalize verified work without another model call but still rejects stale evidence", async () => {
  for (const stale of [false, true]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-final-budget-"));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-final-budget-state-"));
    const bounded = structuredClone(config); bounded.effort = { medium: { maxModelCalls: 4 } };
    let step = 0; let modelCalls = 0; let receiptRef: string | undefined;
    const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
      modelCalls++;
      if (request.responseFormat?.type === "json" && !request.tools?.length) return reply('{"passed":true,"findings":[]}');
      switch (step++) {
        case 0: return call("read_file", { path: "notes.txt" });
        case 1:
          receiptRef = [...request.messages].reverse().find(message => message.role === "tool")!.content.match(/receiptRef=(receipt:[a-f0-9]{8})/)?.[1];
          assert.ok(receiptRef); return call("work_claim", { taskId: "T1" });
        case 2: return call("work_verify", { taskId: "T1", attemptId: JSON.parse([...request.messages].reverse().find(message => message.role === "tool" && message.name === "work_claim")!.content).attemptId, invocationIds: [receiptRef!], summary: "The notes say four." });
        default: throw new Error("The completed goal must not make another model call");
      }
    } };
    try {
      await fs.writeFile(path.join(root, "notes.txt"), "four\n");
      const controller = new SessionController({ workspaceRoot: root, storageRoot: storage,
        resolved: { config: bounded, hash: orchestrationHash(bounded), source: "test" }, provider, docdex: false,
        onEvent: async event => {
          if (stale && event.type === "tool_receipt" && (event.data.receipt as { tool: string; status: string }).tool === "work_verify" &&
              (event.data.receipt as { status: string }).status === "success") await fs.writeFile(path.join(root, "notes.txt"), "changed by user\n");
        } });
      if (stale) {
        await assert.rejects(controller.run("Read the notes and report their value."), /verified|evidence|criteria|fresh|required|unfinished/i);
        assert.notEqual(controller.state?.status, "completed");
      } else {
        const result = await controller.run("Read the notes and report their value.");
        assert.equal(result.completed, true); assert.match(result.content, /recorded verification evidence/);
      }
      assert.equal(modelCalls, 4);
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
  }
});

test("compact planning acknowledgements and receipt lookup preserve the full canonical contract", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-plan-receipt-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-plan-receipt-state-"));
  const objective = "Plan the change while preserving this exact original objective.";
  const criterion = "Keep the user's existing notes intact.";
  let step = 0; let readReceipt: string | undefined;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    const last = () => JSON.parse(request.messages.at(-1)!.content);
    switch (step++) {
      case 0: return call("work_refine", { requirements: [{ id: "R2", description: criterion }], constraints: ["No dependencies"], nonGoals: [],
        tasks: [{ id: "T1", title: "Inspect notes", requirementIds: ["R1", "R2"], dependsOn: [], allowedPaths: ["notes.txt"] }] });
      case 1:
        assert.equal(last().canonicalContextRefresh, true); assert.equal(last().objective, undefined);
        assert.deepEqual(last().requirementIds, ["R1", "R2"]);
        assert.ok(request.messages.some(m => m.role === "system" && m.content.includes(objective) && m.content.includes(criterion)));
        return call("read_file", { path: "notes.txt" });
      case 2:
        readReceipt = request.messages.at(-1)!.content.match(/invocation receipt ID ([a-f0-9-]+)/)?.[1];
        assert.ok(readReceipt); return call("work_status", { receiptsOnly: true, receiptTools: ["read_file"] });
      case 3:
        assert.equal(last().state, undefined); assert.equal(last().receipts.length, 1);
        assert.equal(last().receipts[0].id, readReceipt); assert.equal(last().receipts[0].status, "success");
        return call("work_status", {});
      case 4:
        assert.equal(last().state.originalObjective, objective);
        assert.deepEqual(last().state.requirements.map((r: { description: string }) => r.description), [objective, criterion]);
        return reply("Plan recorded; notes preserved.");
      default: throw new Error("Unexpected extra model call");
    }
  } };
  try {
    await fs.writeFile(path.join(root, "notes.txt"), "User-owned notes\n");
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "plan" });
    assert.equal((await controller.run(objective)).completed, false);
    assert.equal(controller.state?.requirements.length, 2); assert.equal(step, 5);
    assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "User-owned notes\n");
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("unchanged successful reads produce recovery guidance and a bounded checkpoint instead of exhausting the model budget", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-read-stall-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-read-stall-state-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, "notes.txt"), "Original notes\n");
  const events: SessionEvent[] = []; let calls = 0; let sawGuidance = false;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    calls++; if (request.messages.at(-1)?.content.includes("Progress guidance")) sawGuidance = true;
    return call("read_file", { path: "notes.txt" });
  } };
  const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false,
    permissions: "plan", effort: "high", onEvent: event => { events.push(event); } });
  await assert.rejects(controller.run("Inspect the notes and prepare a plan."), /Repeated read_file.*checkpoint retained/);
  assert.equal(calls, 6); assert.equal(sawGuidance, true);
  assert.equal(controller.state?.status, "active");
  assert.ok(controller.state!.checkpoints.length > 0);
  assert.ok(events.some(event => event.type === "progress_stalled" && event.data.unchangedInputs === true));
  assert.equal(await fs.readFile(path.join(root, "notes.txt"), "utf8"), "Original notes\n");
});

test("planning excludes execution lifecycle tools and rejects forged calls before claims or reviewer inference", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-planning-mode-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-planning-mode-state-"));
  const events: SessionEvent[] = []; let step = 0;
  const forbidden = ["work_claim", "work_verify", "work_complete"];
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    assert.ok(request.tools?.length, "planning must not invoke the execution reviewer");
    assert.ok(request.tools!.every(tool => !forbidden.includes(tool.name)));
    const system = request.messages.find(message => message.role === "system")!.content;
    assert.match(system, /planning-only mode/); assert.ok(!system.includes("Complete every required task"));
    switch (step++) {
      case 0: return call("work_claim", { taskId: "T1" });
      case 1: return call("work_verify", { taskId: "T1", attemptId: "forged", invocationIds: [], summary: "Claim completion" });
      case 2: return call("work_complete", {});
      case 3: return call("work_plan", { tasks: [{ id: "T1", title: "Future implementation", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["src"] }] });
      default: return reply("The future implementation plan is recorded.");
    }
  } };
  try {
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "plan", onEvent: event => { events.push(event); } });
    assert.equal((await controller.run("Plan the implementation without executing it.")).completed, false);
    assert.equal(controller.state!.tasks[0].attemptId, undefined); assert.deepEqual(controller.state!.evidence, []);
    assert.equal(controller.state!.status, "active");
    const receipts = events.filter(event => event.type === "tool_receipt").map(event => event.data.receipt as { tool: string; status: string; output?: string });
    for (const name of forbidden) assert.ok(receipts.some(receipt => receipt.tool === name && receipt.status === "failed" && /Planning mode/.test(receipt.output ?? "")));
    assert.ok(receipts.some(receipt => receipt.tool === "work_plan" && receipt.status === "success"));
    assert.equal(step, 5);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

const projectAuthorityFixture = (loseFirstHandoffResponse = false) => {
  let snapshot: ProjectTaskSnapshot = { schemaVersion: 1, authority: "mcoda", taskId: "project-task", key: "PROJ-1", projectId: "project", title: "Answer arithmetic", description: "Explain why two plus two is four.", status: "not_started", revision: "original", dependencies: [] };
  let acceptedOperation: string | undefined; let submissions = 0; let claims = 0;
  const authority: ProjectTaskAuthority = {
    read: async () => structuredClone(snapshot),
    acquire: async (_task, sessionId, revision) => {
      assert.equal(revision, snapshot.revision); claims++;
      snapshot = { ...snapshot, revision: "claimed", status: "in_progress", lease: { id: "lease", sessionId, expiresAt: new Date(Date.now() + 120000).toISOString() } };
      return structuredClone(snapshot);
    },
    check: async expected => { if (expected.revision !== snapshot.revision) throw new Error("Project task changed"); },
    renew: async () => structuredClone(snapshot), release: async () => undefined,
    submit: async (expected, submission) => {
      assert.equal(submission.sessionId, expected.lease?.sessionId);
      assert.ok(submission.evidenceIds.length); assert.match(submission.evidenceDigest, /^[a-f0-9]{64}$/);
      if (acceptedOperation !== submission.operationId) {
        acceptedOperation = submission.operationId; submissions++;
        snapshot = { ...snapshot, revision: "review", status: "ready_to_code_review" };
        if (loseFirstHandoffResponse) throw new Error("Connection lost after the authoritative write");
      }
      return structuredClone(snapshot);
    },
  };
  return { authority, snapshot: () => snapshot, submissions: () => submissions, claims: () => claims, change: () => { snapshot.revision = "external-change"; } };
};

test("project review handoff survives a lost response without duplicate status transitions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-project-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-project-state-"));
  const project = projectAuthorityFixture(true); let step = 0;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) return reply('{"passed":true,"findings":[]}');
    if (++step === 1) return call("work_claim", { taskId: "T1" });
    if (step === 2) return call("work_verify", { taskId: "T1", attemptId: JSON.parse(request.messages.at(-1)!.content).attemptId, invocationIds: [], summary: "Two plus two is four." });
    if (step === 3) return call("work_complete", {});
    return reply("Four.");
  } };
  const options = { workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, projectTaskAuthority: project.authority, projectTaskKey: "PROJ-1" };
  try {
    const controller = new SessionController(options);
    await assert.rejects(controller.run("Complete the task"), /pending project review handoff/);
    assert.ok(controller.state?.projectTask?.pendingSubmission);
    assert.equal(project.snapshot().status, "ready_to_code_review");
    assert.notEqual(controller.state?.status, "completed");
    const resumed = new SessionController(options); await resumed.resume(controller.sessionId!);
    assert.equal(resumed.state?.status, "completed");
    assert.equal(resumed.state?.projectTask?.snapshot.status, "ready_to_code_review");
    assert.equal(resumed.state?.projectTask?.pendingSubmission, undefined);
    assert.equal(project.submissions(), 1);
    assert.match(resumed.state!.originalObjective, /PROJ-1.*Answer arithmetic/);
    const detached = new SessionController({ ...options, projectTaskAuthority: undefined, projectTaskKey: undefined });
    await assert.rejects(detached.resume(controller.sessionId!), /authority/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("project changes fence the next tool and planning never claims the canonical task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-project-fence-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-project-fence-state-"));
  const project = projectAuthorityFixture();
  let change = false;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async () => {
    if (change) { project.change(); return call("work_claim", { taskId: "T1" }); }
    return reply("Plan: inspect the arithmetic requirement.");
  } };
  const options = { workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, projectTaskAuthority: project.authority, projectTaskKey: "PROJ-1" };
  try {
    const planning = new SessionController({ ...options, permissions: "plan" });
    assert.equal((await planning.run("Plan the task")).completed, false);
    assert.equal(project.claims(), 0); assert.equal(project.snapshot().status, "not_started");
    const working = new SessionController(options); change = true;
    await assert.rejects(working.run("Complete the task"), /Project task changed/);
    assert.equal(working.state?.tasks[0].attemptId, undefined);
    assert.equal(project.submissions(), 0);
    await assert.rejects(working.fork(), /one execution owner/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("switching sessions restores only the selected session's usage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-switch-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-switch-store-"));
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async () => reply("A bounded plan") };
  try {
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "plan" });
    await controller.run("Plan a feature");
    const first = controller.sessionId!;
    assert.equal(controller.usageSnapshot().tokens, 20);
    await controller.start("Another goal");
    const second = controller.sessionId!;
    await controller.resume(first);
    assert.equal(controller.usageSnapshot().tokens, 20);
    await controller.resume(second);
    assert.deepEqual(controller.usageSnapshot(), { modelCalls: 0, toolCalls: 0, tokens: 0, inputTokens: 0, outputTokens: 0, estimated: false });
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("configuration reload pins contents and replaces managed versus external Docdex tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-config-reload-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-config-reload-state-"));
  const mutable = structuredClone(resolved);
  try {
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved: mutable });
    mutable.config.profile = "unexpected caller mutation";
    assert.equal(controller.status().configHash, resolved.hash);
    await assert.rejects(controller.reloadConfiguration(mutable), /hash does not match/);
    assert.ok(controller.registry.list().some(t => t.name === "docdex_search"));
    const managed = structuredClone(config);
    managed.models.embedding = { provider: "local", catalogId: "embedding", revision: "sha256:" + "a".repeat(64), operations: ["embeddings"], contextWindow: 8192, maxOutputTokens: 1,
      embeddingDimensions: 2, embedding: { queryPrefix: "q:", documentPrefix: "d:", pooling: "mean", normalization: "l2" } };
    managed.bindings.embedding = { candidates: ["embedding"], embeddingSpace: "fixture-space" };
    await controller.reloadConfiguration({ config: managed, hash: orchestrationHash(managed), source: "managed" });
    assert.equal(controller.registry.list().some(t => t.name === "docdex_search"), false, "managed tools wait for their private daemon to start");
    await controller.reloadConfiguration(resolved);
    assert.equal(controller.registry.list().filter(t => t.name === "docdex_search").length, 1);
    assert.equal(controller.registry.list().some(t => t.name === "docdex_web_research"), false, "external daemon inference defaults remain excluded");
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("premature final answers cannot complete a goal and verified state survives restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-controller-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-controller-store-"));
  const events: SessionEvent[] = []; let step = 0; let attemptId = "";
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) return reply('{"passed":true,"findings":[]}');
    step++;
    if (step === 1) return reply("Done already!");
    if (step === 2) return call("work_claim", { taskId: "T1" });
    if (step === 3) { attemptId = JSON.parse(request.messages.at(-1)!.content).attemptId; return call("work_verify", { taskId: "T1", attemptId, invocationIds: [], summary: "The answer to two plus two is four." }); }
    if (step === 4) return call("work_complete", {});
    return reply("Two plus two is four.");
  } };
  try {
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, onEvent: e => events.push(e) });
    const result = await controller.run("What is two plus two?");
    assert.equal(result.completed, true); assert.equal(step, 4);
    assert.equal(controller.state?.tasks[0].status, "verified");
    assert.equal(controller.usageSnapshot().modelCalls, 5);
    const resumed = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false });
    await resumed.resume(controller.sessionId!);
    assert.equal(resumed.state?.originalObjective, "What is two plus two?");
    assert.equal(resumed.state?.status, "completed");
    assert.equal(resumed.usageSnapshot().modelCalls, 5);
    assert.equal(new Set(events.map(e => e.id)).size, events.length);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("repeated confident answers leave the goal open with a durable checkpoint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-false-done-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-false-done-store-"));
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async () => reply("Everything is complete") };
  try {
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false });
    await assert.rejects(controller.run("Implement and test the requested feature"), /unmet criteria/);
    assert.equal(controller.state?.status, "active"); assert.ok(controller.state!.checkpoints.length > 0);
    assert.equal(controller.busy, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

for (const conflict of [false, true]) test(`final evidence delivery checks unchanged source and fences late edits: conflict=${conflict}`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-evidence-delivery-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-evidence-delivery-state-"));
  const source = "export const expired = (entry, now) => now >= entry.expiresAt;\n";
  let step = 0; let reviewCount = 0; let readReceipt = ""; const events: SessionEvent[] = [];
  let controller!: SessionController;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) {
      reviewCount++;
      const context = JSON.parse(request.messages.at(-1)!.content);
      assert.equal(context.source["cache.mjs"], source);
      assert.equal(context.claimedSummary, "Expiry is inclusive at expiresAt; no code change is required.");
      return reply('{"passed":true,"findings":[]}');
    }
    if (++step === 1) return call("work_claim", { taskId: "T1" });
    if (step === 2) return call("read_file", { path: "cache.mjs" });
    if (step === 3) return call("work_verify", { taskId: "T1", attemptId: controller.state!.tasks[0].attemptId, invocationIds: [readReceipt], summary: "Expiry is inclusive at expiresAt; no code change is required." });
    if (step === 4) return call("work_complete", {});
    throw new Error("An unreviewed final generation could invent a different source implementation");
  } };
  try {
    await fs.writeFile(path.join(root, "cache.mjs"), source);
    controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false,
      onEvent: event => {
        events.push(event); const receipt = event.data.receipt as { id: string; tool: string; status: string } | undefined;
        if (event.type === "tool_receipt" && receipt?.tool === "read_file") readReceipt = receipt.id;
        if (conflict && event.type === "tool_receipt" && receipt?.tool === "work_complete" && receipt.status === "success") writeFileSync(path.join(root, "cache.mjs"), "// concurrent user change after acceptance\n");
      } });
    if (conflict) {
      await assert.rejects(controller.run("Investigate the expiry boundary in cache.mjs without changing code."), /Required task work remains|Unverified\/stale/);
      assert.equal(controller.state?.status, "active"); assert.equal(step, 4);
      assert.equal(events.some(event => event.type === "completion_report"), false);
      return;
    }
    const result = await controller.run("Investigate the expiry boundary in cache.mjs without changing code.");
    assert.equal(result.completed, true); assert.equal(step, 4); assert.equal(reviewCount, 1);
    assert.match(result.content, /Expiry is inclusive/);
    assert.ok(events.some(event => event.type === "completion_report" && event.data.modelCallSkipped === true));
    assert.equal(await fs.readFile(path.join(root, "cache.mjs"), "utf8"), source);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("duplicate completion delivery cannot submit the same project handoff twice", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-completion-handoff-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-completion-handoff-state-"));
  const project = projectAuthorityFixture(); let step = 0; let controller!: SessionController;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    if (request.responseFormat?.type === "json" && !request.tools?.length) return reply('{"passed":true,"findings":[]}');
    if (++step === 1) return call("work_claim", { taskId: "T1" });
    if (step === 2) return call("work_verify", { taskId: "T1", attemptId: controller.state!.tasks[0].attemptId, invocationIds: [], summary: "Two plus two is four." });
    if (step === 3) return { ...reply(""), toolCalls: [...call("work_complete", {}).toolCalls!, ...call("work_complete", {}).toolCalls!] };
    throw new Error("Completion must use accepted evidence without another model call");
  } };
  try {
    controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false,
      projectTaskAuthority: project.authority, projectTaskKey: "PROJ-1" });
    const result = await controller.run("Complete the arithmetic task");
    assert.equal(result.completed, true); assert.equal(project.submissions(), 1); assert.equal(step, 3);
    assert.match(result.content, /submitted for mcoda review/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("cancellation rejects a provider that ignores AbortSignal without accepting late output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-cancel-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-cancel-store-"));
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let release!: (value: ProviderResponse) => void;
  const events: SessionEvent[] = [];
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async () => { started(); return new Promise(resolve => { release = resolve; }); } };
  try {
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, onEvent: event => { events.push(event); } });
    const run = controller.run("Wait for a task"); await ready; controller.cancel();
    await assert.rejects(run, /Cancelled/); const retained = controller.usageSnapshot(); release(reply("Late success"));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(controller.usageSnapshot(), retained);
    assert.equal(events.filter(event => event.type === "model_receipt").length, 0);
    assert.equal(controller.state?.status, "active"); assert.equal(controller.busy, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("fork preserves the objective and decisions but resets claims, evidence and grants", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-fork-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-fork-store-"));
  try {
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, docdex: false });
    await controller.start("Keep the main goal");
    await controller.steer("Preserve existing tests");
    const parent = controller.sessionId;
    const child = await controller.fork();
    assert.notEqual(parent, child);
    assert.equal((await controller.store.readSession(child)).parentSessionId, parent);
    assert.equal(controller.state?.originalObjective, "Keep the main goal");
    assert.equal(controller.state?.requirements.length, 2);
    assert.equal(controller.state?.evidence.length, 0);
    assert.equal(controller.state?.tasks.some(t => t.attemptId || t.status === "verified"), false);
    await controller.reloadConfiguration(resolved);
    assert.equal(controller.registry.list().filter(t => t.name === "media_job_status").length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("the controller enforces structural evidence and invalidates it after source changes", { concurrency: false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-analysis-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-analysis-store-"));
  const originalFetch = globalThis.fetch; let symbols = 0; let ingests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); let payload: unknown = {};
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/v1/initialize") payload = { repo_id: "fixture" };
    if (url.pathname === "/v1/index/status") payload = { ready: true };
    if (url.pathname === "/v1/index/ingest") { ingests++; payload = { ok: true }; }
    if (url.pathname === "/v1/graph/impact") payload = { source: "math.js", edges: [], inbound: [], outbound: [] };
    if (url.pathname === "/v1/mcp") {
      const body = JSON.parse(String(init?.body));
      payload = { result: body.method === "docdex_symbols" ? { file: "math.js", outcome: { status: ++symbols === 1 ? "skipped" : "ok" }, symbols: [] } : {} };
    }
    return Response.json(payload);
  };
  let step = 0;
  const events: SessionEvent[] = [];
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    const previous = request.messages.at(-1)!.content;
    switch (step++) {
      case 0: return call("work_plan", { tasks: [{ id: "T1", title: "Implement", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["math.js"] }] });
      case 1: return call("work_claim", { taskId: "T1" });
      case 2: return call("read_file", { path: "math.js" });
      case 3: return call("write_file", { path: "math.js", content: "export const x = 1;\n" });
      case 4: assert.match(previous, /Fresh structure and impact/); return call("docdex_symbols", { path: "math.js" });
      case 5: return call("docdex_impact_graph", { file: "math.js" });
      case 6: return call("write_file", { path: "math.js", content: "export const x = 1;\n" });
      case 7: assert.match(previous, /Fresh structure analysis/); return call("docdex_symbols", { path: "math.js" });
      case 8: return call("write_file", { path: "math.js", content: "export const x = 1;\n" });
      case 9: assert.match(previous, /Wrote math.js/); return call("read_file", { path: "math.js" });
      case 10: return call("write_file", { path: "math.js", content: "export const x = 2;\n" });
      case 11: assert.match(previous, /Fresh structure and impact/); return call("work_block", { taskId: "T1", reason: "Regression scenario intentionally ends before refreshed analysis" });
      default: return reply("Checkpoint retained.");
    }
  } };
  try {
    await fs.writeFile(path.join(root, "math.js"), "export const x = 0;\n");
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, permissions: "workspace", onEvent: e => events.push(e) });
    const result = await controller.run("Implement the bounded change");
    assert.equal(result.completed, false);
    assert.equal(await fs.readFile(path.join(root, "math.js"), "utf8"), "export const x = 1;\n");
    assert.equal(ingests, 3);
    const analysis = events.filter(e => e.type === "tool_receipt").map(e => e.data.receipt as { analysis?: { valid: boolean } }).filter(r => r.analysis);
    assert.deepEqual(analysis.map(r => r.analysis!.valid), [false, true, true]);
  } finally { globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

for (const scenario of ["success", "skipped-parser", "content-race", "oversized", "host-denied", "budget"] as const) {
  test(`prepare_edit retains child policy and receipts: ${scenario}`, { concurrency: false }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-prepare-"));
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-prepare-state-"));
    const originalFetch = globalThis.fetch; let symbolCalls = 0; let step = 0;
    const events: SessionEvent[] = [];
    const original = scenario === "oversized" ? `// ${"a".repeat(15000)}\nexport const x = 0;\n` : "export const x = 0;\n";
    await fs.writeFile(path.join(root, "math.js"), original);
    t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); let payload: unknown = {};
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname === "/v1/initialize") payload = { repo_id: "fixture" };
      if (url.pathname === "/v1/index/status") payload = { ready: true };
      if (url.pathname === "/v1/graph/impact") payload = { source: "math.js", edges: [], inbound: [], outbound: [] };
      if (url.pathname === "/v1/mcp") {
        const body = JSON.parse(String(init?.body));
        if (body.method === "docdex_symbols") {
          symbolCalls++;
          if (scenario === "content-race") await fs.writeFile(path.join(root, "math.js"), "export const x = 9;\n");
          payload = { result: { file: "math.js", outcome: { status: scenario === "skipped-parser" ? "skipped" : "ok" }, symbols: [] } };
        } else payload = { result: {} };
      }
      return Response.json(payload);
    };
    const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
      const previous = request.messages.at(-1)!.content;
      if (scenario === "budget") {
        if (step++ === 0) return call("prepare_edit", { path: "math.js" });
        assert.match(previous, /Shared tool budget exhausted/); return reply("Budget exhausted without edits.");
      }
      switch (step++) {
        case 0: return call("work_claim", { taskId: "T1", allowedPaths: ["math.js"] });
        case 1: return call("prepare_edit", { path: "math.js" });
        case 2:
          if (scenario === "success") { assert.match(previous, /"prepared":true/); assert.match(previous, /docdex_impact_graph/); }
          else assert.match(previous, /ERROR\[/);
          return call("write_file", { path: "math.js", content: "export const x = 1;\n" });
        case 3:
          assert.match(previous, scenario === "success" ? /Wrote math.js/ : /has not been read/);
          return call("work_block", { taskId: "T1", reason: "Preparation regression scenario finished" });
        default: return reply("Checkpoint retained.");
      }
    } };
    const limited = { ...config, effort: { medium: { maxToolCalls: 3 } } };
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved: scenario === "budget" ? { config: limited, hash: orchestrationHash(limited), source: "test" } : resolved, provider,
      permissions: scenario === "budget" ? "plan" : "workspace", runContext: scenario === "host-denied" ? { deniedTools: ["docdex_symbols"] } : {}, onEvent: e => events.push(e) });
    assert.equal((await controller.run("Prepare and safely edit math.js")).completed, false);
    const expected = scenario === "success" ? "export const x = 1;\n" : scenario === "content-race" ? "export const x = 9;\n" : original;
    assert.equal(await fs.readFile(path.join(root, "math.js"), "utf8"), expected);
    const receipts = events.filter(e => e.type === "tool_receipt").map(e => e.data.receipt as { id: string; tool: string; status: string });
    assert.equal(new Set(receipts.map(r => r.id)).size, receipts.length);
    assert.equal(receipts.find(r => r.tool === "prepare_edit")?.status, scenario === "success" ? "success" : "failed");
    assert.equal(receipts.some(r => r.status === "pending"), false);
    if (scenario === "success") assert.deepEqual(receipts.slice(1, 5).map(r => r.tool), ["read_file", "docdex_symbols", "docdex_impact_graph", "prepare_edit"]);
    if (scenario === "host-denied" || scenario === "oversized") assert.equal(symbolCalls, 0);
    if (scenario === "budget") assert.equal((controller.status().usage as { toolCalls: number }).toolCalls, 3);
  });
}

test("terminal shell is read-only by default and explicit writes cannot bypass structural or task scope checks", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-shell-scope-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-shell-scope-store-"));
  let step = 0;
  const provider: Provider = { name: "fixture", supportsToolCalls: true, generate: async request => {
    const previous = request.messages.at(-1)!.content;
    switch (step++) {
      case 0: return call("work_plan", { tasks: [{ id: "T1", title: "Test shell isolation", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["math.js"] }] });
      case 1: return call("work_claim", { taskId: "T1" });
      case 2: return call("run_shell", { command: "node", args: ["-e", "require('fs').writeFileSync('math.js','bypass')"] });
      case 3: assert.match(previous, /EROFS|EPERM|read-only|Operation not permitted/); return call("run_shell", { command: "node", args: ["-e", "0"], writePaths: ["."] });
      case 4: assert.match(previous, /outside the claimed task scope/); return call("run_shell", { command: "node", args: ["-e", "0"], writePaths: ["math.js"] });
      case 5: assert.match(previous, /has not been read/); return call("work_block", { taskId: "T1", reason: "Regression scenario completed" });
      default: return reply("Blocked writes preserved the file.");
    }
  } };
  try {
    await fs.writeFile(path.join(root, "math.js"), "original");
    const controller = new SessionController({ workspaceRoot: root, storageRoot: storage, resolved, provider, docdex: false, permissions: "workspace" });
    if (!controller.isolation.available) { t.skip(controller.isolation.reason); return; }
    await controller.run("Exercise shell write permissions");
    assert.equal(await fs.readFile(path.join(root, "math.js"), "utf8"), "original");
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});
