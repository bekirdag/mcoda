// Host-side grading only. Never place specifications or observations in a model prompt.
import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createDocumentTools } from '../../packages/codali/dist/tools/documents/DocumentTools.js';
import { createIsolatedExecutor } from '../../packages/codali/dist/tools/shell/IsolatedExecutor.js';
import { pinOrchestrationConfig, resolveBinding } from '../../packages/codali/dist/config/OrchestrationConfig.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const media = { png: 'images.generations', wav: 'audio.generations', webm: 'videos.generations' };
const formats = new Set(['md', 'pdf', 'docx', 'xlsx', ...Object.keys(media)]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const inside = (root, target) => { const rel = path.relative(root, target); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const fields = (object, allowed) => {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !allowed.includes(key))) throw Error('Invalid artifact specification fields');
};

export function validateArtifactSpec(spec) {
  fields(spec, ['path', 'format', 'textIncludes', 'textExcludes', 'values', 'media', 'requireLocalGeneration']);
  if (typeof spec.path !== 'string' || spec.path.length > 1000 || /[\x00-\x1f\\]/.test(spec.path) || path.isAbsolute(spec.path)
    || spec.path.split('/').some(part => !part || ['.', '..', '.git', '.mcoda'].includes(part))
    || !formats.has(spec.format) || path.extname(spec.path) !== `.${spec.format}`) throw Error('Invalid artifact path/format');
  for (const key of ['textIncludes', 'textExcludes']) if (spec[key] !== undefined && (!Array.isArray(spec[key]) || spec[key].length > 50
    || spec[key].some(value => typeof value !== 'string' || !value || value.length > 4000))) throw Error('Invalid artifact text expectations');
  if (spec.values !== undefined) {
    if (!Array.isArray(spec.values) || spec.values.length > 100) throw Error('Invalid artifact value expectations');
    for (const entry of spec.values) {
      fields(entry, ['pointer', 'equals']);
      if (typeof entry.pointer !== 'string' || entry.pointer.length > 500 || !/^\/(?:[^~]|~[01])*$/.test(entry.pointer)
        || !own(entry, 'equals') || JSON.stringify(entry.equals)?.length > 8000) throw Error('Invalid artifact value assertion');
    }
  }
  if (spec.requireLocalGeneration !== undefined && typeof spec.requireLocalGeneration !== 'boolean') throw Error('Invalid local-generation requirement');
  if (media[spec.format]) {
    if (spec.textIncludes || spec.textExcludes || spec.values || spec.requireLocalGeneration === false) throw Error('Media grading requires local generation and media checks');
    if (spec.media) {
      const keys = ['width', 'height', 'channels', 'sampleRate', 'minDurationSeconds', 'maxDurationSeconds', 'minFrames', 'maxFrames', 'fps'];
      fields(spec.media, keys);
      if (Object.values(spec.media).some(value => !Number.isFinite(value) || value <= 0)) throw Error('Invalid media expectations');
      if (spec.media.minDurationSeconds > spec.media.maxDurationSeconds || spec.media.minFrames > spec.media.maxFrames) throw Error('Reversed media expectation range');
    }
  } else if (spec.media || spec.requireLocalGeneration !== undefined) throw Error('Non-media artifact cannot have media expectations');
  return spec;
}

async function artifactBytes(workspace, relative, maxBytes) {
  const root = await fs.realpath(workspace);
  let target = root;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    if ((await fs.lstat(target)).isSymbolicLink()) throw Error('Artifact symlinks are not accepted');
  }
  if (!inside(root, await fs.realpath(path.dirname(target)))) throw Error('Artifact escapes workspace');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (process.platform === 'linux' && !inside(root, await fs.realpath(`/proc/self/fd/${handle.fd}`))) throw Error('Opened artifact escapes workspace');
    const before = await handle.stat();
    if (!before.isFile() || !before.size || before.size > maxBytes) throw Error('Artifact is empty, oversized or not a regular file');
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) { const read = await handle.read(buffer, count, buffer.length - count, null); if (!read.bytesRead) break; count += read.bytesRead; }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('Artifact changed while reading');
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

