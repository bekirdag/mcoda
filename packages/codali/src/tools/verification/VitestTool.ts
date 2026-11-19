import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createIsolatedExecutor } from "../shell/IsolatedExecutor.js";
import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

/** Keep the diagnostic, not hundreds of characters of runner stack frames.
 * Vitest can put timeout/caused-by messages after STACK_TRACE_ERROR frames. */
export const testFailureSummary = (message: string): string => {
  const diagnostic = message.split("\n").filter(line => !/^\s+at\s/.test(line)).join("\n").trim();
  return diagnostic.length <= 900 ? diagnostic : `${diagnostic.slice(0, 350)}\n[…]\n${diagnostic.slice(-500)}`;
};

/** Resolve only the installed runner's dependency closure, never a workspace config. */
async function runnerRuntime() {
  const require = createRequire(import.meta.url);
  const entry = await fs.realpath(path.dirname(require.resolve("vitest/package.json")));
  const seen = new Set<string>(), mounts = new Set<string>();
  const visit = async (root: string) => {
    if (seen.has(root)) return;
    if (seen.size >= 256) throw Error("Test runner dependency closure is unexpectedly large");
    seen.add(root);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const marker = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`;
    const at = root.lastIndexOf(marker);
    if (at >= 0) {
      const containerEnd = root.indexOf(`${path.sep}node_modules${path.sep}`, at + marker.length);
      mounts.add(root.slice(0, containerEnd + "/node_modules".length));
    } else mounts.add(root);
    const resolver = createRequire(path.join(root, "package.json"));
    const optional = manifest.optionalDependencies ?? {};
    for (const dep of Object.keys({ ...manifest.dependencies, ...optional })) {
      let resolved: string | undefined;
      for (const candidate of resolver.resolve.paths(dep) ?? []) {
        try {
          const file = path.join(candidate, dep, "package.json");
          const pkg = JSON.parse(await fs.readFile(file, "utf8"));
          if (pkg.name === dep) { resolved = await fs.realpath(path.dirname(file)); break; }
        } catch { /* Try the next installed module search path. */ }
      }
      if (resolved) await visit(resolved);
      else if (!Object.prototype.hasOwnProperty.call(optional, dep)) throw Error(`Missing installed runner dependency: ${dep}`);
    }
  };
  await visit(entry);
  const version = JSON.parse(await fs.readFile(path.join(entry, "package.json"), "utf8")).version;
  // This patched v3 release installs on Node 20/22's npm without the v4.1
  // optional Vite/devtools peer cycle (npm/cli#9787). No peer checks are disabled.
  if (version !== "3.2.7") throw Error("Vitest runtime does not match the pinned version");
  return { entry, version, mounts: [...mounts] };
}

export const createVitestTool = (): ToolDefinition => ({
  name: "verify_tests", readOnly: true, capability: "verification",
  description: "Run supplied tests offline: runner vitest (default) for JS/TS, node for node:test, python for standard-library unittest (test_*.py). Use the requested language/runner without translating tests. No workspace/config/credentials. Reports supplied-test results, not independent proof.",
  inputSchema: { type: "object", properties: { runner: { type: "string", enum: ["vitest", "node", "python"] }, files: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", properties: {
    path: { type: "string", minLength: 1, maxLength: 160 }, content: { type: "string", maxLength: 24000 },
  }, required: ["path", "content"], additionalProperties: false } } }, required: ["files"], additionalProperties: false },
  handler: async (raw, context) => {
    context.signal?.throwIfAborted();
    const args = raw as { runner?: "vitest" | "node" | "python"; files: Array<{ path: string; content: string }> };
    const runner = args.runner ?? "vitest";
    const testPattern = runner === "python" ? /(?:^|\/)test_[^/]+\.py$/ : /\.test\.(?:[cm]?js|ts)$/;
    const payload = JSON.stringify(args);
    if (!["vitest", "node", "python"].includes(runner) || payload.length > 96000 || !Array.isArray(args.files) || !args.files.length || args.files.length > 12
      || args.files.some(file => !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?js|ts|py)$/.test(file.path)
        || (runner === "python" ? !file.path.endsWith(".py") : file.path.endsWith(".py") || runner === "node" && file.path.endsWith(".ts"))
        || file.path.split("/").some(segment => segment === "node_modules" || segment.startsWith(".")) || /(?:^|\/)(?:vite|vitest)\.config\./.test(file.path)
        || typeof file.content !== "string" || file.content.length > 24000)
      || new Set(args.files.map(file => file.path)).size !== args.files.length || !args.files.some(file => testPattern.test(file.path))) {
      throw new ToolExecutionError("tool_invalid_args", "Supply up to 12 bounded relative source/test files for the chosen runner: *.test.js/ts for Vitest, *.test.js/mjs/cjs for Node, test_*.py for Python. No configs or node_modules");
    }
    const runtime = runner === "vitest" ? await runnerRuntime() : undefined;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-vitest-"));
    const started = Date.now();
    try {
      await fs.chmod(root, 0o700);
      for (const file of args.files) {
        const target = path.join(root, file.path); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.content);
      }
      await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
      await fs.mkdir(path.join(root, "artifacts"));
      if (runner !== "vitest") {
        const tests = args.files.filter(file => testPattern.test(file.path)).map(file => path.join(root, file.path));
        const python = `import unittest,sys,os,json,importlib.util
sys.path.insert(0,os.getcwd())
suite=unittest.TestSuite()
for i,file in enumerate(sys.argv[1:]):
 spec=importlib.util.spec_from_file_location('codali_test_'+str(i),file)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
result=unittest.TextTestRunner(verbosity=2).run(suite)
data={'total':result.testsRun,'failedTests':len(result.failures)+len(result.errors)+len(result.unexpectedSuccesses),'pendingTests':len(result.skipped)+len(result.expectedFailures)}
data['passedTests']=data['total']-data['failedTests']-data['pendingTests']
with open('artifacts/native-report.json','w') as f:json.dump(data,f)
sys.exit(0 if result.wasSuccessful() and data['total']>0 and data['pendingTests']==0 else 1)`;
        let output = "", exitCode = 0;
        try {
          const run = await createIsolatedExecutor({ network: false })(runner === "node" ? process.execPath : "python3",
            runner === "node" ? ["--max-old-space-size=256", "--test", "--test-reporter=tap", ...tests] : ["-I", "-B", "-c", python, ...tests],
            { workspaceRoot: root, signal: context.signal, allowedWritePaths: ["artifacts"], shellTimeoutMs: 15000, shellMaxOutputBytes: 128000 });
          output = run.output;
        } catch (error) {
          if (!(error instanceof ToolExecutionError) || error.code !== "tool_execution_failed" || error.details?.exitCode !== 1) throw error;
          exitCode = 1; output = String(error.details?.output ?? error.message);
        }
        const count = (key: string) => Number([...output.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))].at(-1)?.[1] ?? NaN);
        const reportPath = path.join(root, "artifacts", "native-report.json");
        if (runner === "python") {
          const stat = await fs.lstat(reportPath).catch(() => undefined);
          if (!stat) throw new ToolExecutionError("tool_execution_failed", `Python tests could not start. This runner loads standard-library unittest.TestCase tests; third-party packages such as pytest are not installed. Fix the reported import/syntax error or use unittest.\n${testFailureSummary(output)}`, { details: { exitCode, output } });
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000) throw new Error("Invalid test report");
        }
        const report = runner === "node" ? { total: count("tests"), passedTests: count("pass"), failedTests: count("fail"), pendingTests: count("skipped") + count("todo") + count("cancelled") }
          : JSON.parse(await fs.readFile(reportPath, "utf8"));
        if (!Object.values(report).every(value => Number.isSafeInteger(value) && Number(value) >= 0) || report.total < 1) throw new ToolExecutionError("tool_execution_failed", `No complete test results were produced. Python requires unittest.TestCase methods named test_*; Node requires node:test cases. Zero executed tests cannot establish correctness.\n${testFailureSummary(output)}`, { details: { exitCode, output } });
        const result = { library: runner === "node" ? "node:test" : "unittest", ...report,
          passed: exitCode === 0 && report.failedTests === 0 && report.pendingTests === 0 && report.passedTests === report.total,
          diagnostic: testFailureSummary(output).slice(0, 1800), sourceSha256: createHash("sha256").update(payload).digest("hex"), elapsedMs: Date.now() - started,
          scope: "Supplied tests executed in an offline sandbox; not independent proof or a workspace test run" };
        return { output: JSON.stringify(result), data: result };
      }
      if (!runtime) throw new Error("Vitest runtime unavailable");
      await fs.mkdir(path.join(root, "node_modules")); await fs.symlink(runtime.entry, path.join(root, "node_modules", "vitest"));
      const config = { cacheDir: path.join(root, "artifacts", "cache"), server: { host: "127.0.0.1", hmr: false }, test: { include: ["**/*.test.{js,ts,mjs,cjs}"], environment: "node", globals: false,
        // macOS denies signaling separate child processes inside this sandbox.
        // Threads retain the same OS boundary without requiring signal grants.
        pool: "threads", maxWorkers: 1, fileParallelism: false, testTimeout: 1000, hookTimeout: 1000, passWithNoTests: false, reporters: ["json"], outputFile: path.join(root, "artifacts", "report.json") } };
      await fs.writeFile(path.join(root, "codali.config.mjs"), `export default ${JSON.stringify(config)};`);
      let exitCode = 0;
      let executionFailure: ToolExecutionError | undefined;
      try {
        await createIsolatedExecutor({ network: false, readOnlyRuntimeRoots: runtime.mounts })(process.execPath,
          ["--max-old-space-size=256", path.join(runtime.entry, "vitest.mjs"), "run", "--config", path.join(root, "codali.config.mjs"), "--configLoader", "native"],
          { workspaceRoot: root, signal: context.signal, allowedWritePaths: ["artifacts"], shellTimeoutMs: 15000, shellMaxOutputBytes: 128000 });
      } catch (error) {
        if (!(error instanceof ToolExecutionError) || error.code !== "tool_execution_failed" || error.details?.exitCode !== 1) throw error;
        exitCode = 1; executionFailure = error;
      }
      const reportPath = path.join(root, "artifacts", "report.json");
      let reportStat;
      try { reportStat = await fs.lstat(reportPath); }
      catch (error) { throw executionFailure ?? error; }
      if (reportStat.isSymbolicLink() || !reportStat.isFile() || reportStat.size > 256000) throw Error("Invalid test report");
      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      if (!Number.isInteger(report.numTotalTests) || report.numTotalTests < 1 || !Array.isArray(report.testResults)) throw Error("No complete test results were produced");
      const result = { library: "vitest", version: runtime.version, passed: exitCode === 0 && report.success === true && report.numFailedTests === 0 && report.numPassedTests === report.numTotalTests,
        total: report.numTotalTests, passedTests: report.numPassedTests, failedTests: report.numFailedTests, pendingTests: report.numPendingTests,
        assertions: report.testResults.flatMap((suite: { assertionResults?: Array<{ fullName: string; status: string; duration?: number; failureMessages?: string[] }> }) =>
          (suite.assertionResults ?? []).map(check => ({ name: check.fullName.slice(0, 200), status: check.status, durationMs: check.duration, failures: check.failureMessages?.map(testFailureSummary).slice(0, 2) })))
          .sort((a: { status: string }, b: { status: string }) => Number(b.status === "failed") - Number(a.status === "failed")).slice(0, 64),
        sourceSha256: createHash("sha256").update(payload).digest("hex"), elapsedMs: Date.now() - started,
        scope: "Results reported by the supplied tests in an offline sandbox; not independent proof or a workspace test run" };
      return { output: JSON.stringify(result), data: result };
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
});
