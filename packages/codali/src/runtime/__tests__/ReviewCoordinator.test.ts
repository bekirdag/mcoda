import test from "node:test";
import assert from "node:assert/strict";
import { createWorkState } from "../../session/WorkState.js";
import { taskReviewContext } from "../TaskReviewContext.js";
import { reviewTaskScope, reviewWorkspaceHash } from "../ReviewCoordinator.js";
import { contractReviewFixture } from "../../eval/fixtures/ContractReviewProvider.js";

function fixture() {
  const state = createWorkState("Preserve the exact error message and complete both modules.");
  state.constraints = ["Do not add dependencies."];
  const hashes = { "a.mjs": "a", "b.mjs": "b" };
  const task = state.tasks[0];
  const scope = taskReviewContext(state, task, { changedPaths: Object.keys(hashes),
    observedPaths: [], contextPaths: [], currentHashes: hashes });
  return { state, task, scope, hashes };
}

test("many checks share exact quotations without dropping obligations at the review context limit", async () => {
  const { task, scope, hashes } = fixture(); let reviewed = 0; const quotationIds = new Set<string>();
  const result = await reviewTaskScope({ task, scope, hashes, receipts: [], summary: "Review every obligation.",
    maxInputChars: 22_000, maxOutputTokens: 8192, diff: async () => "",
    readSource: async () => ({ content: "bounded source", truncated: false }),
    readSourcePage: async (file, offset) => ({ path: file, offset, content: "source", truncated: false }),
    provider: { name: "fixture", generate: async request => {
      if (request.messages[0].content.startsWith("Prepare independent contract checks")) {
        const input = JSON.parse(request.messages[1].content);
        const checks = input.contractSources.flatMap((source: { id: string }, sourceIndex: number) =>
          Array.from({ length: sourceIndex === 0 ? 140 : 1 }, (_, i) => ({ sourceId: source.id,
            quoteIndex: 0, expectedBehavior: "Check distinct obligation " + i })));
        return { message: { role: "assistant", content: JSON.stringify({ checks }) } };
      }
      assert.ok(JSON.stringify(request.messages).length <= 22_000);
      const input = JSON.parse(request.messages.at(-1)!.content);
      assert.ok(Object.keys(input.contractChecklist.quotes).length <= 2);
      for (const check of input.contractChecklist.checks) {
        const i = reviewed++; quotationIds.add(check.quoteId);
        const quote = input.contractChecklist.quotes[check.quoteId];
        assert.equal(quote.sourceId, i < 140 ? "requirement:R1" : "constraint:0");
        assert.equal(quote.contractQuote, i < 140 ? scope.goal : scope.constraints[0]);
        assert.equal(check.expectedBehavior, "Check distinct obligation " + (i < 140 ? i : 0));
      }
      return { message: { role: "assistant", content: '{"passed":true,"findings":[]}' } };
    } } });
  assert.deepEqual(result, { passed: true, findings: [] }); assert.equal(reviewed, 141); assert.equal(quotationIds.size, 2);
});

test("large source reserves paging space without dropping original contract or source paths", async () => {
  const { task, scope, hashes } = fixture();
  let reviews = 0; let expectedOffset = -1;
  const result = await reviewTaskScope({ task, scope, hashes, receipts: [], summary: "Review both modules.",
    maxInputChars: 22_000, maxOutputTokens: 2048, diff: async () => "",
    readSource: async (_file, limit) => ({ content: "x".repeat(limit), truncated: true }),
    readSourcePage: async (file, offset) => {
      assert.equal(file, "a.mjs"); assert.equal(offset, expectedOffset);
      return { path: file, offset, content: "final bounded source page", truncated: false };
    },
    provider: { name: "fixture", generate: async request => {
      assert.ok(JSON.stringify(request.messages).length <= 22_000);
      const prepared = contractReviewFixture(request); if (prepared) return prepared;
      if (!reviews++) {
        const input = JSON.parse(request.messages.at(-1)!.content);
        assert.equal(input.goal, scope.goal); assert.deepEqual(input.constraints, scope.constraints);
        assert.deepEqual(Object.keys(input.sourceRoles), ["a.mjs", "b.mjs"]);
        assert.deepEqual(input.sourceTruncatedPaths, ["a.mjs", "b.mjs"]);
        assert.ok(input.source["a.mjs"].length > 0 && input.source["a.mjs"].length < 8000);
        expectedOffset = input.source["a.mjs"].length;
        return { message: { role: "assistant", content: '{"sourceRequests":[{"path":"a.mjs"}]}' } };
      }
      return { message: { role: "assistant", content: '{"passed":true,"findings":[]}' } };
    } } });
  assert.deepEqual(result, { passed: true, findings: [] }); assert.equal(reviews, 2);
});

test("integration retains every criterion while loading only sources without fresh scoped assessments", async () => {
  const { task, scope, hashes } = fixture(); const reads: string[] = [];
  const assessments = [{ taskId: "prior", criterionIds: ["R1"], sourcePaths: ["a.mjs"], workspaceSnapshotHash: reviewWorkspaceHash(hashes) }];
  const result = await reviewTaskScope({ task, scope, hashes, receipts: [], summary: "Integrate.", assessments,
    maxInputChars: 30_000, maxOutputTokens: 2048,
    diff: async files => { assert.deepEqual(files, ["b.mjs"]); return "b changed"; },
    readSource: async file => { reads.push(file); return { content: "current source", truncated: false }; },
    readSourcePage: async (file, offset) => ({ path: file, offset, content: "assessed source still available", truncated: false }),
    provider: { name: "fixture", generate: async request => {
      const prepared = contractReviewFixture(request); if (prepared) return prepared;
      const input = JSON.parse(request.messages.at(-1)!.content);
      assert.equal(input.goal, scope.goal); assert.equal(input.requirements.length, scope.requirements.length);
      assert.deepEqual(input.taskAssessments, assessments); assert.ok(input.sourceRoles["a.mjs"]);
      assert.equal(input.source["a.mjs"], undefined); assert.equal(input.source["b.mjs"], "current source");
      return { message: { role: "assistant", content: '{"passed":false,"findings":["Missing final delivery."]}' } };
    } } });
  assert.deepEqual(reads, ["b.mjs"]); assert.equal(result.passed, false);
  assert.deepEqual(result.findings, ["Missing final delivery."]);
});

