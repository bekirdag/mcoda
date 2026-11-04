import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { redactSecretValues } from './SecretRedaction.js';
import type { ReviewSourcePage } from './TaskReview.js';

/** Bounded review evidence; binary assets remain checksums, never prompt data. */
export const readReviewSource = async (root: string, relative: string, expectedHash: string, maxChars: number): Promise<{ content: string; truncated: boolean }> => {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return { content: '[missing or not a regular source file]', truncated: false };
  const canonicalRoot = await fs.realpath(root);
  const file = await fs.realpath(path.join(canonicalRoot, relative));
  if (!file.startsWith(canonicalRoot + path.sep)) throw new Error(`Review source escapes the workspace: ${relative}`);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Review source is not a regular file: ${relative}`);
    if (metadata.size > 128 * 1024) return { content: '[large source omitted; use bounded source/diff receipts for review]', truncated: true };
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const content = bytes.subarray(0, length);
    if (createHash('sha256').update(content).digest('hex') !== expectedHash) throw new Error(`Review source changed before inspection: ${relative}`);
    if (content.includes(0) || /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|tgz|gz|mp[34]|mov|webm|wav|flac|gguf|bin|exe)$/i.test(relative)) return { content: '[binary artifact omitted; checksum and tool receipt identify its content]', truncated: false };
    // Redact before slicing: a credential spanning a page boundary must never
    // leave a raw prefix or suffix in either prompt.
    const text = redactSecretValues(content.toString('utf8'));
    return { content: text.slice(0, maxChars), truncated: text.length > maxChars };
  } finally { await handle.close(); }
};

/** Page offsets refer to redacted text, so repeated reads cannot reconstruct a secret. */
export async function readReviewSourcePage(root: string, relative: string, expectedHash: string, offset: number): Promise<ReviewSourcePage> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid review source offset');
  const source = await readReviewSource(root, relative, expectedHash, 128 * 1024);
  if (source.truncated) return { path: relative, offset, content: source.content, truncated: true, unavailable: true };
  if (offset > source.content.length) throw new Error(`Review source offset exceeds the file length: ${relative}`);
  const content = source.content.slice(offset, offset + 8000);
  const truncated = offset + content.length < source.content.length;
  return { path: relative, offset, content, truncated, ...(truncated ? { nextOffset: offset + content.length } : {}) };
}
