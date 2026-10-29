import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { createDocumentTools, defaultDocumentPythonRoot } from "../DocumentTools.js";
import { inspectDocumentRuntime } from "../DocumentRuntime.js";
import { ToolRegistry } from "../../ToolRegistry.js";

const registry = () => { const tools = new ToolRegistry(); for (const tool of createDocumentTools()) tools.register(tool); return tools; };
const fixture = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-document-test-")); t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
};
const python = async (root: string, script: string) => promisify(execFile)(path.join(defaultDocumentPythonRoot(), "bin/python"), ["-I", "-B", "-c", script, root], { timeout: 10000, maxBuffer: 100000, env: { PATH: process.env.PATH } });
const blocks = [{ type: "heading", level: 2, text: "Observations" }, { type: "paragraph", text: "Verified value: 42. <not markup>" },
  { type: "table", headers: ["Item", "Count"], rows: [["A", 3], ["B", 5]] }, { type: "bullet", text: "Check the source." }];

test("real Markdown, PDF and DOCX files preserve text/tables and bind exact bytes", async t => {
  const root = await fixture(t), tools = registry();
  for (const format of ["md", "pdf", "docx"]) {
    const touched: string[] = [];
    const result = await tools.execute("document_create", { path: `report.${format}`, format, title: "Test report", blocks },
      { workspaceRoot: root, allowedWritePaths: [`report.${format}`], recordTouchedFile: file => touched.push(file) });
    assert.equal(result.ok, true, result.output);
    const data = result.data as { bytes: number; sha256: string; versions: Record<string, string> };
    const file = await fs.readFile(path.join(root, `report.${format}`));
    assert.equal(data.bytes, file.length); assert.equal(data.sha256, createHash("sha256").update(file).digest("hex"));
    assert.deepEqual(touched, [`report.${format}`]);
    const extracted = await tools.execute("document_read", { path: `report.${format}` }, { workspaceRoot: root });
    assert.equal(extracted.ok, true, extracted.output); assert.match(extracted.output, /Verified value: 42/);
    assert.match(extracted.output, /not markup/); assert.match(extracted.output, /Count/);
    if (format === "pdf") assert.equal(file.subarray(0, 5).toString(), "%PDF-");
  }
  // Inspect the actual OOXML body independently of the creating/extracting library.
  const inspected = await python(root, "import sys,zipfile,xml.etree.ElementTree as E; from pathlib import Path; z=zipfile.ZipFile(Path(sys.argv[1])/'report.docx'); r=E.fromstring(z.read('word/document.xml')); ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}; print(len(r.findall('.//w:tbl',ns))); print('|'.join(x.text or '' for x in r.findall('.//w:t',ns)))");
  assert.match(inspected.stdout, /^1\n/); assert.match(inspected.stdout, /Item\|Count\|A\|3\|B\|5/);
});

test("XLSX stores typed values and formula-looking input as literal text", async t => {
  const root = await fixture(t), tools = registry();
  const result = await tools.execute("document_create", { path: "values.xlsx", format: "xlsx", sheets: [{ name: "Inputs", rows: [["Key", "Value"], ["exact integer", "9007199254740993"], ["number", 42], ["formula-looking", "=SUM(1,1)"], ["boolean", true]] }] }, { workspaceRoot: root });
  assert.equal(result.ok, true, result.output);
  const read = await tools.execute("document_read", { path: "values.xlsx" }, { workspaceRoot: root });
  assert.equal(read.ok, true, read.output);
  const data = read.data as { sheets: Array<{ rows: unknown[][]; formulas: unknown[]; formulaValuesVerified: boolean }> };
  assert.deepEqual(data.sheets[0].rows[1], ["exact integer", "9007199254740993"]);
  assert.deepEqual(data.sheets[0].rows[2], ["number", 42]); assert.deepEqual(data.sheets[0].formulas, []);
  const inspected = await python(root, "import sys,zipfile,xml.etree.ElementTree as E; from pathlib import Path; z=zipfile.ZipFile(Path(sys.argv[1])/'values.xlsx'); r=E.fromstring(z.read('xl/worksheets/sheet1.xml')); ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}; print(len(r.findall('.//s:f',ns))); print(E.tostring(r,encoding='unicode'))");
  assert.match(inspected.stdout, /^0\n/); assert.match(inspected.stdout, /9007199254740993/); assert.match(inspected.stdout, /=SUM\(1,1\)/);
});

