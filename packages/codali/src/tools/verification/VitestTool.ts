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

/** Standard-library stand-in for the part of pytest that generated tests use. */
const PYTEST_STAND_IN = `import math,re
class _Raises:
 def __init__(self,expected,match=None): self.expected=expected; self.match=match; self.value=None
 def __enter__(self): return self
 def __exit__(self,kind,value,trace):
  if kind is None: raise AssertionError('DID NOT RAISE '+str(self.expected))
  if not issubclass(kind,self.expected): return False
  if self.match is not None and not re.search(self.match,str(value)): raise AssertionError('raised message '+repr(str(value))+' does not match '+repr(self.match))
  self.value=value; return True
def raises(expected,*args,match=None,**kwargs):
 if args:
  with _Raises(expected,match): args[0](*args[1:],**kwargs)
  return None
 return _Raises(expected,match)
class approx:
 def __init__(self,expected,rel=None,abs=None): self.expected=expected; self.rel=1e-6 if rel is None else rel; self.abs=1e-12 if abs is None else abs
 def _one(self,actual,expected): return math.isclose(actual,expected,rel_tol=self.rel,abs_tol=self.abs)
 def __eq__(self,actual):
  e=self.expected
  if isinstance(e,dict): return isinstance(actual,dict) and actual.keys()==e.keys() and all(self._one(actual[k],e[k]) for k in e)
  if isinstance(e,(list,tuple)): return len(actual)==len(e) and all(self._one(a,b) for a,b in zip(actual,e))
  return self._one(actual,e)
 def __ne__(self,actual): return not self.__eq__(actual)
 def __repr__(self): return 'approx('+repr(self.expected)+')'
def fail(reason=''): raise AssertionError(reason)
class _Mark:
 def parametrize(self,names,values,**ignored):
  keys=[n.strip() for n in names.split(',')] if isinstance(names,str) else list(names)
  def wrap(fn):
   rows=[tuple(v) if len(keys)>1 else (v,) for v in values]
   earlier=getattr(fn,'_codali_params',[()]); earlier_names=getattr(fn,'_codali_names',())
   fn._codali_params=[tuple(r)+tuple(e) for r in rows for e in earlier]; fn._codali_names=tuple(keys)+tuple(earlier_names)
   return fn
  return wrap
 def __getattr__(self,name): raise AttributeError('pytest.mark.'+name+' is not available in this runner; only parametrize is')
mark=_Mark()
def __getattr__(name): raise AttributeError('pytest.'+name+' is not available in this runner (stand-in provides raises, approx, fail and mark.parametrize); use the standard library')
`;

export const createVitestTool = (): ToolDefinition => ({
  name: "verify_tests", readOnly: true, capability: "verification",
  description: "Run supplied tests offline: runner vitest (default) for JS/TS, node for node:test, python for unittest classes and pytest-style test_ functions or Test classes in test_*.py (pytest.raises/approx/parametrize only; no fixtures, async tests or plugins). Use the requested language/runner without translating tests. No workspace/config/credentials. Reports supplied-test results, not independent proof.",
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
        // Models write pytest-style tests (plain test_* functions, pytest.raises,
        // approx, parametrize) far more often than unittest classes; cycle 6 lost
        // twelve test runs to "pytest is not installed". A small stand-in covers
        // that subset on the standard library; anything else says so by name.
        if (runner === "python" && !args.files.some(file => file.path === "pytest.py" || file.path.startsWith("pytest/"))) await fs.writeFile(path.join(root, "pytest.py"), PYTEST_STAND_IN);
        const python = `import unittest,sys,os,json,importlib.util,inspect
sys.path.insert(0,os.getcwd())
suite=unittest.TestSuite()
def one(name,fn,owner=None):
 sets=getattr(fn,'_codali_params',[()])
 for index,values in enumerate(sets):
  names=getattr(fn,'_codali_names',())
  kwargs=dict(zip(names,values))
  needed=[p for p in inspect.signature(fn).parameters if p not in kwargs and p!='self']
  def run(fn=fn,kwargs=kwargs,needed=needed):
   if inspect.iscoroutinefunction(fn) or inspect.isasyncgenfunction(fn): raise RuntimeError('async test '+name+' is not run by this runner: make it a plain function and call asyncio.run(...) inside it')
   if inspect.isgeneratorfunction(fn): raise RuntimeError('generator test '+name+' is not run by this runner: its body after the first yield would never execute')
   if needed: raise RuntimeError('fixture '+needed[0]+' is not available in this runner: build the value inside the test or use unittest setUp')
   if owner is None: return fn(**kwargs)
   target=owner()
   if hasattr(target,'setup_method'): target.setup_method(fn)
   try: getattr(target,fn.__name__)(**kwargs)
   finally:
    if hasattr(target,'teardown_method'): target.teardown_method(fn)
  yield unittest.FunctionTestCase(run,description=name+('['+str(index)+']' if len(sets)>1 else ''))
def cases(module):
 for name,item in sorted(vars(module).items()):
  if getattr(item,'__module__',None)!=module.__name__: continue
  if name.startswith('test') and inspect.isfunction(item): yield from one(name,item)
  elif name.startswith('Test') and inspect.isclass(item) and not issubclass(item,unittest.TestCase):
   for method,fn in sorted(vars(item).items()):
    if method.startswith('test') and inspect.isfunction(fn): yield from one(name+'.'+method,fn,item)
for i,file in enumerate(sys.argv[1:]):
 spec=importlib.util.spec_from_file_location('codali_test_'+str(i),file)
 module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
 suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
 suite.addTests(cases(module))
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
          if (!stat) throw new ToolExecutionError("tool_execution_failed", `Python tests could not start. This runner loads unittest.TestCase classes and plain test_* functions, with a stand-in for pytest.raises, pytest.approx and pytest.mark.parametrize; other third-party packages are not installed. Fix the reported import/syntax error.\n${testFailureSummary(output)}`, { details: { exitCode, output } });
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000) throw new Error("Invalid test report");
        }
        const report = runner === "node" ? { total: count("tests"), passedTests: count("pass"), failedTests: count("fail"), pendingTests: count("skipped") + count("todo") + count("cancelled") }
          : JSON.parse(await fs.readFile(reportPath, "utf8"));
        if (!Object.values(report).every(value => Number.isSafeInteger(value) && Number(value) >= 0) || report.total < 1) throw new ToolExecutionError("tool_execution_failed", `No complete test results were produced. Python requires test_* functions or unittest.TestCase methods named test_*; Node requires node:test cases. Zero executed tests cannot establish correctness.\n${testFailureSummary(output)}`, { details: { exitCode, output } });
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
