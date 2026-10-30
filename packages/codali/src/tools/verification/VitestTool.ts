import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createIsolatedExecutor } from "../shell/IsolatedExecutor.js";
import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

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
  description: "Run Vitest on supplied JS/TS source and *.test.js/ts files in an offline temporary sandbox. Import vitest and supplied relative modules. No workspace/config/credentials. Reports supplied-test results, not independent proof; prefer verify_javascript for simple synchronous JSON cases.",
  inputSchema: { type: "object", properties: { files: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", properties: {
    path: { type: "string", minLength: 1, maxLength: 160 }, content: { type: "string", maxLength: 24000 },
  }, required: ["path", "content"], additionalProperties: false } } }, required: ["files"], additionalProperties: false },
  handler: async (raw, context) => {
    context.signal?.throwIfAborted();
    const args = raw as { files: Array<{ path: string; content: string }> };
    const payload = JSON.stringify(args);
    if (payload.length > 96000 || !Array.isArray(args.files) || !args.files.length || args.files.length > 12
      || args.files.some(file => !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?js|ts)$/.test(file.path)
        || file.path.split("/").some(segment => segment === "node_modules" || segment.startsWith(".")) || /(?:^|\/)(?:vite|vitest)\.config\./.test(file.path)
        || typeof file.content !== "string" || file.content.length > 24000)
      || new Set(args.files.map(file => file.path)).size !== args.files.length || !args.files.some(file => /\.test\.(?:[cm]?js|ts)$/.test(file.path))) {
      throw new ToolExecutionError("tool_invalid_args", "Supply up to 12 bounded source/test files with relative paths, including a *.test.js/ts file; no configs or node_modules");
    }
    const runtime = await runnerRuntime();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-vitest-"));
    const started = Date.now();
    try {
      await fs.chmod(root, 0o700);
      for (const file of args.files) {
        const target = path.join(root, file.path); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.content);
      }
      await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
      await fs.mkdir(path.join(root, "node_modules")); await fs.symlink(runtime.entry, path.join(root, "node_modules", "vitest"));
      await fs.mkdir(path.join(root, "artifacts"));
      const config = { cacheDir: path.join(root, "artifacts", "cache"), server: { host: "127.0.0.1", hmr: false }, test: { include: ["**/*.test.{js,ts,mjs,cjs}"], environment: "node", globals: false,
        pool: "forks", maxWorkers: 1, fileParallelism: false, testTimeout: 1000, hookTimeout: 1000, passWithNoTests: false, reporters: ["json"], outputFile: path.join(root, "artifacts", "report.json") } };
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
        assertions: report.testResults.flatMap((suite: { assertionResults?: Array<{ fullName: string; status: string; failureMessages?: string[] }> }) =>
          (suite.assertionResults ?? []).map(check => ({ name: check.fullName.slice(0, 200), status: check.status, failures: check.failureMessages?.map(message => message.slice(0, 500)).slice(0, 2) }))).slice(0, 64),
        sourceSha256: createHash("sha256").update(payload).digest("hex"), elapsedMs: Date.now() - started,
        scope: "Results reported by the supplied tests in an offline sandbox; not independent proof or a workspace test run" };
      return { output: JSON.stringify(result), data: result };
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
});
