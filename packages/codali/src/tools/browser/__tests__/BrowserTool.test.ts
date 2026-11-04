import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { browserUrl, createBrowserTools } from "../BrowserTool.js";

test("browser navigation rejects local files, script URLs and embedded credentials", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "https://user:secret@example.org", "relative/path"]) assert.throws(() => browserUrl(url));
  assert.equal(browserUrl("https://example.org/docs"), "https://example.org/docs");
});

test("browser snapshot reads reject missing identities and cancelled calls", async () => {
  const [open, read] = createBrowserTools();
  const context = { workspaceRoot: "." };
  await assert.rejects(read.handler({ snapshotId: "missing", offset: 0 }, context), /unavailable/);
  await assert.rejects(open.handler({ url: "https://example.org" }, { ...context, signal: AbortSignal.abort(new Error("stop browser")) }), /stop browser/);
});

test("browser-use cannot load the workspace dotenv into its caller", { skip: !process.env.CODALI_TEST_BROWSER_BINARY, timeout: 45000 }, async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-browser-env-"));
  const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<main>Isolated evidence</main>"); });
  try {
    await fs.writeFile(path.join(root, ".env"), "CODALI_BROWSER_DOTENV_SENTINEL=untrusted\n");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    // Fresh caller process makes the test independent of browser-use's module
    // cache in other tests and never changes this test runner's cwd or env.
    const script = `import assert from 'node:assert/strict';
      import {createBrowserTools} from ${JSON.stringify(new URL("../BrowserTool.js", import.meta.url).href)};
      delete process.env.CODALI_BROWSER_DOTENV_SENTINEL;
      const [open]=createBrowserTools({executablePath:process.env.CODALI_TEST_BROWSER_BINARY});
      const result=await open.handler({url:${JSON.stringify(url)}},{workspaceRoot:process.cwd()});
      assert.match(JSON.parse(result.output).content,/Isolated evidence/);
      assert.equal(process.env.CODALI_BROWSER_DOTENV_SENTINEL,undefined);`;
    await new Promise<void>((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script], { cwd: root, timeout: 40000, maxBuffer: 200000 }, error => error ? reject(error) : resolve()));
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("real browser cancellation interrupts navigation and invalidates earlier evidence", { skip: !process.env.CODALI_TEST_BROWSER_BINARY, timeout: 15000 }, async t => {
  let notifySlow: () => void = () => undefined;
  const slowRequested = new Promise<void>(resolve => { notifySlow = resolve; });
  const server = createServer((request, response) => {
    if (request.url === "/slow") { notifySlow(); return; }
    response.setHeader("content-type", "text/html"); response.end("<main>Earlier evidence</main>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const [open, read] = createBrowserTools({ executablePath: process.env.CODALI_TEST_BROWSER_BINARY, timeoutMs: 10000 });
  const previous = JSON.parse((await open.handler({ url: baseUrl }, { workspaceRoot: "." })).output);
  const abort = new AbortController();
  const pending = open.handler({ url: `${baseUrl}/slow` }, { workspaceRoot: ".", signal: abort.signal });
  // Attach a handler immediately so an early navigation failure is observable.
  const rejected = assert.rejects(pending, /stop browser/);
  await Promise.race([slowRequested, pending]);
  const started = Date.now(); abort.abort(new Error("stop browser"));
  await rejected; assert.ok(Date.now() - started < 2000);
  await assert.rejects(read.handler({ snapshotId: previous.snapshotId, offset: 0 }, { workspaceRoot: "." }), /unavailable/);
});

test("real browser renders scripts and tables, blocks POST, and paginates captured evidence", { skip: !process.env.CODALI_TEST_BROWSER_BINARY }, async t => {
  let mutations = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET") { mutations++; response.end("unexpected mutation"); return; }
    response.setHeader("content-type", "text/html");
    response.end(`<title>Browser evidence fixture</title><nav>Navigation banner</nav><main><h1>Initial heading</h1><table><tr><th>Project</th><th>Count</th></tr><tr><td>Juniper</td><td>7</td></tr></table><a href="/details">Read details</a><p>${'Some "quoted" evidence. '.repeat(500)}</p></main><script>document.querySelector('h1').textContent='Rendered heading';fetch('/mutation',{method:'POST'}).catch(()=>{});</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number };
  const [open, read] = createBrowserTools({ executablePath: process.env.CODALI_TEST_BROWSER_BINARY });
  const opened = await open.handler({ url: `http://127.0.0.1:${address.port}/` }, { workspaceRoot: "." });
  assert.ok(opened.output.length <= 3800);
  const first = JSON.parse(opened.output.slice(0, 4000));
  assert.equal(first.scope, "main"); assert.doesNotMatch(first.content, /Navigation banner/);
  assert.equal(first.title, "Browser evidence fixture"); assert.match(first.content, /Rendered heading/);
  assert.match(first.content, /Juniper/); assert.match(first.content, /Read details/); assert.ok(first.nextOffset > 0);
  assert.equal(mutations, 0);
  const second = JSON.parse((await read.handler({ snapshotId: first.snapshotId, offset: first.nextOffset, maxChars: 1000 }, { workspaceRoot: "." })).output);
  assert.equal(second.offset, first.nextOffset); assert.ok(second.content.length <= 1000); assert.equal(second.url, first.url);
  let current = first, combined = first.content;
  while (current.nextOffset !== null) {
    const result = await read.handler({ snapshotId: first.snapshotId, offset: current.nextOffset, maxChars: 8000 }, { workspaceRoot: "." });
    assert.ok(result.output.length <= 3800);
    current = JSON.parse(result.output.slice(0, 4000)); combined += current.content;
  }
  assert.equal(combined.length, first.totalChars);
  assert.match(combined, /Some.*quoted.*evidence/);
  await assert.rejects(read.handler({ snapshotId: "stale", offset: 0 }, { workspaceRoot: "." }), /unavailable/);
});
