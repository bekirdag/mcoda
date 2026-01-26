import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQaPlanOutput } from '../QaPlanValidator.js';

test('normalizeQaPlanOutput handles non-object input', () => {
  const result = normalizeQaPlanOutput('bad');
  assert.deepEqual(result.taskProfiles, {});
  assert.deepEqual(result.taskPlans, {});
  assert.ok(result.warnings.length > 0);
});

test('normalizeQaPlanOutput normalizes task_profiles entries', () => {
  const result = normalizeQaPlanOutput({
    task_profiles: {
      'task-1': 'cli',
      'task-2': ['cli', 'chromium', 123],
      'task-3': ['  ', 'maestro'],
    },
  });
  assert.deepEqual(result.taskProfiles['task-1'], ['cli']);
  assert.deepEqual(result.taskProfiles['task-2'], ['cli', 'chromium']);
  assert.deepEqual(result.taskProfiles['task-3'], ['maestro']);
});

test('normalizeQaPlanOutput accepts task_plans with cli/api/browser entries', () => {
  const result = normalizeQaPlanOutput({
    task_plans: {
      'task-1': {
        profiles: ['cli', 'chromium'],
        cli: { commands: ['node tests/all.js'] },
        api: { base_url: 'http://127.0.0.1:3000', requests: [{ method: 'GET', path: '/' }] },
        browser: { base_url: 'http://127.0.0.1:3000', actions: [{ type: 'navigate', url: '/' }] },
      },
    },
  });
  assert.deepEqual(result.taskPlans['task-1']?.profiles, ['cli', 'chromium']);
  assert.deepEqual(result.taskPlans['task-1']?.cli?.commands, ['node tests/all.js']);
  assert.equal(result.taskPlans['task-1']?.api?.base_url, 'http://127.0.0.1:3000');
  assert.equal(result.taskPlans['task-1']?.browser?.base_url, 'http://127.0.0.1:3000');
});

test('normalizeQaPlanOutput preserves stress actions', () => {
  const result = normalizeQaPlanOutput({
    task_plans: {
      'task-1': {
        stress: {
          api: [{ type: 'burst', count: 2, request: { method: 'GET', path: '/health' } }],
          browser: [{ type: 'repeat', count: 3, action: { type: 'click', selector: '#save' } }],
        },
      },
    },
  });
  assert.equal(result.taskPlans['task-1']?.stress?.api?.length, 1);
  assert.equal(result.taskPlans['task-1']?.stress?.browser?.length, 1);
});