function pointerValue(object, pointer) {
  let current = object;
  for (const component of pointer.slice(1).split('/').map(value => value.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (current === null || typeof current !== 'object' || !own(current, component)) return { found: false };
    current = current[component];
  }
  return { found: true, value: current };
}

function documentText(value) {
  if (value.format === 'md') return value.text ?? '';
  if (value.format === 'pdf') return (value.pages ?? []).map(page => page.text).join('\n');
  if (value.format === 'docx') return (value.blocks ?? []).map(block => block.text ?? block.rows?.map(row => row.join('\t')).join('\n') ?? '').join('\n');
  return (value.sheets ?? []).map(sheet => sheet.rows.map(row => row.join('\t')).join('\n')).join('\n');
}

/** Require host-owned job receipts and a prospectively frozen model/node allowlist.
 * A filename, model-produced citation, or configured backend name alone is insufficient. */
export function verifyLocalMediaGeneration(observation, spec, jobs, policy) {
  const failures = [];
  const matches = jobs.filter(job => job?.artifact?.sha256 === observation.sha256 && job.artifact.bytes === observation.bytes);
  if (matches.length !== 1) return { passed: false, failures: ['Expected exactly one matching host-owned media job'] };
  const job = matches[0];
  let resolved;
  try { resolved = pinOrchestrationConfig(job.resolved); } catch { failures.push('Invalid pinned media configuration'); }
  try {
    if (!resolved || job.request?.model !== job.catalogId || !resolveBinding(resolved.config, job.binding, job.operation).some(candidate => candidate.id === job.modelId)) throw Error('route');
  } catch { failures.push('Media job does not match its selected binding'); }
  const model = resolved?.config.models[job.modelId];
  const allowed = policy?.models?.find(entry => entry.modelId === job.modelId && entry.catalogId === job.catalogId && entry.operation === media[spec.format]);
  if (!allowed || allowed.backend !== 'openai-compatible-local' || model?.backend !== allowed.backend
    || model?.catalogId !== job.catalogId || model?.provider !== job.providerId || !model?.operations?.includes(job.operation)
    || policy.configHash !== job.configHash || resolved?.hash !== job.configHash) failures.push('Generation route is not the frozen local specialist');
  if (job.status !== 'succeeded' || job.operation !== media[spec.format] || job.artifact.jobId !== job.id
    || job.artifact.model !== job.modelId || job.artifact.configHash !== job.configHash) failures.push('Media completion or artifact identity mismatch');
  if (job.remote?.protocol !== 'mswarm-media-jobs-v1' || job.remote.status !== 'succeeded' || !job.remote.invocationId
    || !/^shj_media_[a-f0-9]{64}$/.test(job.remote.jobId ?? '') || !/^[a-f0-9]{64}$/.test(job.remote.resultSha256 ?? '')
    || !Array.isArray(allowed?.nodeIds) || !allowed.nodeIds.length || !allowed.nodeIds.includes(job.remote?.nodeId)) failures.push('Missing successful execution receipt from an allowed local node');
  return { passed: failures.length === 0, failures, jobId: job.id, model: job.catalogId, backend: model?.backend,
    nodeId: job.remote?.nodeId, invocationId: job.remote?.invocationId, usage: job.remote?.usage ?? null,
    usageKnown: job.remote?.usage !== undefined, createdAt: job.createdAt, updatedAt: job.updatedAt };
}

const rational = value => {
  if (typeof value !== 'string' || !/^\d+(?:\/\d+)?$/.test(value)) return null;
  const [a, b = '1'] = value.split('/'); const result = Number(a) / Number(b); return Number.isFinite(result) && result > 0 ? result : null;
};

async function probeMedia(root, file, spec, signal) {
  // Parse only a copied artifact in a network-disabled namespace. No workspace,
  // credentials, score specifications or other files are mounted into the decoder.
  const execute = createIsolatedExecutor({ network: false });
  const context = { workspaceRoot: root, allowedWritePaths: [], signal, shellTimeoutMs: 30000, shellMaxOutputBytes: 64000 };
  const limited = async (command, args) => {
    const result = await execute('/usr/bin/prlimit', ['--as=1073741824', '--cpu=20', '--nofile=64', '--', command, ...args], context);
    if (result.data.truncated) throw Error('Media observation was truncated');
    return result.data;
  };
  const version = (await limited('/usr/bin/ffprobe', ['-version'])).stdout.split('\n')[0];
  const probe = await limited('/usr/bin/ffprobe', ['-v', 'error', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-count_frames',
    '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height,sample_rate,channels,duration,nb_read_frames,avg_frame_rate', '-of', 'json', file]);
  const metadata = JSON.parse(probe.stdout);
  const streams = metadata.streams ?? [];
  const wanted = spec.format === 'wav' ? 'audio' : 'video';
  if (streams.length !== 1 || streams[0].codec_type !== wanted) throw Error('Artifact stream type/count mismatch');
  const stream = streams[0];
  if (spec.format === 'png' && stream.codec_name !== 'png' || spec.format === 'wav' && !metadata.format?.format_name?.split(',').includes('wav')
    || spec.format === 'webm' && !metadata.format?.format_name?.split(',').includes('webm')) throw Error('Artifact format does not match file type');
  await limited('/usr/bin/ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-i', file,
    '-map', '0:0', '-threads', '1', '-f', 'null', '-']);
  if (probe.stderr.trim()) throw Error('Media parser reported an error');
  const number = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  return { format: spec.format, decoder: version, decoded: true, codec: stream.codec_name, width: number(stream.width), height: number(stream.height),
    channels: number(stream.channels), sampleRate: number(stream.sample_rate), durationSeconds: number(stream.duration ?? metadata.format?.duration),
    frames: number(stream.nb_read_frames), fps: rational(stream.avg_frame_rate) };
}

