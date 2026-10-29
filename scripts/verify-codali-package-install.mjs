#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_DIRS, loadPackedTarballs, packTarballs } from './pack-npm-tarballs.js';

// Run after building. This installs real tarballs, including SQLite's native
// dependency, outside the checkout and never links or installs a global CLI.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'codali-package-install-'));
const project = path.join(temporary, 'clean project');
const workspace = path.join(temporary, 'workspace with spaces');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex < 0 ? undefined : path.resolve(process.argv[outputIndex + 1]);
const artifactsIndex = process.argv.indexOf('--artifacts-dir');
const artifactsDir = artifactsIndex < 0 ? undefined : path.resolve(process.argv[artifactsIndex + 1]);
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
  // Exercise the complete CLI dependency graph: a transitive installer must not
  // provision or restart the user's existing global/private Docdex daemons.
  const packageDirs = PACKAGE_DIRS;
  const first = artifactsDir ? loadPackedTarballs({ root, dest: artifactsDir, packageDirs })
    : packTarballs({ root, dest: path.join(temporary, 'first'), packageDirs });
  const second = artifactsDir ? undefined : packTarballs({ root, dest: path.join(temporary, 'second'), packageDirs });
  for (const [index, artifact] of first.entries()) {
    const sha256 = hash(artifact.tarballPath);
    if (second) assert.equal(sha256, hash(second[index].tarballPath), `${artifact.manifest.name} packing must reproduce identical bytes`);
    report.artifacts.push({ name: artifact.manifest.name, version: artifact.manifest.version, sha256 });
  }
  report.checks.push(artifactsDir ? 'exact prebuilt artifact checksums and portable manifests' : 'two independent packs have identical bytes');
  report.sourceRevision = process.env.GITHUB_SHA ?? null;
  if (artifactsDir && process.env.GITHUB_SHA) report.checks.push('artifact source revision matches the CI checkout');
  const npmOptions = ['--no-audit', '--no-fund', '--userconfig', path.join(temporary, 'npmrc'), '--cache', path.join(temporary, 'npm-cache')];
  run('npm', ['install', ...first.map(item => item.tarballPath), '--ignore-scripts=false', ...npmOptions], 0, 240_000);
  assert.ok(!existsSync(path.join(project, 'node_modules/docdex')), 'mcoda installation must not install the optional Docdex npm peer');
  report.checks.push('full mcoda/Codali/mSwarm install without automatic Docdex npm provisioning');
  const codaliRoot = path.join(project, 'node_modules/@mcoda/codali');
  assert.ok(!realpathSync(codaliRoot).startsWith(root + path.sep), 'Installed package must not resolve to the workspace checkout');
  for (const file of ['dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'README.md', 'ORCHESTRATION.md', 'config/AGENTS.md', 'config/skills/planning/SKILL.md', 'config/orchestration.schema.json', 'config/raijin-suku.example.json', 'config/alternate-local.example.json', 'config/docdex-runtime.json']) {
    assert.ok(existsSync(path.join(codaliRoot, file)), `Missing installed file: ${file}`);
  }
  const installedFiles = files(codaliRoot);
  assert.ok(!installedFiles.some(file => file.includes('__tests__/') || /\.test\.[cm]?[jt]s(?:\.map)?$/.test(file)), 'Test implementations must not ship');
  report.checks.push('portable manifests and required package files');
  const bin = path.join(project, 'node_modules/.bin/codali');
  assert.ok(statSync(bin).mode & 0o111, 'Installed codali bin must be executable');
  const version = first.find(item => item.manifest.name === '@mcoda/codali').manifest.version;
  assert.equal(run(bin, ['--version']).trim(), version);
  assert.match(run(path.join(project, 'node_modules/.bin/mcoda'), ['--version']), new RegExp(version.replaceAll('.', '\\.')));
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

  // Exercise the installed publication bytes, including the TUI's transitive
  // dependencies. Source-checkout terminal tests alone cannot qualify a tarball.
  env.CODALI_PACKAGE_ROOT = codaliRoot;
  for (const script of ['verify-codali-terminal-pty.py', 'verify-codali-tui-pty.py']) {
    const terminal = JSON.parse(run('python3', [path.join(root, 'scripts', script), process.execPath], 0, 60_000));
    assert.equal(terminal.passed, true);
    report.checks.push(...terminal.checks.map(check => `installed TUI: ${check}`));
  }
  delete env.CODALI_PACKAGE_ROOT;

  const probe = path.join(project, 'probe.mjs');
  writeFileSync(probe, `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import * as api from '@mcoda/codali';
    import * as embeddedApi from './node_modules/@mcoda/mswarm/dist/vendor/codali/index.js';
    import { SessionStore } from './node_modules/@mcoda/codali/dist/session/SessionStore.js';
    import { SkillCatalog } from './node_modules/@mcoda/codali/dist/session/SkillCatalog.js';
    import { SkillCatalog as EmbeddedSkills } from './node_modules/@mcoda/mswarm/dist/vendor/codali/session/SkillCatalog.js';
    const require = createRequire(import.meta.url);
    const sqlite3 = require('sqlite3');
    assert.equal(typeof api.runCodaliTask, 'function');
    assert.equal(typeof embeddedApi.runCodaliTask, 'function');
    const database = new sqlite3.Database(':memory:');
    await new Promise((resolve, reject) => database.get('SELECT 7 AS result', (error, row) => { if (error) reject(error); else { assert.equal(row.result, 7); resolve(); } }));
    await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
    const workspaceRoot = process.argv[2];
    for (const Catalog of [SkillCatalog, EmbeddedSkills]) {
      const skills = new Catalog({ workspaceRoot, includeUser: false }); await skills.refresh();
      assert.ok(skills.list().skills.some(skill => skill.name === 'planning'));
      assert.match(String((await skills.read('planning')).content), /work_plan/);
    }
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
  const runtimeProbe = path.join(project, 'runtime-probe.mjs');
  writeFileSync(runtimeProbe, `
    import assert from 'node:assert/strict';
    import { ensureManagedDocdexRuntime } from './node_modules/@mcoda/codali/dist/docdex/ManagedRuntime.js';
    const stateRoot = process.argv[2];
    const first = await ensureManagedDocdexRuntime({ stateRoot });
    globalThis.fetch = async () => { throw new Error('Cached runtime must not download again'); };
    const cached = await ensureManagedDocdexRuntime({ stateRoot });
    assert.deepEqual(cached, first);
    console.log(JSON.stringify(first));
  `);
  report.docdexRuntime = JSON.parse(run(process.execPath, [runtimeProbe, path.join(temporary, 'private-runtimes')], 0, 180_000).trim());
  report.checks.push('published Docdex archive/binary pins, native capabilities, private installation and offline cached reuse');
  assert.equal(readFileSync(path.join(workspace, 'user-notes.txt'), 'utf8'), 'Preserve this existing user file.\n');
  run('npm', ['uninstall', ...first.map(item => item.manifest.name), '--ignore-scripts', ...npmOptions], 0, 60_000);
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
