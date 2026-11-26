import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// The built-in webapp-testing driver, exercised against small apps written for
// this test. A journey that never reloads a signed-in page cannot see a session
// restore that drops something the client needs; the driver must make that
// reachable (reload) and observable (failed requests, console errors).
const driverUrl = new URL("../../../config/skills/webapp-testing/journey-driver.mjs", import.meta.url).href;
const chrome = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser"].filter(Boolean)
  .find(bin => spawnSync(bin!, ["--version"], { stdio: "ignore" }).status === 0);
const skip = chrome ? false : "no Chrome or Chromium on this host";

interface Driver {
  launch(options?: { chrome?: string }): Promise<Page>;
}
interface Page {
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  waitForText(text: string, ms?: number): Promise<unknown>;
  step(name: string, run: () => Promise<void>, options?: { allow?: (number | RegExp)[]; labels?: boolean }): Promise<void>;
  unlabelledControls(): Promise<string[]>;
  problems(): { kind: string; status?: number }[];
  close(): Promise<void>;
}

/** A reading-list app: sign-in returns a write token the client keeps in memory;
 * after a reload the client asks /api/session for it again. `restoreToken`
 * false is the defect: the session endpoint answers the user but not the token. */
const readingList = (restoreToken: boolean) => {
  const books: string[] = [];
  const page = `<!doctype html><html><body>
<form id="login"><label for="who">Reader</label><input id="who"><button id="enter">Enter</button></form>
<form id="add" hidden><label for="title">Title</label><input id="title"><button id="save">Add</button></form>
<ul id="books"></ul><p id="status"></p>
<script>
let token;
const show = list => { document.getElementById('books').innerHTML = list.map(b => '<li>' + b + '</li>').join(''); };
const signedIn = async t => { token = t; document.getElementById('login').hidden = true; document.getElementById('add').hidden = false;
  show(await (await fetch('/api/books')).json()); document.getElementById('status').textContent = 'Signed in'; };
document.getElementById('login').onsubmit = async e => { e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST' }); signedIn((await r.json()).token); };
document.getElementById('add').onsubmit = async e => { e.preventDefault();
  const r = await fetch('/api/books', { method: 'POST', headers: { 'x-token': String(token) }, body: document.getElementById('title').value });
  if (r.ok) { show(await r.json()); document.getElementById('status').textContent = 'Saved'; } };
fetch('/api/session').then(r => r.ok ? r.json() : null).then(s => { if (s) signedIn(s.token); });
</script></body></html>`;
  return createServer((req, res) => {
    const signed = /session=1/.test(req.headers.cookie ?? "");
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(page); return; }
    if (req.url === "/api/login") return json(200, { user: "reader", token: "t-1" }, { "set-cookie": "session=1; Path=/" });
    if (req.url === "/api/session") return signed ? json(200, restoreToken ? { user: "reader", token: "t-1" } : { user: "reader" }) : json(401, {});
    if (req.url === "/api/books" && req.method === "GET") return json(200, books);
    if (req.url === "/api/books") {
      let body = ""; req.on("data", chunk => body += chunk);
      req.on("end", () => { if (req.headers["x-token"] !== "t-1") return json(403, { error: "token required" }); books.push(body); json(200, books); });
      return;
    }
    res.writeHead(404); res.end();
  });
};

const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
};

const journey = async (restoreToken: boolean) => {
  const server = readingList(restoreToken); const url = await listen(server);
  const driver = await import(driverUrl) as Driver;
  const page = await driver.launch({ chrome });
  const log: string[] = [];
  try {
    await page.step("sign in and add a book", async () => {
      await page.goto(url); await page.type("#who", "Ada"); await page.click("#enter"); await page.waitForText("Signed in");
      await page.type("#title", "Dune"); await page.click("#save"); await page.waitForText("Saved");
    }, { allow: [/^401 GET \S+\/api\/session$/] });
    log.push("first");
    await page.step("reload, then add another book", async () => {
      await page.reload(); await page.waitForText("Signed in");
      await page.type("#title", "Emma"); await page.click("#save"); await page.waitForText("Emma", 2000);
    });
    log.push("second");
  } catch (error) { log.push(String(error instanceof Error ? error.message : error)); }
  finally { await page.close(); server.close(); }
  return log;
};

test("a reload-then-act step fails on the refused mutation when the session restore drops the client's token", { skip, timeout: 60_000 }, async () => {
  const log = await journey(false);
  assert.equal(log[0], "first");
  assert.equal(log.length, 2, "the post-reload step must fail");
  assert.match(log[1], /POST http:\/\/127\.0\.0\.1:\d+\/api\/books returned 403/);
});

test("the same journey passes when the session restore returns everything the client needs", { skip, timeout: 60_000 }, async () => {
  assert.deepEqual(await journey(true), ["first", "second"]);
});

test("a step fails on console errors and uncaught exceptions; an expected refusal can be allowed", { skip, timeout: 60_000 }, async () => {
  const server = createServer((req, res) => {
    if (req.url === "/denied") { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><button id="warn" onclick="console.error('quota lookup failed')">w</button>
<button id="throw" onclick="setTimeout(() => { throw new Error('render crashed') })">t</button>
<button id="deny" onclick="fetch('/denied')">d</button>`);
  });
  const url = await listen(server);
  const page = await (await import(driverUrl) as Driver).launch({ chrome });
  try {
    await page.goto(url);
    await assert.rejects(page.step("console", () => page.click("#warn")), /console error: quota lookup failed/);
    await assert.rejects(page.step("exception", () => page.click("#throw")), /render crashed/);
    await assert.rejects(page.step("refused", () => page.click("#deny")), /returned 403/);
    await page.step("expected refusal", () => page.click("#deny"), { allow: [403] });
    await page.step("expected refusal by pattern", () => page.click("#deny"), { allow: [/^403 GET \S+\/denied$/] });
    await assert.rejects(page.step("other pattern", () => page.click("#deny"), { allow: [/\/elsewhere$/] }), /returned 403/);
  } finally { await page.close(); server.close(); }
});

test("form controls without an accessible name are listed and fail a step", { skip, timeout: 60_000 }, async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    // A loan form: two named controls, a hidden field, and a branch select the
    // script builds later whose visible caption is not tied to it.
    res.end(`<!doctype html><form>
<label for="member">Member</label><input id="member">
<label>Due <input type="date" name="due"></label>
<span id="notes-cap">Notes</span><textarea aria-labelledby="notes-cap"></textarea>
<input type="hidden" name="csrf" value="x"><input aria-label="Search" type="search">
<span>Branch</span><div id="slot"></div></form>
<script>setTimeout(() => { const s = document.createElement('select'); s.id = 'branch'; s.innerHTML = '<option>North</option>'; document.getElementById('slot').append(s); }, 50);</script>`);
  });
  const url = await listen(server);
  const page = await (await import(driverUrl) as Driver).launch({ chrome });
  try {
    await page.goto(url);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await page.unlabelledControls(), ["select#branch"]);
    await assert.rejects(page.step("loan form", async () => undefined), /form controls without a label: select#branch/);
  } finally { await page.close(); server.close(); }
});
