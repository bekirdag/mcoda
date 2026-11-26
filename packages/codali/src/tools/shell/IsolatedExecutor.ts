import { type Dirent, existsSync, lstatSync, realpathSync, statSync, readdirSync, mkdirSync, mkdtempSync, rmSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runProcess } from "./AsyncProcess.js";
import { resolveShellWorkingDirectory } from "./ShellWorkingDirectory.js";
import { ToolExecutionError, type ToolContext, type ToolHandlerResult } from "../ToolTypes.js";
import { discoverHostToolchain, extraRuntimeMounts, venvInterpreter, type HostRuntime } from "./HostToolchain.js";

export interface ExecutorStatus { available: boolean; backend: "bubblewrap" | "sandbox-exec" | "unavailable"; reason?: string; }

/** All paths have been canonicalized by the host, before launching the sandbox. */
export const darwinSandboxProfile = (root: string, scratch: string, writePaths: string[], runtimes: HostRuntime[], network = false, runtimeRoots: string[] = [], protectedPaths: string[] = [], cacheRoot?: string, sessionScratch?: string): string => {
  const quoted = (value: string) => JSON.stringify(value);
  const ancestors = new Set<string>();
  for (const target of [root, scratch, ...(cacheRoot ? [cacheRoot] : []), ...(sessionScratch ? [sessionScratch] : []), ...runtimeRoots, ...extraRuntimeMounts(runtimes).map(runtime => runtime.readOnlyRoot)]) {
    for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.add(parent);
  }
  return [
    "(version 1)", "(deny default)", "(allow process*)", "(allow sysctl-read)",
    // dyld opens the root directory when locating its shared cache. This literal
    // permits the directory itself, never a recursive read of the filesystem.
    '(allow file-read* (literal "/"))',
    // macOS exposes these system aliases before resolving /private/... paths.
    // Metadata on the aliases permits traversal, never reading their siblings.
    '(allow file-read-metadata (literal "/var") (literal "/tmp") (literal "/etc"))',
    // realpath/lstat needs ancestor metadata, not directory contents or sibling files.
    ...[...ancestors].map(parent => `(allow file-read-metadata (literal ${quoted(parent)}))`),
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/private/etc") (subpath "/dev"))',
    // Git and other native tools open the null device read/write for discarded IO.
    '(allow file-write-data (literal "/dev/null"))',
    // Apple's /bin/sh reads this system selector before starting npm scripts.
    // Permit only that selector, not other private /var files or directories.
    '(allow file-read* (literal "/private/var/select/sh") (literal "/var/select/sh"))',
    '(allow file-read-metadata (literal "/private/var/select") (literal "/var/select"))',
    `(allow file-read* (subpath ${quoted(root)}))`,
    ...runtimeRoots.map(runtime => `(allow file-read* (subpath ${quoted(runtime)}))`),
    ...extraRuntimeMounts(runtimes).map(runtime => `(allow file-read* (${runtime.directory ? "subpath" : "literal"} ${quoted(runtime.readOnlyRoot)}))`),
    `(allow file-read* file-write* (subpath ${quoted(scratch)}))`,
    ...(cacheRoot ? [`(allow file-read* file-write* (subpath ${quoted(cacheRoot)}))`, `(deny file-write-unlink (literal ${quoted(cacheRoot)}))`] : []),
    ...(sessionScratch ? [`(allow file-read* file-write* (subpath ${quoted(sessionScratch)}))`, `(deny file-write-unlink (literal ${quoted(sessionScratch)}))`] : []),
    ...writePaths.map(file => `(allow file-write* (subpath ${quoted(file)}))`),
    ...[".git", ".mcoda"].map(dir => `(deny file-write* (subpath ${quoted(path.join(root, dir))}))`),
    ...protectedPaths.map(file => `(deny file-write* (subpath ${quoted(file)}))`),
    // Renaming a directory that holds a protected file would move the file
    // away and let the command recreate its path with other content.
    ...[...new Set(protectedPaths.flatMap(file => {
      const holders: string[] = [];
      for (let directory = path.dirname(file); directory !== root && directory.startsWith(`${root}/`); directory = path.dirname(directory)) {
        if (writePaths.some(scope => directory === scope || directory.startsWith(`${scope}/`))) holders.push(directory);
      }
      return holders;
    }))].map(directory => `(deny file-write-unlink (literal ${quoted(directory)}))`),
    network ? "(allow network*)" : "(deny network*)",
  ].join("\n");
};

