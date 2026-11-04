import test from "node:test";
import assert from "node:assert/strict";
import { prepareReviewContract, reviewContractSources } from "../ReviewContract.js";
import type { ProviderResponse } from "../../providers/ProviderTypes.js";

const sources = reviewContractSources({
  requirements: [{ id: "R1", description: "Reject overlap with Error('conflict'). Keep the input unchanged." }],
  constraints: ["Run the existing tests."], nonGoals: ["Do not add dependencies."],
});
const checks = sources.map(source => ({ sourceId: source.id, contractQuote: source.text, expectedBehavior: source.text }));
const restoreSources = (values: { id: string; excerpts: { quoteIndex: number; text: string }[] }[]) => values.map(source => ({ id: source.id, text: source.excerpts.map(excerpt => excerpt.text).join("") }));
const response = (value: unknown): ProviderResponse => ({ message: { role: "assistant", content: JSON.stringify(value) } });

test("indexed excerpts resolve similar sources without model-copied quotation changes", async () => {
  const original = [
    { id: "goal", text: "Reject the FIRST error. A synchronous throw follows the same rule." },
    { id: "requirement:R3", text: "Reject the FIRST error; a synchronous throw follows the same rule." },
  ];
  const result = await prepareReviewContract({ sources: original, maxInputChars: 10_000,
    provider: { name: "fixture", generate: async () => response({ checks: original.map(source => ({
      sourceId: source.id, quoteIndex: 0, expectedBehavior: "Stop dispatching after the first observed failure.",
    })) }) } });
  assert.deepEqual(result, { checks: original.map(source => ({ sourceId: source.id, contractQuote: source.text,
    expectedBehavior: "Stop dispatching after the first observed failure." })) });
});

test("source excerpts preserve every character, Unicode boundary and authoritative source", async () => {
  const original = [{ id: "goal", text: "x".repeat(511) + "🧭" + " original obligation;\n".repeat(80) }];
  const result = await prepareReviewContract({ sources: original, maxInputChars: 10_000,
    provider: { name: "fixture", generate: async request => {
      const payload = JSON.parse(request.messages[1].content);
      const excerpts = payload.contractSources[0].excerpts;
      assert.ok(Array.isArray(excerpts)); assert.equal(excerpts.map((excerpt: { text: string }) => excerpt.text).join(""), original[0].text);
      assert.ok(excerpts.length > 1);
      for (const [index, { text, quoteIndex }] of excerpts.entries()) {
        assert.equal(quoteIndex, index, "each excerpt identifies its exact index without model counting");
        assert.ok(text.length > 0 && text.length <= 512);
        assert.doesNotMatch(text, /[\uD800-\uDBFF]$/); assert.doesNotMatch(text, /^[\uDC00-\uDFFF]/);
      }
      return response({ checks: excerpts.map(({ quoteIndex }: { quoteIndex: number }) => ({
        sourceId: "goal", quoteIndex, expectedBehavior: "Preserve this obligation.",
      })) });
    } } });
  assert.ok("checks" in result); assert.equal(result.checks.map(check => check.contractQuote).join(""), original[0].text);
});

for (const quoteIndex of [-1, 0.5, 1, "0", null]) {
  test(`invalid excerpt reference cannot establish acceptance: ${JSON.stringify(quoteIndex)}`, async () => {
    let calls = 0;
    const result = await prepareReviewContract({ sources, maxInputChars: 10_000,
      provider: { name: "fixture", generate: async () => {
        calls++;
        return response({ checks: sources.map(source => ({ sourceId: source.id, quoteIndex, expectedBehavior: source.text })) });
      } } });
    assert.ok("findings" in result && /excerpt index/.test(result.findings[0])); assert.equal(calls, 2);
  });
}

test("an excerpt index cannot conceal a conflicting quotation or an omitted source", async () => {
  for (const invalid of [
    { checks: [{ sourceId: sources[0].id, quoteIndex: 0, expectedBehavior: sources[0].text }] },
    { checks: sources.map(source => ({ sourceId: source.id, quoteIndex: 0, contractQuote: "Allow other errors", expectedBehavior: source.text })) },
  ]) {
    const result = await prepareReviewContract({ sources, maxInputChars: 10_000,
      provider: { name: "fixture", generate: async () => response(invalid) } });
    assert.ok("findings" in result);
  }
});

