import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CONSENT_NOT_REQUIRED_MESSAGE,
  ConsentCommands,
} from '../commands/consent/ConsentCommands.js';
import { SetupCommand } from '../commands/setup/SetupCommand.js';
import { MswarmConfigStore } from '@mcoda/core';

const captureLogs = async (
  fn: () => Promise<unknown> | unknown
): Promise<string[]> => {
  const logs: string[] = [];
  const originalLog = console.log;
  // @ts-ignore override
  console.log = (...args: any[]) => {
    logs.push(args.join(' '));
  };
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    console.log = originalLog;
  }
  return logs;
};

const withNoNetwork = async (fn: () => Promise<void>): Promise<void> => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: unknown) => {
    throw new Error(`unexpected network call: ${String(input)}`);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test(
  'mcoda consent is a local no-op that reports consent is not required',
  { concurrency: false },
  async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-consent-'));
    const configPath = path.join(tempDir, 'config.json');
    try {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mswarm: {
            baseUrl: 'https://example.invalid/',
            consentAccepted: true,
            consentToken: 'legacy-token',
            uploadSigningSecret: 'legacy-secret',
          },
        }),
        'utf8'
      );
      const store = new MswarmConfigStore(configPath);
      await withNoNetwork(async () => {
        for (const sub of ['accept', 'show', 'revoke', 'request-deletion']) {
          const logs = await captureLogs(() =>
            ConsentCommands.run([sub, '--json'], { store })
          );
          const payload = JSON.parse(logs.join('\n'));
          assert.equal(payload.consentRequired, false);
          assert.equal(payload.message, CONSENT_NOT_REQUIRED_MESSAGE);
        }
      });
      const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
      assert.deepEqual(saved.mswarm, { baseUrl: 'https://example.invalid/' });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

test(
  'mcoda consent reports removed legacy keys in text mode',
  { concurrency: false },
  async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-consent-'));
    const configPath = path.join(tempDir, 'config.json');
    try {
      await fs.writeFile(
        configPath,
        JSON.stringify({ mswarm: { consentToken: 'legacy-token' } }),
        'utf8'
      );
      const store = new MswarmConfigStore(configPath);
      const logs = await captureLogs(() => ConsentCommands.run([], { store }));
      assert.equal(logs[0], CONSENT_NOT_REQUIRED_MESSAGE);
      assert.match(logs.join('\n'), /Removed legacy consent data .*consentToken/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

test(
  'mcoda setup needs no consent, prompt or network',
  { concurrency: false },
  async () => {
    await withNoNetwork(async () => {
      const logs = await captureLogs(() => SetupCommand.run(['--json']));
      const payload = JSON.parse(logs.join('\n'));
      assert.equal(payload.status, 'ready');
      assert.equal(payload.consentRequired, false);
      const textLogs = await captureLogs(() =>
        SetupCommand.run(['--policy-version', '2026-03-18'])
      );
      assert.match(textLogs.join('\n'), /mcoda is ready to use/);
      assert.doesNotMatch(textLogs.join('\n'), /Consent>|Type "accept"/);
    });
  }
);