const bubblewrapRoot = (): string[] => {
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/usr", "/usr", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const dir of ["/bin", "/sbin", "/lib", "/lib64"]) if (existsSync(dir)) args.push("--ro-bind", realpathSync(dir), dir);
  // Debian/Ubuntu BLAS and LAPACK sonames pass through /etc/alternatives.
  // Expose only library targets already inside system library roots, not /etc
  // or the other configured alternatives. ffprobe needs these on Ubuntu 22.04.
  if (existsSync("/etc/ld.so.cache")) args.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
  // Toolchain installers inspect this public distribution descriptor. Do not
  // expose all of /etc merely to identify the operating system.
  if (existsSync("/etc/os-release")) args.push("--ro-bind", realpathSync("/etc/os-release"), "/etc/os-release");
  // Public system font selection is needed for reproducible browser rendering.
  // User font settings/profiles and the rest of /etc remain inaccessible.
  if (existsSync("/etc/fonts")) args.push("--ro-bind", realpathSync("/etc/fonts"), "/etc/fonts");
  if (existsSync("/etc/alternatives")) for (const name of readdirSync("/etc/alternatives")) {
    // Commands such as awk are aliases through /etc/alternatives to a binary
    // under /usr/bin that is already visible; without the alias the command
    // is "not found" inside the sandbox.
    const library = /^lib[^/]+\.so(?:\..+)?$/.test(name);
    try {
      const alias = path.join("/etc/alternatives", name), target = realpathSync(alias);
      if (!(library ? ["/usr/lib/", "/usr/lib64/", "/lib/", "/lib64/"] : ["/usr/bin/", "/bin/"]).some(prefix => target.startsWith(prefix)) || !statSync(target).isFile()) continue;
      args.push("--ro-bind", target, alias);
    } catch { /* A broken optional system-library alternative is not mounted. */ }
  }
  return args;
};

export const executorStatus = (): ExecutorStatus => {
  if (process.platform === "linux") {
    if (!existsSync("/usr/bin/bwrap")) return { available: false, backend: "unavailable", reason: "Install bubblewrap to enable isolated shell execution" };
    // On a busy host the probe itself can take seconds. A probe that ran out of
    // time says nothing about user namespaces, so it is tried again with more
    // time before the sandbox is declared missing (a full test run on a loaded
    // machine skipped fourteen sandbox tests for this reason).
    let probe = spawnSync("/usr/bin/bwrap", [...bubblewrapRoot(), "--", "/usr/bin/true"], { timeout: 3000, stdio: "ignore" });
    const timedOut = () => probe.status === null && ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || probe.signal === "SIGTERM");
    if (timedOut()) probe = spawnSync("/usr/bin/bwrap", [...bubblewrapRoot(), "--", "/usr/bin/true"], { timeout: 20000, stdio: "ignore" });
    return probe.status === 0 ? { available: true, backend: "bubblewrap" }
      : { available: false, backend: "unavailable", reason: timedOut() ? "the bubblewrap sandbox did not start within 20 seconds; the host may be overloaded" : "bubblewrap user namespaces are unavailable" };
  }
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "codali-isolation-probe-")));
    try {
      const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", darwinSandboxProfile(scratch, scratch, [], []), "/usr/bin/true"], { timeout: 3000, stdio: "ignore" });
      if (probe.status === 0) return { available: true, backend: "sandbox-exec" };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  return { available: false, backend: "unavailable", reason: "No supported isolation backend on this platform" };
};

const packageCacheEnvironment = (root: string) => ({
  NPM_CONFIG_CACHE: path.join(root, "npm"), GRADLE_USER_HOME: path.join(root, "gradle"),
  PIP_CACHE_DIR: path.join(root, "pip"), UV_CACHE_DIR: path.join(root, "uv"),
  CARGO_HOME: path.join(root, "cargo"), XDG_CACHE_HOME: path.join(root, "xdg"),
});

