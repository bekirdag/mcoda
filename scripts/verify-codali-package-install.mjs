#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packTarballs } from './pack-npm-tarballs.js';

// Run after building. This installs real tarballs, including SQLite's native
// dependency, outside the checkout and never links or installs a global CLI.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'codali-package-install-'));
const project = path.join(temporary, 'clean project');
const workspace = path.join(temporary, 'workspace with spaces');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0 ? undefined : path.resolve(process.argv[outputIndex + 1]);
const report = { schemaVersion: 1, platform: `${process.platform}-${process.arch}`, node: process.version, checks: [], artifacts: [] };
const env = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (command, args, expectedStatus = 0, timeout = 60_000) => {
  const result = spawnSync(command, args, { cwd: project, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedStatus, `${path.basename(command)} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name]);

try {
  assert.ok(['linux', 'darwin'].includes(process.platform), 'Terminal package qualification currently covers Linux and macOS');
  mkdirSync(project); mkdirSync(workspace);
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'codali-clean-install', version: '0.0.0', private: true, type: 'module' }));
  writeFileSync(path.join(temporary, 'npmrc'), '');
  writeFileSync(path.join(workspace, 'user-notes.txt'), 'Preserve this existing user file.\n');
  const packageDirs = ['packages/shared', 'packages/db', 'packages/codali'];
  const first = packTarballs({ root, dest: path.join(temporary, 'first'), packageDirs });
  const second = packTarballs({ root, dest: path.join(temporary, 'second'), packageDirs });
  for (const [index, artifact] of first.entries()) {
    const sha256 = hash(artifact.tarballPath);
    assert.equal(sha256, hash(second[index].tarballPath), `${artifact.manifest.name} packing must reproduce identical bytes`);
    report.artifacts.push({ name: artifact.manifest.name, version: artifact.manifest.version, sha256 });
  }
  report.checks.push('two independent packs have identical bytes');
  const npmOptions = ['--no-audit', '--no-fund', '--userconfig', path.join(temporary, 'npmrc'), '--cache', path.join(temporary, 'npm-cache')];
  run('npm', ['install', ...first.map(item => item.tarballPath), '--ignore-scripts=false', ...npmOptions], 0, 240_000);
  const codaliRoot = path.join(project, 'node_modules/@mcoda/codali');
  assert.ok(!realpathSync(codaliRoot).startsWith(root + path.sep), 'Installed package must not resolve to the workspace checkout');
  for (const file of ['dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'README.md', 'ORCHESTRATION.md', 'config/orchestration.schema.json', 'config/raijin-suku.example.json', 'config/alternate-local.example.json', 'config/docdex-runtime.json']) {
    assert.ok(existsSync(path.join(codaliRoot, file)), `Missing installed file: ${file}`);
  }
  const installedFiles = files(codaliRoot);
  assert.ok(!installedFiles.some(file => file.includes('__tests__/') || /\.test\.[cm]?[jt]s(?:\.map)?$/.test(file)), 'Test implementations must not ship');
  report.checks.push('portable manifests and required package files');
  const bin = path.join(project, 'node_modules/.bin/codali');
  assert.ok(statSync(bin).mode & 0o111, 'Installed codali bin must be executable');
  const version = first.find(item => item.manifest.name === '@mcoda/codali').manifest.version;
  assert.equal(run(bin, ['--version']).trim(), version);
  assert.match(run(bin, ['--help']), /codali exec/);
  const missingConfig = path.join(temporary, 'absent-orchestration.json');
  const failed = JSON.parse(run(bin, ['exec', 'must not run', '--json', '--workspace-root', workspace, '--config', missingConfig], 1).trim());
  assert.equal(failed.type, 'command_failed'); assert.equal(failed.data.completed, false);
  const existingConfig = path.join(temporary, 'existing-orchestration.json');
  writeFileSync(existingConfig, 'existing user configuration\n');
  const setup = JSON.parse(run(bin, ['setup', '--config', existingConfig, '--json'], 1).trim());
  assert.equal(setup.type, 'command_failed');
  assert.match(setup.data.message, /already exists/);
  assert.equal(readFileSync(existingConfig, 'utf8'), 'existing user configuration\n');
  assert.deepEqual(readdirSync(workspace), ['user-notes.txt']);
  report.checks.push('executable version/help, JSON failure, configuration and user-file preservation');

  const probe = path.join(project, 'probe.mjs');
  writeFileSync(probe, `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import * as api from '@mcoda/codali';
    import { SessionStore } from './node_modules/@mcoda/codali/dist/session/SessionStore.js';
    const require = createRequire(import.meta.url);
    const sqlite3 = require('sqlite3');
    assert.equal(typeof api.runCodaliTask, 'function');
    const database = new sqlite3.Database(':memory:');
    await new Promise((resolve, reject) => database.get('SELECT 7 AS result', (error, row) => { if (error) reject(error); else { assert.equal(row.result, 7); resolve(); } }));
    await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
    const workspaceRoot = process.argv[2];
    const store = new SessionStore({ workspaceRoot });
    const session = await store.createSession({ repoRoot: workspaceRoot, task: 'package persistence probe' });
    await store.appendTranscript(session.sessionId, { type: 'note', data: { value: 'persisted' } });
    const resumed = new SessionStore({ workspaceRoot });
    assert.equal((await resumed.readSession(session.sessionId)).task, 'package persistence probe');
    assert.equal((await resumed.readTranscript(session.sessionId))[0].data.value, 'persisted');
    console.log('installed-api-native-sqlite-and-session-ok');
  `);
  assert.match(run(process.execPath, [probe, workspace]), /installed-api-native-sqlite-and-session-ok/);
  report.checks.push('installed API, native SQLite, durable session write/read through a fresh store');
  assert.equal(readFileSync(path.join(workspace, 'user-notes.txt'), 'utf8'), 'Preserve this existing user file.\n');
  run('npm', ['uninstall', '@mcoda/codali', '@mcoda/db', '@mcoda/shared', '--ignore-scripts', ...npmOptions], 0, 60_000);
  assert.ok(!existsSync(bin));
  assert.ok(!existsSync(codaliRoot));
  assert.equal(readFileSync(path.join(workspace, 'user-notes.txt'), 'utf8'), 'Preserve this existing user file.\n');
  report.checks.push('local uninstall removes the CLI and preserves workspace data');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (output) { mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
  console.log(JSON.stringify(report, null, 2));
  rmSync(temporary, { recursive: true, force: true });
}
