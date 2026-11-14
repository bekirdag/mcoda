// Read-only authenticated receipt lookup. Never submits inference or edits run artifacts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ModelServiceClient } from '../../packages/codali/dist/providers/ConfiguredProvider.js';
import { loadOrchestrationConfig } from '../../packages/codali/dist/config/OrchestrationConfig.js';
import { redactSecretValues } from '../../packages/codali/dist/runtime/SecretRedaction.js';
import { benchmarkUsageAccounts } from './trust-usage.mjs';
import { argumentsMap, json, jsonl, hash, writeNew } from './trust-common.mjs';

const args = argumentsMap(undefined, ['run', 'output', 'limit']);
if (!args.run || !args.output) throw Error('Use --run RUN_DIR --output NEW_DIR [--limit 16]');
const limit = Number(args.limit ?? 16);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw Error('Receipt lookup limit must be 1–1000');
const manifest = await json(path.join(args.run, 'manifest.json'));
const resolved = await loadOrchestrationConfig(path.join(args.run, 'config.json'));
if (resolved.hash !== manifest.identity.configHash) throw Error('Run configuration drift');
await fs.mkdir(args.output, { mode: 0o700 });
const observations = [], receipts = [], seen = new Set();
for (const record of await jsonl(path.join(args.run, 'ledger.jsonl'))) {
  if (record.type !== 'result' || observations.length >= limit) continue;
  const result = record.result;
  if (seen.has(result.attemptId)) throw Error('Duplicate attempt in ledger'); seen.add(result.attemptId);
  const bytes = await fs.readFile(path.join(record.directory, 'events.jsonl'));
  const events = bytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
  const accounts = benchmarkUsageAccounts(result, events);
  for (const account of accounts.values()) {
    if (observations.length >= limit) break;
    if (!account.counted || account.kind !== 'model' || account.usage || !account.clientRequestId || !account.modelId) continue;
    if (account.configHash !== resolved.hash || result.configHash !== resolved.hash) throw Error('Invocation/run configuration mismatch');
    const model = resolved.config.models[account.modelId], provider = resolved.config.providers[model?.provider];
    if (!provider || provider.adapter !== 'mswarm') continue;
    const base = { schemaVersion: 1, source: 'authenticated_request_usage', attemptId: result.attemptId, caseId: result.caseId,
      configHash: result.configHash, eventsSha256: hash(bytes), requestId: account.clientRequestId, modelId: account.modelId,
      providerOrigin: new URL(provider.baseUrl).origin, checkedAt: new Date().toISOString() };
    try {
      const receipt = await new ModelServiceClient(provider).requestUsage(account.clientRequestId);
      const observation = { ...base, ...receipt }; observations.push(observation);
      if (receipt.complete && receipt.usage) receipts.push(observation);
    } catch (error) { observations.push({ ...base, error: redactSecretValues(String(error)) }); }
  }
}
await writeNew(path.join(args.output, 'observations.json'), { at: new Date().toISOString(), observations,
  note: 'Authenticated read-only observations. Original outcome/errors remain primary; no inference was retried.' });
await fs.writeFile(path.join(args.output, 'usage-receipts.jsonl'), receipts.map(row => JSON.stringify(row)).join('\n') + (receipts.length ? '\n' : ''), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: args.output, lookedUp: observations.length, complete: receipts.length, incomplete: observations.length - receipts.length }));
