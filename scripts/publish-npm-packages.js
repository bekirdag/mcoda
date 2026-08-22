#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PACKAGE_DIRS, packTarballs } from './pack-npm-tarballs.js';

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

function versionExists(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore']
  });
  return result.status === 0;
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
    process.exit(result.status ?? 1);
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
export function verifyPublishedInstall(name, version, {
  attempts = 5,
  retryDelayMs = 5000,
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
        ['install', `${name}@${version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
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

function main() {
  const packageDirs = resolvePackageDirs();
  if (skipInstallCheck) {
    console.log('WARNING: --skip-install-check was passed; published tarballs will not be install-verified.');
  }

  for (const dir of packageDirs) {
    const { name, version } = readPackage(dir);
    if (!dryRun && versionExists(name, version)) {
      console.log(`${name}@${version} already exists on npm; skipping.`);
      continue;
    }

    console.log(`Checking packed manifest for ${name}@${version}`);
    assertPackedManifestPublishable(dir);

    const publishArgs = ['--filter', `./${dir}`, 'publish', '--access', 'public', '--no-git-checks'];
    if (dryRun) {
      publishArgs.push('--dry-run');
    }
    console.log(`${dryRun ? 'Dry-run publishing' : 'Publishing'} ${name}@${version} from ${dir}`);
    run('pnpm', publishArgs);

    if (dryRun) {
      console.log(`Skipping install check for ${name}@${version}; nothing was published.`);
      continue;
    }
    if (skipInstallCheck) {
      continue;
    }
    console.log(`Installing ${name}@${version} into an empty project to confirm it resolves`);
    verifyPublishedInstall(name, version);
    console.log(`${name}@${version} installs cleanly.`);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main();
}
