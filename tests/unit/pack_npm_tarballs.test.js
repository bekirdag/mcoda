import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_DIRS,
  assertPackedManifestPortable,
  canonicalJson,
  expectedPackedWorkspaceRange,
  findWorkspaceProtocolPaths,
  getPnpmCandidates,
  normalizePackedManifestArchive,
  packTarballs,
  packageTarballFilename,
  resolvePnpmCommand,
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

test('Windows pnpm command shims run through ComSpec', () => {
  const calls = [];
  const command = resolvePnpmCommand({
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    execFile: (bin, args, options) => calls.push({ bin, args, options }),
  });

  assert.deepEqual(command, {
    bin: 'C:\\Windows\\System32\\cmd.exe',
    prefixArgs: ['/d', '/s', '/c', 'pnpm.cmd'],
  });
  assert.deepEqual(calls, [
    {
      bin: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', '--version'],
      options: { stdio: 'ignore' },
    },
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

test('canonical manifest JSON retains arrays, primitives and own prototype-named keys', () => {
  const value = JSON.parse('{"z":[2,1,null,true],"__proto__":{"z":2,"a":1},"a":"text"}');
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(canonicalJson(value), canonicalJson(reversed));
  assert.deepEqual(JSON.parse(canonicalJson(value)), value);
  assert.deepEqual(JSON.parse(canonicalJson(value)).z, [2, 1, null, true]);
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

    // Reproduce pnpm's nondeterministic workspace dependency insertion order
    // without relying on the race occurring during this particular test run.
    const original = readFileSync(cli.tarballPath);
    const tar = gunzipSync(original);
    const marker = tar.indexOf(Buffer.from('package/package.json\0'));
    assert.ok(marker >= 0 && marker % 512 === 0);
    const length = Number.parseInt(tar.subarray(marker + 124, marker + 136).toString().replaceAll('\0', '').trim(), 8);
    const manifest = JSON.parse(tar.subarray(marker + 512, marker + 512 + length).toString());
    manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).reverse());
    const altered = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal(altered.length, length);
    altered.copy(tar, marker + 512);
    assert.deepEqual(normalizePackedManifestArchive(gzipSync(tar)), original);
    assert.deepEqual(normalizePackedManifestArchive(original), original, 'normalization is idempotent');
    assert.throws(() => normalizePackedManifestArchive(gzipSync(tar.subarray(0, marker + 513))), /Truncated/);
    assert.throws(() => normalizePackedManifestArchive(gzipSync(Buffer.alloc(1024))), /no package.json/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
