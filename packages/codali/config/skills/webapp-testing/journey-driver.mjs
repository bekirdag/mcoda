// journey-driver.mjs: drive headless Chrome over its debugging protocol.
// No dependencies; Node 22 or newer. Copy it into the project's test folder.
// It records every console error, uncaught exception, HTTP 4xx/5xx response
// and failed request; page.step() fails a step that produced one, or that
// leaves a visible form control without an accessible name.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Start the app and wait until `url` answers. Kill the returned process when done. */
export async function startServer(command, args, { url, env = {}, ms = 20000 } = {}) {
  const proc = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  for (const end = Date.now() + ms; ;) {
    try { await fetch(url); return proc; } catch {}
    if (proc.exitCode !== null) throw new Error('Server exited before it answered');
    if (Date.now() > end) { proc.kill(); throw new Error(`Server not reachable at ${url}`); }
    await sleep(100);
  }
}

/** Launch Chrome and return page controls. Every wait fails with a clear message. */
export async function launch({ chrome = process.env.CHROME_BIN } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'journey-'));
  // Port 0: Chrome picks a free port and writes it to DevToolsActivePort, so
  // two journeys on one machine never attach to each other's browser.
  const flags = ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'];
  let proc;
  for (const bin of [chrome, 'google-chrome', 'chromium', 'chromium-browser'].filter(Boolean)) {
    const candidate = spawn(bin, flags, { stdio: 'ignore' });
    if (await new Promise(r => { candidate.once('error', () => r(false)); setTimeout(() => r(true), 300); })) { proc = candidate; break; }
  }
  if (!proc) throw new Error('No Chrome or Chromium executable found');
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    try {
      const port = Number(readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page');
    } catch {}
    if (!target) await sleep(100);
  }
  if (!target) { proc.kill(); throw new Error('Chrome did not open its debugging port'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Debugging socket failed')); });
  let id = 0;
  const pending = new Map();
  const problems = [], methods = new Map(), loads = [];
  const record = problem => problems.push({ ...problem, at: Date.now() });
  const events = {
    'Page.loadEventFired': () => loads.splice(0).forEach(r => r()),
    'Network.requestWillBeSent': p => methods.set(p.requestId, { method: p.request.method, url: p.request.url }),
    'Network.responseReceived': p => { const { status, url } = p.response;
      if (status >= 400 && !/\/favicon\.ico(?:$|\?)/.test(url)) record({ kind: 'http', status, method: methods.get(p.requestId)?.method ?? 'GET', url }); },
    'Network.loadingFailed': p => { if (!p.canceled) record({ kind: 'network', ...methods.get(p.requestId), error: p.errorText }); },
    'Runtime.consoleAPICalled': p => { if (p.type === 'error' || p.type === 'assert')
      record({ kind: 'console', text: p.args.map(a => a.value ?? a.description ?? '').join(' ') }); },
    'Runtime.exceptionThrown': p => record({ kind: 'exception', text: p.exceptionDetails.exception?.description || p.exceptionDetails.text }),
  };
  ws.onmessage = e => {
    const m = JSON.parse(e.data), p = pending.get(m.id);
    if (m.method) events[m.method]?.(m.params);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  const cdp = (method, params = {}) => new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
  // Resolves on the next load event, so a reload never sees the old page as loaded.
  const load = async (what, start) => {
    let timer;
    const loaded = new Promise((res, rej) => { loads.push(res); timer = setTimeout(() => rej(new Error(`Timed out waiting for ${what}`)), 10000); });
    loaded.catch(() => {});
    try {
      const result = await start();
      if (result?.errorText) throw new Error(`${what} failed: ${result.errorText}`);
      await loaded;
    } finally { clearTimeout(timer); }
  };
  const evaluate = async expression => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, what = expression, ms = 5000) => {
    for (const end = Date.now() + ms; ;) {
      const value = await evaluate(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}; page shows: ${String(await evaluate('document.body?.innerText ?? ""').catch(() => '')).slice(0, 300)}`);
      await sleep(50);
    }
  };
  const q = s => `document.querySelector(${JSON.stringify(s)})`;
  // Visible inputs, selects and textareas with no label[for], wrapping label,
  // aria-label, aria-labelledby or title. Returns a short selector for each.
  const unlabelledControls = () => evaluate(`[...document.querySelectorAll('input, select, textarea')].filter(e =>
    !['hidden', 'submit', 'button', 'reset', 'image'].includes(e.type) && e.getClientRects().length
    && ![...(e.labels ?? [])].some(l => l.innerText.trim()) && !e.getAttribute('aria-label')?.trim() && !e.title.trim()
    && !(e.getAttribute('aria-labelledby') ?? '').split(/\\s+/).some(i => document.getElementById(i)?.innerText.trim())
  ).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : e.name ? '[name=' + e.name + ']' : ''))`);
  const describe = p => p.kind === 'http' ? `${p.method} ${p.url} returned ${p.status}`
    : p.kind === 'network' ? `${p.method} ${p.url} failed: ${p.error}` : `${p.kind} error: ${p.text}`;
  return {
    cdp, evaluate, waitFor, unlabelledControls,
    /** Everything recorded since launch: { kind: http|network|console|exception, ... }. */
    problems: () => [...problems],
    goto: url => load(`load of ${url}`, () => cdp('Page.navigate', { url })),
    /** Reload the current page (the session cookie stays), then wait for the load. */
    reload: () => load('reload', () => cdp('Page.reload', { ignoreCache: true })),
    /** Run one scenario step. It fails on a console error, uncaught exception,
     * failed request or 4xx/5xx response during the step and on unlabelled
     * controls. For a response the step expects (a refusal, a signed-out session
     * probe), list its status or a RegExp for "STATUS METHOD URL" in allow. */
    step: async (name, run, { allow = [], labels = true } = {}) => {
      const start = problems.length;
      const expected = p => p.kind === 'http' && allow.some(a => a instanceof RegExp ? a.test(`${p.status} ${p.method} ${p.url}`) : a === p.status);
      const unexpected = () => problems.slice(start).filter(p => !expected(p)).map(describe).join('; ');
      try {
        await run(); await sleep(300);
        if (unexpected()) throw new Error(unexpected());
        const unlabelled = labels ? await unlabelledControls() : [];
        if (unlabelled.length) throw new Error(`form controls without a label: ${unlabelled.join(', ')}`);
        console.log(`PASS ${name}`);
      } catch (error) {
        // A wait that timed out often hides the refused request behind it.
        const seen = unexpected();
        if (seen && !error.message.includes(seen)) error.message += `; during this step: ${seen}`;
        console.log(`FAIL ${name}: ${error.message}`); throw error;
      }
    },
    waitForSelector: (s, ms) => waitFor(`!!${q(s)}`, `selector ${s}`, ms),
    waitForText: (t, ms) => waitFor(`!!document.body && document.body.innerText.includes(${JSON.stringify(t)})`, `text "${t}"`, ms),
    click: async s => { await waitFor(`!!${q(s)}`, `selector ${s}`); await evaluate(`${q(s)}.click()`); },
    // Sets the value the way a framework expects, then fires input and change.
    type: async (s, text) => {
      await waitFor(`!!${q(s)}`, `selector ${s}`);
      await evaluate(`(() => { const e = ${q(s)}; e.focus();
        const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value')?.set;
        set ? set.call(e, ${JSON.stringify(text)}) : (e.value = ${JSON.stringify(text)});
        e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    },
    text: (s = 'body') => evaluate(`${q(s)}?.innerText ?? ''`),
    screenshot: async () => Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    close: async () => { try { ws.close(); } catch {} proc.kill(); await sleep(150); rmSync(dir, { recursive: true, force: true }); },
  };
}
