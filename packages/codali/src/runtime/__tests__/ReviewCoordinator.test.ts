import test from "node:test";
import assert from "node:assert/strict";
import { createWorkState } from "../../session/WorkState.js";
import { taskReviewContext } from "../TaskReviewContext.js";
import { REVIEW_CHECKS_PER_CALL, reviewTaskScope, reviewWorkspaceHash } from "../ReviewCoordinator.js";
import type { ProviderRequest } from "../../providers/ProviderTypes.js";
import { approvedReview, contractReviewFixture } from "../../eval/fixtures/ContractReviewProvider.js";

function fixture() {
  const state = createWorkState("Preserve the exact error message and complete both modules.");
  state.constraints = ["Do not add dependencies."];
  const hashes = { "a.mjs": "a", "b.mjs": "b" };
  const task = state.tasks[0];
  const scope = taskReviewContext(state, task, { changedPaths: Object.keys(hashes),
    observedPaths: [], contextPaths: [], currentHashes: hashes });
  return { state, task, scope, hashes };
}

test("whole-goal contract preparation and verdict retain original requirement documents", async () => {
  const { task, scope, hashes } = fixture(); let prepared = false; let reviewed = false;
  const text = "A transfer must be atomic. Rejected requests must leave balances unchanged.";
  const result = await reviewTaskScope({ task, scope, hashes, receipts: [], summary: "Complete",
    authoritativeInputs: [{ id: "input:RFP.md", text }], maxInputChars: 40000, maxOutputTokens: 4096,
    diff: async () => "", readSource: async () => ({ content: "source", truncated: false }),
    readSourcePage: async (file, offset) => ({ path: file, offset, content: "source", truncated: false }),
    provider: { name: "fixture", generate: async request => {
      const input = JSON.parse(request.messages.at(-1)!.content);
      if (request.messages[0].content.startsWith("Prepare independent contract checks")) {
        prepared = true;
        assert.equal(input.contractSources.find((s: { id: string }) => s.id === "input:RFP.md").excerpts.map((e: { text: string }) => e.text).join(""), text);
        return { message: { role: "assistant", content: JSON.stringify({ checks: input.contractSources.map((s: { id: string }) => ({ sourceId: s.id, quoteIndex: 0, expectedBehavior: "Check all specified behavior" })) }) } };
      }
      reviewed = true; assert.deepEqual(input.authoritativeInputs, [{ id: "input:RFP.md", text }]);
      assert.ok(Object.values(input.contractChecklist.quotes).some((q: any) => q.sourceId === "input:RFP.md" && q.contractQuote === text));
      return { message: { role: "assistant", content: '{"passed":false,"findings":["Failure atomicity missing"]}' } };
    } } });
  assert.equal(prepared, true); assert.equal(reviewed, true); assert.equal(result.passed, false);
});

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
      return { message: { role: "assistant", content: approvedReview(request) } };
    } } });
  assert.deepEqual(result, { passed: true, findings: [] }); assert.equal(reviewed, 141); assert.equal(quotationIds.size, 2);
});

