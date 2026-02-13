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
