import assert from "node:assert/strict";
import test from "node:test";
import { runCodali } from "../CodaliApi.js";

test("a run with no host context refuses instead of using the operator's own", async () => {
  // ~/.codali/.creds holds the operator's GitHub, Jira and Microsoft tokens. A
  // tenant request that forgot its context must not be answered from them: it
  // would not error, it would answer confidently against the wrong account.
  const result = await runCodali({
    messages: [{ role: "user", content: "What are my open issues?" }],
  });

  assert.equal(result.status, "failed");
  assert.ok(result.warnings.includes("run_context_required"));
  assert.match(result.answer, /run context/i);
});

test("an explicit operator opt-in still resolves local configuration", async () => {
  let resolved = false;
  await runCodali(
    {
      messages: [{ role: "user", content: "hello" }],
      allowOperatorConfigFallback: true,
    },
    {
      resolveRunContext: async () => {
        resolved = true;
        return { warnings: [] } as never;
      },
      loadInventory: async () => ({ agents: [], warnings: [] }) as never,
    },
  );
  assert.equal(resolved, true, "the host resolver should still be preferred");
});

test("a host-supplied resolver is used without any opt-in", async () => {
  let resolved = false;
  await runCodali(
    { messages: [{ role: "user", content: "hello" }] },
    {
      resolveRunContext: async () => {
        resolved = true;
        return { warnings: [] } as never;
      },
      loadInventory: async () => ({ agents: [], warnings: [] }) as never,
    },
  );
  assert.equal(resolved, true);
});
