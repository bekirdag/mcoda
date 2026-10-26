import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleProvider } from '../OpenAiCompatibleProvider.js';

test('HTTP200 SSE error event must reject and redact configured apiKey', { concurrency: false }, async () => {
  const apiKey = 'sk-secret-key-12345';
  const provider = new OpenAiCompatibleProvider({ model: 'test', apiKey });

  const sseBody = [
    'data: {"error":{"code":"failure","message":"Invalid API key: sk-secret-key-12345"}}\n\n',
    'data: [DONE]\n\n'
  ].join('');

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      return new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    };

    await assert.rejects(
      provider.generate({ messages: [{ role: 'user', content: 'go' }], stream: true }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /stream error/);
        assert.match(err.message, /\[redacted\]/);
        return !err.message.includes(apiKey);
      },
      'Error message should not contain the API key'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('abruptly ended content stream without finish_reason or DONE must reject', { concurrency: false }, async () => {
  const provider = new OpenAiCompatibleProvider({ model: 'test' });

  const sseBody = [
    'data: {"choices":[{"delta":{"content":"unfinished"}}]}\n\n'
  ].join('');

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      return new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    };

    await assert.rejects(
      provider.generate({ messages: [{ role: 'user', content: 'go' }], stream: true }),
      /before a complete response/i,
      'Should reject on incomplete stream without finish_reason or DONE'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fragmented tool arguments across data events assemble valid JSON', { concurrency: false }, async () => {
  const provider = new OpenAiCompatibleProvider({ model: 'test' });

  const sseBody = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n'
  ].join('');

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      return new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    };

    const result = await provider.generate({ messages: [{ role: 'user', content: 'go' }], stream: true });

    assert.ok(result.toolCalls, 'toolCalls should be present');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'call_1');
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.deepEqual(result.toolCalls[0].args, { path: 'a.ts' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
