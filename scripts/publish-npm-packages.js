#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageDirs = [
  'packages/shared',
  'packages/db',
  'packages/agents',
  'packages/generators',
  'packages/integrations',
  'packages/core',
  'packages/cli',
  'packages/codali',
  'packages/mswarm'
];

if (process.env.MCODA_PUBLISH_AGENT_SETUP === '1') {
  packageDirs.splice(6, 0, 'packages/agent-setup');
} else {
  console.log('Skipping @mcoda/agent-setup publish; set MCODA_PUBLISH_AGENT_SETUP=1 after npm package access is configured.');
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

function readPackage(dir) {
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

for (const dir of packageDirs) {
  const { name, version } = readPackage(dir);
  if (!dryRun && versionExists(name, version)) {
    console.log(`${name}@${version} already exists on npm; skipping.`);
    continue;
  }

  const publishArgs = ['--filter', `./${dir}`, 'publish', '--access', 'public', '--no-git-checks'];
  if (dryRun) {
    publishArgs.push('--dry-run');
  }
  console.log(`${dryRun ? 'Dry-run publishing' : 'Publishing'} ${name}@${version} from ${dir}`);
  run('pnpm', publishArgs);
}
