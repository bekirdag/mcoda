// App-build benchmark adapter: dependency network enabled in isolated shell. No production runtime edits.
// Prospective workflow comparator support. Existing frozen read-only studies do not import this module.
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { ToolRegistry, toolDescriptorFor } from '../../packages/codali/dist/tools/ToolRegistry.js';
import { PermissionGate, permissionKind } from '../../packages/codali/dist/permissions/PermissionGate.js';
import { createFileTools } from '../../packages/codali/dist/tools/filesystem/FileTools.js';
import { createDocumentTools } from '../../packages/codali/dist/tools/documents/DocumentTools.js';
import { createConfiguredMediaTools } from '../../packages/codali/dist/connectors/media/ConfiguredMediaTools.js';
import { createShellTool, DEVELOPMENT_COMMANDS } from '../../packages/codali/dist/tools/shell/ShellTool.js';
import { createTextTool } from '../../packages/codali/dist/tools/system/TextTool.js';
import { createCalendarTool } from '../../packages/codali/dist/tools/system/CalendarTool.js';
import { createIsolatedExecutor, executorStatus } from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
import { compactToolSchema } from '../../packages/codali/dist/runtime/InteractionRouter.js';
import { compressProviderContext } from '../../packages/codali/dist/runtime/ContextCompression.js';
import { SkillCatalog } from '../../packages/codali/dist/session/SkillCatalog.js';
import { orchestrationHash } from '../../packages/codali/dist/config/OrchestrationConfig.js';
import { fullTrustTools } from './trust-full-tools.mjs';
import { validateWorkflowExecution } from './trust-workflow.mjs';
export { validateWorkflowExecution } from './trust-workflow.mjs';

export const workflowShellAllowlist = DEVELOPMENT_COMMANDS;

export function workflowControllerOptions(execution) {
  validateWorkflowExecution(execution);
  return { effort: execution.effort, permissions: execution.writes ? 'workspace' : 'ask', allowWeb: execution.web,
    allowMedia: execution.media, allowMemory: false, allowNetwork: true, userInstructionsPath: false };
}

/** Same direct implementations and host permissions as the candidate. The raw
 * comparator gets no task planner, final-answer repair, reviewer or completion gate. */
