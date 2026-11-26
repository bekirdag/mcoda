import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchCycle, systemdUnitState, completedCategories, acquireLock, POST_RUN_STEPS } from './cycle-watch.mjs';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cycle-watch-'));
const attempt = async (results, id, arm, { error } = {}) => {
  const dir = path.join(results, `${id}-${arm}-0000`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'request.json'), JSON.stringify({ arm: arm === 'after' ? 'codali_candidate' : 'raw_tools', task: { id, domain: 'software', comparison: 'answer', prompt: 'Explain the cache.', execution: { writes: false } } }));
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ content: 'An answer.', elapsedMs: 1000, ...(error ? { error } : {}) }));
  await fs.writeFile(path.join(dir, 'events.jsonl'), '{"type":"benchmark_request"}\n');
  await fs.appendFile(path.join(results, 'ledger.jsonl'), JSON.stringify({ type: 'result', key: `${id}:${arm}`, result: error ? { error } : {} }) + '\n');
};
const notifications = async dir => (await fs.readFile(path.join(dir, 'notifications.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const fakeRun = calls => async (command, args) => {
  calls.push(args.slice(1));
  if (args[1] === 'outages' && calls.filter(call => call[0] === 'outages').length >= 2) return { code: 0, stdout: '2026-01-01T00:00:00Z oom_kill llama-server affected=pk-2:after\nmodel_service_loss pk-2:after 9 of 30 min (30%) failures=2 deadline-bound INFRA_AFFECTED\n', stderr: '' };
  if (args[1] === 'grade') return { code: 0, stdout: '{"rows":[]}', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

test('the watcher survives category-complete and triage events, then runs the post-run steps when the unit ends', async () => {
  const C = await tmp(), results = path.join(C, 'results'); await fs.mkdir(results);
  await fs.writeFile(path.join(C, 'categories.json'), JSON.stringify({ pickers: ['pk-1', 'pk-2'], ledgers: ['lg-1'] }));
  const calls = [], log = [];
  let pass = 0;
  // The study adds attempts between passes: pickers finish first, then ledgers; the unit ends on pass 4.
  const script = [
    async () => { await attempt(results, 'pk-1', 'after'); await attempt(results, 'pk-1', 'raw_tools'); await attempt(results, 'pk-2', 'after'); await attempt(results, 'pk-2', 'raw_tools', { error: 'Error: deadline' }); },
    async () => { await attempt(results, 'lg-1', 'after'); await attempt(results, 'lg-1', 'raw_tools'); },
    async () => { await fs.appendFile(path.join(results, 'ledger.jsonl'), '{"type":"run_complete"}\n'); },
  ];
  await script[0]();
  const out = await watchCycle({
    cycleDir: C, unit: 'fake-study', tools: '/repo/cycle-tools.mjs', node: 'node', intervalMs: 1,
    unitState: async () => ({ active: pass < 3, state: pass < 3 ? 'active' : 'inactive', result: 'success', status: '0' }),
    run: fakeRun(calls), sleep: async () => { await script[++pass]?.(); }, log: line => log.push(line),
  });
  const kinds = (await notifications(C)).map(item => item.kind);
  assert.deepEqual(kinds.filter(kind => kind === 'category_complete').length, 2, 'both categories reported, the watcher kept going after the first');
  assert.ok(kinds.includes('triage') && kinds.includes('outage') && kinds.includes('infra_affected'));
  assert.equal(kinds.at(-1), 'post_run_done');
  const ended = JSON.parse(await fs.readFile(path.join(C, 'RUN-ENDED.json'), 'utf8'));
  assert.equal(ended.state, 'finished'); assert.equal(ended.results, 6); assert.equal(ended.errors, 1);
  const post = calls.slice(-POST_RUN_STEPS.length);
  assert.deepEqual(post.map(call => call.slice(0, 3).join(' ')), ['grade --cycle ' + C, 'packets --kind design', 'packets --kind research', 'outages --cycle ' + C, 'summary --cycle ' + C]);
  assert.ok(post[1].includes('--skip-existing'));
  assert.equal(await fs.readFile(path.join(C, 'post-run/grade.out'), 'utf8'), '{"rows":[]}');
  const notice = await fs.readFile(path.join(C, 'POST-RUN-NOTICE.md'), 'utf8');
  assert.match(notice, /run finished/); assert.match(notice, /APP_REVIEW/); assert.match(notice, /grade: ok/);
  assert.equal(out.ended.state, 'finished');
  // The OOM line is remembered and not reported twice.
  assert.equal((await fs.readFile(path.join(C, 'outages-seen.txt'), 'utf8')).trim().split('\n').length, 2);
});

test('a unit that dies without run_complete is marked died and still evaluated; pending packets are listed', async () => {
  const C = await tmp(), results = path.join(C, 'results'); await fs.mkdir(results);
  await attempt(results, 'zz-9', 'after');
  await fs.mkdir(path.join(C, 'design-packets')); await fs.writeFile(path.join(C, 'design-packets', 'zz-9.md'), '# zz-9');
  const calls = [];
  let pass = 0;
  await watchCycle({ cycleDir: C, unit: 'gone', tools: '/t.mjs', node: 'node', unitState: async () => pass ? { active: false, state: 'failed', result: 'exit-code', status: '1' } : { active: true, state: 'active' }, run: fakeRun(calls), sleep: async () => { pass++; }, log: () => {} });
  const ended = JSON.parse(await fs.readFile(path.join(C, 'RUN-ENDED.json'), 'utf8'));
  assert.equal(ended.state, 'died'); assert.equal(ended.unitResult, 'exit-code'); assert.equal(ended.status, 1);
  assert.equal((await notifications(C))[0].kind, 'run_died');
  assert.match(await fs.readFile(path.join(C, 'POST-RUN-NOTICE.md'), 'utf8'), /Blind design review: 1 packet\(s\).*zz-9/);
});

test('the watcher waits for the results directory, and a failing pass is logged without stopping the watch', async () => {
  const C = await tmp(), log = [];
  let pass = 0;
  const out = await watchCycle({
    cycleDir: C, unit: 'u', tools: '/t.mjs', node: 'node',
    unitState: async () => ({ active: pass < 4, state: 'active' }),
    run: fakeRun([]), log: line => log.push(line),
    sleep: async () => {
      pass++;
      if (pass === 2) { await fs.mkdir(path.join(C, 'results', 'bad-after-1'), { recursive: true }); await fs.writeFile(path.join(C, 'results', 'bad-after-1', 'request.json'), '{not json'); await fs.writeFile(path.join(C, 'results', 'bad-after-1', 'result.json'), '{}'); }
    },
  });
  assert.ok(log.some(line => line.startsWith('WATCH_ERROR')), 'the broken attempt file produced a logged error');
  assert.equal(out.ended.state, 'died');
  assert.ok(await fs.stat(path.join(C, 'POST-RUN-NOTICE.md')));
});

test('a stall is marked once, a long stall runs the post-run on partial results, and the watch goes on', async () => {
  const C = await tmp(), results = path.join(C, 'results'); await fs.mkdir(results);
  await attempt(results, 'st-1', 'after');
  const old = new Date('2026-01-01T00:00:00Z');
  await fs.utimes(path.join(results, 'st-1-after-0000', 'events.jsonl'), old, old);
  let clock = old.getTime() + 50 * 60000, pass = 0;
  const calls = [];
  await watchCycle({
    cycleDir: C, unit: 'u', tools: '/t.mjs', node: 'node', stallMs: 45 * 60000, stallPostRunMs: 120 * 60000, now: () => clock,
    unitState: async () => ({ active: pass < 3, state: pass < 3 ? 'active' : 'inactive' }),
    run: fakeRun(calls), log: () => {}, sleep: async () => { pass++; clock += 60 * 60000; },
  });
  const kinds = (await notifications(C)).map(item => item.kind);
  assert.equal(kinds.filter(kind => kind === 'stalled').length, 1);
  assert.equal(kinds.filter(kind => kind === 'post_run_done').length, 2, 'once for the long stall, once at the end');
  assert.ok(await fs.stat(path.join(C, 'RUN-STALLED.json')));
  assert.equal(calls.filter(call => call[0] === 'grade').length, 2);
});

test('unit state: systemctl show is parsed, and an unreachable systemctl never counts as ended', async () => {
  const state = systemdUnitState(async () => ({ code: 0, stdout: 'ActiveState=failed\nResult=exit-code\nExecMainStatus=5\nLoadState=loaded\n', stderr: '' }));
  assert.deepEqual(await state('x'), { active: false, state: 'failed', result: 'exit-code', status: '5', loaded: 'loaded' });
  assert.equal((await systemdUnitState(async () => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus' }))('x')).active, true);
  assert.equal((await systemdUnitState(async () => ({ code: 0, stdout: 'ActiveState=deactivating\n', stderr: '' }))('x')).active, true);
});

test('categories complete only when every case has both arms, each reported once', () => {
  const cats = { a: ['q-1', 'q-2'], b: ['q-3'] };
  assert.deepEqual(completedCategories(cats, ['q-1-after-x', 'q-1-raw_tools-y', 'q-2-after-z'], []), []);
  assert.deepEqual(completedCategories(cats, ['q-1-after-x', 'q-1-raw_tools-y', 'q-2-after-z', 'q-2-raw_tools-w', 'q-3-after-v'], []), ['a']);
  assert.deepEqual(completedCategories(cats, ['q-1-after-x', 'q-1-raw_tools-y', 'q-2-after-z', 'q-2-raw_tools-w'], ['a']), []);
});

test('a mistyped or not-yet-started unit is waited for: no RUN-ENDED, no evaluation, one notice after the grace period', async () => {
  const C = await tmp(); await fs.mkdir(path.join(C, 'results'));
  let clock = Date.parse('2026-04-01T00:00:00Z');
  const calls = [];
  const out = await watchCycle({
    cycleDir: C, unit: 'codali-cylce9', tools: '/t.mjs', node: 'node', startGraceMs: 30 * 60000, now: () => clock, maxPasses: 6,
    unitState: async () => ({ active: false, state: 'inactive', loaded: 'not-found' }), run: fakeRun(calls), log: () => {}, sleep: async () => { clock += 10 * 60000; },
  });
  assert.equal(out.ended, false);
  assert.equal(await fs.stat(path.join(C, 'RUN-ENDED.json')).then(() => true, () => false), false);
  assert.equal(calls.filter(call => call[0] === 'grade').length, 0);
  assert.deepEqual((await notifications(C)).map(item => item.kind).filter(kind => kind.startsWith('unit') || kind.startsWith('run') || kind.startsWith('post')), ['unit_not_seen']);
  assert.equal(await fs.stat(path.join(C, 'cycle-watch.lock')).then(() => true, () => false), false, 'the lock is released');
});

test('a restarted watcher remembers the unit ran, and never repeats a finished evaluation', async () => {
  const C = await tmp(), results = path.join(C, 'results'); await fs.mkdir(results);
  await attempt(results, 'rs-1', 'after');
  // First watcher sees the unit running, then is stopped before the run ends.
  await watchCycle({ cycleDir: C, unit: 'u9', tools: '/t.mjs', node: 'node', maxPasses: 1, unitState: async () => ({ active: true, state: 'active' }), run: fakeRun([]), log: () => {}, sleep: async () => {} });
  // Restarted after the transient unit is gone (not-found): the run has ended, so it is evaluated.
  const calls = [];
  const second = await watchCycle({ cycleDir: C, unit: 'u9', tools: '/t.mjs', node: 'node', unitState: async () => ({ active: false, state: 'inactive', loaded: 'not-found' }), run: fakeRun(calls), log: () => {}, sleep: async () => {} });
  assert.equal(second.ended.state, 'died');
  assert.equal(calls.filter(call => call[0] === 'grade').length, 1);
  assert.ok(JSON.parse(await fs.readFile(path.join(C, 'RUN-ENDED.json'), 'utf8')).postRunCompletedAt);
  // A further restart finds the final evaluation and does nothing.
  const again = [];
  const third = await watchCycle({ cycleDir: C, unit: 'u9', tools: '/t.mjs', node: 'node', unitState: async () => ({ active: false, state: 'inactive' }), run: fakeRun(again), log: () => {}, sleep: async () => {} });
  assert.equal(third.skipped, 'already_evaluated'); assert.deepEqual(again, []);
});

test('two watchers on one cycle: the second exits on the lock; a stale lock is taken over', async () => {
  const C = await tmp(), results = path.join(C, 'results'); await fs.mkdir(results);
  let release, gate = new Promise(resolve => { release = resolve; }), pass = 0;
  const firstCalls = [];
  const first = watchCycle({ cycleDir: C, unit: 'u', tools: '/t.mjs', node: 'node', unitState: async () => ({ active: pass < 1, state: pass < 1 ? 'active' : 'inactive' }), run: fakeRun(firstCalls), log: () => {}, sleep: async () => { await gate; pass++; } });
  while (!await fs.stat(path.join(C, 'cycle-watch.lock')).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 5));
  const secondCalls = [];
  const second = await watchCycle({ cycleDir: C, unit: 'u', tools: '/t.mjs', node: 'node', unitState: async () => ({ active: false, state: 'inactive' }), run: fakeRun(secondCalls), log: () => {}, sleep: async () => {} });
  assert.equal(second.skipped, 'locked'); assert.equal(second.holder.pid, process.pid); assert.deepEqual(secondCalls, []);
  release();
  assert.equal((await first).ended.state, 'died');
  assert.equal(firstCalls.filter(call => call[0] === 'grade').length, 1, 'the evaluation ran once');
  // A lock left by a process that no longer exists does not block a new watcher.
  const lockFile = path.join(C, 'stale.lock');
  await fs.writeFile(lockFile, JSON.stringify({ pid: 2 ** 22 + 12345 }));
  const taken = await acquireLock(lockFile);
  assert.equal(taken.acquired, true); await taken.release();
});
