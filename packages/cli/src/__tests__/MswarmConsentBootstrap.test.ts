import assert from 'node:assert/strict';
import test from 'node:test';
import { MswarmConfigStore } from '@mcoda/core';
import { runMswarmConsentBootstrap } from '../install/MswarmConsentBootstrap.js';

test(
  'runMswarmConsentBootstrap returns already_configured when consent exists',
  { concurrency: false },
  async () => {
    const originalReadState = MswarmConfigStore.prototype.readState;
    (MswarmConfigStore.prototype as any).readState = async () => ({
      consentAccepted: true,
      consentToken: 'token-123',
      clientId: 'client-123',
      clientType: 'free_mcoda_client',
      consentPolicyVersion: '2026-03-18',
    });
    try {
      const result = await runMswarmConsentBootstrap({
        interactive: true,
        logger: () => undefined,
      });
      assert.equal(result.status, 'already_configured');
      assert.equal(result.consentAccepted, true);
      assert.equal(result.consentTokenSet, true);
    } finally {
      (MswarmConfigStore.prototype as any).readState = originalReadState;
    }
  }
);

test(
  'runMswarmConsentBootstrap defers when non-interactive install cannot prompt',
  { concurrency: false },
  async () => {
    const logs: string[] = [];
    const originalReadState = MswarmConfigStore.prototype.readState;
    (MswarmConfigStore.prototype as any).readState = async () => ({
      consentAccepted: false,
      consentToken: undefined,
    });
    try {
      const result = await runMswarmConsentBootstrap({
        interactive: false,
        onDeferred: 'log',
        logger: (line) => logs.push(line),
      });
      assert.equal(result.status, 'deferred');
      assert.match(logs.join('\n'), /mcoda setup/);
    } finally {
      (MswarmConfigStore.prototype as any).readState = originalReadState;
    }
  }
);

test(
  'runMswarmConsentBootstrap accepts consent after interactive confirmation',
  { concurrency: false },
  async () => {
    const originalReadState = MswarmConfigStore.prototype.readState;
    (MswarmConfigStore.prototype as any).readState = async () => ({
      consentAccepted: false,
      consentToken: undefined,
    });
    try {
      const result = await runMswarmConsentBootstrap({
        interactive: true,
        logger: () => undefined,
        termsText: 'terms',
        acceptConsent: async () => ({
          consentAccepted: true,
          consentToken: 'token-123',
          clientId: 'client-123',
          clientType: 'free_mcoda_client',
          consentPolicyVersion: '2026-03-18',
        }),
        prompter: {
          question: async () => 'accept',
          close: () => undefined,
        },
      });
      assert.equal(result.status, 'accepted');
      assert.equal(result.consentAccepted, true);
      assert.equal(result.clientId, 'client-123');
    } finally {
      (MswarmConfigStore.prototype as any).readState = originalReadState;
    }
  }
);

test(
  'runMswarmConsentBootstrap rejects declined consent',
  { concurrency: false },
  async () => {
    const originalReadState = MswarmConfigStore.prototype.readState;
    (MswarmConfigStore.prototype as any).readState = async () => ({
      consentAccepted: false,
      consentToken: undefined,
    });
    try {
      await assert.rejects(
        () =>
          runMswarmConsentBootstrap({
            interactive: true,
            logger: () => undefined,
            termsText: 'terms',
            prompter: {
              question: async () => 'no',
              close: () => undefined,
            },
          }),
        /Telemetry consent was not accepted/
      );
    } finally {
      (MswarmConfigStore.prototype as any).readState = originalReadState;
    }
  }
);
