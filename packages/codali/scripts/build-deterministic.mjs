import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('../dist/tools/deterministic/', import.meta.url), { recursive: true });
await build({ entryPoints: [new URL('../config/deterministic/node-worker.mjs', import.meta.url).pathname],
  outfile: new URL('../dist/tools/deterministic/node-worker.cjs', import.meta.url).pathname,
  bundle: true, platform: 'node', format: 'cjs', target: 'node20', minify: true, legalComments: 'eof' });
await copyFile(new URL('../config/deterministic/python-worker.py', import.meta.url), new URL('../dist/tools/deterministic/python-worker.py', import.meta.url));
await mkdir(new URL('../dist/tools/documents/', import.meta.url), { recursive: true });
await copyFile(new URL('../config/documents/worker.py', import.meta.url), new URL('../dist/tools/documents/worker.py', import.meta.url));
