// Prospective workflow protocol. Private grading specifications never enter an attempt.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { effortBudget, resolveBinding } from '../../packages/codali/dist/config/OrchestrationConfig.js';
import { interactionSettings } from '../../packages/codali/dist/runtime/InteractionRouter.js';
import { hash, json, benchmarkFingerprint, repository, fixtureSnapshot } from './trust-common.mjs';
import { validateWorkflowExecution } from './trust-workflow.mjs';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === keys.split(',').sort().join();
export function workflowPath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\') || value.includes('\0') || path.isAbsolute(value)
    || value.split('/').some(part => !part || ['.','..','.git','.mcoda'].includes(part))) throw Error('Invalid workflow fixture path');
  return value;
}

export function validateWorkflowCase(task) {
  if (!exact(task, 'id,domain,family,split,variant,prompt,history,files,execution,comparison')) throw Error('Invalid public workflow fields');
  for (const key of ['id','domain','family']) if (typeof task[key] !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,119}$/.test(task[key])) throw Error('Invalid workflow identity');
  if (!['development','validation','held_out'].includes(task.split) || !Number.isSafeInteger(task.variant) || task.variant < 1) throw Error('Invalid workflow split/variant');
  if (!['answer','artifact','implementation'].includes(task.comparison)) throw Error('Invalid workflow comparison class');
  if (typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 32000) throw Error('Invalid workflow prompt');
  if (!Array.isArray(task.history) || task.history.length > 40 || task.history.some(message => !exact(message,'role,content')
    || !['user','assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 32000)) throw Error('Invalid workflow history');
  if (!task.files || typeof task.files !== 'object' || Array.isArray(task.files) || Object.keys(task.files).length > 100) throw Error('Invalid workflow fixtures');
  let bytes = 0;
  for (const [file, value] of Object.entries(task.files)) {
    workflowPath(file);
    if (!exact(value,'encoding,content,sha256') || !['utf8','base64'].includes(value.encoding) || typeof value.content !== 'string') throw Error('Invalid workflow fixture encoding');
    const buffer = Buffer.from(value.content, value.encoding);
    if (value.encoding === 'base64' && buffer.toString('base64') !== value.content || hash(buffer) !== value.sha256) throw Error('Workflow fixture checksum/encoding mismatch');
    if (buffer.length > 8 * 1024 * 1024 || (bytes += buffer.length) > 16 * 1024 * 1024) throw Error('Workflow fixtures exceed byte limit');
  }
  validateWorkflowExecution(task.execution);
  if (task.comparison !== 'answer' && !task.execution.writes) throw Error('Artifact/implementation tasks require write capability');
  return task;
}

export async function readWorkflowCorpus(directory) {
  const manifest = await json(path.join(directory,'manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.protocol !== 'trust-workflows-v1' || !Array.isArray(manifest.limitations)) throw Error('Invalid workflow corpus manifest');
  const bytes = await fs.readFile(path.join(directory,'prompts.jsonl'));
  if (hash(bytes) !== manifest.promptsSha256) throw Error('Workflow corpus checksum mismatch');
  const cases = bytes.toString('utf8').trim().split('\n').map(line=>validateWorkflowCase(JSON.parse(line)));
  if (!cases.length || cases.length !== manifest.caseCount || new Set(cases.map(task=>task.id)).size !== cases.length) throw Error('Workflow corpus count/identity mismatch');
  return { manifest, cases };
}

export async function workflowFingerprint() {
  const files = ['trust-workflow.mjs','trust-workflow-protocol.mjs','trust-workflow-attempt.mjs','run-workflow-benchmark.mjs'];
  return { base: await benchmarkFingerprint(), files: Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await fs.readFile(path.join(repository,'scripts/benchmarks',file)))]))),
    builtinSkills: await fixtureSnapshot(path.join(repository,'packages/codali/config/skills')) };
}

