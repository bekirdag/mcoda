import { usageAccounts, accountedUsage } from '../../packages/codali/dist/runtime/UsageReconciliation.js';
import { verifiedTokenUsage } from '../../packages/codali/dist/providers/ConfiguredModelScope.js';

/** Adapt the raw comparator's request/response ledger to the same accounting model. */
export function benchmarkUsageAccounts(result, events) {
  if (result.arm.startsWith('codali')) return usageAccounts(events);
  const normalized = [];
  for (const event of events) {
    const data = event.data;
    if (event.type === 'model_request') {
      if (!data?.id || !data.request || data.request.requestId !== data.id) throw Error('Raw request lacks a bound invocation identity');
      if (normalized.some(row => row.type === 'model_intent' && row.data.id === data.id)) throw Error('Duplicate raw invocation identity');
      const reservedTokens = Math.ceil(JSON.stringify([data.request.messages, data.request.tools]).length / 3) + (data.request.maxTokens ?? 2048);
      normalized.push({ type: 'model_intent', data: { id: data.id, clientRequestId: data.id, configHash: data.configHash, reservedTokens } });
      normalized.push({ type: 'model_route', data });
    } else if (event.type === 'model_response') {
      normalized.push({ type: 'model_receipt', data: { id: data.id, status: 'completed', usage: { ...data.usage, estimated: !verifiedTokenUsage(data.usage) } } });
    } else if (['embedding_intent', 'embedding_receipt'].includes(event.type)) normalized.push(event);
  }
  return usageAccounts(normalized);
}

/** Sidecar receipts never alter answers, errors, primary-attempt selection or original ledgers. */
export function reconciledBenchmarkUsage(result, events, eventsSha256, receipts) {
  if (!receipts.length) return undefined;
  const accounts = benchmarkUsageAccounts(result, events);
  const seen = new Set();
  for (const row of receipts) {
    const account = accounts.get(row.requestId);
    if (row.schemaVersion !== 1 || row.source !== 'authenticated_request_usage' || row.attemptId !== result.attemptId ||
        row.caseId !== result.caseId || row.configHash !== result.configHash || row.eventsSha256 !== eventsSha256 ||
        row.complete !== true || !Number.isFinite(Date.parse(row.checkedAt)) || !account?.counted || account.kind !== 'model' ||
        account.clientRequestId !== row.requestId || account.configHash !== row.configHash || account.modelId !== row.modelId ||
        !Array.isArray(row.invocationIds) || !row.invocationIds.length || row.invocationIds.length > 16 ||
        new Set(row.invocationIds).size !== row.invocationIds.length || row.invocationIds.some(id => typeof id !== 'string' || !id) ||
        !verifiedTokenUsage(row.usage) || seen.has(row.requestId) || account.usage) throw Error('Invalid, duplicate, already-settled or unbound usage receipt');
    account.usage = row.usage; account.reconciled = true; seen.add(row.requestId);
  }
  const totals = accountedUsage(accounts.values());
  if (!totals || totals.modelCalls !== result.usage?.modelCalls) throw Error('Incomplete accounting cannot reconcile the reported attempt budget');
  return { ...result.usage, ...totals,
    pendingReservations: [...accounts.values()].filter(account => account.counted && !account.usage).map(account => account.id),
    reconciledRequests: [...seen] };
}
