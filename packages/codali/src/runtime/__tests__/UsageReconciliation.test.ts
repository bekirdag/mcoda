import test from "node:test";
import assert from "node:assert/strict";
import { accountedUsage, usageAccounts, type UsageEvent } from "../UsageReconciliation.js";

const event = (type: string, data: Record<string, unknown>): UsageEvent => ({ type, data });
test("lead, helper, review and embedding usage replay by identity without duplicate settlement", () => {
  const events: UsageEvent[] = [];
  for (const [id, binding] of [["lead-call", "lead"], ["helper-call", "helper"], ["review-call", "reviewer"]]) {
    events.push(event("model_intent", { id, clientRequestId: id, binding, configHash: "config", reservedTokens: 100 }),
      event("model_route", { id, configHash: "config", modelId: binding }),
      event("model_receipt", { id, status: "outcome_unknown", reservedTokens: 100 }));
  }
  events.push(event("embedding_intent", { id: "embed", estimatedTokens: 40 }), event("embedding_receipt", { id: "embed", reportedTokens: 4 }));
  assert.deepEqual(accountedUsage(usageAccounts(events).values()), { modelCalls: 4, tokens: 304, inputTokens: 4, outputTokens: 0, embeddingCalls: 1, embeddingTokens: 4, estimated: true });
  const receipt = event("model_usage_reconciled", { receipts: ["lead-call", "helper-call", "review-call"].map(id => ({ id, clientRequestId: id, usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 } })) });
  events.push(receipt, receipt);
  assert.deepEqual(accountedUsage(usageAccounts(events).values()), { modelCalls: 4, tokens: 55, inputTokens: 34, outputTokens: 21, embeddingCalls: 1, embeddingTokens: 4, estimated: false });
});

test("unreported legacy calls and wrong correlation IDs cannot justify a refund", () => {
  const events = [event("model_intent", { id: "old" }), event("model_route", { id: "different-old-route", modelId: "lead" }),
    event("model_usage_reconciled", { receipts: [{ id: "old", clientRequestId: "old", usage: { totalTokens: 0 } }] })];
  const accounts = usageAccounts(events); assert.equal(accounts.get("old")?.modelId, undefined);
  assert.equal(accounts.get("old")?.reconciled, undefined); assert.equal(accountedUsage(accounts.values()), undefined);
});

test("preflight failures do not count as dispatched model work", () => {
  const events = [event("model_intent", { id: "preflight", reservedTokens: 100 }),
    event("model_receipt", { id: "preflight", status: "not_dispatched", usage: { totalTokens: 0, estimated: false } })];
  assert.equal(accountedUsage(usageAccounts(events).values())?.modelCalls, 0);
  assert.equal(accountedUsage(usageAccounts(events).values())?.tokens, 0);
});
