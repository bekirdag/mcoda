import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConsentCommands,
  parseConsentArgs,
} from '../commands/consent/ConsentCommands.js';
import { acceptMswarmConsent } from '../commands/consent/MswarmConsentFlow.js';
import { MswarmApi, MswarmConfigStore } from '@mcoda/core';

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

test(
  'acceptMswarmConsent persists paid consent when the response omits client identifiers',
  { concurrency: false },
  async () => {
    const originalCreate = MswarmApi.create;
    (MswarmApi as any).create = async () =>
      ({
        async issuePaidConsent(policyVersion: string) {
          assert.equal(policyVersion, '2026-03-18');
          return {
            consent_token: 'paid-token-123',
            client_type: 'paid_mcoda_client',
            issued_at_ms: 123,
            upload_signing_secret: 'upload-secret-123',
          };
        },
        async close() {},
      }) as MswarmApi;

    const state = {
      apiKey: 'paid-key',
      deletionRequestedAtMs: 42,
    };
    let savedConsent:
      | Parameters<MswarmConfigStore['saveConsentState']>[0]
      | undefined;
    const store = {
      async readState() {
        return state;
      },
      async saveConsentState(consent: Parameters<MswarmConfigStore['saveConsentState']>[0]) {
        savedConsent = consent;
        return {
          ...state,
          ...consent,
        };
      },
    } as MswarmConfigStore;

    try {
      const nextState = await acceptMswarmConsent({
        state,
        policyVersion: '2026-03-18',
        store,
      });
      assert.equal(savedConsent?.consentAccepted, true);
      assert.equal(savedConsent?.clientId, undefined);
      assert.equal(savedConsent?.clientType, 'paid_mcoda_client');
      assert.equal(savedConsent?.consentToken, 'paid-token-123');
      assert.equal(savedConsent?.registeredAtMs, 123);
      assert.equal(savedConsent?.uploadSigningSecret, 'upload-secret-123');
      assert.equal(savedConsent?.deletionRequestedAtMs, 42);
      assert.equal(nextState.consentAccepted, true);
      assert.equal(nextState.clientId, undefined);
      assert.equal(nextState.clientType, 'paid_mcoda_client');
    } finally {
      (MswarmApi as any).create = originalCreate;
    }
  }
);
