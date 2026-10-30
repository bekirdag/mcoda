import test from "node:test";
import assert from "node:assert/strict";
import { compressConversation, compressProviderContext, contextHash, estimateContextTokens } from "../ContextCompression.js";
import type { ProviderMessage, ProviderRequest } from "../../providers/ProviderTypes.js";

test("conversation compression retains every user constraint and recoverable original replies", () => {
  const messages: ProviderMessage[] = [
    { role: "user", content: "Never deploy. Keep PostgreSQL and use milliseconds." },
    { role: "assistant", content: "Initial reply. " + "background explanation ".repeat(600) + " Pending decision: choose the cache TTL." },
    { role: "user", content: "The TTL is 1700 ms. Preserve the audit log." },
    { role: "assistant", content: "Recorded." },
  ];
  const before = structuredClone(messages), result = compressConversation(messages, 2000);
  assert.deepEqual(messages, before);
  assert.deepEqual(result.messages.filter(message => message.role === "user"), messages.filter(message => message.role === "user"));
  assert.ok(JSON.stringify(result.messages).length < 2500);
  assert.match(result.messages[1].content, /abbreviated.*Full saved source/);
  assert.match(result.messages[1].content, /Pending decision/);
  assert.deepEqual(result.archived[0].message, messages[1]); assert.equal(result.archived[0].sha256, contextHash(messages[1]));
  const repeated = compressConversation(result.messages, 2000); assert.equal(repeated.archived.length, 0);
});

test("context compaction counts schemas and output reserve and preserves native tool pairs", () => {
  const request: ProviderRequest = { messages: [
    { role: "system", content: "Goal: inspect only. Constraints: do not change files. Decision: PostgreSQL. Pending: validate retry delay." },
    { role: "user", content: "Show the retry delay from the actual repository." },
    { role: "assistant", content: "", toolCalls: [{ id: "call-7", name: "docdex_open", args: { path: "src/retry.ts" } }] },
    { role: "tool", toolCallId: "call-7", content: 'src/retry.ts:1 retryMs = 1700;\n' + "irrelevant source context ".repeat(1500) + "\nSource ends here." },
    { role: "assistant", content: "The retrieved value is 1700 ms." },
  ], tools: [{ name: "docdex_open", description: "Read source. ".repeat(100), inputSchema: { type: "object", properties: { path: { type: "string" } } } }], maxTokens: 512 };
  const before = structuredClone(request), result = compressProviderContext(request, 6000, 512);
  assert.ok(result.beforeTokens > 6000); assert.ok(result.afterTokens + 512 + 512 <= 6000);
  assert.deepEqual(result.request.messages.slice(0, 3), request.messages.slice(0, 3));
  assert.equal(result.request.messages[3].toolCallId, "call-7"); assert.equal(result.request.messages[3].role, "tool");
  assert.match(result.request.messages[3].content, /retryMs = 1700/); assert.match(result.request.messages[3].content, /Source ends here/);
  assert.deepEqual(result.request.tools, request.tools); assert.deepEqual(request, before);
  assert.equal(result.archived.length, 1); assert.equal(result.archived[0].message.content, request.messages[3].content);
  assert.equal(estimateContextTokens(result.request), result.afterTokens);
});

test("oversized fixed instructions fail before dispatch rather than discarding user constraints", () => {
  const request: ProviderRequest = { messages: [{ role: "system", content: "required rule ".repeat(1000) }, { role: "user", content: "Do not delete anything." }], maxTokens: 512 };
  assert.throws(() => compressProviderContext(request, 2048, 512), /no model call was sent/);
  assert.throws(() => compressProviderContext({ messages: [{ role: "user", content: "x".repeat(9000) }] }, 2048, 512), /User instructions/);
});

test("short requests are untouched and compaction spends no extra model calls", () => {
  const request: ProviderRequest = { messages: [{ role: "user", content: "Hello." }], maxTokens: 256 };
  const result = compressProviderContext(request, 4096, 256);
  assert.equal(result.request, request); assert.equal(result.archived.length, 0); assert.equal(result.beforeTokens, result.afterTokens);
});
