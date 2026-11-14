import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { browserUrl, createBrowserTools, findSnapshotText, snapshotSectionContext, snapshotContentStart } from "../BrowserTool.js";

test("snapshot lookup tolerates line breaks and intervening words without inventing quotes", () => {
  assert.deepEqual(findSnapshotText("There can only be one\nwriter at a time.", "only one writer"), { index: 10, mode: "ordered_terms" });
  assert.deepEqual(findSnapshotText("A single writer. Another single writer.", "SINGLE writer"), { index: 2, mode: "exact" });
  assert.equal(findSnapshotText("only " + "x".repeat(250) + "one writer", "only one writer")?.mode, "ranked_terms");
  assert.equal(findSnapshotText("writer one only", "only one writer")?.mode, "ranked_terms");
  assert.equal(findSnapshotText("single writer", "single writer", 5), undefined);
});

test("paged passages retain their nearest heading scope", () => {
  const content = '- heading "Modes" [level=1]\n- heading "Mode A" [level=2]\n- paragraph: body A\n- heading "Mode B" [level=2]\n- paragraph: body B';
  assert.deepEqual(snapshotSectionContext(content, content.indexOf("body A")), ["Modes", "Mode A"]);
  assert.deepEqual(snapshotSectionContext(content, content.indexOf("body B")), ["Modes", "Mode B"]);
});

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

