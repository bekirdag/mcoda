import test from "node:test";
import assert from "node:assert/strict";
import { budgetInspection } from "../InspectionBudget.js";
import type { ProviderRequest } from "../../providers/ProviderTypes.js";

test("inspection leaves capacity for an answer without increasing the budget or losing evidence", () => {
  const request: ProviderRequest = { messages: [{ role: "system", content: "Read only." }, { role: "user", content: "Who owns this?" },
    { role: "tool", content: "Owner: Iris", name: "read_file", toolCallId: "read" }],
    tools: [{ name: "read_file", description: "Read a file" }], maxTokens: 512 };
  const original = structuredClone(request);
  assert.equal(budgetInspection(request, 16000, 5, 5).finalizing, false);
  const result = budgetInspection(request, 3000, 5, 5);
  assert.equal(result.finalizing, true);
  assert.equal(result.request.tools, undefined); assert.equal(result.request.toolChoice, "none");
  assert.equal(result.request.maxTokens, 512);
  assert.deepEqual(result.request.messages.slice(0, -1), request.messages);
  assert.match(result.request.messages.at(-1)!.content, /missing evidence/);
  const reservation = Math.ceil(JSON.stringify({ messages: result.request.messages, tools: result.request.tools }).length / 3) + 512;
  assert.ok(reservation < 3000);
  assert.deepEqual(request, original);
  assert.equal(budgetInspection(request, 16000, 1, 5).finalizing, true);
  assert.equal(budgetInspection(request, 16000, 5, 1).finalizing, true);
});

test("calculator result bounds keep tools available without increasing the shared limit", () => {
  const request: ProviderRequest = { messages: [{ role: "user", content: "Calculate" }],
    tools: [{ name: "calculate", description: "Arithmetic" }], maxTokens: 1024 };
  assert.equal(budgetInspection(request, 3500, 5, 5, 1000).finalizing, false);
  assert.equal(budgetInspection(request, 3500, 5, 5, 6000).finalizing, true);
  assert.equal(budgetInspection(request, 4000, 1, 5, 1000).finalizing, true);
  assert.equal(budgetInspection(request, 4000, 5, 1, 1000).finalizing, true);
});

test("final reporting omits tool-only guidance while preserving instructions, evidence and output budget", () => {
  const finalSystem = "Follow the original request. Never deploy. Cite actual evidence.";
  const request: ProviderRequest = { messages: [{ role: "system", content: finalSystem + "Tool discovery guidance. ".repeat(120) },
    { role: "user", content: "Which file contains the retry limit?" },
    { role: "tool", content: "src/settings.js retryLimit = 7", toolCallId: "source" }], tools: [{ name: "docdex_open" }], maxTokens: 1024 };
  const result = budgetInspection(request, 16000, 1, 5, 6000, finalSystem);
  assert.equal(result.finalizing, true); assert.equal(result.request.messages[0].content, finalSystem);
  assert.deepEqual(result.request.messages.slice(1, -1), request.messages.slice(1));
  assert.equal(result.request.maxTokens, 1024); assert.equal(result.request.tools, undefined);
  const full = budgetInspection(request, 4000, 5, 5, 1000);
  const staged = budgetInspection(request, 4000, 5, 5, 1000, finalSystem);
  assert.equal(full.finalizing, true); assert.equal(staged.finalizing, false);
});
