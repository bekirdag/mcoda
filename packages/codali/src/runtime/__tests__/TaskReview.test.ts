import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderMessage, ProviderResponse } from "../../providers/ProviderTypes.js";
import { runTaskReview, type ReviewSourcePage } from "../TaskReview.js";

const messages: ProviderMessage[] = [{ role: "system", content: "Independently review the contract." }, { role: "user", content: "The final section is truncated." }];
const response = (value: unknown): ProviderResponse => ({ message: { role: "assistant", content: JSON.stringify(value) } });
const page = async (path: string, offset: number): Promise<ReviewSourcePage> => ({ path, offset, content: "acceptance detail", truncated: false });

test("a malformed received review gets one accounted format repair with original authority and no native JSON validator", async () => {
  let calls = 0;
  const result = await runTaskReview({ messages, allowedPaths: [], maxInputChars: 10_000,
    provider: { name: "fixture", generate: async request => {
      assert.equal(request.responseFormat, undefined, "client validation must receive malformed output and its usage");
      assert.deepEqual(request.messages.slice(0, 2), messages);
      if (!calls++) return { message: { role: "assistant", content: '{"passed":false,"findings":["unescaped "literal""]}' }, usage: { totalTokens: 25 } };
      assert.equal(request.messages.length, 4);
      assert.match(request.messages.at(-1)!.content, /format/);
      return response({ passed: false, findings: ["The exact literal violates the original contract."] });
    } }, readSourcePage: page });
  assert.equal(calls, 2); assert.equal(result.passed, false); assert.match(result.findings[0], /exact literal/);
});

test("review format repair is bounded, context checked, and never retries unknown transport outcomes", async () => {
  for (const mode of ["invalid", "context", "transport"] as const) {
    let calls = 0;
    const run = () => runTaskReview({ messages, allowedPaths: [], maxInputChars: mode === "context" ? 1000 : 10_000,
      provider: { name: "fixture", generate: async () => {
        calls++; if (mode === "transport") throw new Error("Unknown remote outcome");
        return { message: { role: "assistant", content: mode === "context" ? "x".repeat(5000) : "invalid JSON" } };
      } }, readSourcePage: async () => { throw new Error("Malformed review cannot authorize reads"); } });
    if (mode === "transport") await assert.rejects(run, /Unknown remote outcome/);
    else assert.equal((await run()).passed, false);
    assert.equal(calls, mode === "invalid" ? 2 : 1);
  }
});

test("format repair does not widen the four-round source allowance", async () => {
  let calls = 0; let reads = 0;
  const result = await runTaskReview({ messages, allowedPaths: ["known.txt"], maxInputChars: 100_000,
    provider: { name: "fixture", generate: async () => {
      calls++;
      return calls === 1 ? { message: { role: "assistant", content: "invalid JSON" } }
        : response({ sourceRequests: [{ path: "known.txt", offset: calls * 8000 }] });
    } }, readSourcePage: async (path, offset) => { reads++; return page(path, offset); } });
  assert.equal(result.passed, false); assert.match(result.findings[0], /limit reached/);
  assert.equal(calls, 6); assert.equal(reads, 4);
});

test("bounded review retains earlier evidence and returns only a final decision", async () => {
  let calls = 0; let reads = 0;
  const provider: Provider = { name: "fixture", generate: async request => {
    assert.equal(request.tools, undefined); assert.equal(request.responseFormat, undefined);
    assert.equal(request.maxTokens, 6000, "paging retains the caller's configured review output budget");
    assert.deepEqual(request.messages.slice(0, 2), messages);
    if (calls++ === 0) return response({ sourceRequests: [{ path: "test/task.mjs", offset: 8000 }] });
    assert.equal(request.messages.length, 4);
    assert.equal(JSON.parse(request.messages.at(-1)!.content).sourcePages[0].content, "acceptance detail");
    return response({ passed: false, findings: ["Missing required error handling."] });
  } };
  const result = await runTaskReview({ provider, messages, allowedPaths: ["test/task.mjs"], maxInputChars: 10_000, maxOutputTokens: 6000,
    readSourcePage: async (path, offset) => { reads++; return page(path, offset); } });
  assert.deepEqual(result, { passed: false, findings: ["Missing required error handling."] });
  assert.equal(calls, 2); assert.equal(reads, 1); assert.equal(messages.length, 2);
});

test("omitted page offsets continue exact partial-source cursors without skipping evidence", async () => {
  let calls = 0; const reads: number[] = [];
  const result = await runTaskReview({ messages, allowedPaths: ["test/task.mjs"],
    initialSourceOffsets: { "test/task.mjs": 3453 }, maxInputChars: 10_000,
    provider: { name: "fixture", generate: async request => {
      assert.deepEqual(request.messages.slice(0, 2), messages);
      if (calls++ < 2) return response({ sourceRequests: [{ path: "test/task.mjs" }] });
      return response({ passed: false, findings: ["The newly supplied middle section violates the contract."] });
    } }, readSourcePage: async (path, offset) => {
      reads.push(offset);
      return { path, offset, content: offset === 3453 ? "missing middle evidence" : "tail evidence", truncated: offset === 3453,
        ...(offset === 3453 ? { nextOffset: 11453 } : {}) };
    } });
  assert.deepEqual(reads, [3453, 11453]);
  assert.equal(calls, 3); assert.equal(result.passed, false);
});

