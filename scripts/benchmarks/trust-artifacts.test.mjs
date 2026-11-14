import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { gradeArtifact, validateArtifactSpec, verifyLocalMediaGeneration } from './trust-artifacts.mjs';
import { createDocumentTools } from '../../packages/codali/dist/tools/documents/DocumentTools.js';
import { orchestrationHash } from '../../packages/codali/dist/config/OrchestrationConfig.js';
import { executorStatus } from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';

const exec = promisify(execFile);
const isolated = executorStatus().available;
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codali-artifact-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
function proof(format, bytes) {
  const operation = { png: 'images.generations', wav: 'audio.generations', webm: 'videos.generations' }[format];
  const config = { schemaVersion: 1, profile: 'test', providers: { local: { adapter: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' } },
    models: { specialist: { provider: 'local', catalogId: 'local-specialist', backend: 'openai-compatible-local', revision: 'test', operations: [operation], contextWindow: 1024, maxOutputTokens: 1 },
      text: { provider: 'local', catalogId: 'text-fixture', revision: 'test', operations: ['chat.completions'], contextWindow: 1024, maxOutputTokens: 128 } },
    bindings: { lead: { candidates: ['text'] }, media: { candidates: ['specialist'] } } };
  const hash = orchestrationHash(config), at = new Date().toISOString();
  const artifact = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, jobId: 'test-job', model: 'specialist', configHash: hash };
  const job = { schemaVersion: 1, id: 'test-job', sessionId: 'session', operation, binding: 'media', modelId: 'specialist', catalogId: 'local-specialist', providerId: 'local', configHash: hash,
    resolved: { config, hash, source: 'fixture' }, request: { model: 'local-specialist' }, status: 'succeeded', artifact, createdAt: at, updatedAt: at,
    remote: { protocol: 'mswarm-media-jobs-v1', status: 'succeeded', jobId: `shj_media_${'a'.repeat(64)}`, invocationId: 'invocation', nodeId: 'test-local-node', resultSha256: 'b'.repeat(64), usage: { render_seconds: 1 } } };
  return { mediaJobs: [job], localMediaPolicy: { configHash: hash, models: [{ modelId: 'specialist', catalogId: 'local-specialist', backend: 'openai-compatible-local', operation, nodeIds: ['test-local-node'] }] } };
}

test('artifact criteria reject traversal, unsafe metadata, unsupported formats and disabling local media', () => {
  for (const value of [
    { path: '../x.pdf', format: 'pdf' }, { path: '/x.pdf', format: 'pdf' }, { path: '.mcoda/x.pdf', format: 'pdf' },
    { path: 'x.pdf', format: 'docx' }, { path: 'x.exe', format: 'exe' }, { path: 'x.md', format: 'md', arbitrary: true },
    { path: 'x.png', format: 'png', requireLocalGeneration: false }, { path: 'x.png', format: 'png', media: { width: -1 } },
    { path: 'x.wav', format: 'wav', media: { minDurationSeconds: 5, maxDurationSeconds: 1 } },
    { path: 'x.xlsx', format: 'xlsx', values: [{ pointer: '/bad~2', equals: 0 }] },
  ]) assert.throws(() => validateArtifactSpec(value));
  assert.equal(validateArtifactSpec({ path: 'report.pdf', format: 'pdf' }).format, 'pdf');
});

test('missing files, claimed success, empty files, symlinks and invalid media never pass', { skip: !isolated }, async t => {
  const root = await temporary(t), outside = await temporary(t);
  await fs.writeFile(path.join(outside, 'hidden.md'), 'must not be read');
  await fs.symlink(path.join(outside, 'hidden.md'), path.join(root, 'link.md'));
  await fs.symlink(outside, path.join(root, 'directory'));
  await fs.writeFile(path.join(root, 'empty.md'), '');
  await fs.writeFile(path.join(root, 'claimed.png'), 'I generated an image successfully.');
  for (const name of ['missing.md', 'link.md', 'directory/hidden.md', 'empty.md', 'claimed.png']) {
    const result = await gradeArtifact(root, { path: name, format: name.endsWith('png') ? 'png' : 'md' });
    assert.equal(result.technicalPassed, false, name); assert.equal(result.semanticPassed, null); assert.ok(result.failures.length);
  }
});

test('real document content and typed cells are verified from file bytes, never a creation claim', { skip: !isolated }, async t => {
  const root = await temporary(t); const create = createDocumentTools().find(tool => tool.name === 'document_create');
  for (const format of ['md', 'pdf', 'docx', 'xlsx']) {
    const args = { path: `artifact.${format}`, format, ...(format === 'xlsx'
      ? { sheets: [{ name: 'Ledger', rows: [['Item', 'Amount'], ['A', 12.5], ['literal', '=1+1']], header: true }] }
      : { title: 'Recorded facts', blocks: [{ type: 'paragraph', text: 'Verified total is 12.50 EUR.' }] }) };
    await create.handler(args, { workspaceRoot: root, allowedWritePaths: ['.'] });
    const spec = { path: args.path, format, ...(format === 'xlsx'
      ? { values: [{ pointer: '/sheets/0/rows/1/1', equals: 12.5 }, { pointer: '/sheets/0/rows/2/1', equals: '=1+1' }, { pointer: '/sheets/0/formulas', equals: [] }] }
      : { textIncludes: ['Verified total is 12.50 EUR.'], textExcludes: ['fake amount'] }) };
    const result = await gradeArtifact(root, spec);
    assert.equal(result.technicalPassed, true, JSON.stringify(result.failures)); assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.semanticPassed, null); assert.equal(result.semanticReviewRequired, true);
    const bad = await gradeArtifact(root, { path: args.path, format, values: [{ pointer: '/invented', equals: 1 }] });
    assert.equal(bad.technicalPassed, false);
  }
});