export async function createWorkflowTools({ workspace, execution, resolved, mediaStore, startDocdex, initialTools, onToolEvent = () => {} }) {
  validateWorkflowExecution(execution);
  const root = await fs.realpath(workspace), isolation = executorStatus(), registry = new ToolRegistry();
  const cacheRoot = path.join(os.homedir(), '.local', 'state', 'codali', 'benchmark-caches', createHash('sha256').update(root).digest('hex'));
  const protectedPaths = resolved?.config.taskControl?.immutableInputs ?? ['RFP.md', 'ENVIRONMENT.md'];
  const exposed = fullTrustTools(registry, root, startDocdex, []);
  const archive = new Map();
  registry.register({ name: 'context_read', capability: 'context_read', readOnly: true,
    description: 'Recover exact archived context by sha256, with bounded character offset paging.',
    inputSchema: { type: 'object', required: ['sha256'], additionalProperties: false, properties: {
      sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 8000 } } },
    handler: async ({sha256,offset=0,maxChars=4000}) => {
      const message=archive.get(sha256);if(!message)throw Error('Unknown archived context hash');
      return {output:JSON.stringify({sha256,offset,content:message.content.slice(offset,offset+maxChars),nextOffset:offset+maxChars<message.content.length?offset+maxChars:null})};
    } });
  registry.register(createCalendarTool());
  registry.register(createTextTool());
  const skills = new SkillCatalog({ workspaceRoot: root, ...resolved?.config.skills, includeUser: false });
  for (const tool of skills.tools()) registry.register(tool);
  if (execution.writes) {
    for (const tool of [...createFileTools(), ...createDocumentTools()]) if (!tool.readOnly) registry.register(tool);
    registry.register(createShellTool());
  }
  if (execution.media) {
    if (!resolved || !mediaStore) throw Error('Media workflow requires pinned configuration and a host-owned job store');
    for (const tool of createConfiguredMediaTools(resolved, () => mediaStore)) registry.register(tool);
  }
  if (!execution.web) for (const tool of registry.list()) if (permissionKind(toolDescriptorFor(tool)) === 'web') registry.unregister(tool.name);
  for (const name of initialTools ?? ['docdex_search','docdex_open','calculate']) {
    if (name !== 'tools_describe' && !registry.list().some(tool => tool.name === name && tool.readOnly && ['read','web'].includes(permissionKind(toolDescriptorFor(tool))))) throw Error('Initial workflow tool is not permitted');
    exposed.add(name);
  }
  const discover = registry.list().find(tool => tool.name === 'tools_describe');
  registry.unregister('tools_describe');
  registry.register({ ...discover, description: 'Find capabilities or load up to four named tools. Includes repository/web research, deterministic math/data, documents, planning skills, scoped files and shell, and local media when permitted. Loaded tools become directly callable.' });
  const gate = new PermissionGate(execution.writes ? 'workspace' : 'ask', undefined, { shellIsolated: isolation.available, allowWeb: execution.web, allowMedia: execution.media, allowMemory: false });

  async function checkPath(target, action) {
    const absolute = path.resolve(target), relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('Workflow path escapes workspace');
    if (action === 'write' && (!execution.writes || relative.split(path.sep).some(part => ['.git', '.mcoda'].includes(part)))) throw Error('Workflow write is not authorized');
    if (action === 'write' && protectedPaths.some(input => relative === input || relative.startsWith(input + path.sep))) throw Error('Authoritative benchmark input is immutable');
    // File tools resolve symlinks themselves. Shell write mounts require an existing canonical target.
    if (action === 'mount') {
      const real = await fs.realpath(absolute), rel = path.relative(root, real);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || rel.split(path.sep).some(part => ['.git', '.mcoda'].includes(part))) throw Error('Workflow shell mount escapes scope');
    }
  }
  return { registry, exposed,
    async rememberContext(entries) {
      const fresh=entries.filter(entry=>!archive.has(entry.sha256));
      for(const entry of fresh)archive.set(entry.sha256,structuredClone(entry.message));
      if(fresh.length){exposed.add('context_read');await onToolEvent('context_archive',{entries:fresh});}
    },
    schemas: () => registry.list().filter(tool => exposed.has(tool.name)).map(tool => ({ name: tool.name, description: tool.description.slice(0,140), inputSchema: compactToolSchema(tool.inputSchema) })),
    async execute(call, signal) {
      signal?.throwIfAborted();
      await onToolEvent('tool_intent', { call });
      let receipt;
      try {
      const tool = registry.list().find(tool => tool.name === call.name);
      if (!tool || !exposed.has(call.name)) throw Error('Unadvertised workflow tool call');
      await gate.authorize(toolDescriptorFor(tool), call.args, signal);
      let writePaths = [];
      if (call.name === 'run_shell') {
        const requested = call.args?.writePaths ?? [];
        if (!Array.isArray(requested) || requested.length > 32 || requested.some(value => typeof value !== 'string' || !value || path.isAbsolute(value))) throw Error('Invalid workflow shell write scope');
        for (const scope of requested) { const target = path.resolve(root, scope); await checkPath(target, 'write'); await checkPath(target, 'mount'); }
        writePaths = requested;
      }
      const context = { workspaceRoot: root, signal, allowedWritePaths: execution.writes ? ['.'] : [], checkPath,
        allowShell: execution.writes, allowDestructiveOperations: false, allowOutsideWorkspace: false,
        shellAllowlist: workflowShellAllowlist, shellTimeoutMs: Math.min(execution.deadlineMs,120000), shellMaxOutputBytes: 64000,
        shellExecutor: (command, args, context) => createIsolatedExecutor({ network: true, status: isolation, cacheRoot })(command, args, { ...context, allowedWritePaths: writePaths, protectedPaths }) };
      receipt = await registry.execute(call.name, call.args, context);
      } catch (cause) {
        signal?.throwIfAborted();
        // Native call failures are observable feedback, not hidden answer repair.
        // Denied handlers never run, and the raw model may recover within budget.
        receipt = { ok: false, output: '', error: { code: 'tool_permission_denied', message: String(cause), retryable: false } };
      }
      await onToolEvent('tool_receipt', { call, receipt });
      return receipt;
    },
  };
}

/** The attempt deadline is enforced from outside the controller, so tell the
 * controller too; otherwise its time-based finalizer works from the longer config
 * limit and it runs into the deadline with nothing delivered. */