test("large source reserves paging space without dropping original contract or source paths", async () => {
  const { task, scope, hashes } = fixture();
  let reviews = 0; let expectedOffset = -1;
  const result = await reviewTaskScope({ task, scope, hashes, receipts: [], summary: "Review both modules.",
    maxInputChars: 22_000, maxOutputTokens: 2048, diff: async () => "",
    readSource: async (_file, limit) => ({ content: "export const errorMessage = \"exact\"; // dependencies: none\n".repeat(Math.ceil(limit / 60)).slice(0, limit), truncated: true }),
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
      return { message: { role: "assistant", content: approvedReview(request) } };
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

for (const requested of ["a.mjs", "unassessed.mjs"]) test(`later scoped reviews can inspect only declared or freshly assessed source: ${requested}`, async () => {
  const { task, scope: original, hashes: originalHashes } = fixture();
  const hashes = { ...originalHashes, "unassessed.mjs": "present-in-snapshot" };
  const scope = { ...original, reviewScope: "assigned_task", changedPaths: ["b.mjs"], otherTaskChangedPaths: ["a.mjs"],
    reviewPaths: ["b.mjs"], sourceRoles: { "b.mjs": "reviewed_change" } };
  const assessments = [{ taskId: "module", criterionIds: ["R1"], sourcePaths: ["a.mjs"], workspaceSnapshotHash: reviewWorkspaceHash(hashes) }];
  const reads: string[] = []; let reviews = 0; let initial: Record<string, any> = {};
  const result = await reviewTaskScope({ task, scope, hashes, assessments, receipts: [], summary: "Check the report's module claim.",
    maxInputChars: 30_000, maxOutputTokens: 2048, diff: async files => { assert.deepEqual(files, ["b.mjs"]); return "report diff"; },
    readSource: async file => { assert.equal(file, "b.mjs"); return { content: "Report claims module value is two.", truncated: false }; },
    readSourcePage: async (file, offset) => { reads.push(file); assert.equal(file, "a.mjs"); assert.equal(offset, 0);
      return { path: file, offset, content: "export const value = 1;", truncated: false }; },
    provider: { name: "fixture", generate: async request => {
      const prepared = contractReviewFixture(request); if (prepared) return prepared;
      if (!reviews++) { initial = JSON.parse(request.messages.at(-1)!.content);
        return { message: { role: "assistant", content: JSON.stringify({ sourceRequests: [{ path: requested }] }) } }; }
      assert.equal(JSON.parse(request.messages.at(-1)!.content).sourcePages[0].content, "export const value = 1;");
      return { message: { role: "assistant", content: '{"passed":false,"findings":["The report contradicts the current module value."]}' } };
    } } });
  assert.equal(result.passed, false);
  assert.deepEqual(scope.reviewPaths, ["b.mjs"]);
  assert.deepEqual(initial.changedPaths, ["b.mjs"]);
  assert.deepEqual(initial.otherTaskChangedPaths, ["a.mjs"]);
  if (requested === "a.mjs") {
    assert.equal(reviews, 2); assert.deepEqual(reads, ["a.mjs"]);
    assert.deepEqual(result.findings, ["The report contradicts the current module value."]);
    assert.equal(initial.sourceRoles["a.mjs"], "read_only_context");
    assert.equal(initial.source["a.mjs"], undefined, "Freshly assessed source should be paged only when needed");
  } else { assert.equal(reviews, 1); assert.deepEqual(reads, []); assert.match(result.findings[0], /outside.*scope/); }
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
      return { message: { role: "assistant", content: defect ? JSON.stringify({ passed: false, findings: ["The last obligation is violated."] }) : approvedReview(request) } };
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
          Array.from({ length: i ? 1 : 255 }, (_, j) => ({ sourceId: source.id, quoteIndex: 0, expectedBehavior: `Obligation ${j}: ` + "x".repeat(3900) }))) }) } };
      }
      reviews++; return { message: { role: "assistant", content: approvedReview(request) } };
    } } });
  assert.equal(result.passed, false); assert.equal(reviews, 0);
  assert.match(result.findings.join(" "), /too many bounded.*batches/i);
});

// A library-loan app (written for this test): the session endpoint must return
// the write token, and renewing an overdue loan must be visible but refused
// with the reason. The build omits both; a same-model reviewer that approves
// without citing anything must not establish acceptance.
const loanApp = () => {
  const state = createWorkState("Build the library loan app described in the brief.");
  state.requirements.push({ id: "R2", description: "GET /session returns the member and the write token.", required: true },
    { id: "R3", description: "Renew is unavailable and explained when a loan is overdue.", required: true });
  const task = { ...state.tasks[0], requirementIds: ["R1", "R2", "R3"] };
  const files: Record<string, string> = {
    "server/routes.js": "app.get('/session', (req, res) => res.json({ member: req.member }));\napp.post('/loans/:id/renew', renewLoan);",
    "public/loans.js": "row.append(loan.overdue ? '' : renewButton(loan));",
    "README.md": "Start with npm start.\nRenewing an overdue loan shows the reason inline.",
  };
  const hashes = Object.fromEntries(Object.keys(files).map(file => [file, file]));
  const scope = taskReviewContext(state, task, { changedPaths: Object.keys(files), observedPaths: [], contextPaths: [], currentHashes: hashes });
  const receipts = [{ id: "r-journey", tool: "run_shell", args: { command: "node", args: ["tests/journey.mjs"] }, status: "success",
    output: "PASS member signs in\nPASS member renews a current loan\nPASS overdue loan has no renew button" }];
  return { task, scope, hashes, files, receipts };
};
const loanReview = async (respond: (input: any, request: ProviderRequest) => string, extra: Partial<Parameters<typeof reviewTaskScope>[0]> = {}) => {
  const { task, scope, hashes, files, receipts } = loanApp(); let calls = 0;
  const result = reviewTaskScope({ task, scope, hashes, receipts, summary: "All loan features done.", maxInputChars: 60_000, maxOutputTokens: 4096,
    diff: async () => "", readSource: async file => ({ content: files[file] ?? "[missing or not a regular source file]", truncated: false }),
    readSourcePage: async (file, offset) => ({ path: file, offset, content: files[file], truncated: false }),
    provider: { name: "same-model", generate: async request => {
      const prepared = contractReviewFixture(request); if (prepared) return prepared;
      calls++;
      return { message: { role: "assistant", content: respond(JSON.parse(request.messages.find(message => message.role === "user")!.content), request) } };
    } }, ...extra });
  return { result: await result, calls };
};

