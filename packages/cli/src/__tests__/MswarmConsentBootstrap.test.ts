import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MswarmConfigStore } from '@mcoda/core';
import { GlobalRepository } from '@mcoda/db';
import { PathHelper } from '@mcoda/shared';
import { runMswarmConsentBootstrap } from '../install/MswarmConsentBootstrap.js';

test(
  'setup registers and persists consent without opening a readonly agent database',
  { concurrency: false },
  async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcoda-consent-'));
    const configPath = path.join(tempDir, 'config.json');
    const requests: { method?: string; url?: string; body: unknown }[] = [];
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        consent_token: 'test-token',
        client_id: 'test-client',
        client_type: 'free_mcoda_client',
        issued_at_ms: 123,
        upload_signing_secret: 'test-secret',
      }));
    });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      await fs.writeFile(configPath, JSON.stringify({
        unrelatedSetting: 'preserve-me',
        mswarm: { baseUrl },
      }));
      t.mock.method(PathHelper, 'getGlobalConfigPath', () => configPath);
      const openRepository = t.mock.method(GlobalRepository, 'create', async () => {
        throw Object.assign(new Error('SQLITE_READONLY: attempt to write a readonly database'), {
          code: 'SQLITE_READONLY',
        });
      });
      const store = new MswarmConfigStore(configPath);
      const result = await runMswarmConsentBootstrap({
        interactive: true,
        store,
        termsText: 'Test terms',
        logger: () => undefined,
        prompter: { question: async () => 'accept', close: () => undefined },
      });
      assert.equal(result.status, 'accepted');
      assert.equal(result.consentAccepted, true);
      assert.equal(result.consentTokenSet, true);
      assert.equal(result.clientId, 'test-client');
      assert.equal(result.clientType, 'free_mcoda_client');
      assert.equal(result.policyVersion, '2026-03-18');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].url, '/v1/swarm/mcoda/free-client/register');
      assert.equal((requests[0].body as Record<string, unknown>).product, 'mcoda');
      const savedConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
      assert.equal(savedConfig.unrelatedSetting, 'preserve-me');
      assert.equal(savedConfig.mswarm.baseUrl, baseUrl);
      assert.equal(savedConfig.mswarm.consentToken, 'test-token');
      assert.equal(savedConfig.mswarm.clientId, 'test-client');
      assert.equal(savedConfig.mswarm.registeredAtMs, 123);
      assert.equal(savedConfig.mswarm.uploadSigningSecret, 'test-secret');
      const repeated = await runMswarmConsentBootstrap({
        store,
        interactive: false,
        logger: () => undefined,
      });
      assert.equal(repeated.status, 'already_configured');
      assert.equal(requests.length, 1);
      assert.equal(openRepository.mock.callCount(), 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

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
