// Explicit host setup. The model cannot select an installer, path or pip arguments.
import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(process.env.CODALI_DOCUMENT_PYTHON_ROOT ?? path.join(os.homedir(), '.local/state/codali/tool-runtimes/documents-v1'));
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', shell: false });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`Document setup failed (${code})`)));
});
await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
try { await access(path.join(root, 'pyvenv.cfg')); }
catch { await run('python3', ['-m', 'venv', root]); }
await run(path.join(root, 'bin/python'), ['-m', 'pip', 'install', '--only-binary=:all:', '--disable-pip-version-check', '-r', fileURLToPath(new URL('./requirements.txt', import.meta.url))]);
console.log(`Codali document tools ready: ${root}`);
