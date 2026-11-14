import { constants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createIsolatedExecutor } from "../shell/IsolatedExecutor.js";
import { ToolExecutionError, type ToolContext, type ToolDefinition, type ToolSchemaDefinition } from "../ToolTypes.js";

export interface DocumentToolOptions { pythonRoot?: string; }
export const defaultDocumentPythonRoot = () => process.env.CODALI_DOCUMENT_PYTHON_ROOT ?? path.join(os.homedir(), ".local/state/codali/tool-runtimes/documents-v1");
export const documentVersions = { "python-docx": "1.2.0", openpyxl: "3.1.5", pypdf: "6.21.4", reportlab: "5.1.0", defusedxml: "0.7.1", "charset-normalizer": "3.5.2", et_xmlfile: "2.0.0", lxml: "6.1.3", pillow: "13.0.0", typing_extensions: "4.16.0" };
const maxBytes = 8 * 1024 * 1024;
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const text = (maxLength: number): ToolSchemaDefinition => ({ type: "string", maxLength });
const scalar: ToolSchemaDefinition = { type: ["string", "number", "boolean", "null"], maxLength: 4000 };
const array = (items: ToolSchemaDefinition, maxItems: number, minItems = 0): ToolSchemaDefinition => ({ type: "array", items, maxItems, minItems });
const format: ToolSchemaDefinition = { type: "string", enum: ["md", "pdf", "docx", "xlsx"] };
const rows = array(array(scalar, 32), 500);
const object = (properties: Record<string, ToolSchemaDefinition>, required: string[]): ToolSchemaDefinition => ({ type: "object", properties, required, additionalProperties: false });

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** All input bytes are copied into a private worker directory; no workspace mount. */
async function documentPath(context: ToolContext, target: string, action: "read" | "write") {
  const root = await fs.realpath(context.workspaceRoot);
  const requested = path.resolve(context.workspaceRoot, target);
  if (!within(path.resolve(context.workspaceRoot), requested)) throw new Error("Document path is outside the workspace");
  const parent = await fs.realpath(path.dirname(requested)); // Existing directory required; no implicit broad write scope.
  const actual = path.join(parent, path.basename(requested));
  if (!within(root, actual)) throw new Error("Document path resolves outside the workspace");
  const relative = path.relative(root, actual);
  if (relative.split(path.sep).some(part => [".git", ".mcoda"].includes(part))) throw new Error("Document paths cannot address control metadata");
  const scopes = action === "read" ? context.allowedReadPaths : context.allowedWritePaths;
  if (scopes && !scopes.some(scope => within(path.resolve(root, scope), actual) && within(root, path.resolve(root, scope)))) throw new Error(`Document is outside allowed ${action} scopes`);
  await context.checkPath?.(actual, action);
  return { actual, relative, parent };
}

