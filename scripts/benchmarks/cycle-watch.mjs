// Supervises a running generalization cycle until its study unit ends, then
// starts the post-run evaluation. Meant to run as its own detached systemd user
// unit, so it never exits to "notify" a caller: every event is logged to stdout
// and appended to <cycle>/notifications.jsonl, and watching continues.
//
//   node cycle-watch.mjs --cycle DIR --unit UNIT [--interval-s 300] [--stall-min 45]
//        [--stall-post-run-min 180] [--tools cycle-tools.mjs] [--process 'strata|llama'] [--no-post-run]
//
// Each pass: (1) unit state first; when the unit is no longer active the run has
// ended: write <cycle>/RUN-ENDED.json (finished, or died with the unit result),
// run the post-run steps and exit 0. (2) New triage flags (cycle-triage.mjs),
// (3) model-server OOM kills and infrastructure-affected attempts
// (cycle-tools.mjs outages), (4) categories whose attempts all finished
// (ready for blind review), (5) a stall (no attempt event for --stall-min):
// all are notifications, never exits. A stall that lasts --stall-post-run-min
// also runs the post-run steps once on the partial results (they are re-runnable).
//
// Post-run steps (cycle-tools.mjs): grade, packets design, packets research
// (--skip-existing), outages, summary. Output goes to <cycle>/post-run/, and
// <cycle>/POST-RUN-NOTICE.md lists step results and what still needs reviewer agents.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { triageStudy } from './cycle-triage.mjs';

const exists = file => fs.stat(file).then(() => true, () => false);
const readJson = async (file, fallback) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (fallback !== undefined) return fallback; throw error; } };
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 1) + '\n');

/** Run a command; resolves {code, stdout, stderr} and never rejects. */
export const runCommand = (command, args, { cwd, timeoutMs = 6 * 3600 * 1000 } = {}) => new Promise(resolve => {
  execFile(command, args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (error && typeof error.code !== 'number' ? String(error.message) : '') });
  });
});