export async function gradeArtifact(workspace, spec, options = {}) {
  validateArtifactSpec(spec); // Invalid host criteria are a harness error, never an answer failure.
  options.signal?.throwIfAborted();
  const started = Date.now(), failures = [];
  const result = { path: spec.path, format: spec.format, technicalPassed: false, semanticPassed: null, semanticReviewRequired: true, failures };
  let root;
  try {
    const bytes = await artifactBytes(workspace, spec.path, media[spec.format] ? 67108864 : 8388608);
    Object.assign(result, { bytes: bytes.length, sha256: digest(bytes) });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'codali-artifact-grade-')); await fs.chmod(root, 0o700);
    const file = path.join(root, `artifact.${spec.format}`); await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    if (media[spec.format]) {
      const observed = await probeMedia(root, file, spec, options.signal); result.observed = observed;
      for (const [key, expected] of Object.entries(spec.media ?? {})) {
        const actual = key.includes('Duration') ? observed.durationSeconds : key.endsWith('Frames') ? observed.frames : observed[key];
        const passed = actual !== null && actual !== undefined && (key.startsWith('min') ? actual >= expected : key.startsWith('max') ? actual <= expected : Math.abs(actual - expected) <= (key === 'fps' ? 0.01 : 0));
        if (!passed) failures.push(`Media ${key} expected ${expected}, observed ${actual}`);
      }
      result.generation = verifyLocalMediaGeneration(result, spec, options.mediaJobs ?? [], options.localMediaPolicy);
      failures.push(...result.generation.failures);
    } else {
      const tool = createDocumentTools(options.documentOptions).find(tool => tool.name === 'document_read');
      const read = await tool.handler({ path: path.basename(file), maxChars: 24000, maxPages: 20, maxRows: 200, maxSheets: 8 }, { workspaceRoot: root, allowedReadPaths: [path.basename(file)], signal: options.signal });
      result.observed = read.data;
      if (read.data.inputSha256 !== result.sha256) throw Error('Document observation hash mismatch');
      if (read.data.truncated) failures.push('Document extraction truncated; content cannot be fully verified');
      const text = documentText(read.data);
      for (const expected of spec.textIncludes ?? []) if (!text.includes(expected)) failures.push(`Missing required document text: ${JSON.stringify(expected)}`);
      for (const excluded of spec.textExcludes ?? []) if (text.includes(excluded)) failures.push(`Forbidden document text: ${JSON.stringify(excluded)}`);
      for (const assertion of spec.values ?? []) {
        const observed = pointerValue(read.data, assertion.pointer);
        if (!observed.found || !isDeepStrictEqual(observed.value, assertion.equals)) failures.push(`Document value mismatch at ${assertion.pointer}`);
      }
      result.limitations = ['Text/structure checks do not prove visual layout or semantic quality.', 'Spreadsheet formulas are not evaluated.'];
    }
    result.technicalPassed = failures.length === 0;
  } catch (error) { options.signal?.throwIfAborted(); failures.push(String(error.message ?? error).slice(0,1500)); }
  finally { if (root) await fs.rm(root, { recursive: true, force: true }); result.observationMs = Date.now() - started; }
  return result;
}
