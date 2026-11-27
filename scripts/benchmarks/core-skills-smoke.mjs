// Bounded model-level probes, not an intelligence benchmark or production service test.
// Only real SkillCatalog read tools are exposed; no host or workspace mutations.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillCatalog } from '../../packages/codali/dist/session/SkillCatalog.js';
import { ConfiguredModelScope } from '../../packages/codali/dist/providers/ConfiguredModelScope.js';
import { loadOrchestrationConfig, orchestrationHash } from '../../packages/codali/dist/config/OrchestrationConfig.js';

const configPath = process.argv[2];
const outputPath = process.argv[3];
if (!configPath || !outputPath) throw new Error('Usage: node core-skills-smoke.mjs CONFIG OUTPUT.json [CASE_ID]');
const fixtures = [
  { id: 'ui', skill: 'ui-ux-design', request: 'Improve the design of an existing appointment-booking screen without replacing its blue brand or framework. Observed brief: on a narrow phone screen, a three-column form overflows; fields have placeholder-only labels; booking errors clear all input; Cancel is the largest filled button and Confirm booking is a small text link; there is no submitting state. No screenshot or browser/vision tool is available in this probe. Propose prioritized UI/UX changes, coherent visual choices and a validation plan; distinguish observed problems from things not visually verified.' },
  { id: 'architecture', skill: 'architecture-design', request: 'Design a small invoice ingestion service for one server and two developers, about 2000 invoices/day. Clients retry submissions after timeouts. Keep existing SQLite storage. No implementation requested. Give components, data ownership, failure handling and one alternative with tradeoffs.' },
  { id: 'implementation', skill: 'code-implementation', request: 'Propose a minimal repair of this JavaScript helper; the public contract is an inclusive integer range and an empty array when start > end. Existing function: function range(start,end){return Array.from({length:Math.max(0,end-start)},(_,i)=>start+i)}. Return the replacement function in a code field and representative checks. Do not claim files were edited or tests executed.' },
  { id: 'review', skill: 'code-review', request: 'Review only this profile endpoint. Every database query applies the authenticated tenant filter. const cache=new Map(); async function profile(req){const key=req.params.id;if(cache.has(key))return cache.get(key);const row=await db.profile.findFirst({where:{id:key,tenantId:req.auth.tenantId}});cache.set(key,row);return row;} File api/profile.js line1. Give actionable findings, if any, with triggering conditions and consequences. No code edits.' },
  { id: 'testing', skill: 'testing-and-verification', request: 'Choose tests for a worker that retries a timed-out payment provider request. The provider may have accepted the first attempt, and two workers can process the same order concurrently. Existing tests only mock a single successful call. Give meaningful unit/integration checks and distinguish planned checks from executed evidence; no tests have run here.' },
  { id: 'tools', skill: 'tool-selection', request: 'Plan tool usage for these requests: exact total of three items at19.99 plus5.50 delivery; current server UTC time; and callers affected by editing src/payments.ts. Execution tools advertised in the target system are calculate,server_time,docdex_symbols,docdex_impact_graph,docdex_search. Name suitable operations. Do not pretend these tools ran in this read-only skill probe.' },
  { id: 'services', skill: 'system-services', request: 'The user asks to start their Node API as a persistent host service. Environment: Linux, full Codali permission, only sandboxed run_shell and browser_session are available for execution; no host-management connector. package.json starts node server.js on port3000. Explain what can actually be done now and what remains blocked. No commands have run.' },
  { id: 'diagnostics', skill: 'system-diagnostics', request: 'User reports host CPU saturation. The only observation is ps inside Codali sandbox showing two processes. There is no host diagnostic connector. Explain what this evidence establishes, whether it disproves host saturation, and the next useful evidence to request. Do not invent host metrics.' },
];
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codali-skill-probe-'));
const catalog = new SkillCatalog({ workspaceRoot: root, includeUser: false });
await catalog.refresh();
const definitions = catalog.tools();
const results = [];
try {
  for (const fixture of fixtures.filter(f => !process.argv[4] || process.argv[4].split(',').includes(f.id))) {
    const resolved = await loadOrchestrationConfig(configPath);
    resolved.config.effort = { ...resolved.config.effort, low: { maxSteps: 5, maxToolCalls: 5, maxModelCalls: 5, maxTotalTokens: 20000, maxOutputTokens: 3200, timeoutMs: 90000 } };
    resolved.hash = orchestrationHash(resolved.config);
    const scope = new ConfiguredModelScope(resolved, { effort: 'low' });
    const messages = [{ role: 'system', content: 'You are Codali. This is a bounded workflow probe with supplied fixtures, not a live deployment. Select and load the relevant skill before answering. Only the listed skill tools can execute here. Do not claim other tools ran. Return your final answer as a JSON object, no Markdown fences, at most500words.' + catalog.prompt() }, { role: 'user', content: fixture.request }];
    const calls = []; const routes = []; const started = Date.now(); let answer, error, rawAnswer, outputFormat, formatWarning;
    try {
      for (let step = 0; step < 5; step++) {
        const result = await scope.provider('lead').generate({ messages, tools: definitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), maxTokens: 3200, temperature: 0 });
        if (result.route) routes.push(result.route);
        if (!result.toolCalls?.length) {
          rawAnswer = result.message.content;
          const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(rawAnswer);
          outputFormat = fenced ? 'fenced-json' : 'json';
          try { answer = JSON.parse(fenced ? fenced[1] : rawAnswer); }
          catch (e) { formatWarning = String(e); outputFormat = 'unstructured'; answer = { text: rawAnswer }; }
          break;
        }
        messages.push({ role: 'assistant', content: result.message.content ?? '', toolCalls: result.toolCalls });
        for (const call of result.toolCalls) {
          scope.reserveTool();
          const tool = definitions.find(t => t.name === call.name);
          if (!tool) throw new Error(`Unavailable tool: ${call.name}`);
          const result = await tool.handler(call.args, { workspaceRoot: root, signal: scope.signal });
          calls.push({ name: call.name, args: call.args });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.output });
        }
      }
      if (!answer) throw new Error('No final answer within probe budget');
      const expected = catalog.list().skills.find(s => s.name === fixture.skill);
      if (!calls.some(c => c.name === 'skill_load' && [expected.id, expected.name].includes(c.args?.id))) throw new Error(`Expected skill not loaded: ${fixture.skill}`);
    } catch (e) { error = String(e); }
    finally { scope.close(); }
    results.push({ ...fixture, calls, answer, rawAnswer, outputFormat, formatWarning, error, routes, usage: scope.snapshot(), elapsedMs: Date.now() - started });
    await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify({ kind: 'bounded skill selection and behavior probes; manual semantic review required', at: new Date().toISOString(), promptChars: catalog.prompt().length, results }, null, 2) + '\n');
    console.log(JSON.stringify({ id: fixture.id, error, calls: calls.map(c => c.name), tokens: scope.snapshot().totalTokens }));
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
if (results.some(r => r.error)) process.exitCode = 1;
