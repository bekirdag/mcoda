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
