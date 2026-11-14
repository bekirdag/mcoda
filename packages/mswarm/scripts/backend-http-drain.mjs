#!/usr/bin/env node
/**
 * Operator bootstrap for legacy HTTP services without a shutdown handler.
 * Run inside the target container against its loopback Node inspector only.
 * This is not a public administration endpoint. Qualification must pin the
 * runtime/image and prove both request completion and durable-job quiescence.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Self-contained because the inspector evaluates this function in the target.
export function controlHttpAdmission({ action, role, port, nonce, expectedPid }) {
  if (!['gateway', 'proxy'].includes(role) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^[a-zA-Z0-9-]{16,100}$/.test(nonce) || expectedPid !== process.pid ||
      !['inspect', 'barrier', 'status', 'close', 'restore'].includes(action)) {
    throw new Error('Invalid or mismatched deployment target');
  }
  const key = Symbol.for('mcoda.backend.http-drain.v1');
  let state = globalThis[key];
  if (state?.phase === 'restored' && action === 'barrier') {
    delete globalThis[key];
    state = undefined;
  }
  const snapshot = () => ({
    nonce: state.nonce, role: state.role, port: state.port, pid: process.pid,
    phase: state.phase, blockedRequests: state.blockedRequests,
    controlRequests: state.controlRequests, installedAt: state.installedAt,
    closedAt: state.closedAt, closeError: state.closeError,
    listening: state.server.listening,
  });
  if (state && (state.nonce !== nonce || state.port !== port || state.role !== role)) {
    throw new Error('Another deployment owns this process');
  }
  if (!state) {
    if (!['inspect', 'barrier'].includes(action)) throw new Error('No admission barrier is installed');
    // Legacy bootstrap only: the inspected runtime's HTTP handle shape must be
    // qualified before deployment. Fail closed on additional/bypassing handlers.
    const servers = process._getActiveHandles().filter((handle) =>
      handle?.constructor?.name === 'Server' && typeof handle.address === 'function' &&
      handle.address()?.port === port && typeof handle.closeIdleConnections === 'function');
    if (servers.length !== 1) throw new Error('Expected exactly one qualified HTTP server');
    const server = servers[0];
    const listeners = server.listeners('request');
    if (action === 'inspect') return { nonce, role, port, pid: process.pid, phase: 'unmodified',
      runtimeVersion: process.version, listening: server.listening, requestListeners: listeners.length,
      alternateListeners: Object.fromEntries(['checkContinue', 'checkExpectation', 'upgrade'].map((name) => [name, server.listenerCount(name)])) };
    if (listeners.length !== 1 || ['checkContinue', 'checkExpectation', 'upgrade'].some((name) => server.listenerCount(name))) {
      throw new Error('Unsupported HTTP request dispatch; no listener changed');
    }
    state = { nonce, role, port, server, listeners, address: server.address(),
      phase: 'barrier', installedAt: Date.now(), blockedRequests: 0, controlRequests: 0 };
    const controlPath = /^\/v1\/swarm\/self-hosted\/node\/(?:heartbeat|load|models|jobs\/poll|jobs\/[A-Za-z0-9_-]+\/(?:start|events|result))$/;
    state.listener = function (request, response) {
      const pathname = (request.url ?? '').split('?')[0];
      const health = request.method === 'GET' && pathname === '/healthz';
      if (health || (state.role === 'gateway' && request.method === 'POST' && controlPath.test(pathname))) {
        state.controlRequests++;
        for (const listener of state.listeners) listener.call(this, request, response);
        return;
      }
      state.blockedRequests++;
      response.shouldKeepAlive = false;
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '15', connection: 'close' });
      response.end(JSON.stringify({ error: { code: 'deployment_draining', message: 'Service deployment is draining; retry shortly.' } }));
      request.resume();
    };
    globalThis[key] = state;
    server.removeListener('request', listeners[0]);
    server.on('request', state.listener);
  }
  if (action === 'inspect' || action === 'barrier' || action === 'status') return snapshot();
  if (action === 'close') {
    if (state.phase === 'barrier') {
      state.phase = 'closing';
      // Never close active connections. The callback proves every HTTP request
      // has finished; the operator separately checks durable queue records.
      state.server.close((error) => {
        clearInterval(state.idleReaper);
        state.closeError = error ? String(error.message) : undefined;
        state.phase = error ? 'close_failed' : 'closed';
        state.closedAt = Date.now();
      });
      state.server.closeIdleConnections();
      // A response accepted before the barrier can become idle after close()
      // starts. Reap only idle sockets as those responses finish.
      state.idleReaper = setInterval(() => state.server.closeIdleConnections(), 100);
      state.idleReaper.unref();
    }
    return snapshot();
  }
  if (state.phase === 'closing' || state.phase === 'close_failed') throw new Error('HTTP close has not completed');
  if (state.phase === 'closed') {
    state.phase = 'restoring';
    state.server.listen({ port: state.port, host: state.address.address }, () => {
      state.server.removeListener('request', state.listener);
      for (const listener of state.listeners) state.server.on('request', listener);
      state.phase = 'restored';
    });
  } else if (state.phase === 'barrier') {
    state.server.removeListener('request', state.listener);
    for (const listener of state.listeners) state.server.on('request', listener);
    state.phase = 'restored';
  }
  return snapshot();
}

export async function inspectorControl(options) {
  const inspectorPort = options.inspectorPort ?? 9229;
  if (!Number.isInteger(inspectorPort) || inspectorPort < 1 || inspectorPort > 65535) throw new Error('Invalid inspector port');
  if (typeof WebSocket !== 'function') throw new Error('Use Node20 with --experimental-websocket, or Node22');
  const response = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error(`Inspector discovery failed: ${response.status}`);
  const targets = await response.json();
  if (!Array.isArray(targets) || targets.length !== 1) throw new Error('Inspector target is ambiguous');
  const endpoint = new URL(targets[0].webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== inspectorPort || endpoint.username || endpoint.password) {
    throw new Error('Inspector must remain on the selected container loopback port');
  }
  const socket = new WebSocket(endpoint.href);
  return await new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => finish(new Error('Inspector operation timed out')), 10_000);
    let finished = false;
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { socket.close(); } catch { /* Preserve the original failure. */ }
      if (error) reject(error); else resolveResult(value);
    }
    socket.addEventListener('error', () => finish(new Error('Inspector connection failed')));
    socket.addEventListener('close', () => { if (!finished) finish(new Error('Inspector disconnected')); });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(${controlHttpAdmission.toString()})(${JSON.stringify(options)})`, returnByValue: true,
    } })));
    socket.addEventListener('message', ({ data }) => {
      try {
        const message = JSON.parse(String(data));
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails) return finish(new Error('Target rejected drain operation: ' + JSON.stringify(message.error ?? message.result.exceptionDetails)));
        const value = message.result?.result?.value;
        if (!value || value.pid !== options.expectedPid || value.nonce !== options.nonce) return finish(new Error('Invalid target drain receipt'));
        finish(undefined, value);
      } catch (error) { finish(error); }
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = JSON.parse(process.argv[2] ?? '{}');
  try { console.log(JSON.stringify(await inspectorControl(options))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
