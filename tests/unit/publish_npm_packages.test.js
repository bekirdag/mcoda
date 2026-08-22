import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPackedManifestPublishable,
  resolvePackageDirs,
  verifyPublishedInstall,
} from '../../scripts/publish-npm-packages.js';

const okResult = { status: 0, stdout: '', stderr: '' };

test('opt-in packages publish after the packages they depend on', () => {
  const dirs = resolvePackageDirs({
    MCODA_PUBLISH_AGENT_SETUP: '1',
    MCODA_PUBLISH_CODALI: '1',
  });

  assert.ok(dirs.indexOf('packages/shared') < dirs.indexOf('packages/db'));
  assert.ok(dirs.indexOf('packages/db') < dirs.indexOf('packages/codali'));
  assert.ok(dirs.includes('packages/agent-setup'));

  const optedOut = resolvePackageDirs({});
  assert.ok(!optedOut.includes('packages/codali'));
  assert.ok(!optedOut.includes('packages/agent-setup'));
});

test('packed manifests are asserted before the version is published', () => {
  const calls = [];
  const manifest = assertPackedManifestPublishable('packages/codali', {
    root: '/repo',
    packTarballsImpl: (options) => {
      calls.push(options);
      return [{ manifest: { name: '@mcoda/codali', version: '9.9.9' } }];
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, '/repo');
  assert.deepEqual(calls[0].packageDirs, ['packages/codali']);
  // The whole workspace is needed to resolve `workspace:*` into concrete pins.
  assert.ok(calls[0].workspacePackageDirs.includes('packages/db'));
  assert.ok(calls[0].workspacePackageDirs.includes('packages/shared'));
  assert.notEqual(calls[0].dest, undefined);
  assert.equal(manifest.name, '@mcoda/codali');
});

test('a published version that installs into an empty project passes', () => {
  const calls = [];
  const passed = verifyPublishedInstall('@mcoda/codali', '0.1.129', {
    spawn: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return okResult;
    },
    wait: () => {
      throw new Error('should not retry a successful install');
    },
  });

  assert.equal(passed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'npm');
  assert.equal(calls[0].args[0], 'install');
  assert.equal(calls[0].args[1], '@mcoda/codali@0.1.129');
  assert.ok(calls[0].args.includes('--ignore-scripts'));
});

test('an unresolvable dependency spec fails the release', () => {
  const delays = [];
  assert.throws(
    () =>
      verifyPublishedInstall('@mcoda/codali', '0.1.128', {
        attempts: 3,
        retryDelayMs: 1,
        spawn: () => ({
          status: 1,
          stdout: '',
          stderr: 'npm error code EUNSUPPORTEDPROTOCOL',
        }),
        wait: (ms) => delays.push(ms),
      }),
    /cannot be installed into an empty project[\s\S]*EUNSUPPORTEDPROTOCOL/
  );
  // Retries cover registry propagation, not a broken manifest.
  assert.deepEqual(delays, [1, 1]);
});

test('a slow-to-propagate version is retried before it is called a failure', () => {
  let attempt = 0;
  const passed = verifyPublishedInstall('@mcoda/codali', '0.1.129', {
    attempts: 3,
    retryDelayMs: 1,
    spawn: () => {
      attempt += 1;
      return attempt === 1
        ? { status: 1, stdout: '', stderr: 'npm error code E404' }
        : okResult;
    },
    wait: () => {},
  });

  assert.equal(passed, true);
  assert.equal(attempt, 2);
});
