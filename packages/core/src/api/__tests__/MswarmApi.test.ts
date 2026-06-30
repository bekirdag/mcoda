import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GlobalRepository } from '@mcoda/db';
import { CryptoHelper } from '@mcoda/shared';
import { AgentsApi } from '../AgentsApi.js';
import { MswarmApi, signMswarmGenericJobOpsToken, signMswarmGenericJobToken } from '../MswarmApi.js';
import { MswarmConfigStore } from '../MswarmConfigStore.js';

const withTempHome = async (
  fn: (home: string) => Promise<void>
): Promise<void> => {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(
    path.join(os.tmpdir(), 'mcoda-core-mswarm-api-')
  );
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

const withStubServer = async (
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an ephemeral TCP listener');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.close();
    await once(server, 'close');
  }
};

test(
  'MswarmApi.listCloudAgents sends auth and query params',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          assert.equal(req.headers['x-api-key'], 'cloud-key');
          assert.equal(url.pathname, '/v1/swarm/cloud/agents');
          assert.equal(url.searchParams.get('shape'), 'mcoda');
          assert.equal(url.searchParams.get('provider'), 'openrouter');
          assert.equal(url.searchParams.get('limit'), '2');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: [
                {
                  slug: 'openai/gpt-4.1-mini',
                  provider: 'openrouter',
                  default_model: 'openai/gpt-4.1-mini',
                  cost_per_million: 0.9,
                  rating: 8.2,
                  reasoning_rating: 8.5,
                  max_complexity: 8,
                  capabilities: ['code_write', 'plan'],
                  health_status: 'healthy',
                  context_window: 128000,
                  supports_tools: true,
                  pricing_version: '2026-03-17',
                },
              ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'cloud-key' });
          try {
            const agents = await api.listCloudAgents({
              provider: 'openrouter',
              limit: 2,
            });
            assert.equal(agents.length, 1);
            assert.equal(agents[0]?.slug, 'openai/gpt-4.1-mini');
            assert.equal(agents[0]?.supports_tools, true);
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.listCloudAgents applies local advanced filters and catalog sorting',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          assert.equal(req.headers['x-api-key'], 'cloud-key');
          assert.equal(url.pathname, '/v1/swarm/cloud/agents');
          assert.equal(url.searchParams.get('shape'), 'mcoda');
          assert.equal(url.searchParams.get('limit'), null);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: [
                {
                  slug: 'openai/gpt-4.1-mini',
                  provider: 'openrouter',
                  default_model: 'openai/gpt-4.1-mini',
                  cost_per_million: 0.9,
                  rating: 8.2,
                  reasoning_rating: 8.5,
                  max_complexity: 8,
                  capabilities: ['code_write'],
                  context_window: 128000,
                  supports_tools: true,
                },
                {
                  slug: 'anthropic/claude-3.7-sonnet',
                  provider: 'openrouter',
                  default_model: 'anthropic/claude-3.7-sonnet',
                  cost_per_million: 1.1,
                  rating: 9.4,
                  reasoning_rating: 9.2,
                  max_complexity: 9,
                  capabilities: ['code_write', 'plan'],
                  context_window: 200000,
                  supports_tools: true,
                },
                {
                  slug: 'google/gemini-2.5-flash',
                  provider: 'openrouter',
                  default_model: 'google/gemini-2.5-flash',
                  cost_per_million: 1.8,
                  rating: 9.8,
                  reasoning_rating: 9.1,
                  max_complexity: 8,
                  capabilities: ['plan'],
                  context_window: 1000000,
                  supports_tools: true,
                },
                {
                  slug: 'meta/llama-3.3',
                  provider: 'openrouter',
                  default_model: 'meta/llama-3.3',
                  cost_per_million: 0.4,
                  rating: 7.5,
                  reasoning_rating: 7.9,
                  max_complexity: 7,
                  capabilities: ['chat'],
                  context_window: 32768,
                  supports_tools: false,
                },
              ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'cloud-key' });
          try {
            const agents = await api.listCloudAgents({
              maxCostPerMillion: 1.1,
              minContextWindow: 100000,
              minReasoningRating: 8.5,
              sortByCatalogRating: true,
              limit: 2,
            });
            assert.deepEqual(
              agents.map((agent) => agent.slug),
              ['anthropic/claude-3.7-sonnet', 'openai/gpt-4.1-mini']
            );
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.create falls back to the stored encrypted API key',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      const store = new MswarmConfigStore();
      await store.saveApiKey('stored-cloud-key');
      await withStubServer(
        (req, res) => {
          assert.equal(req.headers['x-api-key'], 'stored-cloud-key');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ agents: [] }));
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl });
          try {
            const agents = await api.listCloudAgents();
            assert.deepEqual(agents, []);
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.create respects MCODA_CONFIG for stored API key fallback',
  { concurrency: false },
  async () => {
    await withTempHome(async (home) => {
      const originalConfig = process.env.MCODA_CONFIG;
      process.env.MCODA_CONFIG = path.join(home, 'custom', 'config.json');
      try {
        const store = new MswarmConfigStore();
        await store.saveApiKey('stored-cloud-key');
        await withStubServer(
          (req, res) => {
            assert.equal(req.headers['x-api-key'], 'stored-cloud-key');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ agents: [] }));
          },
          async (baseUrl) => {
            const api = await MswarmApi.create({ baseUrl });
            try {
              const agents = await api.listCloudAgents();
              assert.deepEqual(agents, []);
            } finally {
              await api.close();
            }
          }
        );
      } finally {
        if (originalConfig === undefined) {
          delete process.env.MCODA_CONFIG;
        } else {
          process.env.MCODA_CONFIG = originalConfig;
        }
      }
    });
  }
);

test(
  'MswarmApi.create defaults to the public mswarm gateway',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      const api = await MswarmApi.create({ apiKey: 'cloud-key' });
      try {
        assert.equal(api.baseUrl, 'https://api.mswarm.org/');
      } finally {
        await api.close();
      }
    });
  }
);