test("an approval that cites no evidence for its checks does not establish acceptance", async () => {
  const { result, calls } = await loanReview(() => '{"passed":true,"findings":[]}');
  assert.equal(result.passed, false); assert.equal(calls, 2, "one evidence repair, then the unproven checks are findings");
  assert.ok(result.findings.length >= 3);
  assert.ok(result.findings.every(finding => /^Unproven C\d+ .*no evidence cited/.test(finding)));
  assert.ok(result.findings.some(finding => finding.includes("write token")));
});

test("cited quotations must exist in the current source or the receipt output", async () => {
  const { result } = await loanReview(input => JSON.stringify({ passed: true, findings: [], evidence: Object.fromEntries(input.contractChecklist.checks.map((check: { id: string }) =>
    [check.id, [{ path: "server/routes.js", quote: "res.json({ member: req.member, token: req.token })" }, { receipt: "r-journey", observed: "PASS overdue loan shows why renew is refused" }]])) }));
  assert.equal(result.passed, false);
  assert.match(result.findings[0], /does not appear in server\/routes\.js; receipt r-journey output does not contain/);
});

test("checks proven by exact quotations from source and receipts are accepted", async () => {
  const { result } = await loanReview(input => JSON.stringify({ passed: true, findings: [], evidence: Object.fromEntries(input.contractChecklist.checks.map((check: { id: string }, i: number) =>
    [check.id, i % 2 ? { receipt: "r-journey", observed: "PASS member renews a current loan" } : { path: "server/routes.js", quote: "app.post('/loans/:id/renew', renewLoan);" }])) }));
  assert.deepEqual(result, { passed: true, findings: [] });
});

test("the requirement document and a delivered document's own text are not evidence", async () => {
  const claims = [{ path: "README.md", text: "Renewing an overdue loan shows the reason inline." }];
  const { result } = await loanReview(input => JSON.stringify({ passed: true, findings: [], evidence: Object.fromEntries(input.contractChecklist.checks.map((check: { id: string; quoteId: string }) =>
    [check.id, input.contractChecklist.quotes[check.quoteId].sourceId.startsWith("delivered:")
      ? { path: "README.md", quote: "Renewing an overdue loan shows the reason inline." }
      : [{ path: "server/routes.js", quote: "app.post('/loans/:id/renew', renewLoan);" }, { path: "server/routes.js", quote: "res.json({ member: req.member })" }]])) }), { deliveredClaims: claims });
  assert.equal(result.passed, false);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0], /^Unproven C\d+ \(delivered:README\.md: .*README\.md is a delivered document/);
});

test("review portions follow requirement areas and hold at most the per-call number of checks", async () => {
  const { task, scope, hashes, files, receipts } = loanApp(); const portions: { id: string; sourceId: string }[][] = [];
  const counts: Record<string, number> = { "requirement:R1": 3, "requirement:R2": 11, "requirement:R3": 2 };
  const result = await reviewTaskScope({ task, scope, hashes, receipts, summary: "Done.", maxInputChars: 200_000, maxOutputTokens: 4096,
    diff: async () => "", readSource: async file => ({ content: files[file], truncated: false }),
    readSourcePage: async (file, offset) => ({ path: file, offset, content: files[file], truncated: false }),
    provider: { name: "fixture", generate: async request => {
      if (request.messages[0].content.startsWith("Prepare independent contract checks")) {
        const input = JSON.parse(request.messages[1].content);
        return { message: { role: "assistant", content: JSON.stringify({ checks: input.contractSources.flatMap((source: { id: string }) =>
          Array.from({ length: counts[source.id] ?? 1 }, (_, i) => ({ sourceId: source.id, quoteIndex: 0, expectedBehavior: `${source.id} obligation ${i}` }))) }) } };
      }
      const input = JSON.parse(request.messages.at(-1)!.content);
      portions.push(input.contractChecklist.checks.map((check: { id: string; quoteId: string }) => ({ id: check.id, sourceId: input.contractChecklist.quotes[check.quoteId].sourceId })));
      return { message: { role: "assistant", content: approvedReview(request) } };
    } } });
  assert.deepEqual(result, { passed: true, findings: [] });
  assert.ok(portions.length >= 3);
  assert.ok(portions.every(portion => portion.length <= REVIEW_CHECKS_PER_CALL));
  assert.equal(portions.flat().length, 16);
  // The 11 R2 checks span two portions; no other area is split.
  for (const area of ["requirement:R1", "requirement:R3"]) assert.equal(portions.filter(portion => portion.some(check => check.sourceId === area)).length, 1);
});

