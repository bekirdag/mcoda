import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createDocumentTools, defaultDocumentPythonRoot, type DocumentToolOptions } from "./DocumentTools.js";
import { ToolRegistry } from "../ToolRegistry.js";
import type { DeterministicRuntimeCheck } from "../deterministic/DeterministicRuntime.js";

export async function inspectDocumentRuntime(options: DocumentToolOptions = {}) {
  const pythonRoot = path.resolve(options.pythonRoot ?? defaultDocumentPythonRoot());
  let installed = false, workerSha256: string | undefined;
  try { await fs.access(path.join(pythonRoot, "pyvenv.cfg")); await fs.access(path.join(pythonRoot, "bin/python")); installed = true; } catch { /* Host setup required. */ }
  try { workerSha256 = createHash("sha256").update(await fs.readFile(new URL("./worker.py", import.meta.url))).digest("hex"); } catch { /* Build/package incomplete. */ }
  return { pythonRoot, installed, workerSha256, checkCommand: "codali tools check --documents", installCommand: "codali tools install --documents",
    note: "Metadata only. Check real file creation/extraction before relying on the runtime." };
}

export async function checkDocumentRuntime(options: DocumentToolOptions = {}, signal?: AbortSignal): Promise<DeterministicRuntimeCheck[]> {
  const registry = new ToolRegistry(); for (const tool of createDocumentTools(options)) registry.register(tool);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-document-check-"));
  const checks: DeterministicRuntimeCheck[] = [];
  try {
    await fs.chmod(root, 0o700);
    for (const format of ["md", "pdf", "docx", "xlsx"]) {
      signal?.throwIfAborted(); const started = Date.now();
      try {
        const args = format === "xlsx" ? { sheets: [{ name: "Values", rows: [["Label", "Value"], ["Checked", 42], ["Literal", "=1+1"]] }] }
          : { title: "Runtime check", blocks: [{ type: "paragraph", text: "Checked value: 42." }] };
        const created = await registry.execute("document_create", { path: `probe.${format}`, format, ...args }, { workspaceRoot: root, signal });
        if (!created.ok) throw new Error(created.error?.message ?? "Document creation failed");
        const read = await registry.execute("document_read", { path: `probe.${format}` }, { workspaceRoot: root, signal });
        if (!read.ok) throw new Error(read.error?.message ?? "Document extraction failed");
        const data = read.data as Record<string, unknown>;
        const serialized = JSON.stringify(data);
        const passed = format === "xlsx" ? serialized.includes('["Checked",42]') && serialized.includes('"formulas":[]') && serialized.includes('"=1+1"') : serialized.includes("Checked value: 42.");
        checks.push({ name: `document_${format}`, passed, library: "local document runtime", version: "v1", elapsedMs: Date.now() - started,
          ...(passed ? {} : { error: "Created file did not preserve the independent check value" }) });
      } catch (error) {
        signal?.throwIfAborted(); checks.push({ name: `document_${format}`, passed: false, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return checks;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