test(
  'MswarmApi.getRuntimeIdentity reads tenant product and API key identity',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          assert.equal(req.headers['x-api-key'], 'owner-key');
          assert.equal(req.url, '/v1/swarm/runtime/usage-limits');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              product_slug: 'bdya',
              tenant_id: 'tenant-bdya',
              api_key_id: 'api-key-123',
              subscription_id: 'sub-123',
              budgets: [
                {
                  key: 'runtime.requests',
                  meter_id: 'mswarm.requests',
                  limit: 100,
                  used: 12,
                  remaining: 88,
                  source: 'saas_be',
                },
              ],
              as_of: '2026-05-23T00:00:00.000Z',
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'owner-key' });
          try {
            const identity = await api.getRuntimeIdentity();
            assert.equal(identity.tenantId, 'tenant-bdya');
            assert.equal(identity.productSlug, 'bdya');
            assert.equal(identity.apiKeyId, 'api-key-123');
            assert.equal(identity.usageLimits.budgets[0]?.remaining, 88);
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.listGpuCapabilities signs owner-local capability requests',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          assert.equal(req.method, 'GET');
          assert.equal(req.url, '/v1/swarm/self-hosted/node/capabilities');
          const header = String(req.headers.authorization ?? '');
          assert.match(header, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              generic_jobs_enabled: true,
              job_types: ['cuda.run'],
              accelerators: {
                gpu: {
                  available: true,
                  count: 1,
                  cuda: true,
                  vram_tier: '16-31',
                },
              },
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'owner-key' });
          try {
            const capabilities = await api.listGpuCapabilities({
              nodeBaseUrl: baseUrl,
              nodeId: 'shn_local',
              signingSecret: 'node-secret',
            });
            assert.equal(capabilities.generic_jobs_enabled, true);
            assert.deepEqual(capabilities.job_types, ['cuda.run']);
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi handles generic job artifact upload run and status requests',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      const seen: string[] = [];
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          seen.push(`${req.method} ${url.pathname}`);
          const header = String(req.headers.authorization ?? '');
          assert.match(header, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            if (
              req.method === 'POST' &&
              url.pathname ===
                '/v1/swarm/self-hosted/node/generic-job-control/jobs/job-gpu/artifacts'
            ) {
              const payload = JSON.parse(body) as Record<string, unknown>;
              assert.equal(payload.path, 'inputs/package.tar.gz');
              assert.equal(payload.content_base64, Buffer.from('pkg').toString('base64'));
              res.writeHead(201, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  job_id: 'job-gpu',
                  artifact: {
                    uri: 'artifact://local/job-gpu/inputs/package.tar.gz',
                    name: 'package',
                    size_bytes: 3,
                  },
                })
              );
              return;
            }
            if (
              req.method === 'POST' &&
              url.pathname === '/v1/swarm/self-hosted/node/generic-job-control/jobs'
            ) {
              const payload = JSON.parse(body) as Record<string, any>;
              assert.equal(payload.job_id, 'job-gpu');
              assert.equal(payload.job.job_type, 'cuda.run');
              res.writeHead(202, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  job: { job_id: 'job-gpu', state: 'queued' },
                  events: [],
                  logs: [],
                  artifacts: [],
                  audit: [],
                })
              );
              return;
            }
            if (
              req.method === 'GET' &&
              url.pathname === '/v1/swarm/self-hosted/node/generic-job-control/ops'
            ) {
              assert.equal(url.searchParams.get('audit_limit'), '2');
              assert.equal(url.searchParams.get('audit_offset'), '1');
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  schema_version: '2026-06-14',
                  generated_at: '2026-06-14T00:00:00.000Z',
                  node: {
                    node_id: 'shn_local',
                    owner_local: true,
                    generic_jobs_enabled: true,
                    artifact_store_configured: true,
                    max_concurrent_jobs: 1,
                  },
                  capabilities: { generic_jobs_enabled: true },
                  queue: {
                    jobs: [{ job_id: 'job-gpu', state: 'succeeded' }],
                    totals_by_state: { succeeded: 1 },
                    active_jobs: 0,
                    queued_jobs: 0,
                    terminal_jobs: 1,
                  },
                  quota: {
                    max_concurrent_jobs: 1,
                    active_jobs: 0,
                    queued_jobs: 0,
                    available_slots: 1,
                    production_enforced: false,
                    limits: {},
                  },
                  usage: {
                    total_jobs: 1,
                    active_jobs: 0,
                    terminal_jobs: 1,
                    succeeded_jobs: 1,
                    failed_jobs: 0,
                    cancelled_jobs: 0,
                    blocked_jobs: 0,
                    expired_jobs: 0,
                    gpu_seconds: 0,
                    artifact_count: 0,
                    artifact_bytes: 0,
                    event_count: 0,
                    audit_event_count: 1,
                    stdout_bytes: 0,
                    stderr_bytes: 0,
                    log_bytes: 0,
                  },
                  audit: { total: 1, offset: 1, limit: 2, events: [] },
                })
              );
              return;
            }
            if (
              req.method === 'GET' &&
              url.pathname === '/v1/swarm/self-hosted/node/generic-job-control/jobs/job-gpu'
            ) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  job: { job_id: 'job-gpu', state: 'succeeded' },
                  events: [],
                  logs: [],
                  artifacts: [],
                  audit: [],
                })
              );
              return;
            }
            if (
              req.method === 'POST' &&
              url.pathname === '/v1/swarm/self-hosted/node/generic-job-control/jobs/job-gpu/retry'
            ) {
              res.writeHead(202, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  job: { job_id: 'job-gpu', state: 'queued' },
                  events: [],
                  logs: [],
                  artifacts: [],
                  audit: [],
                })
              );
              return;
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
          });
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'owner-key' });
          const reference = {
            nodeBaseUrl: baseUrl,
            nodeId: 'shn_local',
            jobId: 'job-gpu',
            requestId: 'req-gpu',
            schemaVersion: '2026-06-14',
            jobType: 'cuda.run',
            signingSecret: 'node-secret',
          };
          try {
            const upload = await api.uploadGenericJobArtifact({
              ...reference,
              name: 'package',
              path: 'inputs/package.tar.gz',
              contentBase64: Buffer.from('pkg').toString('base64'),
            });
            assert.equal(upload.artifact.uri, 'artifact://local/job-gpu/inputs/package.tar.gz');

            const run = await api.runGenericJob(
              {
                job_id: 'job-gpu',
                request_id: 'req-gpu',
                node_id: 'shn_local',
                job: {
                  schema_version: '2026-06-14',
                  job_type: 'cuda.run',
                  args: { manifest_path: 'mcoda-job.json', profile: 'nvcc-default', target: 'vector-add' },
                  policy: { trust_mode: 'owner-local', network: 'none', allow_raw_command: false },
                },
              },
              { nodeBaseUrl: baseUrl, signingSecret: 'node-secret' }
            );
            assert.equal(run.job.state, 'queued');

            const status = await api.getGenericJob(reference);
            assert.equal(status.job.state, 'succeeded');
            const ops = await api.getGenericJobOps({
              nodeBaseUrl: baseUrl,
              nodeId: 'shn_local',
              signingSecret: 'node-secret',
              auditLimit: 2,
              auditOffset: 1,
            });
            assert.equal(ops.usage.total_jobs, 1);
            const retry = await api.retryGenericJob(reference);
            assert.equal(retry.job.state, 'queued');
            assert.deepEqual(seen, [
              'POST /v1/swarm/self-hosted/node/generic-job-control/jobs/job-gpu/artifacts',
              'POST /v1/swarm/self-hosted/node/generic-job-control/jobs',
              'GET /v1/swarm/self-hosted/node/generic-job-control/jobs/job-gpu',
              'GET /v1/swarm/self-hosted/node/generic-job-control/ops',
              'POST /v1/swarm/self-hosted/node/generic-job-control/jobs/job-gpu/retry',
            ]);
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test('signMswarmGenericJobToken creates bearer-compatible JWT-like tokens', () => {
  const token = signMswarmGenericJobToken({
    signingSecret: 'node-secret',
    nodeId: 'shn_local',
    jobId: 'job-gpu',
    requestId: 'req-gpu',
    schemaVersion: '2026-06-14',
    jobType: 'cuda.run',
    ttlSeconds: 60,
  });
  assert.match(token, /^[^.]+\.[^.]+\.[^.]+$/);
});

test('signMswarmGenericJobOpsToken creates bearer-compatible JWT-like tokens', () => {
  const token = signMswarmGenericJobOpsToken({
    signingSecret: 'node-secret',
    nodeId: 'shn_local',
    ttlSeconds: 60,
  });
  assert.match(token, /^[^.]+\.[^.]+\.[^.]+$/);
});

test(
  'MswarmApi.registerFreeMcodaClient posts the free-client consent payload',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          assert.equal(req.method, 'POST');
          assert.equal(req.url, '/v1/swarm/mcoda/free-client/register');
          assert.equal(req.headers['x-api-key'], undefined);
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            const payload = JSON.parse(body) as Record<string, unknown>;
            assert.equal(payload.product, 'mcoda');
            assert.equal(payload.product_version, '1.2.3');
            assert.equal(payload.policy_version, '2026-03-18');
            assert.deepEqual(payload.consent_types, [
              'anonymous',
              'non_anonymous',
            ]);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                client_id: 'free-client-123',
                client_type: 'free_mcoda_client',
                consent_token: 'consent-token-123',
                consent_types: ['anonymous', 'non_anonymous'],
                issued_at_ms: 123,
                upload_signing_secret: 'upload-secret-123',
              })
            );
          });
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl });
          try {
            const response = await api.registerFreeMcodaClient({
              clientId: 'free-client-123',
              policyVersion: '2026-03-18',
              productVersion: '1.2.3',
            });
            assert.equal(response.client_id, 'free-client-123');
            assert.equal(response.client_type, 'free_mcoda_client');
            assert.equal(response.consent_token, 'consent-token-123');
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.revokeConsent posts the revoke payload',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          assert.equal(req.method, 'POST');
          assert.equal(req.url, '/v1/swarm/consent/revoke');
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            const payload = JSON.parse(body) as Record<string, unknown>;
            assert.equal(payload.consent_token, 'consent-token-123');
            assert.equal(payload.reason, 'user-request');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ revoked: true, revoked_at_ms: 456 }));
          });
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl });
          try {
            const response = await api.revokeConsent(
              'consent-token-123',
              'user-request'
            );
            assert.equal(response.revoked, true);
            assert.equal(response.revoked_at_ms, 456);
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.requestDataDeletion posts the deletion payload',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          assert.equal(req.method, 'POST');
          assert.equal(req.url, '/v1/swarm/data/deletion-request');
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            const payload = JSON.parse(body) as Record<string, unknown>;
            assert.equal(payload.consent_token, 'consent-token-123');
            assert.equal(payload.product, 'mcoda');
            assert.equal(payload.client_id, 'client-123');
            assert.equal(payload.client_type, 'free_mcoda_client');
            assert.equal(payload.reason, 'privacy');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                accepted: true,
                request_id: 9,
                product: 'mcoda',
                client_id: 'client-123',
                client_type: 'free_mcoda_client',
                status: 'pending',
                requested_at: '2026-03-18T00:00:00Z',
              })
            );
          });
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl });
          try {
            const response = await api.requestDataDeletion({
              consentToken: 'consent-token-123',
              product: 'mcoda',
              clientId: 'client-123',
              clientType: 'free_mcoda_client',
              reason: 'privacy',
            });
            assert.equal(response.accepted, true);
            assert.equal(response.request_id, 9);
            assert.equal(response.status, 'pending');
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.listWorkers returns one worker page and listAllWorkers paginates',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          assert.equal(req.headers['x-api-key'], 'worker-key');
          assert.equal(url.pathname, '/v1/swarm/workers');
          assert.equal(url.searchParams.get('shape'), 'mcoda');
          if (url.searchParams.get('updated_after')) {
            assert.equal(
              url.searchParams.get('updated_after'),
              '2026-05-07T09:00:00.000Z'
            );
            assert.equal(url.searchParams.get('include_disabled'), 'false');
          }
          if (!url.searchParams.get('cursor')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                generated_at: '2026-05-07T09:30:00.000Z',
                total: 2,
                agents: [
                  {
                    slug: 'worker_abc123',
                    remote_slug: 'mswarm/workers/worker_abc123',
                    provider: 'mswarm',
                    adapter: 'mswarm-worker',
                    updated_at: '2026-05-07T09:05:00.000Z',
                    default_model: 'mswarm-worker:worker_abc123',
                    supports_tools: true,
                    capabilities: ['structured_output'],
                    health_status: 'healthy',
                    worker: { installation_id: 'abc-123', name: 'Worker A' },
                  },
                ],
                next_cursor: 'cursor-2',
              })
            );
            return;
          }
          assert.equal(url.searchParams.get('cursor'), 'cursor-2');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              generated_at: '2026-05-07T09:30:01.000Z',
              total: 2,
              agents: [
                {
                  slug: 'worker_def456',
                  remote_slug: 'mswarm/workers/worker_def456',
                  provider: 'mswarm',
                  adapter: 'mswarm-worker',
                  default_model: 'mswarm-worker:worker_def456',
                  supports_tools: true,
                  capabilities: ['chat'],
                  health_status: 'healthy',
                  worker: { installation_id: 'def-456', name: 'Worker B' },
                },
              ],
              next_cursor: null,
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'worker-key' });
          try {
            const page = await api.listWorkers({
              limit: 1,
              includeDisabled: false,
              updatedAfter: '2026-05-07T09:00:00.000Z',
            });
            assert.deepEqual(
              page.workers.map((worker) => worker.slug),
              ['worker_abc123']
            );
            assert.equal(page.next_cursor, 'cursor-2');
            assert.equal(page.total, 2);
            assert.equal(page.generated_at, '2026-05-07T09:30:00.000Z');
            assert.equal(page.workers[0]?.updated_at, '2026-05-07T09:05:00.000Z');

            const workers = await api.listAllWorkers();
            assert.deepEqual(
              workers.map((worker) => worker.slug),
              ['worker_abc123', 'worker_def456']
            );
            assert.equal(workers[0]?.worker?.name, 'Worker A');
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncWorkers materializes managed worker agents and runWorker posts payloads',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          assert.equal(req.headers['x-api-key'], 'worker-key');
          if (req.method === 'GET') {
            assert.equal(url.pathname, '/v1/swarm/workers');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                agents: [
                  {
                    slug: 'worker_abc123',
                    remote_slug: 'mswarm/workers/worker_abc123',
                    provider: 'mswarm',
                    adapter: 'mswarm-worker',
                    default_model: 'mswarm-worker:worker_abc123',
                    model_id: 'mswarm-worker:worker_abc123',
                    supports_tools: true,
                    supports_reasoning: false,
                    capabilities: ['structured_output'],
                    health_status: 'healthy',
                    rating: 8.5,
                    worker: {
                      installation_id: 'abc-123',
                      name: 'Client intake worker',
                    },
                  },
                ],
                next_cursor: null,
              })
            );
            return;
          }
          assert.equal(req.method, 'POST');
          assert.equal(url.pathname, '/v1/swarm/workers/worker_abc123/run');
          assert.equal(req.headers['idempotency-key'], 'idem-1');
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            assert.deepEqual(JSON.parse(body), { text: 'hello worker' });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ result: { output: '{"ok":true}' } }));
          });
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'worker-key' });
          try {
            const summary = await api.syncWorkers();
            assert.equal(summary.created, 1);
            assert.equal(summary.agents[0]?.localSlug, 'mswarm-worker-abc123');

            const repo = await GlobalRepository.create();
            try {
              const worker = await repo.getAgentBySlug('mswarm-worker-abc123');
              assert.equal(worker?.adapter, 'mswarm-worker');
              assert.equal(worker?.defaultModel, 'mswarm-worker:worker_abc123');
              assert.equal(
                (worker?.config as any)?.mswarmWorker?.remoteSlug,
                'mswarm/workers/worker_abc123'
              );
              const secret = worker
                ? await repo.getAgentAuthSecret(worker.id)
                : undefined;
              assert.equal(
                secret?.encryptedSecret
                  ? await CryptoHelper.decryptSecret(secret.encryptedSecret)
                  : undefined,
                'worker-key'
              );
            } finally {
              await repo.close();
            }

            const result = await api.runWorker(
              'worker_abc123',
              { text: 'hello worker' },
              { idempotencyKey: 'idem-1' }
            );
            assert.deepEqual(result, { result: { output: '{"ok":true}' } });
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncWorkers rejects pruneMissing with partial worker catalog filters',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      const api = await MswarmApi.create({
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'worker-key',
      });
      try {
        await assert.rejects(
          () => api.syncWorkers({ pruneMissing: true, limit: 1 }),
          /partial worker catalog filters/
        );
        await assert.rejects(
          () =>
            api.syncWorkers({
              pruneMissing: true,
              updatedAfter: '2026-05-07T09:00:00.000Z',
            }),
          /partial worker catalog filters/
        );
        await assert.rejects(
          () => api.syncWorkers({ pruneMissing: true, includeDisabled: false }),
          /partial worker catalog filters/
        );
      } finally {
        await api.close();
      }
    });
  }
);