test("HTTP error pages cannot masquerade as retrieved source evidence", { skip: !process.env.CODALI_TEST_BROWSER_BINARY, timeout: 45000 }, async t => {
  const server = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<main><h1>Document unavailable</h1></main>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const [open, read] = createBrowserTools({ executablePath: process.env.CODALI_TEST_BROWSER_BINARY });
  const data = JSON.parse((await open.handler({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/missing` }, { workspaceRoot: "." })).output);
  assert.equal(data.httpStatus, 404);
  assert.equal(data.evidenceStatus, "http_error");
  assert.match(data.evidenceNotice, /not claim verification/);
  const page = JSON.parse((await read.handler({ snapshotId: data.snapshotId, offset: 0 }, { workspaceRoot: "." })).output);
  assert.equal(page.httpStatus, 404);
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
    response.end(`<title>Browser evidence fixture</title><nav>Navigation banner</nav><main><h1>Initial heading</h1><p><s>Old limitation</s> Current replacement.</p><table><tr><th>Project</th><th>Count</th></tr><tr><td>Juniper</td><td>7</td></tr></table><a href="/details">Read details</a><p>${'Some "quoted" evidence. '.repeat(500)}</p></main><script>document.querySelector('h1').textContent='Rendered heading';fetch('/mutation',{method:'POST'}).catch(()=>{});</script>`);
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
  assert.match(first.content, /DELETED\/STRUCK-THROUGH TEXT/); assert.match(first.content, /Old limitation/); assert.match(first.content, /Current replacement/);
  assert.match(first.content, /Juniper/); assert.match(first.content, /Read details/); assert.ok(first.nextOffset > 0);
  assert.equal(mutations, 0);
  const second = JSON.parse((await read.handler({ snapshotId: first.snapshotId, offset: first.nextOffset, maxChars: 1000 }, { workspaceRoot: "." })).output);
  assert.equal(second.offset, first.nextOffset); assert.ok(second.content.length <= 1000); assert.equal(second.url, first.url);
  assert.deepEqual(second.sectionContext, ["Rendered heading"]);
  let current = first, combined = first.content;
  while (current.nextOffset !== null) {
    const result = await read.handler({ snapshotId: first.snapshotId, offset: current.nextOffset, maxChars: 8000 }, { workspaceRoot: "." });
    assert.ok(result.output.length <= 3800);
    current = JSON.parse(result.output.slice(0, 4000)); combined += current.content;
  }
  assert.equal(combined.length, first.totalChars);
  assert.match(combined, /Some.*quoted.*evidence/);
  const searched = JSON.parse((await read.handler({ snapshotId: first.snapshotId, query: "Juniper" }, { workspaceRoot: "." })).output);
  assert.match(searched.content, /Juniper/);
  const approximate = await read.handler({ snapshotId: first.snapshotId, query: "juniper rendered", maxChars: 8000 }, { workspaceRoot: "." });
  assert.ok(approximate.output.length <= 3800);
  const candidate = JSON.parse(approximate.output);
  assert.equal(candidate.matchMode, "ranked_terms"); assert.match(candidate.matchNotice, /not a literal quotation/);
  assert.equal(candidate.nextOffset, candidate.offset + candidate.content.length);
  await open.handler({ url: `http://127.0.0.1:${address.port}/second` }, { workspaceRoot: "." });
  assert.match(JSON.parse((await read.handler({ snapshotId: first.snapshotId, query: "Juniper" }, { workspaceRoot: "." })).output).content, /Juniper/);
  const absent = JSON.parse((await read.handler({ snapshotId: first.snapshotId, query: "nonexistent distinctive phrase" }, { workspaceRoot: "." })).output);
  assert.equal(absent.matchFound, false);
  await assert.rejects(read.handler({ snapshotId: "stale", offset: 0 }, { workspaceRoot: "." }), /unavailable/);
});

test("snapshot title lookup prefers the document section over its table-of-contents link", () => {
  const content = '- link "Isolation modes"\n  - /url: #isolation\n- heading "Isolation modes" [level=2]\n- paragraph: Actual scope and limitations.';
  assert.equal(findSnapshotText(content, "Isolation modes")?.index, content.lastIndexOf("Isolation modes"));
  assert.equal(findSnapshotText('- link "Other page"\n  - /url: /other', "Other page")?.index, 8);
  assert.equal(findSnapshotText(content, "Isolation modes", content.indexOf("- heading"))?.index, content.lastIndexOf("Isolation modes"));
  assert.equal(findSnapshotText(content, ""), undefined);
});

test("keyword fallback retrieves nearby unordered terms without inventing exact matches", () => {
  const source = 'Background '.repeat(140) + 'Retries may be needed when concurrent updates conflict. Readers retain snapshots.';
  const match = findSnapshotText(source, 'snapshots conflict retries');
  assert.equal(match?.mode, 'ranked_terms');
  assert.deepEqual(new Set(match?.matchedTerms), new Set(['snapshots', 'conflict', 'retries']));
  assert.equal(findSnapshotText(source, 'volcano nebula glacier'), undefined);
  assert.equal(findSnapshotText('alpha ' + 'padding '.repeat(500) + 'beta', 'beta alpha'), undefined);
  assert.equal(findSnapshotText('Ölçüm güvenilir sonuç üretir.', 'sonuç ölçüm')?.mode, 'ranked_terms');
  assert.equal(findSnapshotText(source, 'snapshots conflict retries', source.length), undefined);
});

test("initial content positioning is bounded and does not remove source text", () => {
  const prefix = '- navigation:\n  - link "Home"\n- heading "Sidebar" [level=3]\n';
  assert.equal(snapshotContentStart(prefix + '- heading "Document" [level=1]\n- paragraph: Body'), prefix.length);
  assert.equal(snapshotContentStart(prefix), 0);
  assert.equal(snapshotContentStart('x'.repeat(20001) + '\n- heading "Late" [level=1]'), 0);
});

test("main fallback starts at document heading while explicit page scope retains navigation", { skip: !process.env.CODALI_TEST_BROWSER_BINARY }, async t => {
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<nav><a href="/">Navigation prefix</a></nav><h1>Actual document</h1><p>Evidence.</p>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const [open, read] = createBrowserTools({ executablePath: process.env.CODALI_TEST_BROWSER_BINARY });
  const initial = JSON.parse((await open.handler({ url }, { workspaceRoot: '.' })).output);
  assert.equal(initial.scope, 'page'); assert.ok(initial.offset > 0);
  assert.match(initial.content, /Actual document/); assert.doesNotMatch(initial.content, /Navigation prefix/);
  const prefix = JSON.parse((await read.handler({ snapshotId: initial.snapshotId, offset: 0 }, { workspaceRoot: '.' })).output);
  assert.match(prefix.content, /Navigation prefix/);
  const entire = JSON.parse((await open.handler({ url, scope: 'page' }, { workspaceRoot: '.' })).output);
  assert.equal(entire.offset, 0); assert.match(entire.content, /Navigation prefix/);
});

test("research text keeps inline-rich qualifying prose together instead of spending the page on ARIA markup", { skip: !process.env.CODALI_TEST_BROWSER_BINARY, timeout: 45000 }, async t => {
  const intro = Array.from({length: 35}, (_, i) => `<a href="/ref-${i}">term${i}</a> <em>means</em> <strong>scope${i}</strong>. `).join("");
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<main><h1>Evidence handbook</h1><p>${intro}</p><h2>Limits</h2><p>Only the inspection component is wait-free; updates can wait. Capacity is not a rate.</p><p style="display:none">HIDDEN MISLEADING CLAIM</p></main>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as {port: number};
  const [open] = createBrowserTools({executablePath:process.env.CODALI_TEST_BROWSER_BINARY});
  const result = JSON.parse((await open.handler({url:`http://127.0.0.1:${address.port}/`},{workspaceRoot:"."})).output);
  assert.match(result.source,/rendered-text/);
  assert.match(result.content,/Only the inspection component is wait-free; updates can wait/);
  assert.match(result.content,/Capacity is not a rate/);
  assert.doesNotMatch(result.content,/HIDDEN MISLEADING/);
  assert.ok(result.nextOffset > 0); // remaining source links stay recoverable
});

test("plain-text specification searches prefer body over indented contents entries", () => {
  const doc = 'Table of Contents\n   1. Overview\n   2. Sender constraints\n\n1. Overview\nGeneral context\n\n2. Sender constraints\nRequired safeguards.';
  assert.equal(snapshotContentStart(doc), doc.indexOf('\n1. Overview') + 1);
  assert.equal(findSnapshotText(doc, 'Sender constraints')?.index, doc.lastIndexOf('Sender constraints'));
});

test("keyword lookup searches retained document text beyond the old cutoff", () => {
  const doc = 'unrelated text '.repeat(11000) + '\nProof rotation safeguards\n';
  const hit = findSnapshotText(doc, 'safeguards rotation proof');
  assert.equal(hit?.mode, 'ranked_terms'); assert.ok(hit!.index > 100000);
});

test("large primary documents retain readable evidence beyond 100k characters", { skip: !process.env.CODALI_TEST_BROWSER_BINARY, timeout: 45000 }, async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('Background paragraph.\n'.repeat(7000) + '\nMANDATORY_TAIL_EVIDENCE\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const [open, read] = createBrowserTools({ executablePath: process.env.CODALI_TEST_BROWSER_BINARY });
  const first = JSON.parse((await open.handler({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` }, { workspaceRoot: '.' })).output);
  assert.ok(first.totalChars > 100000); assert.equal(first.truncated, false);
  const tail = JSON.parse((await read.handler({ snapshotId: first.snapshotId, query: 'MANDATORY_TAIL_EVIDENCE' }, { workspaceRoot: '.' })).output);
  assert.ok(tail.offset > 100000); assert.match(tail.content, /MANDATORY_TAIL_EVIDENCE/);
  assert.ok(JSON.stringify(tail).length <= 3800);
});

test("reopening a captured URL reuses its snapshot and many snapshots stay readable", { skip: !process.env.CODALI_TEST_BROWSER_BINARY }, async t => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.setHeader("content-type", "text/html"); response.end(`<main>Evidence page ${requests}</main>`); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const [open, read] = createBrowserTools({ executablePath: process.env.CODALI_TEST_BROWSER_BINARY, timeoutMs: 20000 });
  const first = JSON.parse((await open.handler({ url: `${baseUrl}/a` }, { workspaceRoot: "." })).output);
  const served = requests;
  const again = JSON.parse((await open.handler({ url: `${baseUrl}/a` }, { workspaceRoot: "." })).output);
  assert.equal(again.snapshotId, first.snapshotId); assert.equal(again.reused, true); assert.equal(requests, served);
  for (const name of ["b", "c", "d", "e", "f"]) await open.handler({ url: `${baseUrl}/${name}` }, { workspaceRoot: "." });
  assert.match(JSON.parse((await read.handler({ snapshotId: first.snapshotId, offset: 0 }, { workspaceRoot: "." })).output).content, /Evidence page/);
  await assert.rejects(read.handler({ snapshotId: "missing", offset: 0 }, { workspaceRoot: "." }), /snap-1/);
});
