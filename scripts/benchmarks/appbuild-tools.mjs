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
import { modelStallAllowanceMs, modelStreamGapAllowanceMs } from '../../packages/codali/dist/runtime/OutageWait.js';
import { estimateProviderInputTokens } from '../../packages/codali/dist/providers/RequestSize.js';
import { compressProviderContext } from '../../packages/codali/dist/runtime/ContextCompression.js';
import { outageRetryDelayMs } from '../../packages/codali/dist/runtime/OutageWait.js';
import { SkillCatalog } from '../../packages/codali/dist/session/SkillCatalog.js';
import { orchestrationHash } from '../../packages/codali/dist/config/OrchestrationConfig.js';
import { fullTrustTools, exposeResearchWebTools } from './trust-full-tools.mjs';
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
  // Raw-arm parity: a read-only web session is a research session; declare the
  // candidate research route's web tools up front (search and page reader).
  exposeResearchWebTools(registry, exposed, { research: execution.web && !execution.writes });
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
    schemas: () => (exposeResearchWebTools(registry, exposed), registry.list().filter(tool => exposed.has(tool.name))).map(tool => ({ name: tool.name, description: tool.description.slice(0,140), inputSchema: compactToolSchema(tool.inputSchema) })),
    async execute(call, signal) {
      signal?.throwIfAborted();
      await onToolEvent('tool_intent', { call });
      let receipt;
      try {
      exposeResearchWebTools(registry, exposed);
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
        // Same as Codali: the isolated executor confines deletes to the call's writePaths.
        shellIsolated: isolation.available,
        shellAllowlist: workflowShellAllowlist, shellTimeoutMs: Math.min(execution.deadlineMs,120000), shellMaxTimeoutMs: Math.min(execution.deadlineMs,900000), shellMaxOutputBytes: 64000,
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
/* Parity with Codali's own handling (cycle 6): it also waits out a model route
 * that disappears (404 model_unavailable) and a failed connection ("fetch
 * failed"), and abandons a request that never returns. Without these the raw
 * arm lost two research attempts to a model-server restart and a 12-hour build
 * to a five-second gateway blip. */
export const RAW_RETRYABLE_MODEL_CODES = new Set(['invalid_response', 'service_unavailable', 'rate_limited', 'model_unavailable', 'transport_unavailable']);
export const RAW_MODEL_RETRIES = 2;
/** A temporary outage is waited out on the same schedule Codali uses, so
 * neither arm loses a long build to a two-minute service restart. A malformed
 * reply keeps the two quick retries. */
export const RAW_OUTAGE_CODES = new Set(['service_unavailable', 'rate_limited', 'model_unavailable', 'transport_unavailable']);
export const RAW_OUTAGE_WAITS_MS = [500, 2000, 5000, 15_000, 30_000, 60_000, 60_000, 60_000];

/** The service error behind a failure: a native-reasoning preflight wraps it as its cause. */
const modelErrorCode = error => error instanceof TypeError && error.message === 'fetch failed' ? 'transport_unavailable' : error?.code ?? error?.cause?.code;

/** A regular request (or its retry wait) that would run into the final-answer
 * reserve. It is given up so the tool-free final turn keeps the whole reserve. */
const reserveCutoff = () => Object.assign(new Error('Model request reached the final-answer reserve'), { code: 'final_answer_reserve', cutoff: true });

/** The same request again, unchanged: no added guidance, so it is not answer repair.
 * An outage is waited out exactly as Codali waits out a failed model request
 * (outageRetryDelayMs: the ladder, then a minute per retry, within the outage
 * allowance and the time left less the delivery reserve). The stall allowance
 * is Codali's too, including its reset on streamed progress. */
export async function generateWithRetry(provider, request, { signal, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), onRetry = () => {}, deadlineAt, cutoffAt, now = Date.now, stall = { longestMs: 0 }, stallMs } = {}) {
  let stalled = 0, outageStartedAt, waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    // The same allowance Codali gives each of its requests.
    const allowance = stallMs ?? modelStallAllowanceMs(estimateProviderInputTokens(request), request.maxTokens ?? 65536, stall.longestMs, stalled);
    const gapMs = stallMs ?? modelStreamGapAllowanceMs(allowance, stall.longestMs);
    // Codali bounds a request that is not the final one by its answer reserve; so does the raw arm.
    const untilCutoff = cutoffAt === undefined ? Infinity : cutoffAt - now();
    if (untilCutoff <= 0) throw reserveCutoff();
    const timer = new AbortController(); let reason;
    const stop = why => { if (timer.signal.aborted) return; reason = why; timer.abort(); };
    let stallHandle = setTimeout(() => stop('stalled'), allowance);
    const cutoffHandle = Number.isFinite(untilCutoff) ? setTimeout(() => stop('cutoff'), untilCutoff) : undefined;
    // A stream that is producing output is not stalled: each chunk restarts the stall timer.
    const onProgress = () => { if (timer.signal.aborted) return; clearTimeout(stallHandle); stallHandle = setTimeout(() => stop('stalled'), gapMs); request.onProgress?.(); };
    const started = now();
    try {
      const dispatched = provider.generate({ ...request, stream: request.stream ?? true, onProgress, signal: request.signal ? AbortSignal.any([request.signal, timer.signal]) : timer.signal });
      dispatched.catch(() => undefined);
      const response = await Promise.race([dispatched, new Promise((_, reject) => timer.signal.addEventListener('abort', () => reject(reason === 'cutoff' ? reserveCutoff() : Object.assign(new Error('Model request stalled'), { code: 'service_unavailable', stalled: true })), { once: true }))]);
      stall.longestMs = Math.max(stall.longestMs, now() - started);
      return response;
    }
    catch (error) {
      if (error?.cutoff) throw error;
      if (error?.stalled) stalled++;
      const code = modelErrorCode(error);
      const remainingMs = deadlineAt === undefined ? Infinity : Math.max(0, deadlineAt - now());
      let waitMs;
      if (RAW_OUTAGE_CODES.has(code)) {
        outageStartedAt ??= now();
        // Elapsed outage time is never less than the waits already scheduled.
        const elapsedMs = Math.max(now() - outageStartedAt, waitedMs);
        const retryAfter = error?.retryAfterSeconds ?? error?.cause?.retryAfterSeconds ?? 0;
        waitMs = outageRetryDelayMs(attempt, remainingMs, elapsedMs, retryAfter, false);
      } else waitMs = RAW_OUTAGE_WAITS_MS.slice(0, RAW_MODEL_RETRIES)[attempt];
      if (waitMs === undefined || !RAW_RETRYABLE_MODEL_CODES.has(code) || signal?.aborted) throw error;
      // A retry that could only start inside the reserve is not made; the final turn follows.
      if (cutoffAt !== undefined && now() + waitMs >= cutoffAt) throw reserveCutoff();
      await onRetry({ attempt: attempt + 1, code, waitMs, ...(error?.stalled ? { stalledAfterMs: allowance } : {}) });
      await wait(waitMs); waitedMs += waitMs;
    }
    finally { clearTimeout(stallHandle); clearTimeout(cutoffHandle); }
  }
}

