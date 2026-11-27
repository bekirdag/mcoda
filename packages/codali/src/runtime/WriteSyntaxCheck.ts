import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createIsolatedExecutor, type ExecutorStatus } from "../tools/shell/IsolatedExecutor.js";
import { ToolExecutionError } from "../tools/ToolTypes.js";
import { workspaceRelativePath } from "./StructuralEvidence.js";

export interface WriteSyntaxCheck {
  status: "passed" | "failed" | "unavailable";
  command: string[];
  output: string;
  fileHash?: string;
}

/** Syntax-only feedback: no source execution, network, writes, or unsafe fallback. */
export async function checkWrittenJavaScript(workspaceRoot: string, file: string, status: ExecutorStatus, signal?: AbortSignal): Promise<WriteSyntaxCheck | undefined> {
  if (!/\.[cm]?js$/i.test(file) || !status.available) return undefined;
  const command = ["node", "--check", file];
  let fileHash: string | undefined;
  try {
    const root = await fs.realpath(workspaceRoot);
    workspaceRelativePath(root, file);
    const absolute = await fs.realpath(path.resolve(root, file));
    workspaceRelativePath(root, absolute);
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024) return { status: "unavailable", command, output: "Syntax check requires a regular source file of at most 1 MiB." };
    const hash = async () => createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
    fileHash = await hash();
    const result = await createIsolatedExecutor({ status, network: false })("node", ["--check", absolute], {
      workspaceRoot: root, signal, allowedWritePaths: [], shellTimeoutMs: 5000, shellMaxOutputBytes: 6000,
    });
    if (fileHash !== await hash()) return { status: "unavailable", command, output: "Source changed during syntax checking." };
    return { status: "passed", command, fileHash, output: result.output };
  } catch (error) {
    return { status: error instanceof ToolExecutionError && error.code === "tool_execution_failed" ? "failed" : "unavailable",
      command, fileHash, output: (error instanceof Error ? error.message : String(error)).slice(0, 6000) };
  }
}
