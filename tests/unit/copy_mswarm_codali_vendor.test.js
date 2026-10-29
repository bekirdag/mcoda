import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('vendoring rejects missing runtime dependencies before replacing an existing build', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcoda-vendor-contract-'));
  try {
    const source = path.join(root, 'packages/codali');
    const target = path.join(root, 'packages/mswarm');
    const vendor = path.join(target, 'dist/vendor/codali');
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(source, 'dist'), { recursive: true });
    await mkdir(path.join(source, 'config/skills/planning'), { recursive: true });
    await writeFile(path.join(source, 'config/skills/planning/SKILL.md'), 'Planning instructions.\n');
    await mkdir(vendor, { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    await copyFile(new URL('../../scripts/copy-mswarm-codali-vendor.js', import.meta.url), path.join(root, 'scripts/copy.mjs'));
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies: { 'new-terminal-dependency': '1.2.3' } }));
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ dependencies: {} }));
    await writeFile(path.join(source, 'dist/index.js'), 'export const runtime = true;\n');
    await writeFile(path.join(vendor, 'previous.js'), 'preserved');
    const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/copy.mjs')], { encoding: 'utf8', timeout: 10000 });
    const missing = run();
    assert.equal(missing.status, 1); assert.match(missing.stderr, /new-terminal-dependency@1\.2\.3/);
    assert.equal(await readFile(path.join(vendor, 'previous.js'), 'utf8'), 'preserved');
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ dependencies: { 'new-terminal-dependency': '1.2.2' } }));
    assert.equal(run().status, 1, 'A different dependency contract also requires review');
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ dependencies: { 'new-terminal-dependency': '1.2.3' } }));
    const valid = run(); assert.equal(valid.status, 0, valid.stderr);
    assert.equal(await readFile(path.join(vendor, 'index.js'), 'utf8'), 'export const runtime = true;\n');
    assert.equal(await readFile(path.resolve(vendor, '../config/skills/planning/SKILL.md'), 'utf8'), 'Planning instructions.\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
