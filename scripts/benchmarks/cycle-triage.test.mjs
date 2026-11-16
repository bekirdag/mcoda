import test from 'node:test';
import assert from 'node:assert/strict';
import { triageAttempt } from './cycle-triage.mjs';

const codeTask = { id: 'c-26', domain: 'software', comparison: 'answer', prompt: 'Write a module. Return exactly one fenced python code block, no prose.', execution: { writes: false, deadlineMs: 1800000 } };
const codes = flags => flags.map(flag => flag.code).sort();

test('an answer-only code request routed into execution without code is flagged', () => {
  const flags = triageAttempt({ request: { arm: 'codali_candidate', task: codeTask },
    result: { mode: 'execute', content: 'Delivered above.\n\nGoal remains open: required work has not passed the completion gate.', elapsedMs: 700000 },
    events: [{ type: 'interaction_handoff' }] });
  assert.deepEqual(codes(flags), ['EXECUTE_ON_ANSWER', 'GOAL_OPEN', 'NO_CODE_BLOCK']);
});

test('a delivered code answer has no flags, and raw arms are never flagged for execution routing', () => {
  assert.deepEqual(triageAttempt({ request: { arm: 'codali_candidate', task: codeTask }, result: { mode: 'answer', content: '```python\nx=1\n```', elapsedMs: 300000 }, events: [] }), []);
  assert.deepEqual(codes(triageAttempt({ request: { arm: 'raw_tools', task: codeTask }, result: { content: 'no code' }, events: [{ type: 'interaction_handoff' }] })), ['NO_CODE_BLOCK']);
});

test('an equation review that changes an answer after a passing code run is flagged', () => {
  const events = [
    { type: 'tool_receipt', data: { receipt: { tool: 'verify_javascript', status: 'success', output: '{"passed":true}' } } },
    { type: 'calculation_answer_audit', data: { draftSha256: 'a', answerSha256: 'b' } },
  ];
  const task = { id: 'n-11', domain: 'quantitative', comparison: 'answer', prompt: 'Return only JSON', execution: { writes: false, deadlineMs: 1800000 } };
  assert.deepEqual(codes(triageAttempt({ request: { arm: 'codali_candidate', task }, result: { content: '{"a":1}', elapsedMs: 600000 }, events })), ['AUDIT_REWROTE_VERIFIED']);
});

test('research that stops well before its deadline, empty answers, errors and deadlines are flagged', () => {
  const task = { id: 'r-1', domain: 'research', comparison: 'answer', prompt: 'Research X', execution: { writes: false, deadlineMs: 2700000 } };
  assert.deepEqual(codes(triageAttempt({ request: { arm: 'codali_candidate', task }, result: { content: 'Answer', elapsedMs: 2040000 }, events: [] })), ['UNUSED_RESEARCH_TIME']);
  assert.deepEqual(codes(triageAttempt({ request: { arm: 'codali_candidate', task }, result: { content: '', elapsedMs: 2700000, error: { message: 'deadline' } }, events: [] })), ['ATTEMPT_ERROR', 'DEADLINE_REACHED', 'EMPTY_ANSWER']);
});
