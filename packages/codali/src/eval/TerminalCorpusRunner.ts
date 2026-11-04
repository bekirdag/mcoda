import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedExecutor } from "../tools/shell/IsolatedExecutor.js";
import { runProcess } from "../tools/shell/AsyncProcess.js";
import { loadOrchestrationConfig, type EffortLevel } from "../config/OrchestrationConfig.js";
import { terminalTaskCorpus, terminalCorpusHash, TERMINAL_CORPUS_VERSION, type TerminalCorpusTask } from "./TerminalTaskCorpus.js";

export interface TerminalGrade {
  passed: boolean;
  contractPassed: boolean;
  publicTestsPassed: boolean;
  publicTestCount: number;
  protectedFilesPreserved: boolean;
  scopePreserved: boolean;
  testsExtended: boolean;
  changedPaths: string[];
  failures: string[];
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Detect edits to the executed build between cases. Use an isolated package install for dependency pinning. */
export async function terminalClientBuildHash(root = fileURLToPath(new URL("../", import.meta.url))): Promise<string> {
  const digest = createHash("sha256");
  const visit = async (relative: string): Promise<void> => {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Evaluation build contains a symlink: ${file}`);
      if (entry.isDirectory()) { if (entry.name !== "__tests__") await visit(file); }
      else if (/\.(?:js|json|node)$/.test(entry.name)) digest.update(file).update("\0").update(await fs.readFile(path.join(root, file))).update("\0");
    }
  };
  await visit(""); return digest.digest("hex");
}
export async function materializeTerminalTask(task: TerminalCorpusTask, workspace: string): Promise<void> {
  await fs.mkdir(workspace, { mode: 0o700 });
  for (const [file, content] of Object.entries(task.files)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), content, { flag: "wx", mode: 0o600 });
  }
}

/** Only regular, bounded files enter the grading copy; it never executes agent code on the host. */
async function workspaceFiles(root: string, relative = "", output = new Map<string, string>()): Promise<Map<string, string>> {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!relative && [".git", ".mcoda"].includes(entry.name)) continue;
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await workspaceFiles(root, file, output);
    else {
      if (!entry.isFile()) throw new Error(`Nonregular evaluation file: ${file}`);
      if (output.size >= 200 || (await fs.stat(path.join(root, file))).size > 1048576) throw new Error("Evaluation workspace exceeds file bounds");
      output.set(file, await fs.readFile(path.join(root, file), "utf8"));
    }
  }
  return output;
}

export async function gradeTerminalTask(task: TerminalCorpusTask, workspace: string): Promise<TerminalGrade> {
  const result: TerminalGrade = { passed: false, contractPassed: false, publicTestsPassed: false, publicTestCount: 0,
    protectedFilesPreserved: false, scopePreserved: false, testsExtended: false, changedPaths: [], failures: [] };
  const grading = await fs.mkdtemp(path.join(os.tmpdir(), "codali-corpus-grade-"));
  try {
    const files = await workspaceFiles(workspace);
    result.changedPaths = [...new Set([...files.keys(), ...Object.keys(task.files)])]
      .filter(file => files.get(file) !== task.files[file]).sort();
    result.scopePreserved = result.changedPaths.every(file => task.allowedChanges.includes(file));
    result.protectedFilesPreserved = Object.entries(task.files).filter(([file]) => !task.allowedChanges.includes(file)).every(([file, content]) => files.get(file) === content);
    const requiredExtensions = task.grading?.testFilesToExtend ?? ["test/task.test.mjs"];
    result.testsExtended = requiredExtensions.every(file => files.has(file) && files.get(file) !== task.files[file]);
    for (const [file, content] of files) {
      await fs.mkdir(path.dirname(path.join(grading, file)), { recursive: true });
      await fs.writeFile(path.join(grading, file), content, { flag: "wx", mode: 0o600 });
    }
    const nonce = randomUUID(); const hidden = `.grade-${nonce}.mjs`;
    const entrypoint = task.grading?.entrypoint === undefined ? "src/task.mjs" : task.grading.entrypoint;
    const implementationImport = entrypoint === null ? "" : `import * as m from ${JSON.stringify(`./${entrypoint}`)};\n`;
    await fs.writeFile(path.join(grading, hidden), `import assert from 'node:assert/strict';\n${implementationImport}${task.hiddenChecks}\nconsole.log(${JSON.stringify(nonce)});\n`, { flag: "wx", mode: 0o600 });
    const execute = createIsolatedExecutor({ network: false });
    const context = { workspaceRoot: grading, allowedWritePaths: [], shellTimeoutMs: 15000, shellMaxOutputBytes: 131072 };
    try {
      const outcome = await execute(process.execPath, [hidden], context);
      result.contractPassed = outcome.output.trim() === nonce;
      if (!result.contractPassed) result.failures.push("Hidden contract did not finish with its completion receipt");
    } catch (error) { result.failures.push(`contract: ${String(error).slice(0, 2000)}`); }
    try {
      const outcome = await execute(process.execPath, ["--test", ...(task.grading?.publicTestFiles ?? ["test/task.test.mjs"])], context);
      result.publicTestCount = Number(outcome.output.match(/# tests (\d+)/)?.[1] ?? 0);
      const minimumTests = task.grading?.minimumPublicTests ?? 2;
      result.publicTestsPassed = result.publicTestCount >= minimumTests;
      if (!result.publicTestsPassed) result.failures.push(`Public suite must contain at least ${minimumTests} passing tests`);
    } catch (error) { result.failures.push(`public tests: ${String(error).slice(0, 2000)}`); }
    if (!result.scopePreserved) result.failures.push("Changes escaped the permitted paths");
    if (!result.protectedFilesPreserved) result.failures.push("User notes or package manifest changed");
    if (!result.testsExtended) result.failures.push("Public tests were not extended");
    result.passed = result.contractPassed && result.publicTestsPassed && result.scopePreserved && result.protectedFilesPreserved && result.testsExtended;
  } catch (error) { result.failures.push(String(error).slice(0, 2000)); }
  finally { await fs.rm(grading, { recursive: true, force: true }); }
  return result;
}

export interface TerminalCorpusRunOptions {
  configPath: string;
  outputRoot: string;
  effort?: EffortLevel;
  taskIds?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (record: Record<string, unknown>) => void;
  /** Trusted, versioned harness input, not model-supplied configuration. */
  corpus?: { version: string; hash: string; tasks: TerminalCorpusTask[]; limitations: string[] };
}

/** Serial admission avoids confounding model comparisons with self-induced queue contention. */
export async function runTerminalCorpus(options: TerminalCorpusRunOptions): Promise<void> {
  const resolved = await loadOrchestrationConfig(options.configPath);
  const clientBuildHash = await terminalClientBuildHash();
  const all = options.corpus?.tasks ?? terminalTaskCorpus();
  if (options.taskIds?.some(id => !all.some(task => task.id === id))) throw new Error("Unknown terminal corpus task ID");
  const selected = options.taskIds ? all.filter(task => options.taskIds!.includes(task.id)) : all.filter(task => task.split === "held-out");
  await fs.mkdir(options.outputRoot, { mode: 0o700 });
  const manifest = { schemaVersion: 1, corpusVersion: options.corpus?.version ?? TERMINAL_CORPUS_VERSION, corpusHash: options.corpus?.hash ?? terminalCorpusHash(),
    configHash: resolved.hash, clientBuildHash, nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    effort: options.effort ?? "high", taskIds: selected.map(task => task.id), splits: [...new Set(selected.map(task => task.split))], startedAt: new Date().toISOString(),
    limitations: options.corpus?.limitations ?? ["60 seeded cases across 12 correlated coding families; report families separately. Does not qualify long-session planning, media or production coexistence."] };
  await fs.writeFile(path.join(options.outputRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  for (const task of selected) {
    options.signal?.throwIfAborted();
    const current = await loadOrchestrationConfig(options.configPath);
    if (current.hash !== resolved.hash) throw new Error("Evaluation configuration changed between tasks; start a separately identified run");
    if (await terminalClientBuildHash() !== clientBuildHash) throw new Error("Evaluation client build changed between tasks; use a frozen package install");
    const workspace = path.join(options.outputRoot, task.id);
    await materializeTerminalTask(task, workspace);
    await runProcess("git", ["-c", "core.hooksPath=/dev/null", "init", "--quiet"], { workspaceRoot: workspace, shellTimeoutMs: 10000 });
    await runProcess("git", ["-c", "core.hooksPath=/dev/null", "add", "--", ...Object.keys(task.files)], { workspaceRoot: workspace, shellTimeoutMs: 10000 });
    await runProcess("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Codali evaluation", "-c", "user.email=codali-evaluation@localhost", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Evaluation fixture baseline"], { workspaceRoot: workspace, shellTimeoutMs: 10000 });
    const startedAt = new Date().toISOString(); const logPath = path.join(options.outputRoot, `${task.id}.jsonl`);
    options.onProgress?.({ type: "task_start", taskId: task.id, workspace, startedAt });
    const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
    let bytes = 0; let overflow = false; let timedOut = false; let launchError: string | undefined;
    const child = spawn(process.execPath, [cli, "exec", task.prompt, "--workspace-root", workspace, "--config", path.resolve(options.configPath),
      "--permissions", "workspace", "--effort", options.effort ?? "high", "--json"], {
      cwd: workspace, env: { ...process.env }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    const stop = () => { kill("SIGTERM"); escalation ??= setTimeout(() => kill("SIGKILL"), 3000); escalation.unref(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 900000);
    const capture = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 50 * 1024 * 1024) { if (!log.write(chunk)) { child.stdout.pause(); child.stderr.pause(); log.once("drain", () => { child.stdout.resume(); child.stderr.resume(); }); } }
      else { overflow = true; stop(); }
    };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", error => { launchError = error.message; });
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    const exitCode = await new Promise<number | null>(resolve => { child.once("close", resolve); });
    clearTimeout(timer); if (escalation) clearTimeout(escalation); options.signal?.removeEventListener("abort", stop);
    log.end(); await finished(log);
    const events: Array<Record<string, unknown>> = [];
    const contents = await fs.readFile(logPath, "utf8");
    for (const line of contents.split("\n")) { try { const value = JSON.parse(line); if (value && typeof value === "object") events.push(value); } catch { /* stderr diagnostics are not events */ } }
    const grade = await gradeTerminalTask(task, workspace);
    const result = { taskId: task.id, family: task.family, variant: task.variant, split: task.split, startedAt, endedAt: new Date().toISOString(), exitCode,
      timedOut, overflow, launchError, passed: grade.passed && exitCode === 0 && !timedOut && !overflow && !launchError,
      grade, logSha256: hash(contents), configHash: resolved.hash, clientBuildHash,
      turnResult: [...events].reverse().find(event => event.type === "turn_result")?.data,
      usage: [...events].reverse().find(event => event.type === "usage")?.data,
      routes: events.filter(event => event.type === "model_route").map(event => event.data),
    };
    await fs.writeFile(path.join(options.outputRoot, `${task.id}.result.json`), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await fs.appendFile(path.join(options.outputRoot, "results.jsonl"), JSON.stringify(result) + "\n", { mode: 0o600 });
    options.onProgress?.({ type: "task_result", taskId: task.id, passed: result.passed, exitCode, failures: grade.failures, endedAt: result.endedAt });
  }
}
