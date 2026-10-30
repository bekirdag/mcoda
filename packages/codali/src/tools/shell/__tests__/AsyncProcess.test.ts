import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../AsyncProcess.js';
import type { ToolContext, ToolHandlerResult } from '../../ToolTypes.js';
import os from 'node:os';

const tmpDir = os.tmpdir();

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: tmpDir,
    shellTimeoutMs: 5000,
    shellMaxOutputBytes: 1024,
    ...overrides,
  };
}

test('runProcess truncates output to shellMaxOutputBytes', async () => {
  const maxBytes = 10;
  // Produce more than maxBytes of stdout
  const script = `console.log("x".repeat(100))`;
  const result: ToolHandlerResult = await runProcess(
    process.execPath,
    ['-e', script],
    makeContext({ shellMaxOutputBytes: maxBytes })
  );

  assert.match(result.output, /output truncated/);
  const data = result.data as { stdout?: string; stderr?: string; exitCode?: number };
  assert.equal(data.stdout?.length, maxBytes);
  assert.equal((result.data as { truncated: boolean }).truncated, true);
});

test('runProcess preserves UTF-8 characters split across process writes', async () => {
  let streamed = '';
  const result = await runProcess(process.execPath, ['-e', 'const b=Buffer.from("日本語 🧠"); let i=0; const timer=setInterval(()=>{process.stdout.write(b.subarray(i,i+1)); if(++i===b.length)clearInterval(timer)},5)'],
    makeContext({ onOutput: (_stream, text) => { streamed += text; } }));
  assert.equal(result.output, '日本語 🧠'); assert.equal(streamed, result.output);
});

test('runProcess excludes secret environment variables', async () => {
  const script = `console.log(JSON.stringify({ hasSecret: process.env.SECRET_KEY === undefined, hasPath: typeof process.env.PATH === 'string' }))`;
  // Ensure SECRET_KEY is set in parent env to verify it's excluded
  const originalSecret = process.env.SECRET_KEY;
  try {
    process.env.SECRET_KEY = 'super-secret-value';
    const result: ToolHandlerResult = await runProcess(
      process.execPath,
      ['-e', script],
      makeContext()
    );

    assert.ok(result.data);
    const data = result.data as { stdout?: string; exitCode?: number };
    assert.equal(data.exitCode, 0);
    const parsed = JSON.parse((data.stdout ?? '').trim());
    assert.equal(parsed.hasSecret, true, 'SECRET_KEY should be excluded from child env');
    assert.equal(parsed.hasPath, true, 'PATH should be present in child env');
  } finally {
    if (originalSecret === undefined) {
      delete process.env.SECRET_KEY;
    } else {
      process.env.SECRET_KEY = originalSecret;
    }
  }
});

test('runProcess throws on nonzero exit code', async () => {
  const script = `process.exit(1)`;
  await assert.rejects(
    runProcess(process.execPath, ['-e', script], makeContext()),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
});

test('host environment overrides are limited to private home, temporary directory and tool path', async () => {
  const result = await runProcess(process.execPath, ['-e', 'console.log(JSON.stringify({home:process.env.HOME,tmp:process.env.TMPDIR,path:process.env.PATH,secret:process.env.SECRET_KEY??null}))'], makeContext(), {
    HOME: '/private/fixture/home', TMPDIR: '/private/fixture/tmp', PATH: '/private/fixture/bin',
    ...{ SECRET_KEY: 'must not pass through' },
  });
  assert.deepEqual(JSON.parse(result.output), { home: '/private/fixture/home', tmp: '/private/fixture/tmp', path: '/private/fixture/bin', secret: null });
});

test('runProcess aborts endless child process via signal', async () => {
  const ac = new AbortController();
  // Script that runs indefinitely
  const script = `setInterval(() => {}, 1000)`;
  const context = makeContext({ signal: ac.signal });

  const started = Date.now();
  const promise = runProcess(process.execPath, ['-e', script], context);

  // Abort after a short delay to ensure we don't wait for the full timeout
  const timer = setTimeout(() => {
    ac.abort(new Error('Test abort'));
  }, 100);

  await assert.rejects(
    promise,
    /Test abort/
  );
  clearTimeout(timer);
  assert.ok(Date.now() - started < 3000);
});