test('extraction limits cannot turn a partially inspected document into a pass', { skip: !isolated }, async t => {
  const root = await temporary(t); await fs.writeFile(path.join(root, 'long.md'), 'x'.repeat(25000));
  const result = await gradeArtifact(root, { path: 'long.md', format: 'md', textIncludes: ['xxxx'] });
  assert.equal(result.technicalPassed, false); assert.match(result.failures.join(' '), /truncated/);
  await assert.rejects(gradeArtifact(root, { path: 'long.md', format: 'md' }, { signal: AbortSignal.abort(Error('stop evaluation')) }), /stop evaluation/);
});

test('actual PNG, WAV and WebM decode, dimensions/duration and specialist provenance are independent gates', { skip: !isolated, timeout: 90000 }, async t => {
  const root = await temporary(t);
  // Synthetic CPU-only fixtures validate the evaluator. They are never counted as model generations.
  const common = ['-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1'];
  await exec('/usr/bin/ffmpeg', [...common, '-f', 'lavfi', '-i', 'color=c=blue:s=32x24', '-frames:v', '1', '-threads', '1', path.join(root, 'image.png')], { timeout: 15000 });
  await exec('/usr/bin/ffmpeg', [...common, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=1', '-c:a', 'pcm_s16le', path.join(root, 'audio.wav')], { timeout: 15000 });
  await exec('/usr/bin/ffmpeg', [...common, '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:r=2:d=1', '-c:v', 'libvpx-vp9', '-threads', '1', path.join(root, 'video.webm')], { timeout: 15000 });
  for (const [name, format, expectations] of [
    ['image.png', 'png', { width: 32, height: 24, minFrames: 1, maxFrames: 1 }],
    ['audio.wav', 'wav', { sampleRate: 16000, channels: 1, minDurationSeconds: 0.99, maxDurationSeconds: 1.01 }],
    ['video.webm', 'webm', { width: 32, height: 24, minFrames: 2, maxFrames: 2, fps: 2, minDurationSeconds: 0.99, maxDurationSeconds: 1.01 }],
  ]) {
    const spec = { path: name, format, media: expectations };
    const options = proof(format, await fs.readFile(path.join(root, name)));
    const result = await gradeArtifact(root, spec, options);
    assert.equal(result.technicalPassed, true, JSON.stringify(result.failures)); assert.equal(result.observed.decoded, true);
    assert.equal(result.semanticPassed, null); assert.equal(result.generation.usageKnown, true);
    const noProof = await gradeArtifact(root, spec);
    assert.equal(noProof.observed.decoded, true); assert.equal(noProof.technicalPassed, false);
    const mismatch = await gradeArtifact(root, { ...spec, media: format === 'wav' ? { channels: 2 } : { width: 33 } }, options);
    assert.equal(mismatch.technicalPassed, false); assert.match(mismatch.failures.join(' '), /Media/);
  }
  await fs.writeFile(path.join(root, 'corrupt.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const corrupt = await gradeArtifact(root, { path: 'corrupt.png', format: 'png' }, proof('png', await fs.readFile(path.join(root, 'corrupt.png'))));
  assert.equal(corrupt.technicalPassed, false);
});

test('media evidence rejects uncertain jobs, cloud routes, configuration drift, unknown nodes and duplicate receipts', () => {
  const bytes = Buffer.from('fixture'), base = proof('png', bytes), observed = base.mediaJobs[0].artifact, spec = { path: 'x.png', format: 'png' };
  assert.equal(verifyLocalMediaGeneration(observed, spec, base.mediaJobs, base.localMediaPolicy).passed, true);
  for (const change of [
    options => { options.mediaJobs[0].status = 'uncertain'; },
    options => { options.localMediaPolicy.models[0].backend = 'cloud'; },
    options => { options.mediaJobs[0].resolved.config.models.specialist.backend = 'cloud'; },
    options => { options.mediaJobs[0].remote.nodeId = 'unapproved-node'; },
    options => { delete options.mediaJobs[0].remote.invocationId; },
    options => { options.mediaJobs.push(options.mediaJobs[0]); },
    options => { options.mediaJobs[0].artifact.bytes++; },
    options => { options.mediaJobs[0].operation = 'chat.completions'; },
  ]) {
    const options = structuredClone(base); change(options);
    assert.equal(verifyLocalMediaGeneration(observed, spec, options.mediaJobs, options.localMediaPolicy).passed, false);
  }
});
