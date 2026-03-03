import test from "node:test";
import assert from "node:assert/strict";
import { RunHistoryIndexer } from "../RunHistoryIndexer.js";
import type { DocdexClient } from "../../docdex/DocdexClient.js";

test("RunHistoryIndexer ignores unstructured hits and avoids hardcoded examples", { concurrency: false }, async () => {
  const client = {
    async search() {
      return {
        hits: [
          { path: "docs/sds/test-web-app.md", score: 0.9, summary: "sds" },
          { path: "logs/codali/run.jsonl", score: 0.8, summary: "no request/plan/diff content" },
        ],
      };
    },
  } as unknown as DocdexClient;

  const indexer = new RunHistoryIndexer(client);
  const results = await indexer.findSimilarRuns("secure task rendering", 3);

  assert.deepEqual(results, []);
});

test("RunHistoryIndexer parses structured log snippets", { concurrency: false }, async () => {
  const client = {
    async search() {
      return {
        hits: [
          {
            path: "logs/codali/abc.jsonl",
            score: 0.91,
            summary:
              'USER REQUEST: Develop Secure Task Rendering Engine.\nPLAN:\n- add safe DOM rendering\n- validate task text\nTARGETS:\n- src/public/app.js\n',
          },
        ],
      };
    },
  } as unknown as DocdexClient;

  const indexer = new RunHistoryIndexer(client);
  const results = await indexer.findSimilarRuns("secure task rendering", 3);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.intent, "Develop Secure Task Rendering Engine.");
  assert.match(results[0]?.plan ?? "", /add safe DOM rendering/i);
  assert.equal(results[0]?.diff, "inferred_from_log");
});

test("RunHistoryIndexer adapts normalized run summary records when plan/diff text is absent", { concurrency: false }, async () => {
  const client = {
    async search() {
      return {
        hits: [
          {
            path: "logs/codali/normalized.jsonl",
            score: 0.83,
            request: "stabilize telemetry reporting",
            run_summary: {
              run_id: "run-telemetry-42",
              task_id: "task-42",
              durationMs: 190,
              final_disposition: {
                status: "fail",
                failure_class: "verification_failure",
                reason_codes: ["verification_policy_minimum_unmet"],
              },
              quality_dimensions: {
                plan: "available",
                retrieval: "degraded",
                patch: "available",
                verification: "missing",
                final_disposition: "available",
              },
              phase_telemetry: [
                {
                  phase: "act",
                  usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
                  missing_cost_reason: "pricing_unavailable",
                },
              ],
            },
          },
        ],
      };
    },
  } as unknown as DocdexClient;

  const indexer = new RunHistoryIndexer(client);
  const results = await indexer.findSimilarRuns("stabilize telemetry reporting", 3);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.intent, "stabilize telemetry reporting");
  assert.match(results[0]?.plan ?? "", /plan=available/);
  assert.match(results[0]?.plan ?? "", /verify=missing/);
  assert.match(results[0]?.diff ?? "", /status=fail/);
  assert.match(results[0]?.diff ?? "", /failure_class=verification_failure/);
});
