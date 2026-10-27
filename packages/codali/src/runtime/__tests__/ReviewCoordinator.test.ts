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
