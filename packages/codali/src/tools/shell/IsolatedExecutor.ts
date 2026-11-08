import { existsSync, realpathSync, statSync, readdirSync, mkdtempSync, rmSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runProcess } from "./AsyncProcess.js";
import { resolveShellWorkingDirectory } from "./ShellWorkingDirectory.js";
import { ToolExecutionError, type ToolContext, type ToolHandlerResult } from "../ToolTypes.js";
import { discoverHostToolchain, extraRuntimeMounts, type HostRuntime } from "./HostToolchain.js";

export interface ExecutorStatus { available: boolean; backend: "bubblewrap" | "sandbox-exec" | "unavailable"; reason?: string; }

/** All paths have been canonicalized by the host, before launching the sandbox. */
export const darwinSandboxProfile = (root: string, scratch: string, writePaths: string[], runtimes: HostRuntime[], network = false, runtimeRoots: string[] = [], protectedPaths: string[] = [], cacheRoot?: string): string => {
  const quoted = (value: string) => JSON.stringify(value);
  const ancestors = new Set<string>();
  for (const target of [root, scratch, ...(cacheRoot ? [cacheRoot] : []), ...runtimeRoots, ...extraRuntimeMounts(runtimes).map(runtime => runtime.readOnlyRoot)]) {
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
    ...writePaths.map(file => `(allow file-write* (subpath ${quoted(file)}))`),
    ...[".git", ".mcoda"].map(dir => `(deny file-write* (subpath ${quoted(path.join(root, dir))}))`),
    ...protectedPaths.map(file => `(deny file-write* (subpath ${quoted(file)}))`),
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
    if (!/^lib[^/]+\.so(?:\..+)?$/.test(name)) continue;
    try {
      const alias = path.join("/etc/alternatives", name), target = realpathSync(alias);
      if (!["/usr/lib/", "/usr/lib64/", "/lib/", "/lib64/"].some(prefix => target.startsWith(prefix)) || !statSync(target).isFile()) continue;
      args.push("--ro-bind", target, alias);
    } catch { /* A broken optional system-library alternative is not mounted. */ }
  }
  return args;
};