export async function runRawWorkflow({ provider, tools, messages, limits, contextWindow = 32768, signal, onResponse = () => {}, onRetry, onCutoff = () => {}, wait, deadlineAt, now = Date.now }) {
  const transcript = structuredClone(messages); let toolCalls = 0; const stall = { longestMs: 0 };
  const finalAt = deadlineAt === undefined ? Infinity : deadlineAt - finalAnswerReserveMs(limits.timeoutMs);
  const finalTurn = async step => {
    transcript.push({ role: 'user', content: RAW_FINAL_ANSWER_NOTICE });
    const compressed=compressProviderContext({messages:transcript,tools:[],maxTokens:limits.maxOutputTokens,temperature:0,signal},contextWindow,limits.maxOutputTokens);
    if(compressed.archived.length){
      if(!tools.rememberContext)throw Error('Context compression requires retrievable archive storage');
      await tools.rememberContext(compressed.archived);
    }
    const response = await generateWithRetry(provider, compressed.request, { signal, onRetry, wait, deadlineAt, now, stall });
    await onResponse(response);
    transcript.push(response.message);
    return { content: response.message.content, toolCalls, steps: step + 1, messages: transcript, finalizedAtDeadline: true };
  };
  for (let step = 0; step < limits.maxSteps; step++) {
    signal?.throwIfAborted();
    if (now() >= finalAt) return finalTurn(step);
    // Keep the complete transcript for restoration; compress only inference input.
    // Include archive schema before budgeting so recovery cannot overflow the window.
    if (tools.registry?.list().some(tool=>tool.name==='context_read'))tools.exposed.add('context_read');
    const compressed=compressProviderContext({messages:transcript,tools:tools.schemas(),maxTokens:limits.maxOutputTokens,temperature:0,signal},contextWindow,limits.maxOutputTokens);
    if(compressed.archived.length){
      if(!tools.rememberContext)throw Error('Context compression requires retrievable archive storage');
      await tools.rememberContext(compressed.archived);
    }
    // A request still running when the reserve starts is given up, as Codali
    // does (inspection_request_abandoned): raw 11 and 23 in cycle 7 sent their
    // final notice with about 70 s left and ended empty.
    let response;
    try { response = await generateWithRetry(provider, compressed.request, { signal, onRetry, wait, deadlineAt, cutoffAt: Number.isFinite(finalAt) ? finalAt : undefined, now, stall }); }
    catch (error) {
      if (!error?.cutoff || signal?.aborted) throw error;
      await onCutoff({ step, reserveMs: Math.max(0, deadlineAt - now()) });
      return finalTurn(step);
    }
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
