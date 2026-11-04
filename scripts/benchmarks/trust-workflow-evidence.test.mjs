import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from './trust-common.mjs';
import { workflowToolEvidence, workflowReviewBundle, applyWorkflowReview, validateWorkflowEvidenceRequirements } from './trust-workflow-evidence.mjs';

const requirement = [{ turnIndex: 0, anyOf: [{ tool: 'docdex_open', args: { path: 'README.md' } }] }];
const candidate = (id, tool, args, status = 'success', turnIndex = 0) => ({ type: 'tool_receipt', turnIndex, data: { receipt: { id, tool, args, status, admitted: true, output: 'Observed file contents' } } });
const raw = (id, tool, args, ok = true, turnIndex = 0) => ({ type: 'tool_receipt', turnIndex, data: { call: { id, name: tool, args }, receipt: { ok, output: 'Observed file contents' } } });
const task = () => ({ id: 'fixture.evidence.01', prompt: 'Read the file, then answer.', history: [], execution: { writes: false } });
const result = () => ({ caseId: 'fixture.evidence.01', attemptId: 'attempt-fixture', arm: 'codali_candidate', configHash: 'hidden-config',
  turns: [{ index: 0, content: 'An evidence-based response.', outputSha256: hash('An evidence-based response.') }], workspacePreserved: true, workspaceBefore: {}, workspaceAfter: {} });
const bundle = (overrides = {}) => workflowReviewBundle({ task: task(), result: result(), events: [candidate('one','docdex_open',{path:'README.md'})], requirements: requirement,
  criteria: [{ id: 'answer', criterion: 'Answers the requested question accurately.' }], ...overrides });
const review = value => ({ caseId: value.caseId, attemptId: value.attemptId, observationSha256: value.observationSha256, reviewer: 'fixture-reviewer',
  dimensions: value.criteria.map(item => ({ id: item.id, passed: true, evidence: 'Verified against the supplied fixture.' })) });

test('native successful receipts bind the exact tool, arguments and turn in both arms', () => {
  for (const event of [candidate('one','docdex_open',{path:'README.md',start_line:1}), raw('one','docdex_open',{path:'README.md'})]) {
    const observed = workflowToolEvidence([event],requirement); assert.equal(observed.passed,true); assert.deepEqual(observed.checks[0].receiptIds,['one']);
  }
  for (const event of [candidate('one','docdex_search',{query:'README'}),candidate('one','docdex_open',{path:'other.md'}),
    candidate('one','docdex_open',{path:'README.md'},'failed'),raw('one','docdex_open',{path:'README.md'},false),
    candidate('one','docdex_open',{path:'README.md'},'success',1),{type:'model_response',turnIndex:0,data:{content:'docdex_open({path:"README.md"})'}}]) {
    assert.equal(workflowToolEvidence([event],requirement).passed,false);
  }
  assert.equal(workflowToolEvidence([candidate('one','docdex_open',{path:'README.md'}),candidate('one','docdex_open',{path:'README.md'},'pending')],requirement).passed,false);
  const denied=candidate('one','docdex_open',{path:'README.md'});denied.data.receipt.admitted=false;assert.equal(workflowToolEvidence([denied],requirement).passed,false);
  assert.equal(workflowToolEvidence([{type:'tool_receipt',turnIndex:0,data:{call:{id:'bad',name:'docdex_open',args:{path:'README.md'}}}}],requirement).passed,false);
});

test('evidence requirements fail closed on malformed alternatives and unsafe matching keys', () => {
  for (const value of [null,[{turnIndex:-1,anyOf:[]}],[{turnIndex:0,anyOf:[{tool:'docdex_open',args:[],extra:true}]}],
    [{turnIndex:0,anyOf:[{tool:'docdex_open',args:JSON.parse('{"__proto__":{}}')}]}]]) assert.throws(()=>validateWorkflowEvidenceRequirements(value));
});

test('review bundles omit arm/config labels and bind outputs, all turns, receipts and criteria', () => {
  const value=bundle();assert.equal(JSON.stringify(value).includes('codali_candidate'),false);assert.equal(JSON.stringify(value).includes('hidden-config'),false);
  assert.deepEqual(value.criteria.slice(0,3).map(item=>item.id),['intent','faithfulness','critical']);assert.equal(applyWorkflowReview(value).status,'needs_review');
  const edited=result();edited.turns[0].content='Changed without updating hash';assert.throws(()=>bundle({result:edited}),/output mismatch/);
  const changed=bundle({events:[candidate('two','docdex_open',{path:'README.md'})]});assert.notEqual(value.observationSha256,changed.observationSha256);
  assert.throws(()=>applyWorkflowReview(changed,review(value)),/exact workflow/);
  const altered=structuredClone(value);altered.turns[0].content='Replaced later';assert.throws(()=>applyWorkflowReview(altered,review(value)),/changed after/);
  assert.throws(()=>bundle({criteria:[{id:'faithfulness',criterion:'No check needed'}]}),/reserved/);
});

test('all-positive reviews cannot erase failures, partial follow-ups, unknown media or unverified writes', () => {
  for (const changes of [{error:'request failed'},{unknownOutcome:true},{pendingMediaJobs:[{id:'render'}]},{workspacePreserved:false}]) {
    const value=bundle({result:{...result(),...changes}});assert.equal(applyWorkflowReview(value,review(value)).passed,false);
  }
  const partial=bundle({task:{...task(),followUps:[{prompt:'Continue.',restoreSession:true}]}});assert.ok(partial.failures.includes('incomplete_turns'));
  const missing=bundle({events:[]});assert.equal(applyWorkflowReview(missing,review(missing)).passed,false);
  const artifact=bundle({independentChecks:[{id:'artifact',passed:false,evidence:'Expected file is absent.'}]});assert.equal(applyWorkflowReview(artifact,review(artifact)).passed,false);
});

test('faithfulness and critical failures are separate mandatory judgments with exact observation identity', () => {
  const value=bundle();assert.equal(applyWorkflowReview(value,review(value)).passed,true);
  const unfaithful=review(value);unfaithful.dimensions.find(item=>item.id==='faithfulness').passed=false;
  const grade=applyWorkflowReview(value,unfaithful);assert.equal(grade.passed,false);assert.equal(grade.criticalPassed,true);
  const critical=review(value);critical.dimensions.find(item=>item.id==='critical').passed=false;assert.equal(applyWorkflowReview(value,critical).criticalPassed,false);
  for (const altered of [{...review(value),dimensions:[]},{...review(value),reviewer:''},{...review(value),attemptId:'other'}]) assert.throws(()=>applyWorkflowReview(value,altered));
  const unsupported=review(value);unsupported.dimensions[0].evidence='';assert.throws(()=>applyWorkflowReview(value,unsupported));
});
