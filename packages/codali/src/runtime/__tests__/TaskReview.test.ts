import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderMessage, ProviderResponse } from "../../providers/ProviderTypes.js";
import { runTaskReview, type ReviewSourcePage } from "../TaskReview.js";

const messages: ProviderMessage[] = [{ role: "system", content: "Independently review the contract." }, { role: "user", content: "The final section is truncated." }];
const response = (value: unknown): ProviderResponse => ({ message: { role: "assistant", content: JSON.stringify(value) } });
const page = async (path: string, offset: number): Promise<ReviewSourcePage> => ({ path, offset, content: "acceptance detail", truncated: false });

test("bounded review retains earlier evidence and returns only a final decision", async () => {
  let calls = 0; let reads = 0;
  const provider: Provider = { name: "fixture", generate: async request => {
    assert.equal(request.tools, undefined); assert.equal(request.responseFormat?.type, "json");
    assert.deepEqual(request.messages.slice(0, 2), messages);
    if (calls++ === 0) return response({ sourceRequests: [{ path: "test/task.mjs", offset: 8000 }] });
    assert.equal(request.messages.length, 4);
    assert.equal(JSON.parse(request.messages.at(-1)!.content).sourcePages[0].content, "acceptance detail");
    return response({ passed: false, findings: ["Missing required error handling."] });
  } };
  const result = await runTaskReview({ provider, messages, allowedPaths: ["test/task.mjs"], maxInputChars: 10_000,
    readSourcePage: async (path, offset) => { reads++; return page(path, offset); } });
  assert.deepEqual(result, { passed: false, findings: ["Missing required error handling."] });
  assert.equal(calls, 2); assert.equal(reads, 1); assert.equal(messages.length, 2);
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
