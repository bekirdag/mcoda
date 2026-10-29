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
