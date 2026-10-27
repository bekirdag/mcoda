import test from "node:test";
import assert from "node:assert/strict";
import { prepareReviewContract, reviewContractSources } from "../ReviewContract.js";
import type { ProviderResponse } from "../../providers/ProviderTypes.js";

const sources = reviewContractSources({
  requirements: [{ id: "R1", description: "Reject overlap with Error('conflict'). Keep the input unchanged." }],
  constraints: ["Run the existing tests."], nonGoals: ["Do not add dependencies."],
});
const checks = sources.map(source => ({ sourceId: source.id, contractQuote: source.text, expectedBehavior: source.text }));
const response = (value: unknown): ProviderResponse => ({ message: { role: "assistant", content: JSON.stringify(value) } });

test("whole-goal preparation retains current steering without duplicating an identical goal source", () => {
  const context = { goal: "Original objective", requirements: [{ id: "R1", description: "Original objective" }], constraints: [], nonGoals: [] };
  assert.equal(reviewContractSources(context).length, 1);
  const current = { ...context, goal: "Original objective\nUser steering: deliver a manifest." };
  const values = reviewContractSources(current);
  assert.deepEqual(values, [{ id: "goal", text: current.goal }, { id: "requirement:R1", text: "Original objective" }]);
});

test("contract preparation receives only authoritative sources and retains exact source attribution", async () => {
  const before = JSON.stringify(sources); let calls = 0;
  const result = await prepareReviewContract({ sources, maxInputChars: 10_000,
    provider: { name: "fixture", generate: async request => {
      calls++; assert.equal(request.tools, undefined); assert.equal(request.maxTokens, 4096);
      assert.deepEqual(JSON.parse(request.messages[1].content), { contractSources: sources });
      assert.equal(request.messages.length, 2); assert.equal(request.responseFormat?.type, "json");
      return response({ checks });
    } } });
  assert.deepEqual(result, { checks }); assert.equal(calls, 1); assert.equal(JSON.stringify(sources), before);
  assert.deepEqual(sources.map(source => source.id), ["requirement:R1", "constraint:0", "nonGoal:0"]);
});

for (const invalid of [
  { checks: checks.slice(0, 1) },
  { checks: checks.map((check, index) => index === 1 ? { ...check, sourceId: "requirement:R1" } : check) },
  { checks: [{ ...checks[0], contractQuote: "Allow any error containing conflict." }, ...checks.slice(1)] },
  { checks: [{ ...checks[0], contractQuote: " " }, ...checks.slice(1)] },
  { checks: [{ ...checks[0], expectedBehavior: " " }, ...checks.slice(1)] },
  { checks: [{ ...checks[0], expectedBehavior: "x".repeat(4001) }, ...checks.slice(1)] },
  { checks: [{ ...checks[0], sourceId: "invented" }, ...checks.slice(1)] },
  { checks: Array.from({ length: 257 }, () => checks[0]) },
  { checks: [] }, { passed: true, findings: [] }, null,
]) {
  test(`invalid contract preparation cannot drop or rewrite authority: ${JSON.stringify(invalid).slice(0, 110)}`, async () => {
    let calls = 0;
    const result = await prepareReviewContract({ sources, maxInputChars: 100_000,
      provider: { name: "fixture", generate: async request => {
        assert.deepEqual(JSON.parse(request.messages[1].content), { contractSources: sources });
        if (calls++) assert.match(request.messages.at(-1)!.content, /Validation failure/);
        return response(invalid);
      } } });
    assert.ok("findings" in result); assert.equal(calls, 2);
  });
}

test("one successful format repair keeps every original source and does not approve the task", async () => {
  let calls = 0;
  const result = await prepareReviewContract({ sources, maxInputChars: 10_000,
    provider: { name: "fixture", generate: async request => {
      if (!calls++) return { message: { role: "assistant", content: "invalid JSON" } };
      assert.deepEqual(JSON.parse(request.messages[1].content), { contractSources: sources });
      assert.equal(request.messages[2].content, "invalid JSON");
      return response({ checks, passed: true });
    } } });
  assert.deepEqual(result, { checks }); assert.equal(calls, 2); assert.ok(!("passed" in result));
});

test("empty, duplicate or oversized contract inputs fail before inference", async () => {
  for (const input of [[], [sources[0], sources[0]], [{ id: "x", text: " " }], Array.from({ length: 257 }, (_, index) => ({ id: String(index), text: "check" }))]) {
    const result = await prepareReviewContract({ sources: input, maxInputChars: 10_000,
      provider: { name: "fixture", generate: async () => { throw new Error("Invalid source must not be dispatched"); } } });
    assert.ok("findings" in result);
  }
  const result = await prepareReviewContract({ sources, maxInputChars: 1,
    provider: { name: "fixture", generate: async () => { throw new Error("Over-context request must not be dispatched"); } } });
  assert.ok("findings" in result && /context/.test(result.findings[0]));
});

test("format repair cannot grow past the configured context", async () => {
  let calls = 0;
  const result = await prepareReviewContract({ sources, maxInputChars: 10_000,
    provider: { name: "fixture", generate: async () => { calls++; return response("x".repeat(20_000)); } } });
  assert.ok("findings" in result && /context/.test(result.findings[0])); assert.equal(calls, 1);
});

test("contract preparation never executes tools or retries an uncertain transport", async () => {
  for (const nested of [false, true]) {
    let calls = 0; const toolCalls = [{ id: "bad", name: "run_shell", args: { command: "echo" } }];
    const result = await prepareReviewContract({ sources, maxInputChars: 10_000,
      provider: { name: "fixture", generate: async () => { calls++;
        return nested ? { ...response({ checks }), message: { ...response({ checks }).message, toolCalls } }
          : { ...response({ checks }), toolCalls };
      } } });
    assert.ok("findings" in result && /tool call/.test(result.findings[0])); assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(prepareReviewContract({ sources, maxInputChars: 10_000,
    provider: { name: "fixture", generate: async () => { calls++; throw new Error("Unknown remote outcome"); } } }), /Unknown remote outcome/);
  assert.equal(calls, 1);
});

test("cancellation fences a successful response and its possible format repair", async () => {
  const abort = new AbortController(); let calls = 0;
  await assert.rejects(prepareReviewContract({ sources, maxInputChars: 10_000, signal: abort.signal,
    provider: { name: "fixture", generate: async () => { calls++; abort.abort(); return response({ checks }); } } }), /abort/i);
  assert.equal(calls, 1);
});