// A parcel-locker app (written for this test) for the citation rules: a quote
// must be about the check, and a delivered statement needs evidence from the
// build, not from a document or a receipt that printed the document.
const lockerApp = () => {
  const state = createWorkState("Build the parcel locker service.");
  state.requirements.push({ id: "R2", description: "A courier can reserve a locker for 48 hours.", required: true });
  const task = { ...state.tasks[0], requirementIds: ["R1", "R2"] };
  const files: Record<string, string> = {
    "src/lockers.js": "export const RESERVATION_HOURS = 48;\nexport function reserveLocker(courier) { return { courier, hours: RESERVATION_HOURS }; }",
    "src/format.js": "export const pad = value => String(value).padStart(2, '0');",
    "README.md": "Couriers reserve a locker for 48 hours.",
    "docs/OPERATIONS.md": "Couriers reserve a locker for 48 hours.",
  };
  const hashes = Object.fromEntries(Object.keys(files).map(file => [file, file]));
  const scope = taskReviewContext(state, task, { changedPaths: Object.keys(files), observedPaths: [], contextPaths: [], currentHashes: hashes });
  const receipts = [{ id: "r-cat", tool: "run_shell", args: { command: "cat", args: ["README.md"] }, status: "success", output: files["README.md"] }];
  return { task, scope, hashes, files, receipts };
};
const lockerReview = (cite: (check: { id: string; sourceId: string }) => unknown, extra: Partial<Parameters<typeof reviewTaskScope>[0]> = {}) => {
  const { task, scope, hashes, files, receipts } = lockerApp();
  return reviewTaskScope({ task, scope, hashes, receipts, summary: "Lockers done.", maxInputChars: 60_000, maxOutputTokens: 4096,
    diff: async () => "", readSource: async file => ({ content: files[file], truncated: false }),
    readSourcePage: async (file, offset) => ({ path: file, offset, content: files[file], truncated: false }), ...extra,
    provider: { name: "same-model", generate: async request => {
      const prepared = contractReviewFixture(request); if (prepared) return prepared;
      const input = JSON.parse(request.messages.find(message => message.role === "user")!.content);
      return { message: { role: "assistant", content: JSON.stringify({ passed: true, findings: [], evidence: Object.fromEntries(input.contractChecklist.checks.map((check: { id: string; quoteId: string }) =>
        [check.id, cite({ id: check.id, sourceId: input.contractChecklist.quotes[check.quoteId].sourceId })])) }) } };
    } } }).then(result => ({ result }));
};

test("a quotation that exists but is not about the check does not prove it", async () => {
  const { result } = await lockerReview(() => ({ path: "src/format.js", quote: "export const pad" }));
  assert.equal(result.passed, false);
  assert.ok(result.findings.every(finding => /shares no words with this check/.test(finding)));
  const related = await lockerReview(() => ({ path: "src/lockers.js", quote: "export function reserveLocker(courier)" }));
  assert.deepEqual(related.result, { passed: true, findings: [] });
});

test("a delivered statement is not proven by another delivered document or by a receipt that printed it", async () => {
  const claims = [{ path: "README.md", text: "Couriers reserve a locker for 48 hours." }];
  const other = await lockerReview(check => check.sourceId.startsWith("delivered:")
    ? { path: "docs/OPERATIONS.md", quote: "Couriers reserve a locker for 48 hours." } : { path: "src/lockers.js", quote: "export function reserveLocker(courier)" }, { deliveredClaims: claims });
  assert.equal(other.result.passed, false); assert.match(other.result.findings[0], /docs\/OPERATIONS\.md is a delivered document/);
  const printed = await lockerReview(check => check.sourceId.startsWith("delivered:")
    ? { receipt: "r-cat", observed: "Couriers reserve a locker for 48 hours." } : { path: "src/lockers.js", quote: "export function reserveLocker(courier)" }, { deliveredClaims: claims });
  assert.equal(printed.result.passed, false); assert.match(printed.result.findings[0], /prints the document's statement/);
  const code = await lockerReview(() => ({ path: "src/lockers.js", quote: "export function reserveLocker(courier)" }), { deliveredClaims: claims });
  assert.deepEqual(code.result, { passed: true, findings: [] });
});

test("over the portion budget, delivered statements are sampled and portions grow instead of blocking", async () => {
  const claims = Array.from({ length: 120 }, (_, i) => ({ path: "README.md", text: `Locker bay ${i} accepts parcels from couriers.` }));
  const { result } = await lockerReview(() => ({ path: "src/lockers.js", quote: "export function reserveLocker(courier)" }), { deliveredClaims: claims, maxPortions: 3 });
  assert.equal(result.passed, true);
  assert.ok(result.sampled, "the result says the review was bounded");
  assert.ok(result.sampled!.deliveredReviewed < 120 && result.sampled!.deliveredTotal === 120);
});
