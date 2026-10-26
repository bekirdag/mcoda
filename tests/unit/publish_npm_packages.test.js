import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPackedManifestPublishable,
  assertCodaliRuntimePublishable,
  assertReleaseVersions,
  npmPublishArgs,
  publicationChannel,
  registryVersionState,
  resolvePackageDirs,
  verifyPublishedInstall,
} from '../../scripts/publish-npm-packages.js';

const okResult = { status: 0, stdout: '', stderr: '' };

test('candidate releases explicitly publish checked tarballs to next, never latest', () => {
  for (const version of ['0.1.135-codali.0', '1.0.0-alpha.beta.1', '2.0.0-rc.1+build.456', '1.2.3-01a']) {
    assert.equal(publicationChannel(version), 'next');
    assert.deepEqual(npmPublishArgs('/release/candidate.tgz', version), [
      'publish', '/release/candidate.tgz', '--access', 'public', '--tag', 'next',
    ]);
  }
  assert.equal(publicationChannel('1.2.3'), 'latest');
  assert.equal(publicationChannel('1.2.3+build.001'), 'latest');
  assert.ok(npmPublishArgs('/release/stable.tgz', '1.2.3', { dryRun: true }).includes('--dry-run'));
  for (const version of ['v1.2.3', '01.2.3', '1.2', '1.2.3-', '1.2.3-01', '1.2.3-rc.01', '1.2.3+build..1', '1.2.3\n', null]) {
    assert.throws(() => publicationChannel(version), /Invalid release version/);
  }
});

test('mixed release versions are rejected before any registry work', () => {
  const release = versions => versions.map(version => ({ manifest: { version } }));
  assert.equal(assertReleaseVersions(release(['1.0.0-beta.1', '1.0.0-beta.1'])), 'next');
  assert.throws(() => assertReleaseVersions(release(['1.0.0', '1.0.0-beta.1'])), /same version/);
  assert.throws(() => assertReleaseVersions(release(['1.0.0-beta.1', '1.0.0-beta.2'])), /same version/);
  assert.throws(() => assertReleaseVersions([]), /No packages/);
});

test('existing versions must match tarball integrity and registry outages cannot look absent', () => {
  const integrity = 'sha512-fixture';
  const check = result => registryVersionState('@mcoda/codali', '1.0.0-beta.1', integrity, { spawn: () => result });
  assert.equal(check({ status: 0, stdout: JSON.stringify(integrity) }), 'identical');
  assert.throws(() => check({ status: 0, stdout: '"sha512-different"' }), /different tarball bytes/);
  assert.throws(() => check({ status: 0, stdout: '' }), SyntaxError);
  assert.equal(check({ status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) }), 'absent');
  for (const code of ['E401', 'E403', 'ETIMEDOUT', 'ENOTFOUND']) {
    assert.throws(() => check({ status: 1, stderr: JSON.stringify({ error: { code } }) }), /publication refused/);
  }
  assert.throws(() => check({ error: new Error('npm unavailable') }), /npm unavailable/);
});

test('publication requires trusted runtime pins for every supported terminal platform', async () => {
  await assert.rejects(assertCodaliRuntimePublishable({ schemaVersion: 1, artifacts: {} }), /requires a pinned Docdex runtime/);
  const manifest = { schemaVersion: 1, version: '0.2.100-codali.1', artifacts: {} };
  for (const platform of ['linux-x64-gnu', 'darwin-x64', 'darwin-arm64']) manifest.artifacts[platform] = {
    url: `https://github.com/bekirdag/docdex/releases/download/v${manifest.version}/docdexd-${platform}.tar.gz`,
    archiveSha256: 'a'.repeat(64), binarySha256: 'b'.repeat(64),
  };
  assert.equal(await assertCodaliRuntimePublishable(manifest), manifest);
  const missing = structuredClone(manifest); delete missing.artifacts['darwin-x64'];
  await assert.rejects(assertCodaliRuntimePublishable(missing), /darwin-x64/);
  const untrusted = structuredClone(manifest); untrusted.artifacts['darwin-arm64'].url = 'https://example.test/runtime.tar.gz';
  await assert.rejects(assertCodaliRuntimePublishable(untrusted), /pinned publisher/);
  const unpinned = structuredClone(manifest); delete unpinned.artifacts['linux-x64-gnu'].binarySha256;
  await assert.rejects(assertCodaliRuntimePublishable(unpinned), /Invalid pinned/);
});

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
  // Without this every retry re-reads npm's five-minute packument cache, which
  // is the copy that did not have the just-published version in it.
  assert.ok(calls[0].args.includes('--prefer-online'));
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