export const executorStatus = (): ExecutorStatus => {
  if (process.platform === "linux") {
    if (!existsSync("/usr/bin/bwrap")) return { available: false, backend: "unavailable", reason: "Install bubblewrap to enable isolated shell execution" };
    const probe = spawnSync("/usr/bin/bwrap", [...bubblewrapRoot(), "--", "/usr/bin/true"], { timeout: 3000, stdio: "ignore" });
    return probe.status === 0 ? { available: true, backend: "bubblewrap" } : { available: false, backend: "unavailable", reason: "bubblewrap user namespaces are unavailable" };
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
const preparePackageCache = async (requested: string, workspace: string): Promise<string> => {
  const absolute = path.resolve(requested);
  const unsafe = (value: string) => value === path.parse(value).root || value === realpathSync(os.homedir())
    || value === workspace || workspace.startsWith(`${value}${path.sep}`) || value.startsWith(`${workspace}${path.sep}`);
  if (unsafe(absolute)) throw new ToolExecutionError("tool_permission_denied", "Package cache must be a private dedicated directory outside the workspace");
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(absolute), real = await fs.realpath(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory() || unsafe(real)
    || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw new ToolExecutionError("tool_permission_denied", "Package cache must be an owned private directory, not a symlink");
  }
  return real;
};

export const createIsolatedExecutor = (options: { network?: boolean; status?: ExecutorStatus; /** Host-owned disposable cache; never model arguments. */ cacheRoot?: string; /** Trusted installed libraries only; never model arguments. */ readOnlyRuntimeRoots?: string[] } = {}): ((command: string, args: string[], context: ToolContext) => Promise<ToolHandlerResult>) => {
  const status = options.status ?? executorStatus();
  return async (command, args, context) => {
    if (!status.available) throw new ToolExecutionError("tool_permission_denied", status.reason ?? "Isolation unavailable");
    const root = realpathSync(context.workspaceRoot);
    const cwd = resolveShellWorkingDirectory(root, context.shellWorkingDirectory);
    if (root === path.parse(root).root) throw new ToolExecutionError("tool_permission_denied", "Filesystem root cannot be an isolated workspace");
    const cacheRoot = options.cacheRoot ? await preparePackageCache(options.cacheRoot, root) : undefined;
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
    const writePaths = (context.allowedWritePaths ?? ["."]).map(file => {
      const requested = path.resolve(root, file);
      if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) throw new ToolExecutionError("tool_permission_denied", "Shell write scope escapes workspace");
      if (!existsSync(requested)) throw new ToolExecutionError("tool_permission_denied", "Create the scoped directory with create_directory (or file with write_file) before shell execution");
      const real = realpathSync(requested);
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
        for (const runtime of extraRuntimeMounts(runtimes)) launch.push("--dir", path.dirname(runtime.readOnlyRoot), "--ro-bind", runtime.readOnlyRoot, runtime.readOnlyRoot);
        for (const runtime of runtimeRoots) launch.push("--dir", path.dirname(runtime), "--ro-bind", runtime, runtime);
        launch.push("--dir", "/tmp/codali-bin");
        for (const runtime of runtimes) launch.push("--symlink", runtime.executable, `/tmp/codali-bin/${runtime.name}`);
        for (const file of writePaths) launch.push("--bind", file, file);
        if (cacheRoot) launch.push("--bind", cacheRoot, "/tmp/codali-cache");
        launch.push("--chdir", cwd, "--dir", "/tmp/home", "--setenv", "HOME", "/tmp/home", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/tmp/codali-bin:/usr/local/bin:/usr/bin:/bin");
        for (const [key, value] of Object.entries({ CARGO_HOME: "/tmp/home/cargo", XDG_CACHE_HOME: "/tmp/home/cache", PYTHONPYCACHEPREFIX: "/tmp/home/pycache", PYTHONUSERBASE: "/tmp/home/python", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" })) launch.push("--setenv", key, value);
        if (cacheRoot) for (const [key, value] of Object.entries(packageCacheEnvironment("/tmp/codali-cache"))) launch.push("--setenv", key, value);
        // Git hooks/config and private session state are not part of executable workspace access.
        for (const dir of [".git", ".mcoda"]) if (existsSync(path.join(root, dir))) launch.push("--ro-bind", path.join(root, dir), path.join(root, dir));
        for (const file of protectedPaths) launch.push("--ro-bind", realpathSync(file), file);
        launch.push("--", command, ...args);
        return await runProcess("/usr/bin/bwrap", launch, context);
      } finally { if (resolverRoot) await fs.rm(resolverRoot, { recursive: true, force: true }); }
    }
    const scratch = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "codali-shell-")));
    try {
      await fs.chmod(scratch, 0o700);
      const privateHome = path.join(scratch, "home"); const privateBin = path.join(scratch, "bin");
      await fs.mkdir(privateHome, { mode: 0o700 }); await fs.mkdir(privateBin, { mode: 0o700 });
      for (const runtime of runtimes) await fs.symlink(runtime.executable, path.join(privateBin, runtime.name));
      const profile = darwinSandboxProfile(root, scratch, writePaths, runtimes, options.network, runtimeRoots, protectedPaths, cacheRoot);
      return await runProcess("/usr/bin/sandbox-exec", ["-p", profile, runtimes.find(runtime => runtime.name === command)?.executable ?? command, ...args], context, {
        ...runtimes.find(runtime => runtime.name === "cc")?.environment,
        HOME: privateHome, TMPDIR: scratch, PATH: `${privateBin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        CARGO_HOME: path.join(privateHome, "cargo"), XDG_CACHE_HOME: path.join(privateHome, "cache"),
        ...(cacheRoot ? packageCacheEnvironment(cacheRoot) : {}),
        PYTHONPYCACHEPREFIX: path.join(privateHome, "pycache"), PYTHONUSERBASE: path.join(privateHome, "python"),
        // Host Git settings can invoke external helpers or read private paths.
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
      });
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  };
};