/** systemd user unit state: {active, state, result, status}. An unreachable systemctl is "unknown", never "ended". */
export const systemdUnitState = run => async unit => {
  const shown = await run('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'LoadState', '-p', 'ExecMainStartTimestamp']);
  const props = Object.fromEntries(shown.stdout.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (!props.ActiveState) return { active: true, state: 'unknown', detail: shown.stderr.trim().slice(0, 200) };
  const active = ['active', 'activating', 'reloading', 'deactivating'].includes(props.ActiveState);
  const started = props.ExecMainStartTimestamp && props.ExecMainStartTimestamp !== 'n/a' ? props.ExecMainStartTimestamp : undefined;
  return { active, state: props.ActiveState, result: props.Result, status: props.ExecMainStatus, loaded: props.LoadState, ...(started ? { startedAt: started } : {}) };
};

/** Categories whose every case has a result for both arms, not reported before. */
export const completedCategories = (categories, resultDirs, seen) => {
  const ids = new Set(resultDirs.map(name => name.replace(/-(after|raw_tools)-.*$/, '-$1')));
  return Object.entries(categories).filter(([name, list]) => !seen.includes(name) && list.every(id => ids.has(`${id}-after`) && ids.has(`${id}-raw_tools`))).map(([name]) => name);
};

export const POST_RUN_STEPS = [
  { name: 'grade', args: ['grade'] },
  { name: 'packets-design', args: ['packets', '--kind', 'design', '--skip-existing'] },
  { name: 'packets-research', args: ['packets', '--kind', 'research', '--skip-existing'] },
  { name: 'outages', args: ['outages'], process: true },
  { name: 'summary', args: ['summary'] },
];

/** The notice an operator (or the next agent session) reads after the run. */
export const postRunNotice = ({ cycleDir, reason, ended, steps, packets, reviews, serviceAffected }) => {
  const lines = [`# Post-run notice: ${path.basename(cycleDir)}`, '', `Reason: ${reason}. Written ${new Date().toISOString()}.`];
  if (ended) lines.push(`Run: ${ended.state} (unit ${ended.unit}: ${ended.unitState ?? '?'}${ended.unitResult ? `, result ${ended.unitResult}` : ''}${ended.status != null ? `, status ${ended.status}` : ''}); results ${ended.results}, with error ${ended.errors}.`);
  lines.push('', '## Steps run', '', ...steps.map(step => `- ${step.name}: ${step.code === 0 ? 'ok' : `FAILED (exit ${step.code})`} -> post-run/${step.name}.out`));
  lines.push('', '## Still needs reviewer agents', '');
  const todo = [];
  for (const kind of ['design', 'research']) {
    const pending = (packets[kind] ?? []).filter(id => !(reviews[kind] ?? new Set()).has(id));
    if (pending.length) todo.push(`- Blind ${kind} review: ${pending.length} packet(s) in ${kind}-packets/ (${pending.join(', ')}), one agent per 4-5 packets (PROCESS step 7), then \`cycle-tools.mjs unblind --kind ${kind}\` and second reviewers for needSecondReviewer.`);
  }
  todo.push('- Apps: review per private/apps/APP_REVIEW.md (PROCESS step 7).');
  if (serviceAffected?.length) todo.push(`- Infrastructure-affected attempts (model-service loss over the threshold, deadline-bound): ${serviceAffected.map(row => `${row.id}:${row.arm} ${Math.round(row.lostShare * 100)}%`).join(', ')}. Decide pair reruns (\`cycle-tools.mjs reruns\`, PROCESS step 6) or disclose.`);
  todo.push('- Losses: `cycle-tools.mjs losses` (classify, then `losses --write --ledger losses/ledger.jsonl --classes FILE`), and `recurrence` (PROCESS step 9).');
  if (steps.some(step => step.code !== 0)) todo.push('- Some steps failed: read their .out files and rerun them by hand.');
  return [...lines, ...todo, ''].join('\n');
};

/**
 * The watch loop. All side effects that touch the host go through `unitState`,
 * `run` and `sleep`, so tests drive it with fakes.
 */
export const watchCycle = async ({
  cycleDir, unit, tools = path.join(import.meta.dirname, 'cycle-tools.mjs'), node = process.execPath,
  intervalMs = 300000, stallMs = 45 * 60000, stallPostRunMs = 180 * 60000, startGraceMs = 30 * 60000, processFilter = 'strata|llama', postRun = true,
  unitState, run = runCommand, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(), log = line => console.log(line),
  maxPasses = Infinity,
}) => {
  unitState ??= systemdUnitState(run);
  const C = cycleDir, results = path.join(C, 'results');
  const stamp = () => new Date(now()).toISOString();
  // A finished evaluation is never repeated by a restarted or second watcher.
  const finalStatus = path.join(C, 'post-run', 'status.json');
  if (postRun && (await readJson(finalStatus, null))?.final) { log(`ALREADY_EVALUATED ${stamp()} ${finalStatus}`); return { skipped: 'already_evaluated' }; }
  const lock = await acquireLock(path.join(C, 'cycle-watch.lock'), { unit, at: stamp() });
  if (!lock.acquired) { log(`LOCKED ${stamp()} another watcher (pid ${lock.holder?.pid}) holds ${path.join(C, 'cycle-watch.lock')}`); return { skipped: 'locked', holder: lock.holder }; }
  try { return await watchLocked(); } finally { await lock.release(); }

  async function watchLocked() {
  const notify = async (kind, detail) => {
    const entry = { at: stamp(), kind, ...detail };
    log(`${kind.toUpperCase()} ${entry.at} ${detail.message ?? ''}`.trimEnd());
    await fs.appendFile(path.join(C, 'notifications.jsonl'), JSON.stringify(entry) + '\n');
  };
  const resultDirs = async () => (await fs.readdir(results).catch(() => [])).filter(name => !name.includes('.'));
  const counts = async () => {
    const ledger = path.join(results, 'ledger.jsonl');
    const rows = (await fs.readFile(ledger, 'utf8').catch(() => '')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const done = rows.filter(row => row.type === 'result');
    const mtimeMs = (await fs.stat(ledger).catch(() => null))?.mtimeMs ?? null;
    return { results: done.length, errors: done.filter(row => row.result?.error || row.launchError).length, complete: rows.some(row => row.type === 'run_complete'),
      ran: rows.some(row => row.type === 'start' || row.type === 'result'), mtimeMs };
  };

  const runPostRun = async (reason, ended) => {
    const out = path.join(C, 'post-run'); await fs.mkdir(out, { recursive: true });
    const steps = [];
    for (const step of POST_RUN_STEPS) {
      const args = [tools, ...step.args, '--cycle', C, ...(step.process && processFilter ? ['--process', processFilter] : [])];
      const startedAt = stamp(), result = await run(node, args, { cwd: path.dirname(tools) });
      await fs.writeFile(path.join(out, `${step.name}.out`), result.stdout + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''));
      steps.push({ name: step.name, code: result.code, startedAt, endedAt: stamp() });
      log(`POST_RUN ${step.name} exit=${result.code}`);
    }
    const packets = {}, reviews = {};
    for (const kind of ['design', 'research']) {
      packets[kind] = (await fs.readdir(path.join(C, `${kind}-packets`)).catch(() => [])).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)).sort();
      reviews[kind] = new Set();
      for (const file of (await fs.readdir(path.join(C, 'reviews')).catch(() => [])).filter(name => new RegExp(`^${kind}-\\d+-\\d+\\.json$`).test(name))) {
        const data = await readJson(path.join(C, 'reviews', file), null);
        for (const id of Array.isArray(data) ? data.map(item => item.caseId) : Object.keys(data?.cases ?? {})) reviews[kind].add(id);
      }
    }
    const serviceAffected = (await readJson(path.join(C, 'outages.json'), {}))?.serviceLoss?.affected ?? [];
    await fs.writeFile(path.join(C, 'POST-RUN-NOTICE.md'), postRunNotice({ cycleDir: C, reason, ended, steps, packets, reviews, serviceAffected }));
    // Only the evaluation after the run ended is final; a stall evaluation is partial and repeated at the end.
    await writeJson(ended ? finalStatus : path.join(out, 'stall-status.json'), { reason, at: stamp(), final: !!ended, steps });
    if (ended) await writeJson(path.join(C, 'RUN-ENDED.json'), { ...ended, postRunCompletedAt: stamp() });
    await notify('post_run_done', { message: `${reason}: ${steps.map(step => `${step.name}=${step.code}`).join(' ')}; see POST-RUN-NOTICE.md`, reason, steps });
    return steps;
  };

  // The run has ended only after its unit was seen active (remembered across watcher restarts in
  // watch-state.json) or the ledger says run_complete. A mistyped or not-yet-started unit
  // (inactive / not-found) is waited for, with one notification after the start grace period.
  const statePath = path.join(C, 'watch-state.json'), startedAt = now();
  const watchState = await readJson(statePath, {});
  let seenActive = watchState.unit === unit && !!watchState.seenActiveAt, notSeenNotified = false;
  let passes = 0, stallNotified = false, stallPostRunDone = false;
  for (;;) {
    try {
      // 1. Unit state first.
      const state = await unitState(unit);
      // A unit that started and failed between two polls is never seen active: systemd still shows it
      // failed, with a non-success Result or a main-process start time. A ledger with attempts that has
      // not changed for the stall window also shows a run that stopped (a fresh one may belong to a
      // study running under another unit name, so it is not taken as an end).
      const ledger = !state.active && !seenActive ? await counts() : null;
      const ran = state.state === 'failed' || (!!state.result && state.result !== 'success') || !!state.startedAt
        || (!!ledger?.ran && ledger.mtimeMs != null && now() - ledger.mtimeMs > stallMs);
      if (!seenActive && state.state !== 'unknown' && (state.active || ran)) { seenActive = true; await writeJson(statePath, { unit, seenActiveAt: stamp(), ...(state.active ? {} : { inferredFrom: state.state === 'failed' || (state.result && state.result !== 'success') ? `unit ${state.state}/${state.result}` : state.startedAt ? 'ExecMainStartTimestamp' : 'ledger' }) }); }
      const complete = !!ledger?.complete;
      if (!state.active && !seenActive && !complete) {
        if (!notSeenNotified && now() - startedAt > startGraceMs) {
          notSeenNotified = true;
          await notify('unit_not_seen', { message: `unit ${unit} is ${state.state}${state.loaded ? `/${state.loaded}` : ''} and has not been seen active in ${Math.round((now() - startedAt) / 60000)} min; check the unit name. Still waiting; no evaluation runs until it has run.` });
        }
      } else if (!state.active) {
        const { results: done, errors, complete } = await counts();
        const ended = { state: complete ? 'finished' : 'died', at: stamp(), unit, unitState: state.state, unitResult: state.result, status: state.status != null ? Number(state.status) : null, results: done, errors };
        await writeJson(path.join(C, 'RUN-ENDED.json'), ended);
        await notify(complete ? 'run_finished' : 'run_died', { message: `unit ${unit} ${state.state}/${state.result ?? '-'}; results=${done} errors=${errors}`, ...ended });
        const steps = postRun ? await runPostRun(complete ? 'run finished' : 'run ended without run_complete', ended) : [];
        return { ended, steps };
      }
      // 2. Triage flags (nothing to scan until the results directory exists).
      if (!await exists(results)) { /* waiting for the study to start */ } else {
        const statePath = path.join(C, 'triage-seen.json'), seen = new Set(await readJson(statePath, []));
        const fresh = (await triageStudy(results)).filter(item => !seen.has(`${item.directory}:${item.code}`));
        if (fresh.length) {
          await fs.writeFile(statePath, JSON.stringify([...seen, ...fresh.map(item => `${item.directory}:${item.code}`)]));
          for (const item of fresh) await notify('triage', { message: `${item.severity.toUpperCase()} ${item.code} ${item.key} - ${item.detail}`, severity: item.severity, code: item.code, key: item.key });
        }
      }
      if (await exists(results)) {
      // 3. OOM kills during attempts and attempts that lost their deadline to the model service.
      const outages = await run(node, [tools, 'outages', '--cycle', C, ...(processFilter ? ['--process', processFilter] : [])], { cwd: path.dirname(tools) });
      const lines = outages.stdout.split('\n').filter(line => (/ oom_kill /.test(line) && !/affected=-$/.test(line)) || / (INFRA_AFFECTED|POSSIBLE_INFRA)$/.test(line));
      if (lines.length) {
        const seenFile = path.join(C, 'outages-seen.txt'), seenLines = new Set((await fs.readFile(seenFile, 'utf8').catch(() => '')).split('\n').filter(Boolean));
        const fresh = lines.filter(line => !seenLines.has(line));
        if (fresh.length) {
          await fs.appendFile(seenFile, fresh.join('\n') + '\n');
          for (const line of fresh) await notify(/oom_kill/.test(line) ? 'outage' : 'infra_affected', { message: line });
        }
      }
      // 4. Categories ready for blind review.
      const categoriesFile = path.join(C, 'categories.json');
      if (await exists(categoriesFile)) {
        const seenFile = path.join(C, 'categories-seen.json'), seen = await readJson(seenFile, []);
        const fresh = completedCategories(await readJson(categoriesFile), await resultDirs(), seen);
        if (fresh.length) { await writeJson(seenFile, [...seen, ...fresh]); await notify('category_complete', { message: fresh.join(' '), categories: fresh }); }
      }
      // 5. Stall: no attempt event for stallMs.
      let newest = 0;
      for (const name of await resultDirs()) { const stat = await fs.stat(path.join(results, name, 'events.jsonl')).catch(() => null); if (stat) newest = Math.max(newest, stat.mtimeMs); }
      if (!newest) newest = (await fs.stat(path.join(C, 'run.log')).catch(() => null))?.mtimeMs ?? now();
      const idle = now() - newest;
      if (idle > stallMs) {
        if (!stallNotified) {
          stallNotified = true;
          await writeJson(path.join(C, 'RUN-STALLED.json'), { at: stamp(), unit, idleMinutes: Math.round(idle / 60000), newestEventAt: new Date(newest).toISOString() });
          await notify('stalled', { message: `no attempt event for ${Math.round(idle / 60000)} min; unit ${unit} still ${state.state}`, idleMinutes: Math.round(idle / 60000) });
        }
        if (postRun && !stallPostRunDone && idle > stallPostRunMs) { stallPostRunDone = true; await runPostRun(`run stalled ${Math.round(idle / 60000)} min (partial results; rerun after the run ends)`, null); }
      } else if (stallNotified) {
        stallNotified = false; stallPostRunDone = false;
        await fs.rm(path.join(C, 'RUN-STALLED.json'), { force: true });
        await notify('resumed', { message: 'attempt events resumed' });
      }
      }
    } catch (error) {
      // Never stop watching on a tool error; log it and try again next pass.
      log(`WATCH_ERROR ${stamp()} ${String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ')}`);
    }
    if (++passes >= maxPasses) return { ended: false };
    await sleep(intervalMs);
  }
  }
};

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** Exclusive lockfile holding {pid, ...}; a lock whose process is gone is taken over. */
export const acquireLock = async (file, info = {}) => {
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  for (let tries = 0; tries < 2; tries++) {
    try {
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, token, ...info }) + '\n', { flag: 'wx' });
      return { acquired: true, release: async () => { if ((await readJson(file, null))?.token === token) await fs.rm(file, { force: true }); } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = await readJson(file, null);
      if (holder?.pid && alive(holder.pid)) return { acquired: false, holder };
      await fs.rm(file, { force: true });
    }
  }
  return { acquired: false, holder: await readJson(file, null) };
};

