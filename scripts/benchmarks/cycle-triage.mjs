// Flags known failure signs in finished benchmark attempts, while a study runs.
// Reads only attempt receipts (request.json, result.json, events.jsonl) and never
// grading material, so it can run beside a live study.
//
//   node cycle-triage.mjs <study output dir> [--state file] [--json]
//
// With --state, only flags not reported before are printed and the state file
// is updated, so a watcher loop can call it repeatedly.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const readEvents = async file => {
  try {
    return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const minutes = ms => Math.round(ms / 6000) / 10;
const receiptOf = event => event.data?.receipt ?? event.data?.call ?? {};
const toolName = event => receiptOf(event).tool ?? receiptOf(event).name ?? event.data?.call?.name;
const receiptOk = event => {
  const receipt = event.data?.receipt ?? {};
  return receipt.status ? receipt.status === 'success' : receipt.ok !== false;
};

/** Flags for one finished attempt. `request` is request.json, `result` is
 * result.json and `events` the parsed events.jsonl of that attempt. */
export function triageAttempt({ request, result, events }) {
  const task = request.task ?? {};
  const execution = task.execution ?? {};
  const codali = request.arm !== 'raw_tools';
  const app = task.comparison === 'implementation';
  const content = String(result.content ?? '');
  const deadlineMs = execution.deadlineMs;
  const flags = [];
  const flag = (severity, code, detail) => flags.push({ severity, code, detail });

  if (result.error) flag('high', 'ATTEMPT_ERROR', String(result.error.message ?? JSON.stringify(result.error)).slice(0, 200));
  if (!app && !content.trim()) flag('high', 'EMPTY_ANSWER', 'no answer text');
  if (!app && /fenced (python|javascript|typescript|sql)? ?code block/i.test(task.prompt ?? '') && !content.includes('```')) {
    flag('high', 'NO_CODE_BLOCK', 'the request asks for a fenced code block and the answer has none');
  }
  const handoff = events.some(event => event.type === 'interaction_handoff');
  if (codali && execution.writes === false && (result.mode === 'execute' || handoff)) {
    flag('high', 'EXECUTE_ON_ANSWER', 'an answer-only request was routed into workspace execution');
  }
  if (!app && /Goal remains open/i.test(content)) flag('high', 'GOAL_OPEN', 'the answer reports an unfinished execution goal');
  if (deadlineMs && Number.isFinite(result.elapsedMs) && result.elapsedMs >= deadlineMs && !app) {
    flag('high', 'DEADLINE_REACHED', `ran ${minutes(result.elapsedMs)} of ${minutes(deadlineMs)} min`);
  }

  const receipts = events.filter(event => event.type === 'tool_receipt');
  const failed = receipts.filter(event => !receiptOk(event)).length;
  if (receipts.length >= 10 && failed / receipts.length > 0.4) flag('medium', 'TOOL_FAILURES', `${failed} of ${receipts.length} tool calls failed`);

  // A tool-less audit that changes a draft after executed code passed may undo
  // verified work (cycle 4 numeric 11).
  const verified = receipts.some(event => toolName(event) === 'verify_javascript' && receiptOk(event) && /"passed":true/.test(String(event.data?.receipt?.output ?? '')));
  const audit = events.find(event => event.type === 'calculation_answer_audit');
  if (verified && audit && audit.data?.draftSha256 !== audit.data?.answerSha256) {
    flag('medium', 'AUDIT_REWROTE_VERIFIED', 'the equation review changed an answer after a passing code run');
  }

  // Research benefits from its whole budget; stopping early left points behind
  // in cycle 4 (last tool call at 34 of 45 minutes).
  if (task.domain === 'research' && deadlineMs && Number.isFinite(result.elapsedMs) && result.elapsedMs < deadlineMs * 0.85 && !result.error) {
    flag('medium', 'UNUSED_RESEARCH_TIME', `finished at ${minutes(result.elapsedMs)} of ${minutes(deadlineMs)} min`);
  }
  if (!codali) return flags;
  if (events.some(event => event.type === 'execution_unavailable')) flag('info', 'EXECUTION_REFUSED', 'start_work was refused for lack of authorization');
  return flags;
}

/** Triage every finished attempt in a study output directory. */
export async function triageStudy(output) {
  const findings = [];
  for (const name of (await fs.readdir(output)).sort()) {
    const directory = path.join(output, name);
    let request, result;
    try { request = await readJson(path.join(directory, 'request.json')); result = await readJson(path.join(directory, 'result.json')); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    const events = await readEvents(path.join(directory, 'events.jsonl'));
    const key = `${request.task?.id}:${request.arm === 'raw_tools' ? 'raw_tools' : 'after'}`;
    for (const item of triageAttempt({ request, result, events })) findings.push({ key, directory: name, ...item });
  }
  return findings;
}

const main = async () => {
  const args = process.argv.slice(2);
  const output = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--state');
  if (!output) throw Error('Usage: node cycle-triage.mjs <study output dir> [--state file] [--json]');
  const stateIndex = args.indexOf('--state');
  const statePath = stateIndex >= 0 ? args[stateIndex + 1] : undefined;
  const findings = await triageStudy(path.resolve(output));
  let seen = new Set();
  if (statePath) { try { seen = new Set(await readJson(statePath)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const id = finding => `${finding.directory}:${finding.code}`;
  const fresh = findings.filter(finding => !seen.has(id(finding)));
  if (statePath) await fs.writeFile(statePath, JSON.stringify([...seen, ...fresh.map(id)]));
  if (args.includes('--json')) console.log(JSON.stringify(fresh, null, 1));
  else for (const finding of fresh) console.log(`${finding.severity.toUpperCase()} ${finding.code} ${finding.key} - ${finding.detail}`);
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