/** Disposable, workspace-specific cache. Never mount an existing host package cache or credentials. */
const preparePackageCache = async (requested: string, workspace: string, label = "Package cache"): Promise<string> => {
  const absolute = path.resolve(requested);
  const unsafe = (value: string) => value === path.parse(value).root || value === realpathSync(os.homedir())
    || value === workspace || workspace.startsWith(`${value}${path.sep}`) || value.startsWith(`${workspace}${path.sep}`);
  if (unsafe(absolute)) throw new ToolExecutionError("tool_permission_denied", `${label} must be a private dedicated directory outside the workspace`);
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(absolute), real = await fs.realpath(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory() || unsafe(real)
    || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw new ToolExecutionError("tool_permission_denied", `${label} must be an owned private directory, not a symlink`);
  }
  return real;
};

const within = (file: string, directory: string): boolean => file === directory || file.startsWith(`${directory}${path.sep}`);

export interface WorkspaceMounts {
  /** In mount order: a parent always comes before anything inside it. */
  mounts: Array<{ path: string; writable: boolean }>;
  /** Write paths mounted on themselves: their contents are writable, the path itself cannot be removed or renamed. */
  inPlace: string[];
  /** Entries that appeared during the command in an opened parent and are not write paths. */
  createdOutside: () => string[];
  /** Whether a new entry is a write path, or an entry directly inside one, moved out by the command. */
  movedFromScope: (file: string) => boolean;
}

/**
 * Linux mount plan for the workspace, which is already mounted read-only.
 * A write path mounted on itself becomes a mount point: `rm -rf dist` or
 * `fs.rmSync(outDir)` then fails with EBUSY and `mv dist dist.old` cannot
 * work. So the parent of a write path is opened instead, and every other entry
 * of that parent is mounted read-only on itself, which keeps those entries
 * from being changed, removed or renamed. A parent can still gain new names;
 * createdOutside reports them after the command, and the executor removes
 * them and fails the call. Every directory inside a
 * write path that holds a protected file is a mount point, so renaming an
 * ancestor cannot move the protected file away and recreate the path.
 */
export const mountWorkspace = (root: string, writePaths: string[], protectedPaths: string[] = [], maxParentEntries = 4096): WorkspaceMounts => {
  const rank = { "read-only": 0, parent: 1, write: 2 } as const;
  const marks = new Map<string, keyof typeof rank>();
  const mark = (file: string, kind: keyof typeof rank) => { const previous = marks.get(file); if (!previous || rank[kind] > rank[previous]) marks.set(file, kind); };
  const writable = (file: string) => writePaths.some(scope => within(file, scope));
  const parents = new Map<string, Set<string>>();
  const inPlace: string[] = [];
  const scopeInodes = new Set<string>();
  for (const target of writePaths) {
    const parent = path.dirname(target);
    if (target === root) { mark(target, "write"); continue; }
    if (writable(parent)) continue; // Already writable, and removable, through the enclosing write path.
    let entries: Dirent[] | undefined;
    try { entries = within(parent, root) ? readdirSync(parent, { withFileTypes: true }) : undefined; } catch { entries = undefined; }
    // A symbolic link or special file cannot be protected by a mount on itself.
    if (!entries || entries.length > maxParentEntries || entries.some(entry => !entry.isFile() && !entry.isDirectory() && !writePaths.includes(path.join(parent, entry.name)))) {
      if (!existsSync(target)) throw new ToolExecutionError("tool_permission_denied", "Create the scoped directory with create_directory (or file with write_file) before shell execution");
      mark(target, "write"); inPlace.push(target); continue;
    }
    mark(parent, "parent");
    parents.set(parent, new Set(entries.map(entry => entry.name)));
    // A rename out of scope (mv dist dist.old) must not lose that content.
    for (const file of [target, ...(() => { try { return readdirSync(target).slice(0, maxParentEntries).map(name => path.join(target, name)); } catch { return []; } })()]) {
      try { const stat = lstatSync(file); scopeInodes.add(`${stat.dev}:${stat.ino}`); } catch { /* Not created yet. */ }
    }
    for (const entry of entries) { const file = path.join(parent, entry.name); if (!writePaths.includes(file)) mark(file, "read-only"); }
  }
  for (const file of protectedPaths) {
    for (let directory = path.dirname(file); directory !== root && within(directory, root); directory = path.dirname(directory)) if (writable(directory)) mark(directory, "write");
  }
  const depth = (file: string) => file.split(path.sep).length;
  return {
    mounts: [...marks].sort(([a], [b]) => depth(a) - depth(b)).map(([file, kind]) => ({ path: file, writable: kind !== "read-only" })),
    inPlace,
    createdOutside: () => [...parents].flatMap(([parent, before]) => {
      let names: string[]; try { names = readdirSync(parent); } catch { return []; }
      return names.filter(name => !before.has(name) && !writable(path.join(parent, name))).map(name => path.join(parent, name));
    }),
    movedFromScope: file => { try { const stat = lstatSync(file); return scopeInodes.has(`${stat.dev}:${stat.ino}`); } catch { return false; } },
  };
};