test("explicit offsets still permit focused reads within the declared source scope", async () => {
  let calls = 0;
  const result = await runTaskReview({ messages, allowedPaths: ["known.txt"], initialSourceOffsets: { "known.txt": 3453 }, maxInputChars: 10_000,
    provider: { name: "fixture", generate: async () => calls++ === 0
      ? response({ sourceRequests: [{ path: "known.txt", offset: 20 }] }) : response({ passed: true, findings: [] }) },
    readSourcePage: async (path, offset) => { assert.equal(offset, 20); return page(path, offset); } });
  assert.equal(result.passed, true);
});

test("a malformed rejection retains its concrete finding without granting acceptance", async () => {
  let calls = 0;
  const result = await runTaskReview({ provider: { name: "fixture", generate: async () => {
    calls++; return response({ passed: false, findings: "The implementation and test contradict the exact required error message." });
  } }, messages, allowedPaths: [], maxInputChars: 1000,
  readSourcePage: async () => { throw new Error("A rejection must not request additional source"); } });
  assert.deepEqual(result, { passed: false, findings: ["The implementation and test contradict the exact required error message."] });
  assert.equal(calls, 1);
});

for (const value of [
  { sourceRequests: [{ path: "../private.env", offset: 0 }] },
  { sourceRequests: [{ path: "known.txt", offset: -1 }] },
  { sourceRequests: [{ path: "known.txt", offset: 1.5 }] },
  { sourceRequests: [{ path: "known.txt", offset: "0" }] },
  { sourceRequests: [{ path: "known.txt" }], passed: true, findings: [] },
  { sourceRequests: Array.from({ length: 9 }, () => ({ path: "known.txt" })) },
  { sourceRequests: [] },
  { passed: true, findings: ["blocking defect"] },
  { passed: true, findings: [42] },
  { passed: true, findings: "" },
  { passed: true, findings: "A blocking defect" },
  { passed: false, findings: "   " },
  { passed: "true", findings: [] },
  [], null,
]) {
  test(`invalid or contradictory review fails closed: ${JSON.stringify(value)}`, async () => {
    const result = await runTaskReview({ provider: { name: "fixture", generate: async () => response(value) }, messages,
      allowedPaths: ["known.txt"], maxInputChars: 10_000, readSourcePage: async () => { throw new Error("Invalid requests must never read files"); } });
    assert.equal(result.passed, false); assert.ok(result.findings.length);
  });
}

test("review evidence loops and context growth are bounded without a fabricated pass", async () => {
  for (const mode of ["repeat", "rounds", "context"] as const) {
    let calls = 0; let reads = 0;
    const result = await runTaskReview({ provider: { name: "fixture", generate: async () => {
      calls++; return response({ sourceRequests: [{ path: "known.txt", offset: mode === "repeat" ? 0 : calls * 8000 }] });
    } }, messages, allowedPaths: ["known.txt"], maxInputChars: mode === "context" ? 1000 : 100_000,
    readSourcePage: async (path, offset) => { reads++; return { path, offset, content: "x".repeat(8000), truncated: true, nextOffset: offset + 8000 }; } });
    assert.equal(result.passed, false);
    assert.equal(calls, mode === "repeat" ? 2 : mode === "rounds" ? 5 : 1);
    assert.equal(reads, mode === "rounds" ? 4 : 1);
    assert.match(result.findings[0], mode === "repeat" ? /repeated/ : mode === "rounds" ? /limit reached/ : /configured model context/);
  }
});

test("cancellation and invalid model output cannot authorize review reads", async () => {
  const abort = new AbortController();
  await assert.rejects(runTaskReview({ provider: { name: "fixture", generate: async () => {
    abort.abort(); return response({ sourceRequests: [{ path: "known.txt" }] });
  } }, messages, signal: abort.signal, allowedPaths: ["known.txt"], maxInputChars: 1000,
  readSourcePage: async () => { throw new Error("Cancelled review must not read source"); } }), /abort/i);
  for (const modelResponse of [
    { message: { role: "assistant" as const, content: "not json" } },
    { ...response({ passed: true, findings: [] }), toolCalls: [{ id: "unexpected", name: "run_shell", args: { command: "echo" } }] },
  ]) {
    const result = await runTaskReview({ provider: { name: "fixture", generate: async () => modelResponse }, messages,
      allowedPaths: ["known.txt"], maxInputChars: 1000, readSourcePage: page });
    assert.equal(result.passed, false);
  }
});