test("assessment snapshot mismatch fails before inference or source inspection", async () => {
  const { task, scope, hashes } = fixture();
  const never = async (): Promise<never> => { throw new Error("Stale assessment must not be dispatched"); };
  const result = await reviewTaskScope({ task, scope, hashes, receipts: [], summary: "Integrate.",
    assessments: [{ taskId: "prior", criterionIds: ["R1"], sourcePaths: ["a.mjs"], workspaceSnapshotHash: reviewWorkspaceHash({ ...hashes, "a.mjs": "changed" }) }],
    maxInputChars: 30_000, maxOutputTokens: 2048, diff: never, readSource: never, readSourcePage: never,
    provider: { name: "fixture", generate: never } });
  assert.equal(result.passed, false); assert.match(result.findings[0], /different workspace snapshot/);
  assert.equal(reviewWorkspaceHash(hashes), reviewWorkspaceHash({ "b.mjs": "b", "a.mjs": "a" }));
  assert.notEqual(reviewWorkspaceHash(hashes), reviewWorkspaceHash({ ...hashes, "extra.mjs": "extra" }));
});

for (const rejectLast of [false, true]) test(`oversized checklists retain every obligation across bounded reviews (reject last: ${rejectLast})`, async () => {
  const { task, scope, hashes } = fixture();
  const behaviors = Array.from({ length: 80 }, (_, i) => `Obligation ${i}: ${"Check a distinct boundary and its observable result. ".repeat(10)}`);
  const observed: string[] = []; let reviews = 0;
  const result = await reviewTaskScope({ task, scope, hashes, receipts: [], summary: "Assess every obligation.",
    maxInputChars: 22_000, maxOutputTokens: 8192, diff: async () => "bounded diff",
    readSource: async () => ({ content: "current source", truncated: false }),
    readSourcePage: async (file, offset) => ({ path: file, offset, content: "current source", truncated: false }),
    provider: { name: "fixture", generate: async request => {
      if (request.messages[0].content.startsWith("Prepare independent contract checks")) {
        const input = JSON.parse(request.messages[1].content);
        const checks = input.contractSources.flatMap((source: { id: string }, i: number) =>
          (i ? ["Preserve the dependency constraint"] : behaviors).map(expectedBehavior => ({ sourceId: source.id, quoteIndex: 0, expectedBehavior })));
        return { message: { role: "assistant", content: JSON.stringify({ checks }) } };
      }
      reviews++; assert.ok(JSON.stringify(request.messages).length <= 22_000);
      const input = JSON.parse(request.messages.at(-1)!.content);
      assert.equal(input.goal, scope.goal); assert.deepEqual(input.constraints, scope.constraints);
      assert.equal(input.requirements.length, scope.requirements.length);
      assert.equal(input.workspaceSnapshotHash, reviewWorkspaceHash(hashes));
      assert.deepEqual(Object.keys(input.sourceRoles), ["a.mjs", "b.mjs"]);
      assert.equal(input.source["a.mjs"], "current source");
      assert.equal(input.checklistBatch.index, reviews - 1);
      assert.equal(input.checklistBatch.totalChecks, 81);
      for (const check of input.contractChecklist.checks) {
        assert.ok(input.contractChecklist.quotes[check.quoteId]); observed.push(check.expectedBehavior);
      }
      const defect = rejectLast && observed.includes("Preserve the dependency constraint");
      return { message: { role: "assistant", content: JSON.stringify({ passed: !defect, findings: defect ? ["The last obligation is violated."] : [] }) } };
    } } });
  assert.ok(reviews > 1); assert.deepEqual(observed, [...behaviors, "Preserve the dependency constraint"]);
  assert.deepEqual(result, rejectLast ? { passed: false, findings: ["The last obligation is violated."] } : { passed: true, findings: [] });
});

test("unbounded checklist batching fails before any partial verdict can establish acceptance", async () => {
  const { task, scope, hashes } = fixture(); let reviews = 0;
  const result = await reviewTaskScope({ task, scope, hashes, receipts: [], summary: "Review all.",
    maxInputChars: 22_000, maxOutputTokens: 8192, diff: async () => "",
    readSource: async () => ({ content: "current", truncated: false }),
    readSourcePage: async (file, offset) => ({ path: file, offset, content: "current", truncated: false }),
    provider: { name: "fixture", generate: async request => {
      if (request.messages[0].content.startsWith("Prepare independent contract checks")) {
        const input = JSON.parse(request.messages[1].content);
        return { message: { role: "assistant", content: JSON.stringify({ checks: input.contractSources.flatMap((source: { id: string }, i: number) =>
          Array.from({ length: i ? 1 : 80 }, (_, j) => ({ sourceId: source.id, quoteIndex: 0, expectedBehavior: `Obligation ${j}: ` + "x".repeat(3000) }))) }) } };
      }
      reviews++; return { message: { role: "assistant", content: '{"passed":true,"findings":[]}' } };
    } } });
  assert.equal(result.passed, false); assert.equal(reviews, 0);
  assert.match(result.findings.join(" "), /too many bounded.*batches/i);
});
