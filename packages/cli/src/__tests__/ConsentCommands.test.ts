import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConsentCommands,
  parseConsentArgs,
} from '../commands/consent/ConsentCommands.js';
import { MswarmConfigStore } from '@mcoda/core';

const captureLogs = async (
  fn: () => Promise<void> | void
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

test('parseConsentArgs parses accept flags', () => {
  const parsed = parseConsentArgs([
    'accept',
    '--policy-version',
    '2026-03-18',
    '--json',
  ]);
  assert.equal(parsed.subcommand, 'accept');
  assert.equal(parsed.policyVersion, '2026-03-18');
  assert.equal(parsed.json, true);
});

test(
  'ConsentCommands show renders persisted state as json',
  { concurrency: false },
  async () => {
    const originalReadState = MswarmConfigStore.prototype.readState;
    (MswarmConfigStore.prototype as any).readState = async () => ({
      baseUrl: 'https://api.mswarm.org/',
      apiKey: 'paid-key',
      consentAccepted: true,
      consentPolicyVersion: '2026-03-18',
      consentToken: 'token-123',
      clientId: 'client-123',
      clientType: 'free_mcoda_client',
      uploadSigningSecret: 'secret-123',
      deletionRequestedAtMs: 42,
    });
    try {
      const logs = await captureLogs(() =>
        ConsentCommands.run(['show', '--json'])
      );
      const payload = JSON.parse(logs.join('\n')) as Record<string, unknown>;
      assert.equal(payload.consentAccepted, true);
      assert.equal(payload.clientId, 'client-123');
      assert.equal(payload.clientType, 'free_mcoda_client');
      assert.equal(payload.apiKeySet, true);
      assert.equal(payload.uploadSigningSecretSet, true);
      assert.equal(payload.deletionRequestedAtMs, 42);
    } finally {
      (MswarmConfigStore.prototype as any).readState = originalReadState;
    }
  }
);
