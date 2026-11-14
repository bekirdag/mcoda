import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readPublicCorpus, hasToolBaseline, hash, json, jsonl, writeNew } from './trust-common.mjs';
const exec = promisify(execFile);

test('explicit corpus root verifies its own bytes and cannot be scored as the original corpus', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codali-followup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const task = { id: 'new.fixture.01', family: 'new.fixture', domain: 'math_and_data', split: 'validation', variant: 1,
    prompt: 'Return JSON with answer 3.', files: {}, history: [], capabilities: [], toolParity: 'calculation' };
  const prompts = JSON.stringify(task)+'\n';
  const grading = JSON.stringify({ id: task.id, kind: 'json', expected: { answer: 3 }, critical: false })+'\n';
  await fs.writeFile(path.join(root, 'prompts.jsonl'), prompts);
  await fs.writeFile(path.join(root, 'grading.jsonl'), grading);
  await writeNew(path.join(root, 'manifest.json'), { version: 'synthetic-followup-test', promptsSha256: hash(prompts), gradingSha256: hash(grading) });
  assert.equal((await readPublicCorpus(root)).cases[0].id, task.id);
  assert.equal(hasToolBaseline(task), true);
  assert.equal(hasToolBaseline({ ...task, toolParity: undefined }), false);
  const run = path.join(root, 'run'); await fs.mkdir(run);
  const configHash = 'a'.repeat(64);
  await writeNew(path.join(run, 'manifest.json'), { identity: { corpusHash: hash(prompts), configHash, fingerprint: { synthetic: true }, protocolVersion: 'synthetic-followup-test' } });
  await fs.writeFile(path.join(run, 'ledger.jsonl'), JSON.stringify({ type: 'result', directory: run, result: {
    caseId: task.id, attemptId: 'one', arm: 'raw_direct', configHash, content: '{"answer":3}', workspacePreserved: true, usage: { tokens: 1 },
  } })+'\n');
  const scorer = fileURLToPath(new URL('./score-trust-benchmark.mjs', import.meta.url));
  await exec(process.execPath, [scorer, '--runs', run, '--output', path.join(root, 'score'), '--corpus-root', root], { timeout: 20000 });
  assert.equal((await json(path.join(root, 'score/report.json'))).aggregates['raw_direct:'+configHash].all.passed, 1);
  await assert.rejects(exec(process.execPath, [scorer, '--runs', run, '--output', path.join(root, 'wrong-corpus')], { timeout: 20000 }), /different corpus/);
  await fs.appendFile(path.join(root, 'prompts.jsonl'), ' ');
  await assert.rejects(readPublicCorpus(root), /Public corpus hash mismatch/);
});

test('calculation tool baseline executes the same pure tool without starting Docdex or exposing file tools', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codali-calculation-parity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'test', health_status: 'healthy', supports_tools: true, context_window: 32768, operations: ['chat.completions'] }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); requests.push(payload);
    const message = requests.length === 1 ? { role: 'assistant', content: '', tool_calls: [{ id: 'sum', type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+2"}' } }] }
      : { role: 'assistant', content: '{"answer":3}' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'synthetic', object: 'chat.completion', model: 'test', choices: [{ index: 0, message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { schemaVersion: 1, profile: 'synthetic-parity-test', providers: { local: { adapter: 'openai-compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1` } },
    models: { model: { provider: 'local', catalogId: 'test', revision: '1', operations: ['chat.completions'], contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true } },
    bindings: { lead: { candidates: ['model'] } }, interaction: { calculator: true } };
  const configFile = path.join(root, 'config.json'); await writeNew(configFile, config);
  const task = { id: 'synthetic.parity.01', domain: 'math_and_data', family: 'synthetic.parity', split: 'development', variant: 1,
    prompt: 'Calculate one plus two, return only JSON with answer.', history: [], files: {}, toolParity: 'calculation' };
  const requestFile = path.join(root, 'request.json');
  await writeNew(requestFile, { task, arm: 'raw_tools', attemptId: 'synthetic', directory: root, config: configFile, timeoutMs: 20000 });
  await exec(process.execPath, [fileURLToPath(new URL('./trust-attempt.mjs', import.meta.url)), '--request', requestFile], { timeout: 30000 });
  const result = await json(path.join(root, 'result.json'));
  assert.equal(result.error, undefined); assert.equal(result.content, '{"answer":3}');
  assert.equal(result.usage.modelCalls, 2); assert.equal(result.usage.toolCalls, 1); assert.equal(result.workspacePreserved, true);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.tools.map(tool => tool.function.name), ['calculate']);
    assert.equal(request.max_tokens, 2048);
    assert.ok(!JSON.stringify(request.messages).includes(task.id));
  }
  assert.match(JSON.stringify(requests[1].messages), /IEEE-754/);
  const events = await jsonl(path.join(root, 'events.jsonl'));
  assert.ok(!events.some(e => e.type.startsWith('embedding_') || e.type === 'index_ready'));
  assert.equal(events.filter(e => e.type === 'tool_receipt')[0].data.call.name, 'calculate');
});