// The controller verifies the hash against the contents it is given, so a
// changed deadline needs its own hash; an unchanged config keeps the frozen one.
export const deadlineBoundResolved = (resolved, deadlineMs, hashOf = orchestrationHash) => {
  const timeoutMs = Math.min(resolved.config.interaction?.timeoutMs ?? deadlineMs, deadlineMs);
  if (resolved.config.interaction?.timeoutMs === timeoutMs) return resolved;
  const config = { ...resolved.config, interaction: { ...resolved.config.interaction, timeoutMs } };
  return { ...resolved, config, hash: hashOf(config) };
};

export const RAW_FINAL_ANSWER_NOTICE = 'The time limit is almost up. Stop using tools and give your final answer now from what you already have. Say what you could not finish or verify.';
export const finalAnswerReserveMs = deadlineMs => Math.min(300000, Math.ceil(deadlineMs * 0.1));

/** Native raw-model loop, without automatic answer repair or Codali's planning policy.
 * Model hooks own aggregate token/embedding reservations; caller supplies the same
 * frozen budget as the candidate and retains every request/response/error.
 * With deadlineAt, one tool-free turn near the deadline lets the raw arm deliver
 * what it has, since Codali also knows its deadline. It is not answer repair: the
 * reply is returned as given. */
/** Model-service failures a plain agent loop retries. Codali retries these too;
 * without it one malformed reply ended a raw app build after three hours. */
export const RAW_RETRYABLE_MODEL_CODES = new Set(['invalid_response', 'service_unavailable', 'rate_limited']);
export const RAW_MODEL_RETRIES = 2;

/** The same request again, unchanged: no added guidance, so it is not answer repair. */
export async function generateWithRetry(provider, request, { signal, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onRetry = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await provider.generate(request); }
    catch (error) {
      if (attempt >= RAW_MODEL_RETRIES || !RAW_RETRYABLE_MODEL_CODES.has(error?.code) || signal?.aborted) throw error;
      await onRetry({ attempt: attempt + 1, code: error.code });
      await wait(attempt === 0 ? 500 : 2000);
    }
  }
}

export async function runRawWorkflow({ provider, tools, messages, limits, contextWindow = 32768, signal, onResponse = () => {}, onRetry, wait, deadlineAt, now = Date.now }) {
  const transcript = structuredClone(messages); let toolCalls = 0;
  const finalAt = deadlineAt === undefined ? Infinity : deadlineAt - finalAnswerReserveMs(limits.timeoutMs);
  for (let step = 0; step < limits.maxSteps; step++) {
    signal?.throwIfAborted();
    if (now() >= finalAt) {
      transcript.push({ role: 'user', content: RAW_FINAL_ANSWER_NOTICE });
      const compressed=compressProviderContext({messages:transcript,tools:[],maxTokens:limits.maxOutputTokens,temperature:0,signal},contextWindow,limits.maxOutputTokens);
      if(compressed.archived.length){
        if(!tools.rememberContext)throw Error('Context compression requires retrievable archive storage');
        await tools.rememberContext(compressed.archived);
      }
      const response = await generateWithRetry(provider, compressed.request, { signal, onRetry, wait });
      await onResponse(response);
      transcript.push(response.message);
      return { content: response.message.content, toolCalls, steps: step + 1, messages: transcript, finalizedAtDeadline: true };
    }
    // Keep the complete transcript for restoration; compress only inference input.
    // Include archive schema before budgeting so recovery cannot overflow the window.
    if (tools.registry?.list().some(tool=>tool.name==='context_read'))tools.exposed.add('context_read');
    const compressed=compressProviderContext({messages:transcript,tools:tools.schemas(),maxTokens:limits.maxOutputTokens,temperature:0,signal},contextWindow,limits.maxOutputTokens);
    if(compressed.archived.length){
      if(!tools.rememberContext)throw Error('Context compression requires retrievable archive storage');
      await tools.rememberContext(compressed.archived);
    }
    const response = await generateWithRetry(provider, compressed.request, { signal, onRetry, wait });
    await onResponse(response);
    const calls = response.toolCalls ?? response.message.toolCalls ?? [];
    if (!calls.length) {
      transcript.push(response.message);
      return { content: response.message.content, toolCalls, steps: step + 1, messages: transcript };
    }
    transcript.push({ ...response.message, toolCalls: calls });
    for (const call of calls) {
      if (++toolCalls > limits.maxToolCalls) throw Error('Common workflow tool budget exhausted');
      const receipt = await tools.execute(call, signal);
      transcript.push({ role: 'tool', name: call.name, toolCallId: call.id, content: String(receipt.ok ? receipt.output : JSON.stringify(receipt.error)) });
    }
  }
  throw Error('Common workflow step budget exhausted before an answer');
}