test(
  'MswarmApi.listSelfHostedAgents sends auth and maps mcoda metadata',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          assert.equal(req.headers['x-api-key'], 'self-hosted-key');
          assert.equal(req.headers['x-mswarm-client-identity'], 'heka');
          assert.equal(req.headers['x-mswarm-client'], 'heka');
          assert.equal(url.pathname, '/v1/swarm/self-hosted/agents');
          assert.equal(url.searchParams.get('shape'), 'mcoda');
          assert.equal(url.searchParams.get('provider'), 'mcoda');
          assert.equal(url.searchParams.get('limit'), '3');
          assert.equal(url.searchParams.get('include_unreachable'), 'true');
          assert.equal(url.searchParams.get('client_identity'), 'heka');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: [
                {
                  slug: 'mcoda-lab-claude-sonnet',
                  agent_slug: 'mcoda-lab-claude-sonnet',
                  remote_slug: 'mcoda/lab/claude-sonnet',
                  provider: 'mcoda',
                  adapter: 'claude-cli',
                  source_agent_slug: 'claude-sonnet',
                  default_model: 'mcoda-lab-claude-sonnet',
                  cost_per_million: 0,
                  rating: 7.5,
                  reasoning_rating: 8,
                  max_complexity: 7,
                  capabilities: ['chat', 'code_write'],
                  health_status: 'healthy',
                  client_identity: 'heka',
                  client_allowlist: [
                    {
                      kind: 'domain',
                      value: 'heka',
                      added_at: '2026-06-30T10:00:00.000Z',
                    },
                  ],
                  client_allowlist_count: 1,
                  relay: {
                    gateway_base_url: 'https://gateway.example',
                    jobs_poll_path: '/v1/swarm/self-hosted/node/jobs/poll',
                    jobs_start_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/start',
                    jobs_events_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/events',
                    jobs_result_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/result',
                  },
                  context_window: 200000,
                  supports_tools: true,
                  best_usage: 'code_write',
                  model_id: 'sonnet',
                  display_name: 'Claude Sonnet on lab',
                  supports_reasoning: true,
                  sync: {
                    source: 'self_hosted',
                    node_id: 'shn_lab',
                    server_name: 'lab',
                    remote_slug: 'mcoda/lab/claude-sonnet',
                  },
                },
              ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({
            baseUrl,
            apiKey: 'self-hosted-key',
            clientIdentity: 'heka',
          });
          try {
            const agents = await api.listSelfHostedAgents({
              provider: 'mcoda',
              limit: 3,
              includeUnreachable: true,
            });
            assert.equal(agents.length, 1);
            assert.equal(agents[0]?.slug, 'mcoda-lab-claude-sonnet');
            assert.equal(agents[0]?.remote_slug, 'mcoda/lab/claude-sonnet');
            assert.equal(agents[0]?.adapter, 'claude-cli');
            assert.equal(agents[0]?.source_agent_slug, 'claude-sonnet');
            assert.equal(agents[0]?.client_identity, 'heka');
            assert.equal(agents[0]?.client_allowlist?.[0]?.kind, 'domain');
            assert.equal(agents[0]?.client_allowlist?.[0]?.value, 'heka');
            assert.equal(agents[0]?.client_allowlist_count, 1);
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.listSelfHostedAgents and getSelfHostedAgent opt into load-balanced aliases',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          assert.equal(req.headers['x-api-key'], 'self-hosted-key');
          assert.equal(url.searchParams.get('include_load_balanced'), 'true');
          if (url.pathname === '/v1/swarm/self-hosted/agents') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                agents: [
                  {
                    slug: 'mcoda-auto-claude-sonnet',
                    agent_slug: 'mcoda-auto-claude-sonnet',
                    remote_slug: 'mcoda/load-balanced/claude-sonnet',
                    provider: 'mcoda',
                    adapter: 'claude-cli',
                    default_model: 'mcoda-auto-claude-sonnet',
                    capabilities: ['chat', 'code_write'],
                    health_status: 'healthy',
                    supports_tools: true,
                    load_balanced: true,
                    load_balanced_group_id: 'lb_group_123',
                    selector_fingerprint: 'selector-123',
                    member_count: 2,
                    candidate_node_ids: ['shn_lab', 'shn_backup'],
                    canonical_agent_slug: 'claude-sonnet',
                    canonical_model_id: 'sonnet',
                    execution_class: 'agentic',
                    policy_class: 'standard',
                    context_tier: 'gte-128k',
                  },
                ],
              })
            );
            return;
          }
          assert.equal(
            url.pathname,
            '/v1/swarm/self-hosted/agents/mcoda-auto-claude-sonnet'
          );
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              slug: 'mcoda-auto-claude-sonnet',
              provider: 'mcoda',
              default_model: 'mcoda-auto-claude-sonnet',
              capabilities: ['chat'],
              supports_tools: true,
              load_balanced: true,
              load_balanced_group_id: 'lb_group_123',
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({
            baseUrl,
            apiKey: 'self-hosted-key',
          });
          try {
            const agents = await api.listSelfHostedAgents({
              includeLoadBalanced: true,
            });
            assert.equal(agents.length, 1);
            assert.equal(agents[0]?.load_balanced, true);
            assert.equal(agents[0]?.load_balanced_group_id, 'lb_group_123');
            assert.deepEqual(agents[0]?.candidate_node_ids, [
              'shn_lab',
              'shn_backup',
            ]);
            const detail = await api.getSelfHostedAgent(
              'mcoda-auto-claude-sonnet',
              { includeLoadBalanced: true }
            );
            assert.equal(detail.load_balanced, true);
            assert.equal(detail.load_balanced_group_id, 'lb_group_123');
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.refreshManagedAgentAuth updates synced managed agents only',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      const repo = await GlobalRepository.create();
      try {
        const managed = await repo.createAgent({
          slug: 'mswarm-cloud-openai-gpt-4-1-mini',
          adapter: 'openai-api',
          defaultModel: 'openai/gpt-4.1-mini',
          openaiCompatible: true,
          config: {
            baseUrl: 'https://mswarm.example/v1/swarm/openai/',
            apiBaseUrl: 'https://mswarm.example/v1/swarm/openai/',
            mswarmCloud: {
              managed: true,
              remoteSlug: 'openai/gpt-4.1-mini',
              provider: 'openrouter',
              catalogBaseUrl: 'https://api.mswarm.org/',
              openAiBaseUrl: 'https://mswarm.example/v1/swarm/openai/',
              syncedAt: new Date().toISOString(),
            },
          },
        });
        const selfHosted = await repo.createAgent({
          slug: 'mswarm-self-hosted-mcoda-lab-claude-sonnet',
          adapter: 'openai-api',
          defaultModel: 'mcoda-lab-claude-sonnet',
          openaiCompatible: true,
          config: {
            baseUrl: 'https://mswarm.example/v1/swarm/self-hosted/openai/',
            apiBaseUrl: 'https://mswarm.example/v1/swarm/self-hosted/openai/',
            mswarmSelfHosted: {
              managed: true,
              remoteSlug: 'mcoda/lab/claude-sonnet',
              agentSlug: 'mcoda-lab-claude-sonnet',
              provider: 'mcoda',
              catalogBaseUrl: 'https://api.mswarm.org/',
              openAiBaseUrl: 'https://mswarm.example/v1/swarm/self-hosted/openai/',
              syncedAt: new Date().toISOString(),
            },
          },
        });
        const unmanaged = await repo.createAgent({
          slug: 'local-openai',
          adapter: 'openai-api',
          defaultModel: 'gpt-4o',
          openaiCompatible: true,
        });
        await repo.setAgentAuth(
          managed.id,
          await CryptoHelper.encryptSecret('old-managed-key')
        );
        await repo.setAgentAuth(
          selfHosted.id,
          await CryptoHelper.encryptSecret('old-self-hosted-key')
        );
        await repo.setAgentAuth(
          unmanaged.id,
          await CryptoHelper.encryptSecret('local-key')
        );
      } finally {
        await repo.close();
      }

      const summary = await MswarmApi.refreshManagedAgentAuth('fresh-cloud-key');
      assert.equal(summary.updated, 2);
      assert.deepEqual(summary.agents.sort(), [
        'mswarm-cloud-openai-gpt-4-1-mini',
        'mswarm-self-hosted-mcoda-lab-claude-sonnet',
      ]);

      const repoAfter = await GlobalRepository.create();
      try {
        const managed = await repoAfter.getAgentBySlug(
          'mswarm-cloud-openai-gpt-4-1-mini'
        );
        const managedSecret = managed
          ? await repoAfter.getAgentAuthSecret(managed.id)
          : undefined;
        assert.equal(
          managedSecret?.encryptedSecret
            ? await CryptoHelper.decryptSecret(managedSecret.encryptedSecret)
            : undefined,
          'fresh-cloud-key'
        );

        const selfHosted = await repoAfter.getAgentBySlug(
          'mswarm-self-hosted-mcoda-lab-claude-sonnet'
        );
        const selfHostedSecret = selfHosted
          ? await repoAfter.getAgentAuthSecret(selfHosted.id)
          : undefined;
        assert.equal(
          selfHostedSecret?.encryptedSecret
            ? await CryptoHelper.decryptSecret(selfHostedSecret.encryptedSecret)
            : undefined,
          'fresh-cloud-key'
        );

        const unmanaged = await repoAfter.getAgentBySlug('local-openai');
        const unmanagedSecret = unmanaged
          ? await repoAfter.getAgentAuthSecret(unmanaged.id)
          : undefined;
        assert.equal(
          unmanagedSecret?.encryptedSecret
            ? await CryptoHelper.decryptSecret(unmanagedSecret.encryptedSecret)
            : undefined,
          'local-key'
        );
      } finally {
        await repoAfter.close();
      }
    });
  }
);

