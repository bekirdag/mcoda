import test from "node:test";
import assert from "node:assert/strict";
import { preparedMemory } from "../PreparedMemory.js";
const ok = (value: unknown): PromiseFulfilledResult<unknown> => ({ status: "fulfilled", value });

test("memory preparation retains preferences and facts without transport or storage payloads", () => {
  const text = preparedMemory([
    ok({ preferences: [{ category: "constraint", content: "Preserve the public API", embedding: Array(50).fill(1) }], meta: { docdex_request_id: "unused-id" } }),
    ok({ results: [{ content: "Login handler is src/login.ts", path: "src/login.ts", score: 0.8 }], meta: { unused: true } }),
    ok({ statePaths: { baseDir: "private-storage-path" }, fingerprint: "unused-fingerprint" }),
    ok({ text: "Previous validation failed in test/login.ts", working_memory: null, knowledge_facts: [], trace: { available_tokens: 100 }, meta: { id: "unused-id" } }),
  ]);
  for (const fact of ["Preserve the public API", "Login handler is src/login.ts", "Previous validation failed"]) assert.match(text, new RegExp(fact));
  assert.doesNotMatch(text, /private-storage-path|unused-|available_tokens|embedding|score/);
});

test("empty context is compact while failed retrieval remains explicit", () => {
  assert.equal(preparedMemory([ok({ preferences: [] }), ok({ results: [] }), ok({ statePaths: {} }), ok({ text: "", knowledge_facts: [], working_memory: null })]), "No relevant saved memory.");
  assert.match(preparedMemory([{ status: "rejected", reason: "offline" }]), /profile: unavailable \(offline\)/);
  assert.match(preparedMemory([ok({ disabled: "Managed memory is not configured" })]), /not configured/);
});
