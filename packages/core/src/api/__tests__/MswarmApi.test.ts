import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GlobalRepository } from '@mcoda/db';
import { MswarmApi } from '../MswarmApi.js';
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
