import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readReviewSource, readReviewSourcePage } from '../ReviewSource.js';
import { registerSecretValue } from '../SecretRedaction.js';

test('review context preserves source identity, bounds text, and omits binary/large files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codali-review-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file: string, content: string | Buffer) => { await fs.writeFile(path.join(root, file), content); return createHash('sha256').update(content).digest('hex'); };
  const source = await write('source.ts', 'export const value = 2;\n');
  assert.deepEqual(await readReviewSource(root, 'source.ts', source, 500), { content: 'export const value = 2;\n', truncated: false });
  assert.deepEqual(await readReviewSource(root, 'source.ts', source, 6), { content: 'export', truncated: true });
  await assert.rejects(readReviewSource(root, 'source.ts', '0'.repeat(64), 500), /changed before inspection/);
  const binary = await write('asset.png', Buffer.from('binary-payload-must-not-enter-a-prompt'));
  assert.match((await readReviewSource(root, 'asset.png', binary, 500)).content, /binary artifact omitted/);
  const nullText = await write('opaque.dat', Buffer.from([1, 0, 2]));
  assert.match((await readReviewSource(root, 'opaque.dat', nullText, 500)).content, /binary artifact omitted/);
  const large = await write('large.ts', 'x'.repeat(128 * 1024 + 1));
  assert.deepEqual(await readReviewSource(root, 'large.ts', large, 500), { content: '[large source omitted; use bounded source/diff receipts for review]', truncated: true });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codali-review-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'private.ts'), 'outside');
  await fs.symlink(path.join(outside, 'private.ts'), path.join(root, 'linked.ts'));
  await assert.rejects(readReviewSource(root, 'linked.ts', createHash('sha256').update('outside').digest('hex'), 500), /escapes the workspace/);
});

test('review pages preserve hashes and redact credentials before page boundaries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codali-review-page-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = 'page-boundary-fixture-credential';
  registerSecretValue(secret);
  const text = `${'a'.repeat(7995)}${secret}${'b'.repeat(1000)}end`;
  await fs.writeFile(path.join(root, 'source.txt'), text);
  const hash = createHash('sha256').update(text).digest('hex');
  const first = await readReviewSourcePage(root, 'source.txt', hash, 0);
  assert.equal(first.nextOffset, 8000); assert.equal(first.truncated, true);
  const second = await readReviewSourcePage(root, 'source.txt', hash, first.nextOffset!);
  assert.equal(second.truncated, false); assert.equal(second.nextOffset, undefined);
  assert.equal(first.content + second.content, text.replace(secret, '[redacted]'));
  assert.equal((await readReviewSource(root, 'source.txt', hash, 8000)).content, first.content);
  await assert.rejects(readReviewSourcePage(root, 'source.txt', hash, -1), /Invalid review source offset/);
  await assert.rejects(readReviewSourcePage(root, 'source.txt', hash, 100_000), /exceeds the file length/);
  await fs.writeFile(path.join(root, 'source.txt'), 'changed');
  await assert.rejects(readReviewSourcePage(root, 'source.txt', hash, 8000), /changed before inspection/);
});