export const createIsolatedExecutor = (options: { network?: boolean; status?: ExecutorStatus; /** Host-owned disposable cache; never model arguments. */ cacheRoot?: string; /** Host-owned scratch kept between calls of one session; never model arguments. */ scratchRoot?: string; /** Trusted installed libraries only; never model arguments. */ readOnlyRuntimeRoots?: string[] } = {}): ((command: string, args: string[], context: ToolContext) => Promise<ToolHandlerResult>) => {
  const status = options.status ?? executorStatus();
  return async (command, args, context) => {
    if (!status.available) throw new ToolExecutionError("tool_permission_denied", status.reason ?? "Isolation unavailable");
    const root = realpathSync(context.workspaceRoot);
    const cwd = resolveShellWorkingDirectory(root, context.shellWorkingDirectory);
    if (root === path.parse(root).root) throw new ToolExecutionError("tool_permission_denied", "Filesystem root cannot be an isolated workspace");
    const cacheRoot = options.cacheRoot ? await preparePackageCache(options.cacheRoot, root) : undefined;
    const sessionScratch = options.scratchRoot ? await preparePackageCache(options.scratchRoot, root, "Shell scratch") : undefined;
    const runtimes = discoverHostToolchain(root);
    const protectedPaths = [...new Set((context.protectedPaths ?? []).flatMap(file => {
      const requested = path.resolve(root, file);
      if (requested === root || !requested.startsWith(`${root}${path.sep}`)) throw new ToolExecutionError("tool_permission_denied", "Protected input must be inside the workspace");
      if (!existsSync(requested)) return [];
      const real = realpathSync(requested);
      if (!real.startsWith(`${root}${path.sep}`)) throw new ToolExecutionError("tool_permission_denied", "Protected input resolves outside the workspace");
      return [requested, real];
    }))];
    const runtimeRoots = [...new Set((options.readOnlyRuntimeRoots ?? []).map(requested => {
      const real = realpathSync(requested);
      if (!statSync(real).isDirectory() || [path.parse(real).root, os.homedir(), context.workspaceRoot].some(forbidden => real === realpathSync(forbidden))
        || root.startsWith(`${real}${path.sep}`)) throw new ToolExecutionError("tool_permission_denied", "Runtime mount must be a dedicated installed library directory");
      return real;
    }))];
    for (const [index, venv] of runtimeRoots.entries()) {
      const interpreter = venvInterpreter(venv, root);
      if (interpreter && !runtimes.some(runtime => runtime.executable === interpreter.executable)) runtimes.push({ ...interpreter, name: `python-runtime-${index}` });
    }
    const writePaths = (context.allowedWritePaths ?? ["."]).map(file => {
      const requested = path.resolve(root, file);
      if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) throw new ToolExecutionError("tool_permission_denied", "Shell write scope escapes workspace");
      // A declared output directory that does not exist yet (dist/, data/) is
      // created rather than refused; a missing file still has to be written first.
      if (!existsSync(requested) && (/[\\/]$/.test(file) || !path.extname(requested))) mkdirSync(requested, { recursive: true });
      // A path the command will create (the target of a rename such as
      // dist -> dist.old) needs only an existing parent; mountWorkspace decides
      // whether that parent can be opened for it.
      const real = existsSync(requested) ? realpathSync(requested)
        : existsSync(path.dirname(requested)) && statSync(path.dirname(requested)).isDirectory() ? path.join(realpathSync(path.dirname(requested)), path.basename(requested))
        : (() => { throw new ToolExecutionError("tool_permission_denied", "Create the scoped directory with create_directory (or file with write_file) before shell execution"); })();
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new ToolExecutionError("tool_permission_denied", "Shell write scope resolves outside workspace");
      if ([".git", ".mcoda"].some(dir => real === path.join(root, dir) || real.startsWith(`${root}/${dir}/`))) throw new ToolExecutionError("tool_permission_denied", "Repository control metadata cannot be a write scope");
      if (protectedPaths.some(input => real === input || real.startsWith(`${input}${path.sep}`))) throw new ToolExecutionError("tool_permission_denied", "Authoritative input cannot be a write scope");
      return real;
    });
    if (status.backend === "bubblewrap") {
      const launch = bubblewrapRoot();
      let resolverRoot: string | undefined;
      try {
        if (!options.network) {
          resolverRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codali-resolver-"));
          const hosts = path.join(resolverRoot, "hosts");
          await fs.writeFile(hosts, "127.0.0.1 localhost\n::1 localhost\n", { mode: 0o600 });
          launch.push("--ro-bind", hosts, "/etc/hosts");
        }
        if (options.network) {
          launch.push("--share-net");
          for (const file of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl/certs"]) if (existsSync(file)) launch.push("--ro-bind", realpathSync(file), file);
        }
        launch.push("--dir", path.dirname(root), "--ro-bind", root, root);
        for (const runtime of extraRuntimeMounts(runtimes)) launch.push("--dir", path.dirname(runtime.readOnlyRoot),
          ...(runtime.linkTo ? ["--symlink", runtime.linkTo, runtime.readOnlyRoot] : ["--ro-bind", runtime.readOnlyRoot, runtime.readOnlyRoot]));
        for (const runtime of runtimeRoots) launch.push("--dir", path.dirname(runtime), "--ro-bind", runtime, runtime);
        launch.push("--dir", "/tmp/codali-bin");
        for (const runtime of runtimes) launch.push("--symlink", runtime.executable, `/tmp/codali-bin/${runtime.name}`);
        const mounts = mountWorkspace(root, writePaths, protectedPaths);
        for (const mount of mounts.mounts) launch.push(mount.writable ? "--bind" : "--ro-bind", mount.path, mount.path);
        if (cacheRoot) launch.push("--bind", cacheRoot, "/tmp/codali-cache");
        // The rest of /tmp stays per-call; only $TMPDIR survives between calls.
        if (sessionScratch) launch.push("--bind", sessionScratch, "/tmp/scratch");
        launch.push("--chdir", cwd, "--dir", "/tmp/home", "--setenv", "HOME", "/tmp/home", "--setenv", "TMPDIR", sessionScratch ? "/tmp/scratch" : "/tmp", "--setenv", "PATH", "/tmp/codali-bin:/usr/local/bin:/usr/bin:/bin");
        for (const [key, value] of Object.entries({ CARGO_HOME: "/tmp/home/cargo", XDG_CACHE_HOME: "/tmp/home/cache", PYTHONPYCACHEPREFIX: "/tmp/home/pycache", PYTHONUSERBASE: "/tmp/home/python", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" })) launch.push("--setenv", key, value);
        if (cacheRoot) for (const [key, value] of Object.entries(packageCacheEnvironment("/tmp/codali-cache"))) launch.push("--setenv", key, value);
        // A relocated Python (a CI tool cache, a copied installation) records the
        // library directory it was built for, not the one it lives in, and fails
        // with "libpython not found". Point the loader at the interpreter
        // libraries already mounted from the same installation, and nothing else.
        const interpreterLibraries = [...new Set(runtimes.flatMap(runtime => (runtime.support ?? [])
          .filter(mount => !mount.directory && /^libpython3\./.test(path.basename(mount.readOnlyRoot))).map(mount => path.dirname(mount.readOnlyRoot))))];
        if (interpreterLibraries.length) launch.push("--setenv", "LD_LIBRARY_PATH", interpreterLibraries.join(":"));
        // Git hooks/config and private session state are not part of executable workspace access.
        for (const dir of [".git", ".mcoda"]) if (existsSync(path.join(root, dir))) launch.push("--ro-bind", path.join(root, dir), path.join(root, dir));
        for (const file of protectedPaths) launch.push("--ro-bind", realpathSync(file), file);
        launch.push("--", command, ...args);
        let outcome: ToolHandlerResult | undefined, failure: unknown;
        try { outcome = await runProcess("/usr/bin/bwrap", launch, context); } catch (error) { failure = error; }
        // Names that appeared next to a write path did not exist when the
        // mounts were planned, so the command made them outside its scope
        // (a conftest.py or .npmrc there would change later runs). Remove them.
        const created = mounts.createdOutside();
        const removed: string[] = [], kept: string[] = [];
        const moved = created.filter(file => mounts.movedFromScope(file));
        for (const file of created) {
          if (moved.includes(file)) continue;
          try { await fs.rm(file, { recursive: true, force: true }); removed.push(file); } catch { kept.push(file); }
        }
        if (context.signal?.aborted) throw failure ?? context.signal.reason;
        if (created.length) {
          const names = (files: string[]) => files.slice(0, 10).map(file => path.relative(root, file)).join(", ") + (files.length > 10 ? ` and ${files.length - 10} more` : "");
          const prior = failure instanceof Error ? failure.message : outcome?.output ?? "";
          throw new ToolExecutionError("tool_permission_denied", `The command created ${names(created)} outside its writePaths (${writePaths.map(file => path.relative(root, file) || ".").join(", ")}).${removed.length ? ` Removed ${names(removed)}: they did not exist when the command started.` : ""}${moved.length ? ` Kept ${names(moved)}: it holds content moved out of a write path; declare it in writePaths to keep it, or move it back.` : ""}${kept.length ? ` Could not remove ${names(kept)}; delete them before continuing.` : ""} Any other effects of the command inside its writePaths remain. Name every path the command creates in writePaths (a path that does not exist yet is allowed when its parent directory exists), or write inside a declared path.${prior ? `\n\nCommand output:\n${prior.slice(0, 4000)}` : ""}`, { retryable: false, details: { outsideWritePaths: created.map(file => path.relative(root, file)), removed: removed.map(file => path.relative(root, file)) } });
        }
        if (failure) {
          if (failure instanceof ToolExecutionError && mounts.inPlace.length) failure.message += `\nNote: ${mounts.inPlace.map(file => path.relative(root, file) || ".").join(", ")} could only be mounted in place, because the parent directory holds a symbolic link or special file. The command can change the contents but cannot remove or rename the path itself.`;
          throw failure;
        }
        return outcome!;
      } finally { if (resolverRoot) await fs.rm(resolverRoot, { recursive: true, force: true }); }
    }
    const scratch = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "codali-shell-")));
    try {
      await fs.chmod(scratch, 0o700);
      const privateHome = path.join(scratch, "home"); const privateBin = path.join(scratch, "bin");
      await fs.mkdir(privateHome, { mode: 0o700 }); await fs.mkdir(privateBin, { mode: 0o700 });
      for (const runtime of runtimes) await fs.symlink(runtime.executable, path.join(privateBin, runtime.name));
      const profile = darwinSandboxProfile(root, scratch, writePaths, runtimes, options.network, runtimeRoots, protectedPaths, cacheRoot, sessionScratch);
      return await runProcess("/usr/bin/sandbox-exec", ["-p", profile, runtimes.find(runtime => runtime.name === command)?.executable ?? command, ...args], context, {
        ...runtimes.find(runtime => runtime.name === "cc")?.environment,
        HOME: privateHome, TMPDIR: sessionScratch ?? scratch, PATH: `${privateBin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        CARGO_HOME: path.join(privateHome, "cargo"), XDG_CACHE_HOME: path.join(privateHome, "cache"),
        ...(cacheRoot ? packageCacheEnvironment(cacheRoot) : {}),
        PYTHONPYCACHEPREFIX: path.join(privateHome, "pycache"), PYTHONUSERBASE: path.join(privateHome, "python"),
        // Host Git settings can invoke external helpers or read private paths.
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
      });
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  };
};
