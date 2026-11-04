// Prospective workflow comparator support. Existing frozen read-only studies do not import this module.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ToolRegistry, toolDescriptorFor } from '../../packages/codali/dist/tools/ToolRegistry.js';
import { PermissionGate, permissionKind } from '../../packages/codali/dist/permissions/PermissionGate.js';
import { createFileTools } from '../../packages/codali/dist/tools/filesystem/FileTools.js';
import { createDocumentTools } from '../../packages/codali/dist/tools/documents/DocumentTools.js';
import { createConfiguredMediaTools } from '../../packages/codali/dist/connectors/media/ConfiguredMediaTools.js';
import { createShellTool } from '../../packages/codali/dist/tools/shell/ShellTool.js';
import { createIsolatedExecutor, executorStatus } from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
import { compactToolSchema } from '../../packages/codali/dist/runtime/InteractionRouter.js';
import { SkillCatalog } from '../../packages/codali/dist/session/SkillCatalog.js';
import { fullTrustTools } from './trust-full-tools.mjs';

export const workflowShellAllowlist = ['git', 'rg', 'node', 'npm', 'pnpm', 'npx', 'python3', 'pytest', 'cargo', 'go', 'make', 'cmake', 'tsc', 'sh', 'bash', 'ls', 'cat', 'pwd', 'expr', 'printf', 'head', 'tail', 'sed', 'awk'];

export function validateWorkflowExecution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== 'deadlineMs,effort,media,web,writes'
    || ['writes', 'web', 'media'].some(key => typeof value[key] !== 'boolean')
    || !['low', 'medium', 'high', 'max'].includes(value.effort)
    || !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 1000 || value.deadlineMs > 3600000
    || value.media && !value.writes) throw Error('Invalid frozen workflow execution contract');
  return value;
}

export function workflowControllerOptions(execution) {
  validateWorkflowExecution(execution);
  return { effort: execution.effort, permissions: execution.writes ? 'workspace' : 'ask', allowWeb: execution.web,
    allowMedia: execution.media, allowMemory: false, allowNetwork: false, userInstructionsPath: false };
}

/** Same direct implementations and host permissions as the candidate. The raw
 * comparator gets no task planner, final-answer repair, reviewer or completion gate. */
export async function createWorkflowTools({ workspace, execution, resolved, mediaStore, startDocdex, initialTools, onToolEvent = () => {} }) {
  validateWorkflowExecution(execution);
  const root = await fs.realpath(workspace), isolation = executorStatus(), registry = new ToolRegistry();
  const exposed = fullTrustTools(registry, root, startDocdex, []);
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
    // File tools resolve symlinks themselves. Shell write mounts require an existing canonical target.
    if (action === 'mount') {
      const real = await fs.realpath(absolute), rel = path.relative(root, real);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || rel.split(path.sep).some(part => ['.git', '.mcoda'].includes(part))) throw Error('Workflow shell mount escapes scope');
    }
  }
  return { registry, exposed,
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
        shellExecutor: (command, args, context) => createIsolatedExecutor({ network: false, status: isolation })(command, args, { ...context, allowedWritePaths: writePaths }) };
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

/** Native raw-model loop, without automatic answer repair or Codali's planning policy.
 * Model hooks own aggregate token/embedding reservations; caller supplies the same
 * frozen budget as the candidate and retains every request/response/error. */
export async function runRawWorkflow({ provider, tools, messages, limits, signal, onResponse = () => {} }) {
  const transcript = structuredClone(messages); let toolCalls = 0;
  for (let step = 0; step < limits.maxSteps; step++) {
    signal?.throwIfAborted();
    const response = await provider.generate({ messages: transcript, tools: tools.schemas(), maxTokens: limits.maxOutputTokens, temperature: 0, signal });
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
      transcript.push({ role: 'tool', name: call.name, toolCallId: call.id, content: String(receipt.ok ? receipt.output : JSON.stringify(receipt.error)).slice(0,16000) });
    }
  }
  throw Error('Common workflow step budget exhausted before an answer');
}