async function readBounded(file: string) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Document must be a regular file of at most 8 MiB");
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    let size = 0;
    while (size < buffer.length) { const result = await handle.read(buffer, size, buffer.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size !== stat.size) throw new Error("Document changed size while being read");
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

async function execute(operation: "read" | "create", input: unknown, context: ToolContext, options: DocumentToolOptions) {
  context.signal?.throwIfAborted();
  const { path: target, ...args } = input as { path: string; format?: string; [key: string]: unknown };
  const selectedFormat = args.format ?? path.extname(target).slice(1).toLowerCase();
  if (!["md", "pdf", "docx", "xlsx"].includes(selectedFormat as string) || path.extname(target).slice(1).toLowerCase() !== selectedFormat) throw new Error("Document format must match a .md, .pdf, .docx or .xlsx path");
  const destination = await documentPath(context, target, operation === "read" ? "read" : "write");
  if (operation === "create") {
    try { await fs.lstat(destination.actual); throw new Error("Document creation never overwrites an existing file; choose a new path"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const source = operation === "read" ? await readBounded(destination.actual) : undefined;
  const payload = JSON.stringify({ operation, args: { ...args, format: selectedFormat } });
  if (Buffer.byteLength(payload) > 256000) throw new Error("Document arguments exceed 256000 bytes");
  const runtime = path.resolve(options.pythonRoot ?? defaultDocumentPythonRoot());
  try { await fs.access(path.join(runtime, "pyvenv.cfg")); await fs.access(path.join(runtime, "bin/python")); }
  catch { throw new ToolExecutionError("tool_execution_failed", "Document runtime is missing. Run codali tools install --documents.", { retryable: false }); }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-document-"));
  const started = Date.now();
  try {
    await fs.chmod(root, 0o700);
    const worker = await fs.readFile(new URL("./worker.py", import.meta.url));
    await fs.writeFile(path.join(root, "worker.py"), worker, { mode: 0o600 });
    await fs.writeFile(path.join(root, "input.json"), payload, { mode: 0o600 });
    if (source) await fs.writeFile(path.join(root, "source"), source, { mode: 0o600 });
    await fs.mkdir(path.join(root, "output"), { mode: 0o700 });
    const observed = await createIsolatedExecutor({ network: false, readOnlyRuntimeRoots: [runtime] })(
      path.join(runtime, "bin/python"), ["-I", "-B", path.join(root, "worker.py")],
      { workspaceRoot: root, signal: context.signal, allowedWritePaths: operation === "create" ? ["output"] : [], shellTimeoutMs: 15000, shellMaxOutputBytes: 128000 });
    const observation = observed.data as { stdout: string; truncated: boolean };
    if (observation.truncated) throw new Error("Document observation exceeds its output limit");
    const data = JSON.parse(observation.stdout) as Record<string, unknown>;
    if (data.error) throw new Error(String(data.error));
    const versions = data.versions as Record<string, string>;
    if (Object.entries(documentVersions).some(([name, version]) => versions?.[name] !== version)) throw new Error("Document runtime versions differ from the pinned contract");
    if (operation === "create") {
      const bytes = await readBounded(path.join(root, "output/artifact"));
      if (data.bytes !== bytes.length || data.sha256 !== sha(bytes)) throw new Error("Generated document failed its byte/checksum receipt");
      const checked = await documentPath(context, target, "write");
      if (checked.actual !== destination.actual) throw new Error("Document destination changed during generation");
      const temporary = path.join(checked.parent, `.codali-document-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        context.signal?.throwIfAborted();
        await fs.link(temporary, checked.actual); // Atomic no-replace publication, including existing symlinks.
        context.recordTouchedFile?.(checked.relative);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    const receipt = { ...data, path: destination.relative, inputSha256: sha(source ?? payload), argumentsSha256: sha(payload),
      workerSha256: sha(worker), elapsedMs: Date.now() - started, isolation: "offline worker with copied input only" };
    return { output: JSON.stringify(receipt), data: receipt };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export const createDocumentTools = (options: DocumentToolOptions = {}): ToolDefinition[] => [
  { name: "document_read", capability: "workspace", readOnly: true,
    description: "Read a local PDF, DOCX, XLSX or UTF-8 Markdown file with bounded text/tables and checksum provenance. Reports truncation, uncalculated spreadsheet formulas and PDF pages needing OCR. No OCR, macros, network or formula evaluation.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: text(1000),
      maxChars: { type: "integer", minimum: 100, maximum: 24000 }, maxPages: { type: "integer", minimum: 1, maximum: 20 },
      maxRows: { type: "integer", minimum: 1, maximum: 200 }, maxSheets: { type: "integer", minimum: 1, maximum: 8 } } },
    handler: (args, context) => execute("read", args, context, options) },
  { name: "document_create", capability: "workspace", readOnly: false,
    description: "Create a new PDF/DOCX/Markdown from typed text blocks, or XLSX from literal typed sheet rows. Use an existing parent directory and new path. Returns a real file checksum and bounded read-back. Text/tables only; no images or formula calculation. PDF font supports a limited character set and fails rather than dropping unsupported characters.",
    inputSchema: { type: "object", additionalProperties: false, required: ["path", "format"], properties: { path: text(1000), format, title: text(300),
      blocks: array(object({ type: { type: "string", enum: ["heading", "paragraph", "bullet", "table"] }, text: text(8000), level: { type: "integer", minimum: 1, maximum: 6 }, headers: array(text(300), 16, 1), rows }, ["type"]), 100, 1),
      sheets: array(object({ name: { ...text(31), minLength: 1, pattern: "^[^\\\\/*?:\\[\\]]+$" }, rows, header: { type: "boolean" } }, ["name", "rows"]), 8, 1) } },
    handler: (args, context) => execute("create", args, context, options) },
];
