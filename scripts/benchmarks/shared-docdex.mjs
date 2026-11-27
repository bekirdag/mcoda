import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DocdexClient } from '../../packages/codali/dist/docdex/DocdexClient.js';

/** Borrow the system service. This adapter neither launches nor stops Docdex. */
export async function connectBenchmarkDocdex({ workspace, resolved, signal }) {
  const root = await fs.realpath(workspace);
  const client = new DocdexClient({
    baseUrl: resolved.config.docdex?.baseUrl ?? process.env.DOCDEX_HTTP_BASE_URL ?? 'http://127.0.0.1:28491',
    repoRoot: root, authToken: process.env.DOCDEX_AUTH_TOKEN,
    requireMcpSession: true, signal: () => signal, timeoutMs: 15000, localSearchOnly: true,
  });
  const binding = await client.initialize(pathToFileURL(root).href);
  if (!binding.repoId || !binding.repoRoot) throw Error('System Docdex did not return an explicit repository binding');
  if (await fs.realpath(binding.repoRoot) !== root) throw Error('System Docdex bound a different repository');
  await client.waitForIndex(15000);
  return client;
}
