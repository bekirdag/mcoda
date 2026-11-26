import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

type TestRunner = "vitest" | "node" | "python";
interface TestFile { path: string; content: string; }

/** Which supplied files are tests. Explicitly listed files are run whatever
 * convention they follow: node's default names (x.test.js, x-test.js, x_test.js,
 * test-x.js, test.js, test/…), test_x.js, a file importing node:test or vitest;
 * Python test_x.py or x_test.py. Cycle 7 lost five runs to test_x.js. */
export function isTestFile(file: TestFile, runner: TestRunner): boolean {
  if (runner === "python") return /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(file.path);
  const named = /(?:^|\/)(?:[^/]+[._-](?:test|spec)|test[_-][^/]+|test)\.[cm]?[jt]s$|(?:^|\/)tests?\/[^/].*\.[cm]?[jt]s$/.test(file.path);
  // A name alone is not enough: test-fixtures.js or test/helpers.js with no
  // test call would run as one passing file-level "test" (review of .43).
  const declaresTests = /(?:^|[^\w.$])(?:test|it|describe|suite)(?:\.(?:only|skip|todo|each|concurrent|sequential))?\s*\(/m.test(file.content ?? "");
  return declaresTests && (named || (runner === "node" ? /["']node:test["']/ : /["']vitest["']/).test(file.content ?? ""));
}

let stdlibModules: Set<string> | null | undefined;
/** The sandbox interpreter's standard-library module names, computed once.
 * Undefined when Python is unavailable: then nothing is carried for Python. */
const pythonStdlib = (): Set<string> | undefined => {
  if (stdlibModules === undefined) {
    try {
      const names = execFileSync("python3", ["-I", "-c", "import sys;print(' '.join(sorted(sys.stdlib_module_names)))"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      stdlibModules = new Set(names.split(/\s+/).filter(Boolean));
      if (!stdlibModules.size) stdlibModules = null;
    } catch { stdlibModules = null; }
  }
  return stdlibModules ?? undefined;
};

/** Files a test imports from its own directory tree, with the paths that
 * would satisfy each import. Python names cannot be told from the standard
 * library, so they are reported as candidates, never as definite misses. */
export function localImports(files: TestFile[], runner: TestRunner): Array<{ file: string; specifier: string; candidates: string[] }> {
  const found: Array<{ file: string; specifier: string; candidates: string[] }> = [];
  for (const file of files) {
    if (typeof file?.content !== "string" || typeof file.path !== "string") continue;
    if (runner === "python") {
      const modules = [...file.content.matchAll(/^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b/gm)].map(match => match[1])
        .concat([...file.content.matchAll(/^[ \t]*import[ \t]+([A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*)/gm)].flatMap(match => match[1].split(",").map(item => item.trim())));
      for (const module of new Set(modules)) {
        const nested = module.replace(/\./g, "/"), top = module.split(".")[0];
        found.push({ file: file.path, specifier: module, candidates: [...new Set([`${nested}.py`, `${nested}/__init__.py`, `${top}.py`, `${top}/__init__.py`])] });
      }
      continue;
    }
    const base = path.posix.dirname(file.path);
    for (const match of file.content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"'\n]+)["']/g)) {
      const resolved = path.posix.normalize(path.posix.join(base, match[1]));
      if (resolved.startsWith("..")) continue;
      const extension = path.posix.extname(resolved);
      const candidates = [".js", ".mjs", ".cjs", ".ts"].includes(extension)
        ? [resolved, ...(runner === "vitest" && extension !== ".ts" ? [resolved.slice(0, -extension.length) + ".ts"] : [])]
        : extension ? [] : [".js", ".mjs", ".cjs", ...(runner === "vitest" ? [".ts"] : [])].flatMap(ext => [resolved + ext, `${resolved}/index${ext}`]);
      if (candidates.length) found.push({ file: file.path, specifier: match[1], candidates });
    }
  }
  return found;
}

/** The sandbox keeps nothing between calls. A test sent without the module it
 * imports, when an earlier call in the same session sent that module, gets the
 * session's latest version of it (cycle 7: 5 of 26 runs sent only the test).
 * Only an import that names the file is filled; nothing else is inferred. */
export function completeTestFiles(args: unknown, earlier: ReadonlyMap<string, string>): { args: unknown; carried: string[] } {
  const value = args as { runner?: TestRunner; files?: TestFile[] } | undefined;
  if (!value || !Array.isArray(value.files) || !earlier.size) return { args, carried: [] };
  const runner = value.runner ?? "vitest";
  if (!["vitest", "node", "python"].includes(runner)) return { args, carried: [] };
  const files = [...value.files], carried: string[] = [];
  // A Python import of a standard-library name (json, math, ...) must not
  // pull in a same-named session file that would shadow the library.
  const stdlib = runner === "python" ? pythonStdlib() : undefined;
  if (runner === "python" && !stdlib) return { args, carried: [] };
  for (const item of localImports(value.files, runner)) {
    if (stdlib?.has(item.specifier.split(".")[0])) continue;
    if (item.candidates.some(candidate => files.some(file => file?.path === candidate))) continue;
    const reuse = item.candidates.find(candidate => earlier.has(candidate));
    if (!reuse || files.length >= 12) continue;
    files.push({ path: reuse, content: earlier.get(reuse)! }); carried.push(reuse);
  }
  return carried.length ? { args: { ...value, files }, carried } : { args, carried };
}

const invalidRequest = (args: { runner?: unknown; files?: unknown }, runner: unknown, payload: string): string | undefined => {
  const problems: string[] = [];
  if (!["vitest", "node", "python"].includes(runner as string)) problems.push(`runner must be "vitest", "node" or "python", not ${JSON.stringify(runner)}`);
  if (payload.length > 96000) problems.push(`the request is ${payload.length} characters; the limit is 96000`);
  const files = args.files as TestFile[];
  if (!Array.isArray(files) || !files.length) problems.push("files must list the implementation and its tests (1 to 12 {path, content} objects)");
  else {
    if (files.length > 12) problems.push(`${files.length} files were sent; the limit is 12`);
    for (const file of files) {
      const name = JSON.stringify(typeof file?.path === "string" ? file.path : file?.path ?? null);
      if (typeof file?.path !== "string" || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?js|ts|py)$/.test(file.path)) problems.push(`${name} is not a relative path ending in .js, .mjs, .cjs, .ts or .py`);
      else if (runner === "python" && !file.path.endsWith(".py")) problems.push(`${name}: runner python takes only .py files`);
      else if (runner !== "python" && file.path.endsWith(".py")) problems.push(`${name}: .py files need runner "python"`);
      else if (runner === "node" && file.path.endsWith(".ts")) problems.push(`${name}: runner node cannot load TypeScript; use runner "vitest"`);
      else if (file.path.split("/").some(segment => segment === "node_modules" || segment.startsWith("."))) problems.push(`${name}: node_modules and dot-directories are not allowed`);
      else if (/(?:^|\/)(?:vite|vitest)\.config\./.test(file.path)) problems.push(`${name}: runner configs are not accepted`);
      if (typeof file?.content !== "string") problems.push(`${name} has no string content`);
      else if (file.content.length > 24000) problems.push(`${name} is ${file.content.length} characters; the limit per file is 24000`);
    }
    if (new Set(files.map(file => file?.path)).size !== files.length) problems.push("two files have the same path");
    if (!problems.length && ["vitest", "node", "python"].includes(runner as string) && !files.some(file => isTestFile(file, runner as TestRunner))) {
      problems.push(`none of ${files.map(file => file.path).join(", ")} is recognized as a test for runner ${runner}: ${runner === "python"
        ? "name the test file test_<name>.py or <name>_test.py"
        : `name it <name>.test.js, test_<name>.js or test-<name>.js, or import ${runner === "node" ? "node:test" : "vitest"} in it, and declare cases with test(), it() or describe()`}`);
    }
    if (!problems.length && runner !== "python") {
      const missing = localImports(files, runner as TestRunner).filter(item => !item.candidates.some(candidate => files.some(file => file.path === candidate)));
      for (const item of missing.slice(0, 4)) problems.push(`${item.file} imports "${item.specifier}", which is not among the files; include ${item.candidates[0]} with the implementation`);
    }
  }
  return problems.length ? `verify_tests did not run: ${problems.join("; ")}. Each call starts from an empty sandbox: send the implementation together with its tests.` : undefined;
};

export const createVitestTool = (): ToolDefinition => ({
  name: "verify_tests", readOnly: true, capability: "verification",
  description: "Run supplied tests offline: runner vitest (default) for JS/TS, node for node:test, python for unittest classes and pytest-style test_ functions or Test classes in test_*.py/*_test.py (pytest.raises/approx/parametrize only; no fixtures, async tests or plugins). JS tests: *.test.js, test_*.js, test-*.js or any file importing node:test/vitest. Send the implementation with its tests in every call. Use the requested language/runner without translating tests. No workspace/config/credentials. Reports supplied-test results, not independent proof.",
  inputSchema: { type: "object", properties: { runner: { type: "string", enum: ["vitest", "node", "python"] }, files: { type: "array", minItems: 1, maxItems: 12,
    description: "The implementation and its tests together; nothing persists between calls. Tests: Python test_*.py or *_test.py; JS *.test.js, test_*.js, test-*.js or a file importing node:test/vitest.", items: { type: "object", properties: {
    path: { type: "string", minLength: 1, maxLength: 160 }, content: { type: "string", maxLength: 24000 },
  }, required: ["path", "content"], additionalProperties: false } } }, required: ["files"], additionalProperties: false },
  handler: async (raw, context) => {
    context.signal?.throwIfAborted();
    const args = raw as { runner?: "vitest" | "node" | "python"; files: Array<{ path: string; content: string }> };
    const runner = args.runner ?? "vitest";
    const payload = JSON.stringify(args);
    const invalid = invalidRequest(args, runner, payload);
    if (invalid) throw new ToolExecutionError("tool_invalid_args", invalid);
    const testPaths = args.files.filter(file => isTestFile(file, runner)).map(file => file.path);
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
        const tests = testPaths.map(file => path.join(root, file));
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
          // A module missing from files is usually the implementation itself:
          // nothing persists between calls (cycle 7: five runs sent only tests).
          const absent = /ModuleNotFoundError: No module named '([A-Za-z_][\w.]*)'/.exec(output)?.[1];
          const missing = absent && !args.files.some(file => [`${absent.replace(/\./g, "/")}.py`, `${absent.split(".")[0]}.py`, `${absent.split(".")[0]}/__init__.py`].includes(file.path))
            ? ` Module '${absent}' is not among the files: each call starts from an empty sandbox, so if it is the code under test, include ${absent.replace(/\./g, "/")}.py in files together with the tests.` : "";
          if (!stat) throw new ToolExecutionError("tool_execution_failed", `Python tests could not start.${missing} This runner loads unittest.TestCase classes and plain test_* functions, with a stand-in for pytest.raises, pytest.approx and pytest.mark.parametrize; other third-party packages are not installed. Fix the reported import/syntax error.\n${testFailureSummary(output)}`, { details: { exitCode, output } });
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000) throw new Error("Invalid test report");
        }
        // node:test reports a file that declares no test as one passing test
        // named after the file. That is not a test case: leave it out, so a
        // helper-only run is "zero tests", never a pass.
        const fileLevelPasses = runner === "node" ? [...output.matchAll(/^ok \d+ - (.+?)\s*$/gm)].filter(match =>
          testPaths.some(file => match[1] === file || match[1] === path.join(root, file) || match[1].endsWith(`/${file}`))).length : 0;
        const report = runner === "node" ? { total: count("tests") - fileLevelPasses, passedTests: count("pass") - fileLevelPasses, failedTests: count("fail"), pendingTests: count("skipped") + count("todo") + count("cancelled") }
          : JSON.parse(await fs.readFile(reportPath, "utf8"));
        if (!Object.values(report).every(value => Number.isSafeInteger(value) && Number(value) >= 0) || report.total < 1) throw new ToolExecutionError("tool_execution_failed", `No complete test results were produced. Python requires test_* functions or unittest.TestCase methods named test_*; Node requires node:test cases declared with test(), it() or describe(); a file without them is not a test. Zero executed tests cannot establish correctness.\n${testFailureSummary(output)}`, { details: { exitCode, output } });
        const result = { library: runner === "node" ? "node:test" : "unittest", ...report,
          passed: exitCode === 0 && report.failedTests === 0 && report.pendingTests === 0 && report.passedTests === report.total,
          diagnostic: testFailureSummary(output).slice(0, 1800), sourceSha256: createHash("sha256").update(payload).digest("hex"), elapsedMs: Date.now() - started,
          scope: "Supplied tests executed in an offline sandbox; not independent proof or a workspace test run" };
        return { output: JSON.stringify(result), data: result };
      }
      if (!runtime) throw new Error("Vitest runtime unavailable");
      await fs.mkdir(path.join(root, "node_modules")); await fs.symlink(runtime.entry, path.join(root, "node_modules", "vitest"));
      const config = { cacheDir: path.join(root, "artifacts", "cache"), server: { host: "127.0.0.1", hmr: false }, test: { include: testPaths, environment: "node", globals: false,
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