const option = (args, name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };

const main = async () => {
  const args = process.argv.slice(2);
  const cycleDir = option(args, 'cycle'), unit = option(args, 'unit');
  if (!cycleDir || !unit) throw Error('Usage: node cycle-watch.mjs --cycle DIR --unit UNIT [--interval-s 300] [--stall-min 45] [--stall-post-run-min 180] [--start-grace-min 30] [--tools FILE] [--process RE] [--no-post-run]');
  const stop = signal => { console.log(`WATCHER_STOPPED ${new Date().toISOString()} ${signal}`); fs.appendFile(path.join(cycleDir, 'notifications.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind: 'watcher_stopped', signal }) + '\n').finally(() => process.exit(0)); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
  console.log(`WATCHING ${new Date().toISOString()} ${path.resolve(cycleDir)} unit=${unit}`);
  await watchCycle({
    cycleDir: path.resolve(cycleDir), unit,
    tools: option(args, 'tools') ? path.resolve(option(args, 'tools')) : undefined,
    intervalMs: Number(option(args, 'interval-s') ?? 300) * 1000,
    stallMs: Number(option(args, 'stall-min') ?? 45) * 60000,
    stallPostRunMs: Number(option(args, 'stall-post-run-min') ?? 180) * 60000,
    startGraceMs: Number(option(args, 'start-grace-min') ?? 30) * 60000,
    processFilter: option(args, 'process') ?? 'strata|llama',
    postRun: !args.includes('--no-post-run'),
  });
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