test("whole-goal preparation retains current steering without duplicating an identical goal source", () => {
  const context = { goal: "Original objective", requirements: [{ id: "R1", description: "Original objective" }], constraints: [], nonGoals: [] };
  assert.equal(reviewContractSources(context).length, 1);
  const current = { ...context, goal: "Original objective\nUser steering: deliver a manifest." };
  const values = reviewContractSources(current);
  assert.deepEqual(values, [{ id: "goal", text: current.goal }]);
  assert.deepEqual(reviewContractSources({ ...current, requirements: [...current.requirements,
    { id: "R2", description: "A distinct requirement." }] }), [
    { id: "goal", text: current.goal }, { id: "requirement:R2", text: "A distinct requirement." },
  ]);
});

test("contract preparation receives only authoritative sources and retains exact source attribution", async () => {
  const before = JSON.stringify(sources); let calls = 0;
  const result = await prepareReviewContract({ sources, maxInputChars: 10_000,
    provider: { name: "fixture", generate: async request => {
      calls++; assert.equal(request.tools, undefined); assert.equal(request.maxTokens, 4096);
      assert.deepEqual(restoreSources(JSON.parse(request.messages[1].content).contractSources), sources);
      assert.equal(request.messages.length, 2); assert.equal(request.responseFormat, undefined);
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
        assert.deepEqual(restoreSources(JSON.parse(request.messages[1].content).contractSources), sources);
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
      assert.deepEqual(restoreSources(JSON.parse(request.messages[1].content).contractSources), sources);
      assert.equal(request.messages[2].content, "invalid JSON");
      return response({ checks, passed: true });
    } } });
  assert.deepEqual(result, { checks }); assert.equal(calls, 2); assert.ok(!("passed" in result));
});

test("large contracts prepare bounded source groups while retaining all authoritative context in every call", async () => {
  const large = Array.from({ length: 4 }, (_, index) => ({ id: `requirement:R${index}`, text: `Exact contract ${index}. ${"Preserve original behavior. ".repeat(70)}` }));
  const targets: string[][] = [];
  const result = await prepareReviewContract({ sources: large, maxInputChars: 25_000, maxOutputTokens: 4096,
    provider: { name: "fixture", generate: async request => {
      const payload = JSON.parse(request.messages[1].content);
      assert.deepEqual(restoreSources(payload.contractSources), large, "other sources still qualify and constrain the targeted checks");
      assert.equal(payload.targetSourceIds.length, 1);
      targets.push(payload.targetSourceIds);
      const source = large.find(s => payload.targetSourceIds.includes(s.id))!;
      return response({ checks: [{ sourceId: source.id, contractQuote: `Exact contract ${targets.length - 1}.`, expectedBehavior: "Preserve the quoted behavior." }] });
    } } });
  assert.ok("checks" in result);
  assert.deepEqual(targets.flat(), large.map(s => s.id));
  assert.deepEqual(result.checks.map(c => c.sourceId), large.map(s => s.id));
});

test("an invalid preparation batch cannot silently discard remaining contract sources", async () => {
  const large = [{ id: "first", text: "A".repeat(3000) }, { id: "second", text: "B".repeat(3000) }];
  let calls = 0;
  const result = await prepareReviewContract({ sources: large, maxInputChars: 25_000, maxOutputTokens: 4096,
    provider: { name: "fixture", generate: async request => {
      calls++;
      const payload = JSON.parse(request.messages[1].content);
      return response({ checks: [{ sourceId: "first", contractQuote: "A", expectedBehavior: "Only the first requirement is checked." }] });
    } } });
  assert.ok("findings" in result); assert.equal(calls, 3);
});

test("excessive preparation batches fail before spending the model budget", async () => {
  const result = await prepareReviewContract({ sources: Array.from({ length: 17 }, (_, i) => ({ id: String(i), text: "x".repeat(3000) })),
    maxInputChars: 100_000, maxOutputTokens: 4096,
    provider: { name: "fixture", generate: async () => { throw new Error("Oversized batch plan must not dispatch"); } } });
  assert.ok("findings" in result && /batch/.test(result.findings[0]));
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
