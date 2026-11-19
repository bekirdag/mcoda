// Explicit assisted continuation; never replaces an original one-shot score.
import { promises as fs, appendFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotWorkflowWorkspace } from './appbuild-workspace.mjs';

const runtimeRoot = process.env.CODALI_REPAIR_RUNTIME_ROOT ?? fileURLToPath(new URL('../../packages/codali/dist',import.meta.url));
if (!path.isAbsolute(runtimeRoot)) throw Error('Runtime root must be absolute');
for (const asset of ['tools/deterministic/node-worker.cjs','tools/deterministic/python-worker.py','tools/documents/worker.py']) await fs.access(path.join(runtimeRoot,asset));
const { SessionController } = await import(pathToFileURL(path.join(runtimeRoot,'runtime/SessionController.js')).href);
const { loadOrchestrationConfig, orchestrationHash } = await import(pathToFileURL(path.join(runtimeRoot,'config/OrchestrationConfig.js')).href);

const [directory, sessionId, configFile, label] = process.argv.slice(2);
if (!directory || !path.isAbsolute(directory) || !/^[a-f0-9-]{36}$/.test(sessionId ?? '') || !/^[a-z0-9-]+$/.test(label ?? '')) throw Error('Supply absolute assisted run directory, session UUID, config file and new continuation label');
const origin = JSON.parse(await fs.readFile(path.join(directory, '..', 'manifest.json'), 'utf8'));
if (origin.kind !== 'assisted-development-repair-not-blind-benchmark') throw Error('Continuation requires an assisted-repair manifest; original submissions must remain frozen');
const output = path.join(directory, 'continuations', label);
await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await fs.mkdir(output, { mode: 0o700 });
const { config: original } = await loadOrchestrationConfig(configFile);
const config = structuredClone(original);
config.profile = 'assisted-app-continuation-not-benchmark';
config.taskControl = { maxWritingTasksPerWorktree: 1, maxConcurrentHelpers: 1, helpers: 'read-only-or-draft', repeatedFailureThreshold: 3,
  repairAttemptsBeforeReplan: 2, checkpointOn: ['task-transition','before-compaction','before-exit'], reviewPolicy: 'risk-and-evidence',
  ...config.taskControl, requirePlan: true, immutableInputs: ['RFP.md','ENVIRONMENT.md','REPAIR_FINDINGS.md', '.toolchain'],
  initialTools: ['read_file','write_file','create_directory','prepare_edit','run_shell','list_files','docdex_search','docdex_open','work_claim','work_rescope','work_refine','work_plan','work_decision','work_verify','work_complete','skill_load'] };
config.models['repair-balanced'] = { provider: 'mswarm', catalogId: 'qwen-latest-flash-next', revision: 'catalog-unversioned', operations: ['chat.completions'],
  backend: 'strata', contextWindow: 65536, maxOutputTokens: 4096, supportsTools: true, supportsStreaming: false };
config.bindings.lead = { candidates: ['repair-balanced'] };
if (process.env.CODALI_REPAIR_REASONING_BUDGET) {
  const budget = Number(process.env.CODALI_REPAIR_REASONING_BUDGET);
  if (!Number.isInteger(budget) || budget < 1 || budget > 4096) throw Error('Invalid diagnostic reasoning budget');
  config.models['repair-balanced'].reasoning = { medium: { reasoning_effort: 'low', reasoning_budget_tokens: budget } };
}
config.effort = { medium: { maxTotalTokens: 2000000, maxModelCalls: 160, maxToolCalls: 350, maxSteps: 240, maxOutputTokens: 4096, timeoutMs: 3600000 } };
const resolved = { config, hash: orchestrationHash(config), source: 'explicit assisted continuation' };
const workspace = path.join(directory, 'workspace');
await fs.writeFile(path.join(output,'manifest.json'), JSON.stringify({ kind: 'assisted-continuation-not-one-shot-benchmark', sessionId, configHash: resolved.hash,
  runtimeRoot, runtimeHash: createHash('sha256').update(await fs.readFile(path.join(runtimeRoot,'runtime/SessionController.js'))).digest('hex'), startedAt: new Date().toISOString() }, null, 2));
await fs.cp(runtimeRoot,path.join(output,'runtime'),{recursive:true,errorOnExist:true,force:false});
await fs.writeFile(path.join(output,'before.json'), JSON.stringify(await snapshotWorkflowWorkspace(workspace), null, 2));
const controller = new SessionController({ workspaceRoot: workspace, storageRoot: path.join(directory,'state'), resolved, effort: 'medium', permissions: 'workspace',
  allowNetwork: true, allowWeb: true, allowMemory: false, userInstructionsPath: false,
  onEvent: event => { if (event.type !== 'token') appendFileSync(path.join(output,'events.jsonl'),JSON.stringify(event)+'\n'); } });
const started = Date.now(); let answer, error;
await controller.resume(sessionId);
const before = controller.usageSnapshot();
try { answer = await controller.run(); } catch (cause) { error = String(cause); }
const after = controller.usageSnapshot();
const result = { sessionId, answer, error, elapsedMs: Date.now()-started, sessionUsage: after,
  continuationUsage: Object.fromEntries(Object.entries(after).filter(([,value])=>typeof value === 'number').map(([key,value])=>[key,value-(before[key]??0)])), independentlyValidated: false };
await fs.writeFile(path.join(output,'after.json'), JSON.stringify(await snapshotWorkflowWorkspace(workspace),null,2));
await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