test(
  'MswarmApi.syncCloudAgents materializes managed cloud agents into the registry',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/v1/swarm/cloud/agents') {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: [
                {
                  slug: 'openai/gpt-4.1-mini',
                  provider: 'openrouter',
                  default_model: 'openai/gpt-4.1-mini',
                  cost_per_million: 0.9,
                  rating: 8.2,
                  reasoning_rating: 8.5,
                  max_complexity: 8,
                  capabilities: ['code_write', 'plan'],
                  health_status: 'healthy',
                  context_window: 128000,
                  supports_tools: true,
                  model_id: 'openai/gpt-4.1-mini',
                  display_name: 'GPT-4.1 mini',
                  description: 'Fast cloud model',
                  supports_reasoning: true,
                  pricing_snapshot_id: 'snap-1',
                  pricing_version: '2026-03-17',
                  sync: { source: 'openrouter.models' },
                },
              ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'cloud-key' });
          try {
            const summary = await api.syncCloudAgents();
            assert.equal(summary.created, 1);
            assert.equal(summary.updated, 0);
            assert.equal(
              summary.agents[0]?.localSlug,
              'mswarm-cloud-openai-gpt-4-1-mini'
            );

            const repo = await GlobalRepository.create();
            try {
              const agent = await repo.getAgentBySlug(
                'mswarm-cloud-openai-gpt-4-1-mini'
              );
              assert.ok(agent);
              assert.equal(agent.adapter, 'openai-api');
              assert.equal(agent.defaultModel, 'openai/gpt-4.1-mini');
              assert.equal(agent.openaiCompatible, true);
              assert.equal(agent.contextWindow, 128000);
              assert.equal(agent.maxOutputTokens, 2048);
              assert.equal(agent.supportsTools, true);
              assert.equal(agent.costPerMillion, 0.9);
              assert.equal(agent.rating, 8.2);
              assert.equal(agent.reasoningRating, 8.5);
              assert.equal(agent.bestUsage, 'code_write');
              assert.equal(agent.maxComplexity, 8);
              assert.equal(agent.ratingSamples, 0);
              assert.equal(agent.ratingLastScore, 8.2);
              assert.ok(agent.ratingUpdatedAt);
              assert.equal(agent.complexitySamples, 0);
              assert.ok(agent.complexityUpdatedAt);
              assert.equal(
                (agent.config as any)?.baseUrl,
                new URL('/v1/swarm/openai/', baseUrl).toString()
              );
              assert.equal((agent.config as any)?.mswarmCloud?.managed, true);
              assert.equal(
                (agent.config as any)?.mswarmCloud?.remoteSlug,
                'openai/gpt-4.1-mini'
              );
              assert.equal(
                (agent.config as any)?.mswarmCloud?.pricingVersion,
                '2026-03-17'
              );

              const auth = await repo.getAgentAuthMetadata(agent.id);
              assert.equal(auth.configured, true);

              const capabilities = await repo.getAgentCapabilities(agent.id);
              assert.deepEqual(capabilities, ['code_write', 'plan']);

              const models = await repo.getAgentModels(agent.id);
              assert.equal(models.length, 1);
              assert.equal(models[0]?.modelName, 'openai/gpt-4.1-mini');

              const health = await repo.getAgentHealth(agent.id);
              assert.equal(health?.status, 'healthy');
              assert.equal((health?.details as any)?.source, 'mswarm');
            } finally {
              await repo.close();
            }
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncSelfHostedAgents materializes managed self-hosted agents into the registry',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/v1/swarm/self-hosted/agents') {
            res.writeHead(404);
            res.end();
            return;
          }
          assert.equal(req.headers['x-api-key'], 'self-hosted-key');
          assert.equal(req.headers['x-mswarm-client-identity'], 'heka');
          assert.equal(url.searchParams.get('client_identity'), 'heka');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: [
                {
                  slug: 'mcoda-lab-claude-sonnet',
                  agent_slug: 'mcoda-lab-claude-sonnet',
                  remote_slug: 'mcoda/lab/claude-sonnet',
                  provider: 'mcoda',
                  adapter: 'claude-cli',
                  source_agent_slug: 'claude-sonnet',
                  default_model: 'mcoda-lab-claude-sonnet',
                  cost_per_million: 0,
                  rating: 7.5,
                  reasoning_rating: 8,
                  max_complexity: 7,
                  capabilities: ['chat', 'code_write'],
                  health_status: 'healthy',
                  client_identity: 'heka',
                  client_allowlist: [
                    { kind: 'domain', value: 'heka' },
                    { kind: 'uuid', value: 'tenant-heka-uuid' },
                  ],
                  client_allowlist_count: 2,
                  relay: {
                    gateway_base_url: 'https://gateway.example',
                    jobs_poll_path: '/v1/swarm/self-hosted/node/jobs/poll',
                    jobs_start_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/start',
                    jobs_events_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/events',
                    jobs_result_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/result',
                  },
                  context_window: 200000,
                  max_output_tokens: 64000,
                  supports_tools: true,
                  best_usage: 'code_write',
                  model_id: 'sonnet',
                  display_name: 'Claude Sonnet on lab',
                  description: 'Self-hosted mcoda local agent',
                  supports_reasoning: true,
                  sync: {
                    source: 'self_hosted',
                    node_id: 'shn_lab',
                    server_name: 'lab',
                    remote_slug: 'mcoda/lab/claude-sonnet',
                    relay_mode: 'direct',
                  },
                },
              ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({
            baseUrl,
            apiKey: 'self-hosted-key',
            clientIdentity: 'heka',
          });
          try {
            const summary = await api.syncSelfHostedAgents();
            assert.equal(summary.created, 1);
            assert.equal(summary.updated, 0);
            assert.equal(
                summary.agents[0]?.localSlug,
                'mswarm-self-hosted-mcoda-lab-claude-sonnet'
              );
              assert.equal(summary.agents[0]?.clientIdentity, 'heka');

              const repo = await GlobalRepository.create();
            try {
              const agent = await repo.getAgentBySlug(
                'mswarm-self-hosted-mcoda-lab-claude-sonnet'
              );
              assert.ok(agent);
              assert.equal(agent.adapter, 'openai-api');
              assert.equal(agent.defaultModel, 'mcoda-lab-claude-sonnet');
              assert.equal(agent.openaiCompatible, true);
              assert.equal(agent.contextWindow, 200000);
              assert.equal(agent.maxOutputTokens, 64000);
              assert.equal(agent.supportsTools, true);
              assert.equal(agent.costPerMillion, 0);
              assert.equal(agent.rating, 7.5);
              assert.equal(agent.reasoningRating, 8);
              assert.equal(agent.bestUsage, 'code_write');
              assert.equal(
                (agent.config as any)?.baseUrl,
                new URL('/v1/swarm/self-hosted/openai/', baseUrl).toString()
              );
              assert.equal(
                (agent.config as any)?.mswarmSelfHosted?.managed,
                true
              );
              assert.equal(
                (agent.config as any)?.mswarmSelfHosted?.remoteSlug,
                'mcoda/lab/claude-sonnet'
              );
              assert.equal(
                (agent.config as any)?.mswarmSelfHosted?.sourceAgentSlug,
                'claude-sonnet'
              );
              assert.equal(
                (agent.config as any)?.mswarmSelfHosted?.nodeId,
                'shn_lab'
              );
              assert.equal(
                (agent.config as any)?.mswarmSelfHosted?.clientIdentity,
                'heka'
              );
              assert.equal(
                (agent.config as any)?.mswarmSelfHosted?.clientAllowlistCount,
                2
              );
              assert.deepEqual(
                (agent.config as any)?.mswarmSelfHosted?.clientAllowlist?.map(
                  (entry: any) => `${entry.kind}:${entry.value}`
                ),
                ['domain:heka', 'uuid:tenant-heka-uuid']
              );

              const auth = await repo.getAgentAuthMetadata(agent.id);
              assert.equal(auth.configured, true);

              const capabilities = await repo.getAgentCapabilities(agent.id);
              assert.deepEqual(capabilities, ['chat', 'code_write']);

              const health = await repo.getAgentHealth(agent.id);
              assert.equal(health?.status, 'healthy');
              assert.equal((health?.details as any)?.source, 'mswarm_self_hosted');
            } finally {
              await repo.close();
            }
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncSelfHostedAgents marks lifecycle-incompatible agents degraded',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/v1/swarm/self-hosted/agents') {
            res.writeHead(404);
            res.end();
            return;
          }
          assert.equal(req.headers['x-api-key'], 'self-hosted-key');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: [
                {
                  slug: 'mcoda-lab-qwen',
                  agent_slug: 'mcoda-lab-qwen',
                  remote_slug: 'mcoda/lab/qwen',
                  provider: 'mcoda',
                  adapter: 'ollama-cli',
                  source_agent_slug: 'qwen3.6-llama.cpp',
                  default_model: 'mcoda-lab-qwen',
                  capabilities: ['chat', 'code_write'],
                  health_status: 'healthy',
                  runtime_package_version: '0.1.80',
                  relay: {
                    gateway_base_url: 'https://gateway.example',
                    jobs_poll_path: '/v1/swarm/self-hosted/node/jobs/poll',
                    jobs_events_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/events',
                    jobs_result_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/result',
                  },
                  supports_tools: true,
                  sync: {
                    source: 'self_hosted',
                    node_id: 'shn_lab',
                    server_name: 'lab',
                    remote_slug: 'mcoda/lab/qwen',
                    relay_mode: 'outbound',
                  },
                },
              ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({
            baseUrl,
            apiKey: 'self-hosted-key',
          });
          try {
            const summary = await api.syncSelfHostedAgents();
            assert.equal(summary.created, 1);

            const repo = await GlobalRepository.create();
            try {
              const agent = await repo.getAgentBySlug(
                'mswarm-self-hosted-mcoda-lab-qwen'
              );
              assert.ok(agent);
              const health = await repo.getAgentHealth(agent.id);
              assert.equal(health?.status, 'degraded');
              assert.equal(
                (health?.details as any)?.reason,
                'self_hosted_protocol_mismatch'
              );
              assert.equal(
                (health?.details as any)?.missingRoute,
                'POST /v1/swarm/self-hosted/node/jobs/:jobId/start'
              );
              assert.equal(
                (health?.details as any)?.gatewayBaseUrl,
                'https://gateway.example'
              );
              assert.equal(
                (agent.config as any)?.mswarmSelfHosted?.lifecycle?.compatible,
                false
              );
            } finally {
              await repo.close();
            }

            const agentsApi = await AgentsApi.create();
            try {
              const agents = await agentsApi.listAgents({ refreshHealth: true });
              const listed = agents.find(
                (agent) => agent.slug === 'mswarm-self-hosted-mcoda-lab-qwen'
              );
              assert.equal(listed?.health?.status, 'degraded');
              assert.equal(
                (listed?.health?.details as any)?.health_reason,
                'self_hosted_protocol_mismatch'
              );
            } finally {
              await agentsApi.close();
            }
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncSelfHostedAgents keeps direct agents stable and sanitizes auto-routed aliases',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/v1/swarm/self-hosted/agents') {
            res.writeHead(404);
            res.end();
            return;
          }
          assert.equal(req.headers['x-api-key'], 'self-hosted-key');
          const includeLoadBalanced =
            url.searchParams.get('include_load_balanced') === 'true';
          const directAgent = {
            slug: 'mcoda-lab-claude-sonnet',
            agent_slug: 'mcoda-lab-claude-sonnet',
            remote_slug: 'mcoda/lab/claude-sonnet',
            provider: 'mcoda',
            adapter: 'claude-cli',
            source_agent_slug: 'claude-sonnet',
            default_model: 'mcoda-lab-claude-sonnet',
            capabilities: ['chat', 'code_write'],
            health_status: 'healthy',
            relay: {
              gateway_base_url: 'https://gateway.example',
              jobs_poll_path: '/v1/swarm/self-hosted/node/jobs/poll',
              jobs_start_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/start',
              jobs_events_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/events',
              jobs_result_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/result',
            },
            supports_tools: true,
            sync: {
              source: 'self_hosted',
              node_id: 'shn_lab',
              server_name: 'lab',
              remote_slug: 'mcoda/lab/claude-sonnet',
              relay_mode: 'direct',
            },
          };
          const autoAgent = {
            slug: 'mcoda-auto-claude-sonnet',
            agent_slug: 'mcoda-auto-claude-sonnet',
            remote_slug: 'mcoda/load-balanced/claude-sonnet',
            provider: 'mcoda',
            adapter: 'claude-cli',
            source_agent_slug: 'claude-sonnet',
            default_model: 'mcoda-auto-claude-sonnet',
            capabilities: ['chat', 'code_write'],
            health_status: 'healthy',
            relay: {
              gateway_base_url: 'https://gateway.example',
              jobs_poll_path: '/v1/swarm/self-hosted/node/jobs/poll',
              jobs_start_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/start',
              jobs_events_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/events',
              jobs_result_path_template: '/v1/swarm/self-hosted/node/jobs/:jobId/result',
            },
            supports_tools: true,
            load_balanced: true,
            load_balanced_group_id: 'lb_group_123',
            selector_fingerprint: 'selector-123',
            member_count: 2,
            candidate_node_ids: ['shn_lab', 'shn_backup'],
            sync: {
              source: 'self_hosted',
              node_id: 'lb_group_123',
              node_ids: ['shn_lab', 'shn_backup'],
              server_name: 'load-balanced',
              remote_slug: 'mcoda/load-balanced/claude-sonnet',
              relay_mode: 'outbound',
              load_balanced: true,
              group_id: 'lb_group_123',
              member_count: 2,
              token: 'bad-token',
              api_key: 'bad-api-key',
              invocation_signing_secret: 'bad-signing-secret',
              direct_url: 'http://127.0.0.1:18488/',
            },
          };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: includeLoadBalanced
                ? [directAgent, autoAgent]
                : [directAgent],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({
            baseUrl,
            apiKey: 'self-hosted-key',
          });
          try {
            const first = await api.syncSelfHostedAgents();
            assert.equal(first.created, 1);
            assert.equal(
              first.agents[0]?.localSlug,
              'mswarm-self-hosted-mcoda-lab-claude-sonnet'
            );

            const second = await api.syncSelfHostedAgents({
              includeLoadBalanced: true,
              pruneMissing: true,
            });
            assert.equal(second.created, 1);
            assert.equal(second.updated, 1);
            assert.equal(second.deleted, 0);
            assert.ok(
              second.agents.some(
                (record) =>
                  record.localSlug ===
                    'mswarm-self-hosted-mcoda-lab-claude-sonnet' &&
                  record.routingMode === 'direct'
              )
            );
            assert.ok(
              second.agents.some(
                (record) =>
                  record.localSlug ===
                    'mswarm-self-hosted-auto-mcoda-load-balanced-claude-sonnet' &&
                  record.routingMode === 'auto' &&
                  record.loadBalanced === true
              )
            );

            const repo = await GlobalRepository.create();
            try {
              const direct = await repo.getAgentBySlug(
                'mswarm-self-hosted-mcoda-lab-claude-sonnet'
              );
              const auto = await repo.getAgentBySlug(
                'mswarm-self-hosted-auto-mcoda-load-balanced-claude-sonnet'
              );
              assert.ok(direct);
              assert.ok(auto);
              assert.equal(
                (direct.config as any)?.mswarmSelfHosted?.nodeId,
                'shn_lab'
              );
              const autoConfig = (auto.config as any)?.mswarmSelfHosted;
              assert.equal(autoConfig?.routingMode, 'auto');
              assert.equal(autoConfig?.loadBalanced, true);
              assert.equal(autoConfig?.loadBalancedGroupId, 'lb_group_123');
              assert.equal(autoConfig?.nodeId, undefined);
              assert.equal(autoConfig?.serverName, undefined);
              assert.equal(autoConfig?.sync?.group_id, 'lb_group_123');
              assert.equal(autoConfig?.sync?.node_id, undefined);
              assert.equal(autoConfig?.sync?.node_ids, undefined);
              const serializedConfig = JSON.stringify(auto.config);
              assert.doesNotMatch(serializedConfig, /self-hosted-key/);
              assert.doesNotMatch(serializedConfig, /bad-token/);
              assert.doesNotMatch(serializedConfig, /bad-api-key/);
              assert.doesNotMatch(serializedConfig, /bad-signing-secret/);
              assert.doesNotMatch(serializedConfig, /127\.0\.0\.1:18488/);
              assert.doesNotMatch(serializedConfig, /candidate_node_ids/);
              assert.doesNotMatch(serializedConfig, /node_ids/);

              const auth = await repo.getAgentAuthMetadata(auto.id);
              assert.equal(auth.configured, true);
            } finally {
              await repo.close();
            }
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncCloudAgents preserves locally probed health on resync',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/v1/swarm/cloud/agents') {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: [
                {
                  slug: 'openai/gpt-4.1-mini',
                  provider: 'openrouter',
                  default_model: 'openai/gpt-4.1-mini',
                  capabilities: ['code_write'],
                  supports_tools: true,
                  health_status: 'degraded',
                },
              ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'cloud-key' });
          try {
            await api.syncCloudAgents();
            const repo = await GlobalRepository.create();
            try {
              const agent = await repo.getAgentBySlug(
                'mswarm-cloud-openai-gpt-4-1-mini'
              );
              assert.ok(agent);
              await repo.setAgentHealth({
                agentId: agent.id,
                status: 'healthy',
                lastCheckedAt: new Date().toISOString(),
                details: { source: 'openai_probe' },
              });
            } finally {
              await repo.close();
            }

            await api.syncCloudAgents();

            const repoAfter = await GlobalRepository.create();
            try {
              const agent = await repoAfter.getAgentBySlug(
                'mswarm-cloud-openai-gpt-4-1-mini'
              );
              assert.ok(agent);
              const health = await repoAfter.getAgentHealth(agent.id);
              assert.equal(health?.status, 'healthy');
              assert.equal((health?.details as any)?.source, 'openai_probe');
            } finally {
              await repoAfter.close();
            }
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncCloudAgents preserves local rating metadata on resync',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      let catalogVersion = 1;
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/v1/swarm/cloud/agents') {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: [
                catalogVersion === 1
                  ? {
                      slug: 'openai/gpt-4.1-mini',
                      provider: 'openrouter',
                      default_model: 'openai/gpt-4.1-mini',
                      cost_per_million: 0.9,
                      rating: 8.2,
                      reasoning_rating: 8.5,
                      max_complexity: 8,
                      capabilities: ['code_write', 'plan'],
                      context_window: 128000,
                      supports_tools: true,
                    }
                  : {
                      slug: 'openai/gpt-4.1-mini',
                      provider: 'openrouter',
                      default_model: 'openai/gpt-4.1-mini',
                      cost_per_million: 1.3,
                      rating: 4.1,
                      reasoning_rating: 4.4,
                      max_complexity: 3,
                      capabilities: ['code_write', 'plan'],
                      context_window: 256000,
                      supports_tools: true,
                      mcoda_shape: {
                        maxOutputTokens: 16384,
                      },
                    },
              ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'cloud-key' });
          try {
            await api.syncCloudAgents();

            const repo = await GlobalRepository.create();
            try {
              const agent = await repo.getAgentBySlug(
                'mswarm-cloud-openai-gpt-4-1-mini'
              );
              assert.ok(agent);
              await repo.updateAgent(agent.id, {
                rating: 9.6,
                reasoningRating: 9.4,
                bestUsage: 'system_architecture',
                maxComplexity: 10,
                ratingSamples: 7,
                ratingLastScore: 9.9,
                ratingUpdatedAt: '2026-03-18T09:15:00.000Z',
                complexitySamples: 4,
                complexityUpdatedAt: '2026-03-18T09:20:00.000Z',
              });
            } finally {
              await repo.close();
            }

            catalogVersion = 2;
            const summary = await api.syncCloudAgents();
            assert.equal(summary.created, 0);
            assert.equal(summary.updated, 1);

            const repoAfter = await GlobalRepository.create();
            try {
              const agent = await repoAfter.getAgentBySlug(
                'mswarm-cloud-openai-gpt-4-1-mini'
              );
              assert.ok(agent);
              assert.equal(agent.contextWindow, 256000);
              assert.equal(agent.maxOutputTokens, 16384);
              assert.equal(agent.costPerMillion, 1.3);
              assert.equal(agent.rating, 9.6);
              assert.equal(agent.reasoningRating, 9.4);
              assert.equal(agent.bestUsage, 'system_architecture');
              assert.equal(agent.maxComplexity, 10);
              assert.equal(agent.ratingSamples, 7);
              assert.equal(agent.ratingLastScore, 9.9);
              assert.equal(agent.ratingUpdatedAt, '2026-03-18T09:15:00.000Z');
              assert.equal(agent.complexitySamples, 4);
              assert.equal(
                agent.complexityUpdatedAt,
                '2026-03-18T09:20:00.000Z'
              );
            } finally {
              await repoAfter.close();
            }
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncCloudAgents can prune missing managed agents',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      let phase = 1;
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/v1/swarm/cloud/agents') {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents:
                phase === 1
                  ? [
                      {
                        slug: 'openai/gpt-4.1-mini',
                        provider: 'openrouter',
                        default_model: 'openai/gpt-4.1-mini',
                        capabilities: ['code_write'],
                        supports_tools: true,
                      },
                      {
                        slug: 'anthropic/claude-3.7-sonnet',
                        provider: 'openrouter',
                        default_model: 'anthropic/claude-3.7-sonnet',
                        capabilities: ['plan'],
                        supports_tools: true,
                      },
                    ]
                  : [
                      {
                        slug: 'openai/gpt-4.1-mini',
                        provider: 'openrouter',
                        default_model: 'openai/gpt-4.1-mini',
                        capabilities: ['code_write'],
                        supports_tools: true,
                      },
                    ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'cloud-key' });
          try {
            const first = await api.syncCloudAgents();
            assert.equal(first.created, 2);
            phase = 2;
            const second = await api.syncCloudAgents({ pruneMissing: true });
            assert.equal(second.deleted, 1);
            assert.ok(
              second.agents.some(
                (record) =>
                  record.action === 'deleted' &&
                  record.remoteSlug === 'anthropic/claude-3.7-sonnet'
              )
            );

            const repo = await GlobalRepository.create();
            try {
              const retained = await repo.getAgentBySlug(
                'mswarm-cloud-openai-gpt-4-1-mini'
              );
              const pruned = await repo.getAgentBySlug(
                'mswarm-cloud-anthropic-claude-3-7-sonnet'
              );
              assert.ok(retained);
              assert.equal(pruned, undefined);
            } finally {
              await repo.close();
            }
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncCloudAgents rejects pruneMissing with partial filters',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ agents: [] }));
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'cloud-key' });
          try {
            await assert.rejects(
              () => api.syncCloudAgents({ pruneMissing: true, limit: 1 }),
              /pruneMissing cannot be combined/i
            );
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncCloudAgents uses explicit openAiBaseUrl when provided',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/v1/swarm/cloud/agents') {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: [
                {
                  slug: 'openai/gpt-4.1-mini',
                  provider: 'openrouter',
                  default_model: 'openai/gpt-4.1-mini',
                  capabilities: ['code_write'],
                  supports_tools: true,
                },
              ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({
            baseUrl,
            openAiBaseUrl: 'http://127.0.0.1:18082/v1/swarm/openai/',
            apiKey: 'cloud-key',
          });
          try {
            await api.syncCloudAgents();
            const repo = await GlobalRepository.create();
            try {
              const agent = await repo.getAgentBySlug(
                'mswarm-cloud-openai-gpt-4-1-mini'
              );
              assert.ok(agent);
              assert.equal(
                (agent.config as any)?.baseUrl,
                'http://127.0.0.1:18082/v1/swarm/openai/'
              );
              assert.equal(
                (agent.config as any)?.apiBaseUrl,
                'http://127.0.0.1:18082/v1/swarm/openai/'
              );
            } finally {
              await repo.close();
            }
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);

test(
  'MswarmApi.syncCloudAgents refuses to overwrite a non-managed agent with the same local slug',
  { concurrency: false },
  async () => {
    await withTempHome(async () => {
      const repo = await GlobalRepository.create();
      try {
        await repo.createAgent({
          slug: 'mswarm-cloud-openai-gpt-4-1-mini',
          adapter: 'codex-cli',
          defaultModel: 'gpt-5.4',
        });
      } finally {
        await repo.close();
      }

      await withStubServer(
        (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/v1/swarm/cloud/agents') {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              agents: [
                {
                  slug: 'openai/gpt-4.1-mini',
                  provider: 'openrouter',
                  default_model: 'openai/gpt-4.1-mini',
                  capabilities: [],
                  supports_tools: true,
                },
              ],
            })
          );
        },
        async (baseUrl) => {
          const api = await MswarmApi.create({ baseUrl, apiKey: 'cloud-key' });
          try {
            await assert.rejects(
              () => api.syncCloudAgents(),
              /Refusing to overwrite non-mswarm agent/
            );
          } finally {
            await api.close();
          }
        }
      );
    });
  }
);