test("reading existing formulas, blank PDF pages and bounded content discloses limitations", async t => {
  const root = await fixture(t), tools = registry();
  await python(root, "import sys; from pathlib import Path; from openpyxl import Workbook; from reportlab.pdfgen.canvas import Canvas; p=Path(sys.argv[1]); w=Workbook(); s=w.active; s.append(['Value']); s.append(['=1+1']); s.append([99]); w.save(p/'formula.xlsx'); c=Canvas(str(p/'blank.pdf')); c.rect(0,0,10,10); c.showPage(); c.save()");
  const sheet = await tools.execute("document_read", { path: "formula.xlsx", maxRows: 2 }, { workspaceRoot: root });
  assert.equal(sheet.ok, true, sheet.output); assert.match(sheet.output, /"truncated":true/);
  assert.match(sheet.output, /"expression":"=1\+1"/); assert.match(sheet.output, /"formulaValuesVerified":false/);
  const pdf = await tools.execute("document_read", { path: "blank.pdf" }, { workspaceRoot: root });
  assert.equal(pdf.ok, true, pdf.output); assert.match(pdf.output, /no_extractable_text/); assert.match(pdf.output, /No OCR was performed/);
  await fs.writeFile(path.join(root, "long.md"), "x".repeat(200));
  const md = await tools.execute("document_read", { path: "long.md", maxChars: 100 }, { workspaceRoot: root });
  assert.equal((md.data as { text: string }).text.length, 100); assert.equal((md.data as { truncated: boolean }).truncated, true);
});

test("document path scopes, symlinks, replacement and cancellation are enforced", async t => {
  const root = await fixture(t), outside = await fixture(t), tools = registry();
  const args = { path: "report.md", format: "md", blocks };
  const denied = await tools.execute("document_create", args, { workspaceRoot: root, allowedWritePaths: [] });
  assert.equal(denied.ok, false); assert.deepEqual(await fs.readdir(root), []);
  await fs.writeFile(path.join(root, "report.md"), "Keep original");
  assert.equal((await tools.execute("document_create", args, { workspaceRoot: root })).ok, false);
  assert.equal(await fs.readFile(path.join(root, "report.md"), "utf8"), "Keep original");
  await fs.writeFile(path.join(outside, "secret.md"), "PRIVATE"); await fs.symlink(outside, path.join(root, "escape"));
  for (const name of ["document_read", "document_create"]) {
    const result = await tools.execute(name, name === "document_read" ? { path: "escape/secret.md" } : { ...args, path: "escape/new.md" }, { workspaceRoot: root });
    assert.equal(result.ok, false); assert.doesNotMatch(result.output, /PRIVATE/);
  }
  await fs.symlink(path.join(root, "report.md"), path.join(root, "link.md"));
  assert.equal((await tools.execute("document_read", { path: "link.md" }, { workspaceRoot: root })).ok, false);
  assert.equal((await tools.execute("document_read", { path: "report.md" }, { workspaceRoot: root, allowedReadPaths: [] })).ok, false);
  const abort = new AbortController(); abort.abort(new Error("Cancelled check"));
  await assert.rejects(tools.execute("document_create", { ...args, path: "cancelled.md" }, { workspaceRoot: root, signal: abort.signal }), /Cancelled check/);
  await assert.rejects(fs.access(path.join(root, "cancelled.md")));
});

test("invalid documents and unsupported rendering fail without publishing a fake artifact", async t => {
  const root = await fixture(t), tools = registry();
  for (const args of [
    { path: "bad.pdf", format: "pdf", blocks: [{ type: "paragraph", text: "漢字" }] },
    { path: "bad.docx", format: "docx", blocks: [{ type: "table", headers: ["A"], rows: [[1, 2]] }] },
    { path: "bad.xlsx", format: "xlsx", sheets: [{ name: "A", rows: [] }, { name: "a", rows: [] }] },
    { path: "mismatch.docx", format: "pdf", blocks },
  ]) {
    const result = await tools.execute("document_create", args, { workspaceRoot: root }); assert.equal(result.ok, false);
    await assert.rejects(fs.access(path.join(root, args.path)));
  }
  await fs.writeFile(path.join(root, "fake.pdf"), "This is not a PDF.");
  assert.equal((await tools.execute("document_read", { path: "fake.pdf" }, { workspaceRoot: root })).ok, false);
  await python(root, "import sys,zipfile; from pathlib import Path; z=zipfile.ZipFile(Path(sys.argv[1])/'oversized.docx','w',compression=zipfile.ZIP_DEFLATED); z.writestr('word/document.xml','x'*(34*1024*1024)); z.close()");
  const oversized = await tools.execute("document_read", { path: "oversized.docx" }, { workspaceRoot: root });
  assert.equal(oversized.ok, false); assert.match(oversized.error?.message ?? "", /expands beyond/);
  const metadata = await inspectDocumentRuntime({ pythonRoot: path.join(root, "absent-runtime") });
  assert.equal(metadata.installed, false); assert.match(metadata.workerSha256 ?? "", /^[a-f0-9]{64}$/);
});
