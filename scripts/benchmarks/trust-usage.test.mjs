import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkUsageAccounts, reconciledBenchmarkUsage } from './trust-usage.mjs';

const request = (id, type = 'model_request') => ({ type, data: { id, configHash: 'config', modelId: 'lead', request: { requestId: id, messages: [{ role: 'user', content: 'Test' }], maxTokens: 100 } } });
const response = id => ({ type: 'model_response', data: { id, usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } } });
const result = { attemptId: 'attempt', caseId: 'case', configHash: 'config', arm: 'raw_tools', error: '502 retained', usage: { modelCalls: 2, toolCalls: 1, tokens: 150, estimated: true, pendingReservations: ['second'] } };
const receipt = { schemaVersion: 1, source: 'authenticated_request_usage', attemptId: 'attempt', caseId: 'case', configHash: 'config', eventsSha256: 'events',
  checkedAt: '2026-01-01T00:00:00Z', requestId: 'second', modelId: 'lead', complete: true, invocationIds: ['server-invocation'], usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 } };
const events = [request('first'), response('first'), request('second')];

test('raw receipt reconciliation replaces only the reservation while retaining the failed outcome', () => {
  const original = structuredClone(result);
  const usage = reconciledBenchmarkUsage(result, events, 'events', [receipt]);
  assert.equal(usage.tokens, 30); assert.equal(usage.modelCalls, 2); assert.equal(usage.toolCalls, 1);
  assert.equal(usage.estimated, false); assert.deepEqual(usage.pendingReservations, []);
  assert.deepEqual(result, original); assert.equal(result.error, '502 retained');
  assert.equal(reconciledBenchmarkUsage(result, events, 'events', []), undefined);
});

test('receipt must bind the exact immutable attempt, event stream and unsettled request', () => {
  for (const change of [{ caseId: 'wrong' }, { attemptId: 'wrong' }, { eventsSha256: 'wrong' }, { configHash: 'wrong' },
    { modelId: 'wrong' }, { requestId: 'absent' }, { requestId: 'first' }, { complete: false }, { source: 'model_claim' },
    { usage: { totalTokens: -1 } }, { invocationIds: [] }, { invocationIds: ['x', 'x'] }, { checkedAt: 'invalid' }]) {
    assert.throws(() => reconciledBenchmarkUsage(result, events, 'events', [{ ...receipt, ...change }]), /usage receipt/);
  }
  assert.throws(() => reconciledBenchmarkUsage(result, events, 'events', [receipt, receipt]), /usage receipt/);
  assert.throws(() => reconciledBenchmarkUsage({ ...result, usage: { ...result.usage, modelCalls: 3 } }, events, 'events', [receipt]), /Incomplete accounting/);
  assert.throws(() => benchmarkUsageAccounts(result, [...events, request('second')]), /Duplicate raw invocation/);
  assert.throws(() => benchmarkUsageAccounts(result, [{ ...request('first'), data: { ...request('first').data, request: { requestId: 'different' } } }]), /bound invocation/);
});

test('unreported embedding usage remains estimated after a model receipt is settled', () => {
  const withEmbedding = [...events, { type: 'embedding_intent', data: { id: 'embedding', estimatedTokens: 40 } }];
  const usage = reconciledBenchmarkUsage({ ...result, usage: { ...result.usage, modelCalls: 3 } }, withEmbedding, 'events', [receipt]);
  assert.equal(usage.tokens, 70); assert.equal(usage.estimated, true); assert.equal(usage.embeddingCalls, 1);
  assert.deepEqual(usage.pendingReservations, ['embedding']);
});

test('Codali and raw comparisons use the same authenticated accounting semantics', () => {
  const data = { id: 'second', clientRequestId: 'second', configHash: 'config', reservedTokens: 100 };
  const candidateEvents = [{ type: 'model_intent', data }, { type: 'model_route', data: { ...data, modelId: 'lead' } },
    { type: 'model_receipt', data: { ...data, status: 'outcome_unknown' } }];
  const usage = reconciledBenchmarkUsage({ ...result, arm: 'codali_candidate', usage: { ...result.usage, modelCalls: 1 } }, candidateEvents, 'events', [receipt]);
  assert.equal(usage.tokens, 20); assert.equal(usage.estimated, false);
});
