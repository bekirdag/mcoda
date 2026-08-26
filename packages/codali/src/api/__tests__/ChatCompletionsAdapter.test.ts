import assert from "node:assert/strict";
import test from "node:test";
import { handleChatCompletion, toCodaliMessages } from "../ChatCompletionsAdapter.js";
import { messagesToQuery } from "../CodaliApi.js";
import type { CodaliRequest, CodaliResult } from "../CodaliApi.js";

const result = (overrides: Partial<CodaliResult> = {}): CodaliResult => ({
  status: "succeeded",
  answer: "the answer",
  output: "the answer",
  sources: [{ evidenceId: "ev-1", sourceType: "docdex", title: "a.ts" }],
  artifacts: [],
  warnings: [],
  traceId: "trace-9",
  toolCalls: [],
  ...overrides,
});

const capture = () => {
  const seen: CodaliRequest[] = [];
  return {
    seen,
    run: async (request: CodaliRequest) => {
      seen.push(request);
      return result();
    },
  };
};

test("chat messages map onto Codali messages", () => {
  const messages = toCodaliMessages([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "tool", content: "ignored" },
    { role: "assistant", content: null },
  ]);
  assert.deepEqual(messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ]);
});

test("the last user message is the question, with prior turns as context", () => {
  const query = messagesToQuery([
    { role: "user", content: "who wrote the planner?" },
    { role: "assistant", content: "Bekir did." },
    { role: "user", content: "when?" },
  ]);
  assert.match(query, /Current question: when\?/);
  assert.match(query, /who wrote the planner\?/);
});

test("a single message needs no context preamble", () => {
  assert.equal(messagesToQuery([{ role: "user", content: "hello" }]), "hello");
});

test("the response keeps the OpenAI shape", async () => {
  const { run } = capture();
  const response = await handleChatCompletion(
    { model: "codali", messages: [{ role: "user", content: "hi" }] },
    { run },
  );
  assert.equal(response.object, "chat.completion");
  assert.equal(response.model, "codali");
  assert.equal(response.choices[0]?.message.role, "assistant");
  assert.equal(response.choices[0]?.message.content, "the answer");
});

test("sources and trace id survive the adapter", async () => {
  const { run } = capture();
  const response = await handleChatCompletion(
    { messages: [{ role: "user", content: "hi" }] },
    { run },
  );
  assert.equal(response.codali.traceId, "trace-9");
  assert.equal(response.codali.sources.length, 1);
});

test("a partial answer is not reported as a normal stop", async () => {
  // A client that only inspects finish_reason must not mistake an incomplete
  // answer for a complete one.
  const response = await handleChatCompletion(
    { messages: [{ role: "user", content: "hi" }] },
    { run: async () => result({ status: "partial" }) },
  );
  assert.notEqual(response.choices[0]?.finish_reason, "stop");
  assert.equal(response.codali.status, "partial");
});

test("a clarification request is surfaced, not presented as an answer", async () => {
  const response = await handleChatCompletion(
    { messages: [{ role: "user", content: "how is Bekir doing?" }] },
    {
      run: async () =>
        result({ status: "needs_clarification", answer: "Which Bekir?" }),
    },
  );
  assert.equal(response.codali.status, "needs_clarification");
  assert.equal(response.choices[0]?.message.content, "Which Bekir?");
});

test("a json_schema response_format becomes an enforced response schema", async () => {
  const { seen, run } = capture();
  await handleChatCompletion(
    {
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: { schema: { type: "object", required: ["a"] } },
      },
    },
    { run },
  );
  assert.deepEqual(seen[0]?.responseSchema, { type: "object", required: ["a"] });
});

test("json_object mode asks for JSON without imposing a schema", async () => {
  const { seen, run } = capture();
  await handleChatCompletion(
    { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } },
    { run },
  );
  assert.equal(seen[0]?.responseMode, "json");
  assert.equal(seen[0]?.responseSchema, undefined);
});

test("Codali extras pass through without a plain client noticing", async () => {
  const { seen, run } = capture();
  await handleChatCompletion(
    {
      messages: [{ role: "user", content: "hi" }],
      codali: { mode: "deep", budgets: { maxToolCalls: 5 } },
    },
    { run },
  );
  assert.equal(seen[0]?.mode, "deep");
  assert.equal(seen[0]?.budgets?.maxToolCalls, 5);
});
