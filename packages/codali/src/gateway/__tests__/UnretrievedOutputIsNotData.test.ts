import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGatewayEvidence } from "../EvidenceNormalizer.js";

/** Verbatim from a worker that was offered a connector and called nothing. */
const INVENTED = JSON.stringify({
  evidence_items: [
    {
      source: "http:logmira_tenant_records:okacam_daily_logs_search",
      data: [
        { date: "2026-07-29", employee: "Alice Johnson", hours: 8.5 },
        { date: "2026-07-29", employee: "Bob Smith", hours: 7.0 },
      ],
    },
  ],
});

/** What a worker relaying a real search actually returns. */
const RETRIEVED = JSON.stringify({
  hits: [{ rel_path: "packages/codali/src/index.ts", snippet: "export const runCodali = …" }],
});

const normalize = (workerOutput: string, toolCalls: Array<{ tool: string; status: string }>) =>
  normalizeGatewayEvidence({ runId: "r1", workerOutput, toolCalls } as never);

test("a worker that called nothing yields words, never structured facts", () => {
  // Its rows reached synthesis and the verifier named the people back: "partial
  // daily log entries for Alice Johnson and Bob Smith". Neither exists; the
  // connector was never called. Each invented row had become its own fact.
  const items = normalize(INVENTED, []).evidence;

  assert.equal(items.length, 1, `expected one observation, got ${items.length}`);
  assert.equal(items[0]?.sourceType, "model_observation");
  // The words survive verbatim as a claim — an honest "I found nothing" lives
  // in this same field — but nothing was parsed out of them.
  assert.equal(items[0]?.claim, INVENTED);
});

test("a failed tool call is not retrieval either", () => {
  const items = normalize(INVENTED, [{ tool: "http:x:y", status: "failed" }]).evidence;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.sourceType, "model_observation");
});

test("a real retrieval is still mined into facts", () => {
  // The guard must not blind the normal path.
  const items = normalize(RETRIEVED, [{ tool: "docdex_search", status: "success" }]).evidence;
  assert.ok(items.length >= 1, "a successful search must still produce evidence");
  assert.ok(
    JSON.stringify(items).includes("packages/codali/src/index.ts"),
    "the retrieved path should survive as evidence",
  );
});

test("the same payload without a successful call is not mined", () => {
  // Identical input, only the provenance differs.
  const items = normalize(RETRIEVED, []).evidence;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.sourceType, "model_observation");
});
