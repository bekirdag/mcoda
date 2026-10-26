#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PACKAGE_DIRS, packTarballs, readPackedJsonFile } from './pack-npm-tarballs.js';

export function resolvePackageDirs(env = process.env) {
  const packageDirs = [
    'packages/shared',
    'packages/db',
    'packages/agents',
    'packages/generators',
    'packages/integrations',
    'packages/core',
    'packages/cli',
    'packages/mswarm'
  ];

  if (env.MCODA_PUBLISH_AGENT_SETUP === '1') {
    packageDirs.splice(6, 0, 'packages/agent-setup');
  } else {
    console.log('Skipping @mcoda/agent-setup publish; set MCODA_PUBLISH_AGENT_SETUP=1 after npm package access is configured.');
  }

  if (env.MCODA_PUBLISH_CODALI === '1') {
    packageDirs.splice(packageDirs.indexOf('packages/mswarm'), 0, 'packages/codali');
  } else {
    console.log('Skipping @mcoda/codali publish; set MCODA_PUBLISH_CODALI=1 after npm package access is configured.');
  }

  return packageDirs;
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skipInstallCheck = args.has('--skip-install-check');

export function readPackage(dir) {
  const packageJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (!packageJson.name || !packageJson.version) {
    throw new Error(`${dir}/package.json must include name and version`);
  }
  return packageJson;
}

export function publicationChannel(version) {
  // Strict SemVer, including numeric prerelease identifiers without leading zeros.
  const numeric = '(?:0|[1-9][0-9]*)';
  const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const pattern = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  const match = typeof version === 'string' && pattern.exec(version);
  if (!match) throw new Error(`Invalid release version: ${String(version)}`);
  return match[1] ? 'next' : 'latest';
}

export function assertReleaseVersions(packages) {
  if (packages.length === 0) throw new Error('No packages selected for publication');
  const versions = new Set(packages.map(({ manifest }) => manifest.version));
  for (const version of versions) publicationChannel(version);
  if (versions.size !== 1) throw new Error('All release packages must have the same version before publication');
  return publicationChannel(packages[0].manifest.version);
}

export function tarballIntegrity(tarballPath) {
  return `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`;
}

export function registryVersionState(name, version, integrity, { spawn = spawnSync } = {}) {
  const result = spawn('npm', ['view', `${name}@${version}`, 'dist.integrity', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    if (JSON.parse(result.stdout) !== integrity) throw new Error(`${name}@${version} already exists with different tarball bytes; choose a new version`);
    return 'identical';
  }
  let errorCode;
  for (const output of [result.stdout, result.stderr]) {
    try { errorCode ??= JSON.parse(output).error?.code; } catch { /* npm may also emit plain diagnostics */ }
  }
  if (errorCode === 'E404') return 'absent';
  throw new Error(`Cannot verify registry identity for ${name}@${version}; publication refused`);
}

export function npmPublishArgs(tarballPath, version, { dryRun = false } = {}) {
  const args = ['publish', tarballPath, '--access', 'public', '--tag', publicationChannel(version)];
  if (dryRun) args.push('--dry-run');
  return args;
}

export async function assertCodaliRuntimePublishable(value) {
  // Use the actual client validator so release and runtime trust cannot drift.
  const { validateRuntimeManifest } = await import('../packages/codali/dist/docdex/ManagedRuntime.js');
  const manifest = validateRuntimeManifest(value);
  for (const platform of ['linux-x64-gnu', 'darwin-x64', 'darwin-arm64']) {
    if (!manifest.artifacts[platform]) throw new Error(`Codali publication requires a pinned Docdex runtime for ${platform}`);
  }
  return manifest;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status ?? 'unknown'}`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Packs the package the same way `pnpm publish` will and asserts the packed
// manifest is installable outside the workspace. @mcoda/codali@0.1.128 shipped
// `workspace:*` dependency ranges and could not be installed from the registry
// at all; this runs before the version is burned so that cannot repeat.
export function assertPackedManifestPublishable(dir, { root = process.cwd(), packTarballsImpl = packTarballs } = {}) {
  const dest = mkdtempSync(join(tmpdir(), 'mcoda-publish-pack-'));
  try {
    const [packed] = packTarballsImpl({
      root,
      dest,
      packageDirs: [dir],
      workspacePackageDirs: PACKAGE_DIRS
    });
    return packed.manifest;
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

// Installs the published version into an empty project. A manifest that npm
// refuses to resolve (workspace protocols, unpublished internal pins) fails
// here rather than in a consumer's install.
//
// A just-published version is not visible immediately - npm says so on publish,
// and @mcoda/shared@0.1.129 took about a minute. The retry budget has to outlast
// that, and every attempt has to ask the registry again: npm caches the packument
// for five minutes, so without --prefer-online the retries only re-read the same
// cached copy that did not have the version yet.
export function verifyPublishedInstall(name, version, {
  attempts = 12,
  retryDelayMs = 15000,
  spawn = spawnSync,
  wait = sleep
} = {}) {
  const projectDir = mkdtempSync(join(tmpdir(), 'mcoda-publish-check-'));
  try {
    writeFileSync(
      join(projectDir, 'package.json'),
      `${JSON.stringify({ name: 'mcoda-release-install-check', version: '0.0.0', private: true }, null, 2)}\n`
    );

    let lastOutput = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = spawn(
        'npm',
        ['install', `${name}@${version}`, '--ignore-scripts', '--prefer-online', '--no-audit', '--no-fund', '--loglevel=error'],
        { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      if (result.error) {
        throw result.error;
      }
      if (result.status === 0) {
        return true;
      }
      lastOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      if (attempt < attempts) {
        console.log(`Install check for ${name}@${version} failed (attempt ${attempt}/${attempts}); retrying after registry propagation delay.`);
        wait(retryDelayMs);
      }
    }

    throw new Error(
      `${name}@${version} was published but cannot be installed into an empty project:\n${lastOutput}`
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

async function main() {
  const packageDirs = resolvePackageDirs();
  if (skipInstallCheck) {
    console.log('WARNING: --skip-install-check was passed; published tarballs will not be install-verified.');
  }

  // Reject mixed/invalid versions and check every packed manifest before the
  // first registry mutation. Publish these exact files, never rebuild them.
  assertReleaseVersions(packageDirs.map(dir => ({ manifest: readPackage(dir) })));
  const dest = mkdtempSync(join(tmpdir(), 'mcoda-release-tarballs-'));
  try {
    const packages = packTarballs({ dest, packageDirs });
    const channel = assertReleaseVersions(packages);
    const codali = packages.find(pkg => pkg.manifest.name === '@mcoda/codali');
    if (codali) await assertCodaliRuntimePublishable(readPackedJsonFile(codali.tarballPath, 'package/config/docdex-runtime.json'));
    const states = packages.map(pkg => ({
      ...pkg,
      integrity: tarballIntegrity(pkg.tarballPath),
    }));
    for (const pkg of states) {
      pkg.registryState = dryRun ? 'dry-run' : registryVersionState(pkg.manifest.name, pkg.manifest.version, pkg.integrity);
    }
    for (const pkg of states) {
      const { name, version } = pkg.manifest;
      if (tarballIntegrity(pkg.tarballPath) !== pkg.integrity) throw new Error(`Packed artifact changed before publishing ${name}`);
      if (pkg.registryState === 'identical') {
        console.log(`${name}@${version} already has identical registry bytes; leaving its dist-tags unchanged.`);
      } else {
        console.log(`${dryRun ? 'Dry-run publishing' : 'Publishing'} ${name}@${version} on ${channel}: ${pkg.integrity}`);
        run('npm', npmPublishArgs(pkg.tarballPath, version, { dryRun }));
      }
      if (!dryRun && !skipInstallCheck) {
        console.log(`Installing ${name}@${version} into an empty project to confirm it resolves`);
        verifyPublishedInstall(name, version);
        console.log(`${name}@${version} installs cleanly.`);
      }
    }
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
