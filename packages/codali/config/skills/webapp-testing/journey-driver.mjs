// journey-driver.mjs: drive headless Chrome over its debugging protocol.
// No dependencies; Node 22 or newer. Copy it into the project's test folder.
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
  ws.onmessage = e => {
    const m = JSON.parse(e.data), p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  const cdp = (method, params = {}) => new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  await cdp('Page.enable'); await cdp('Runtime.enable');
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
  return {
    cdp, evaluate, waitFor,
    goto: async url => { await cdp('Page.navigate', { url }); await waitFor('document.readyState === "complete"', `load of ${url}`, 10000); },
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
