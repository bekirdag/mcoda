import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_DIRS,
  assertPackedManifestPortable,
  expectedPackedWorkspaceRange,
  findWorkspaceProtocolPaths,
  getPnpmCandidates,
  packTarballs,
  packageTarballFilename,
} from '../../scripts/pack-npm-tarballs.js';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

test('package set matches the release workflow order', () => {
  assert.deepEqual(PACKAGE_DIRS, [
    'packages/shared',
    'packages/db',
    'packages/agents',
    'packages/generators',
    'packages/integrations',
    'packages/core',
    'packages/agent-setup',
    'packages/cli',
    'packages/codali',
    'packages/mswarm',
  ]);
});

test('pnpm command candidates are platform-aware', () => {
  assert.deepEqual(getPnpmCandidates('darwin'), ['pnpm']);
  assert.deepEqual(getPnpmCandidates('linux'), ['pnpm']);
  assert.deepEqual(getPnpmCandidates('win32'), [
    'pnpm.cmd',
    'pnpm.exe',
    'pnpm',
  ]);
});

test('tarball names follow npm package naming', () => {
  assert.equal(
    packageTarballFilename({ name: '@mcoda/agent-setup', version: '1.2.3' }),
    'mcoda-agent-setup-1.2.3.tgz'
  );
  assert.equal(
    packageTarballFilename({ name: 'mcoda', version: '1.2.3' }),
    'mcoda-1.2.3.tgz'
  );
});

test('workspace protocol validation reports exact manifest paths', () => {
  assert.deepEqual(
    findWorkspaceProtocolPaths({
      dependencies: { '@mcoda/core': 'workspace:*' },
      nested: [{ value: 'workspace:^' }],
    }),
    ['dependencies.@mcoda/core', 'nested.0.value']
  );
  assert.equal(expectedPackedWorkspaceRange('workspace:*', '0.1.92'), '0.1.92');
  assert.equal(
    expectedPackedWorkspaceRange('workspace:^', '0.1.92'),
    '^0.1.92'
  );
  assert.equal(
    expectedPackedWorkspaceRange('workspace:~', '0.1.92'),
    '~0.1.92'
  );
});

test('portable manifest guard rejects leaked workspace protocols', () => {
  assert.throws(
    () =>
      assertPackedManifestPortable({
        sourceManifest: {
          name: '@mcoda/example',
          version: '0.1.92',
          dependencies: { '@mcoda/core': 'workspace:*' },
        },
        packedManifest: {
          name: '@mcoda/example',
          version: '0.1.92',
          dependencies: { '@mcoda/core': 'workspace:*' },
        },
        internalVersions: new Map([['@mcoda/core', '0.1.92']]),
        tarballPath: 'example.tgz',
      }),
    /non-portable workspace protocols/
  );
});

test('pnpm packs portable Agent Setup and CLI manifests', () => {
  const dest = mkdtempSync(path.join(os.tmpdir(), 'mcoda-portable-packs-'));
  try {
    const results = packTarballs({
      root,
      dest,
      packageDirs: ['packages/agent-setup', 'packages/cli'],
    });
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.deepEqual(findWorkspaceProtocolPaths(result.manifest), []);
    }

    const agentSetup = results.find(
      (result) => result.manifest.name === '@mcoda/agent-setup'
    );
    const cli = results.find((result) => result.manifest.name === 'mcoda');
    assert.ok(agentSetup);
    assert.ok(cli);
    assert.equal(
      agentSetup.manifest.dependencies['@mcoda/core'],
      agentSetup.manifest.version
    );
    assert.equal(
      cli.manifest.dependencies['@mcoda/core'],
      cli.manifest.version
    );
    assert.equal(
      cli.manifest.dependencies['@mcoda/shared'],
      cli.manifest.version
    );
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