export function validateWorkflowConfig(config, cases) {
  for (const directory of config.skills?.directories ?? []) workflowPath(directory);
  if (cases.some(task=>task.execution.media)) for (const [binding,operation] of [['image','images.generations'],['audio','audio.generations'],['video','videos.generations']]) {
    if (resolveBinding(config,binding,operation).some(({model})=>model.backend!=='openai-compatible-local')) throw Error('Workflow media must use frozen local specialist models only');
  }
}

// Both systems receive this outer ceiling. Codali's configured interaction policy
// may impose smaller stage limits; all stages share its existing turn accounting.
export function workflowLimits(config, execution) {
  const work = effortBudget(config,execution.effort), interaction = interactionSettings(config.interaction);
  return { maxTotalTokens: Math.max(work.maxTotalTokens,interaction.maxTotalTokens), maxModelCalls: Math.max(work.maxModelCalls,interaction.maxModelCalls),
    maxToolCalls: Math.max(work.maxToolCalls,interaction.maxInspectionSteps*2), maxSteps: work.maxSteps+interaction.maxInspectionSteps,
    maxOutputTokens: Math.max(work.maxOutputTokens,interaction.maxOutputTokens), timeoutMs: execution.deadlineMs };
}

export function workflowAccounting(limits, emit = () => {}) {
  const pending = new Map();
  const usage = { tokens: 0, inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0, embeddingCalls: 0, embeddingTokens: 0, estimated: false };
  const reserve = (id, count, type) => {
    if (!id || pending.has(id) || !Number.isSafeInteger(count) || count < 0) throw Error('Invalid or duplicate usage reservation');
    if (usage.tokens+count > limits.maxTotalTokens || usage.modelCalls >= limits.maxModelCalls) throw Error('Common aggregate workflow model/token budget exhausted');
    pending.set(id,{count,type});usage.tokens+=count;usage.modelCalls++;if(type==='embedding')usage.embeddingCalls++;
  };
  const settle = (id, total, input, output) => {
    const entry = pending.get(id);if(!entry)throw Error('Unknown or already settled usage receipt');
    if (!Number.isSafeInteger(total) || total < 0) { usage.estimated = true;return; }
    usage.tokens+=total-entry.count;pending.delete(id);
    if(entry.type==='embedding'){usage.embeddingTokens+=total;usage.inputTokens+=total;}
    else { if(Number.isSafeInteger(input)&&input>=0)usage.inputTokens+=input;if(Number.isSafeInteger(output)&&output>=0)usage.outputTokens+=output; }
  };
  return {
    snapshot: () => ({...usage,estimated:usage.estimated||pending.size>0,pendingReservations:[...pending.keys()]}),
    beforeRequest: async (invocation,request) => { const count=Math.ceil(JSON.stringify({messages:request.messages,tools:request.tools}).length/3)+(request.maxTokens??limits.maxOutputTokens);reserve(invocation.id,count,'model');await emit('model_request',{...invocation,reservedTokens:count,request:{...request,signal:undefined}}); },
    afterRequest: async (invocation,response) => { const measured=response.usage;settle(invocation.id,measured?.totalTokens??(Number.isSafeInteger(measured?.inputTokens)&&Number.isSafeInteger(measured?.outputTokens)?measured.inputTokens+measured.outputTokens:undefined),measured?.inputTokens,measured?.outputTokens);await emit('model_response',{...invocation,message:response.message,toolCalls:response.toolCalls,usage:measured}); },
    embeddingIntent: async intent => { reserve(intent.id,intent.estimatedTokens,'embedding');await emit('embedding_intent',intent); },
    embeddingReceipt: async receipt => { settle(receipt.id,receipt.reportedTokens);await emit('embedding_receipt',receipt); },
    toolEvent: async (type,data) => {if(type==='tool_intent'&&++usage.toolCalls>limits.maxToolCalls)throw Error('Common workflow tool budget exhausted');await emit(type,data);},
  };
}
