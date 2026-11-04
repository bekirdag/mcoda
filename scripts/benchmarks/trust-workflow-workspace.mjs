// Shared host-side byte accounting. Contains no private grading expectations.
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash } from './trust-common.mjs';

export const workflowWorkspaceLimits = Object.freeze({ files: 512, directories: 128, depth: 16, fileBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 });
const inside = (root, target) => { const rel = path.relative(root, target); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

/** Reject links/special files and bound reads before allocating memory. A copy
 * used by a grader must match the original post-attempt hashes exactly. */
export async function snapshotWorkflowWorkspace(workspace, { copyTo, expected, signal } = {}) {
  signal?.throwIfAborted();
  if ((await fs.lstat(workspace)).isSymbolicLink()) throw Error('Workflow workspace cannot be a symlink');
  const root = await fs.realpath(workspace), files = {}, limits = workflowWorkspaceLimits;
  let fileCount = 0, directoryCount = 0, totalBytes = 0;
  if (copyTo) {
    if ((await fs.lstat(copyTo)).isSymbolicLink()) throw Error('Workspace copy target cannot be a symlink');
    copyTo = await fs.realpath(copyTo);
    if (inside(root, copyTo) || inside(copyTo, root) || (await fs.readdir(copyTo)).length) throw Error('Workspace copy target must be separate and empty');
  }
  async function visit(relative = '', depth = 0) {
    signal?.throwIfAborted();
    if (depth > limits.depth || ++directoryCount > limits.directories) throw Error('Workflow workspace directory limit exceeded');
    const directory = path.join(root, relative);
    if ((await fs.lstat(directory)).isSymbolicLink() || !inside(root, await fs.realpath(directory))) throw Error('Workspace directory escapes retained root');
    for await (const entry of await fs.opendir(directory)) {
      signal?.throwIfAborted();
      const rel = path.posix.join(relative, entry.name), file = path.join(root, rel);
      if (entry.isDirectory()) {
        if (copyTo) await fs.mkdir(path.join(copyTo, rel), { mode: 0o700 });
        await visit(rel, depth + 1);
      } else {
        if (!entry.isFile() || ++fileCount > limits.files) throw Error('Workspace contains nonregular files or exceeds file count');
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (process.platform === 'linux' && !inside(root, await fs.realpath(`/proc/self/fd/${handle.fd}`))) throw Error('Opened workspace file escapes retained root');
          const before = await handle.stat();
          if (!before.isFile() || before.size > limits.fileBytes || (totalBytes += before.size) > limits.totalBytes) throw Error('Workflow workspace byte limit exceeded');
          const bytes = Buffer.alloc(before.size + 1);
          let count = 0;
          while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, null); if (!read.bytesRead) break; count += read.bytesRead; }
          const after = await handle.stat();
          if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('Workspace changed while being observed');
          const content = bytes.subarray(0, count);
          Object.defineProperty(files, rel, { value: hash(content), enumerable: true });
          if (copyTo) await fs.writeFile(path.join(copyTo, rel), content, { flag: 'wx', mode: 0o600 | (before.mode & 0o111) });
        } finally { await handle.close(); }
      }
    }
  }
  await visit();
  if (expected !== undefined && !isDeepStrictEqual(files, expected)) throw Error('Retained workspace differs from the recorded post-attempt hashes');
  return files;
}
