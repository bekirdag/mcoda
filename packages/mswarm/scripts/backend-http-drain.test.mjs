import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { inspectorControl } from './backend-http-drain.mjs';

async function fixture(extraHandler = false) {
  const root = await mkdtemp(join(tmpdir(), 'mcoda-http-drain-'));
  const path = join(root, 'fixture.mjs');
  await writeFile(path, `
import http from 'node:http';
import inspector from 'node:inspector';
const pending = [];
const handler = (request, response) => {
  if (request.url === '/long') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('accepted:'); pending.push(response); return;
  }
  response.end('normal');
};
let server, app;
if (process.env.MCODA_DRAIN_FIXTURE_FASTIFY === '1') {
  const { createRequire } = await import('node:module');
  app = createRequire('/app/package.json')('fastify')({ logger: false });
  app.all('*', (request, reply) => { reply.hijack(); handler(request.raw, reply.raw); });
  server = app.server;
} else server = http.createServer(handler);
${extraHandler ? "server.on('upgrade', () => {});" : ''}
process.on('message', (message) => {
  if (message.release) for (const response of pending.splice(0)) response.end('finished');
});
const ready = () => process.send({ pid: process.pid, port: server.address().port,
  inspectorPort: Number(new URL(inspector.url()).port) });
if (app) { await app.listen({ port: 0, host: '127.0.0.1' }); ready(); }
else server.listen(0, '127.0.0.1', ready);
`);
  const child = fork(path, [], { execArgv: ['--inspect=127.0.0.1:0'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', () => {});
  const [ready] = await once(child, 'message');
  return { child, ...ready, async cleanup() {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  } };
}

for (const role of ['gateway', 'proxy']) {
  test(`${role}: barrier rejects new work, close waits for accepted response, restore resumes`, { timeout: 20000 }, async () => {
    const target = await fixture();
    const options = { role, port: target.port, expectedPid: target.pid,
      inspectorPort: target.inspectorPort, nonce: 'qualification-drain-20261026' };
    const url = `http://127.0.0.1:${target.port}`;
    const control = (action, overrides = {}) => inspectorControl({ ...options, action, ...overrides });
    try {
      assert.equal((await control('inspect')).phase, 'unmodified');
      assert.equal(await (await fetch(url + '/normal')).text(), 'normal');
      const active = await fetch(`${url}/long`);
      assert.equal(active.status, 200);
      const installed = await control('barrier');
      assert.equal(installed.phase, 'barrier');
      assert.equal(await (await fetch(url + '/healthz')).text(), 'normal');
      for (const path of ['/v1/chat/completions', '/v1/swarm/self-hosted/node/register', '/v1/swarm/self-hosted/node/jobs/x/result/extra']) {
        const blocked = await fetch(url + path, { method: 'POST', body: '{}' });
        assert.equal(blocked.status, 503);
        assert.equal(blocked.headers.get('retry-after'), '15');
        assert.equal((await blocked.json()).error.code, 'deployment_draining');
      }
      const heartbeat = await fetch(url + '/v1/swarm/self-hosted/node/heartbeat', { method: 'POST' });
      assert.equal(heartbeat.status, role === 'gateway' ? 200 : 503);
      await heartbeat.text();
      const wrongMethod = await fetch(url + '/v1/swarm/self-hosted/node/heartbeat');
      assert.equal(wrongMethod.status, 503); await wrongMethod.text();
      await assert.rejects(control('close', { nonce: 'wrong-owner-nonce-20261026' }), /rejected/);
      const closing = await control('close');
      assert.equal(closing.phase, 'closing');
      await assert.rejects(control('restore'), /rejected/);
      target.child.send({ release: true });
      assert.equal(await active.text(), 'accepted:finished');
      let state;
      for (let attempt = 0; attempt < 50; attempt++) {
        state = await control('status');
        if (state.phase === 'closed') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(state.phase, 'closed'); assert.equal(state.listening, false);
      assert.ok(state.closedAt >= installed.installedAt);
      await control('restore');
      for (let attempt = 0; attempt < 50; attempt++) {
        state = await control('status');
        if (state.phase === 'restored') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(state.phase, 'restored');
      assert.equal(await (await fetch(url + '/normal')).text(), 'normal');
      assert.equal((await control('barrier', { nonce: 'qualification-second-20261026' })).phase, 'barrier');
      await inspectorControl({ ...options, action: 'restore', nonce: 'qualification-second-20261026' });
    } finally { await target.cleanup(); }
  });
}

test('unexpected request dispatch and incorrect process identity cannot mutate admission', { timeout: 15000 }, async () => {
  const target = await fixture(true);
  const options = { role: 'gateway', port: target.port, expectedPid: target.pid,
    inspectorPort: target.inspectorPort, nonce: 'qualification-rejected-20261026', action: 'barrier' };
  try {
    await assert.rejects(inspectorControl({ ...options, expectedPid: target.pid + 1 }), /rejected/);
    await assert.rejects(inspectorControl(options), /rejected/);
    assert.equal(await (await fetch(`http://127.0.0.1:${target.port}/normal`)).text(), 'normal');
  } finally { await target.cleanup(); }
});
