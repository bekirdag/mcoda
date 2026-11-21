import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { browserRefused, htmlToText, isPdf, pdfToText } from "../HttpFallback.js";
import { captureDirect, createBrowserTools } from "../BrowserTool.js";
import { defaultDocumentPythonRoot } from "../../documents/DocumentTools.js";
import { executorStatus } from "../../shell/IsolatedExecutor.js";

/** A small valid one-page PDF with a text layer, built with correct offsets. */
const pdfWith = (lines: string[]): Buffer => {
  const stream = `BT /F1 12 Tf 72 720 Td ${lines.map(line => `(${line.replace(/[()\\]/g, "\\$&")}) Tj 0 -16 Td`).join(" ")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let body = "%PDF-1.4\n"; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
};

const canExtract = async (): Promise<boolean> => executorStatus().available
  && (await fs.access(`${defaultDocumentPythonRoot()}/bin/python`).then(() => true, () => false)
    || (await Promise.all(String(process.env.PATH ?? "").split(":").map(directory => fs.access(`${directory}/pdftotext`).then(() => true, () => false)))).some(Boolean));

test("only failures that say nothing about the page itself lead to a plain read", () => {
  for (const message of ['page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.example.gov/', "page.goto: net::ERR_CONNECTION_REFUSED at https://web.archive.org/x",
    "page.goto: Timeout 25000ms exceeded.", "page.goto: net::ERR_ABORTED at https://example.org/report.pdf", "page.goto: Download is starting"]) assert.equal(browserRefused(message), true, message);
  // A name that does not resolve, a bad certificate or a worker crash is not worked around.
  for (const message of ["page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/", "page.goto: net::ERR_CERT_COMMON_NAME_INVALID at https://x.test/", "Browser worker exited before returning evidence (1)", "stop browser"]) assert.equal(browserRefused(message), false, message);
  assert.equal(isPdf("application/pdf", "https://example.org/a"), true);
  assert.equal(isPdf("text/html", "https://example.org/doc.pdf?download=true"), true);
  assert.equal(isPdf("text/html; charset=utf-8", "https://example.org/pdf-guide"), false);
});

test("static HTML becomes navigable text without running anything in it", () => {
  const html = `<html><head><title>Ruling &amp; orders</title><script>document.title="x"</script><style>p{}</style></head><body>
    <nav><a href="/home">Home</a></nav>
    <main><h1>Decision of 3&nbsp;June</h1><p>The court <b>dismissed</b> the appeal &mdash; costs follow.<br>Second line.</p>
    <h2>Orders</h2><ul><li>Appeal dismissed</li><li>Costs: <del>$4,000</del> $5,000</li></ul>
    <table><tr><th>Year</th><th>Cases</th></tr><tr><td>2025</td><td>41</td></tr></table>
    <p>See the <a href="/judgments/2026/12">full judgment</a> and <a href="javascript:alert(1)">a script</a>.</p>${"<p>Reasons continue here in detail.</p>".repeat(10)}</main>
    <script>window.secret = "never shown"</script></body></html>`;
  const page = htmlToText(html, "https://court.example/decisions/1");
  assert.equal(page.title, "Ruling & orders"); assert.equal(page.scope, "main");
  assert.match(page.content, /- heading "Decision of 3 June" \[level=1\]/);
  assert.match(page.content, /The court dismissed the appeal — costs follow\.\nSecond line\./);
  assert.match(page.content, /- heading "Orders" \[level=2\]\n+- Appeal dismissed\n- Costs: \[DELETED\/STRUCK-THROUGH TEXT — not current guidance: \$4,000\] \$5,000/);
  assert.match(page.content, /Year \| Cases\n2025 \| 41\n/);
  assert.match(page.content, /See the full judgment and a script\./);
  assert.match(page.content, /- link "full judgment"\n {2}- \/url: https:\/\/court\.example\/judgments\/2026\/12/);
  assert.doesNotMatch(page.content, /never shown|javascript:|document\.title|Home/);
  // Without a main landmark the whole body is read, minus navigation chrome.
  const plain = htmlToText("<body><header>Menu</header><p>Only paragraph.</p><footer>Imprint</footer></body>", "https://example.org/");
  assert.equal(plain.scope, "page"); assert.equal(plain.content, "Only paragraph.");
  assert.match(htmlToText("<body><header>Menu</header><p>Only paragraph.</p></body>", "https://example.org/", "page").content, /Menu/);
});

test("a PDF on the web is read as text, and a page is read directly when asked", async t => {
  if (!await canExtract()) { t.skip("no sandbox or PDF text extractor on this host"); return; }
  const pdf = pdfWith(["Annual report 2026", "Units restarted: 2 (Unit 6 on 9 February 2026)", "Total output 8,212 MW"]);
  const server = createServer((request, response) => {
    if (request.url === "/report.pdf") { response.writeHead(200, { "content-type": "application/pdf" }); response.end(pdf); }
    else if (request.url === "/scan.pdf") { response.writeHead(200, { "content-type": "application/pdf" }); response.end(pdfWith([])); }
    else if (request.url === "/notice") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end("<title>Notice</title><main><h1>Gazette notice 14</h1><p>In force from 2 June 2026.</p>" + "<p>Further provisions apply.</p>".repeat(12) + "</main>"); }
    else if (request.url === "/image") { response.writeHead(200, { "content-type": "image/png" }); response.end(Buffer.from([137, 80, 78, 71])); }
    else { response.writeHead(404, { "content-type": "text/html" }); response.end("<main><h1>Not found</h1></main>"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const report = await captureDirect(`${base}/report.pdf`, "main");
  assert.equal(report.format, "pdf_text"); assert.equal(report.httpStatus, 200);
  assert.match(report.content, /- heading "Page 1" \[level=2\]/);
  assert.match(report.content, /Unit 6 on 9 February 2026/); assert.match(report.content, /8,212 MW/);
  assert.match(report.notice!, /text extracted with (pypdf|pdftotext)/);
  // No text layer: said plainly, never an empty "retrieved" page.
  const scan = await captureDirect(`${base}/scan.pdf`, "main");
  assert.equal(scan.content, ""); assert.match(scan.notice!, /No text could be extracted/);
  const notice = await captureDirect(`${base}/notice`, "main");
  assert.equal(notice.format, "http_text"); assert.equal(notice.title, "Notice");
  assert.match(notice.content, /- heading "Gazette notice 14" \[level=1\]\nIn force from 2 June 2026\./);
  assert.equal((await captureDirect(`${base}/missing`, "main")).httpStatus, 404);
  assert.match((await captureDirect(`${base}/image`, "main")).notice!, /not readable as text/);
  assert.equal(await pdfToText(Buffer.from("<html>not a pdf</html>")), undefined);
});

test("a site that refuses the browser is still read, and the result says how", { skip: !process.env.CODALI_TEST_BROWSER_BINARY, timeout: 60000 }, async t => {
  // The server drops browser connections (as bot protection does) but answers a plain client.
  const server = createServer((request, response) => {
    if (request.headers["upgrade-insecure-requests"] || request.headers["sec-ch-ua"]) { request.socket.destroy(); return; }
    response.writeHead(200, { "content-type": "text/html" }); response.end("<title>Regulator</title><main><h1>Determination</h1><p>Penalty of $49.5 million imposed on 12 March 2026.</p>" + "<p>Background.</p>".repeat(12) + "</main>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const [open] = createBrowserTools({ executablePath: process.env.CODALI_TEST_BROWSER_BINARY });
  const data = JSON.parse((await open.handler({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/determination` }, { workspaceRoot: "." })).output);
  assert.equal(data.evidenceStatus, "retrieved");
  assert.match(data.content, /Penalty of \$49\.5 million imposed on 12 March 2026/);
  assert.match(data.source, /direct HTTP fetch without a browser/);
  assert.match(data.sourceNotice, /browser could not load this page/);
});
