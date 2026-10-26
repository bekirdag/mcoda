import { existsSync, realpathSync, mkdtempSync, rmSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runProcess } from "./AsyncProcess.js";
import { ToolExecutionError, type ToolContext, type ToolHandlerResult } from "../ToolTypes.js";
import { discoverHostToolchain, extraRuntimeMounts, type HostRuntime } from "./HostToolchain.js";

export interface ExecutorStatus { available: boolean; backend: "bubblewrap" | "sandbox-exec" | "unavailable"; reason?: string; }

/** All paths have been canonicalized by the host, before launching the sandbox. */
export const darwinSandboxProfile = (root: string, scratch: string, writePaths: string[], runtimes: HostRuntime[], network = false): string => {
  const quoted = (value: string) => JSON.stringify(value);
  const ancestors = new Set<string>();
  for (const target of [root, scratch, ...extraRuntimeMounts(runtimes).map(runtime => runtime.readOnlyRoot)]) {
    for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.add(parent);
  }
  return [
    "(version 1)", "(deny default)", "(allow process*)", "(allow sysctl-read)",
    // dyld opens the root directory when locating its shared cache. This literal
    // permits the directory itself, never a recursive read of the filesystem.
    '(allow file-read* (literal "/"))',
    // realpath/lstat needs ancestor metadata, not directory contents or sibling files.
    ...[...ancestors].map(parent => `(allow file-read-metadata (literal ${quoted(parent)}))`),
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/private/etc") (subpath "/dev"))',
    `(allow file-read* (subpath ${quoted(root)}))`,
    ...extraRuntimeMounts(runtimes).map(runtime => `(allow file-read* (${runtime.directory ? "subpath" : "literal"} ${quoted(runtime.readOnlyRoot)}))`),
    `(allow file-read* file-write* (subpath ${quoted(scratch)}))`,
    ...writePaths.map(file => `(allow file-write* (subpath ${quoted(file)}))`),
    ...[".git", ".mcoda"].map(dir => `(deny file-write* (subpath ${quoted(path.join(root, dir))}))`),
    network ? "(allow network*)" : "(deny network*)",
  ].join("\n");
};

const bubblewrapRoot = (): string[] => {
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/usr", "/usr", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const dir of ["/bin", "/sbin", "/lib", "/lib64"]) if (existsSync(dir)) args.push("--ro-bind", realpathSync(dir), dir);
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

export const createIsolatedExecutor = (options: { network?: boolean; status?: ExecutorStatus } = {}): ((command: string, args: string[], context: ToolContext) => Promise<ToolHandlerResult>) => {
  const status = options.status ?? executorStatus();
  return async (command, args, context) => {
    if (!status.available) throw new ToolExecutionError("tool_permission_denied", status.reason ?? "Isolation unavailable");
    const root = realpathSync(context.workspaceRoot);
    if (root === path.parse(root).root) throw new ToolExecutionError("tool_permission_denied", "Filesystem root cannot be an isolated workspace");
    const runtimes = discoverHostToolchain(root);
    const writePaths = (context.allowedWritePaths ?? ["."]).map(file => {
      const requested = path.resolve(root, file);
      if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) throw new ToolExecutionError("tool_permission_denied", "Shell write scope escapes workspace");
      if (!existsSync(requested)) throw new ToolExecutionError("tool_permission_denied", "Create the scoped directory/file with write_file before shell execution");
      const real = realpathSync(requested);
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new ToolExecutionError("tool_permission_denied", "Shell write scope resolves outside workspace");
      if ([".git", ".mcoda"].some(dir => real === path.join(root, dir) || real.startsWith(`${root}/${dir}/`))) throw new ToolExecutionError("tool_permission_denied", "Repository control metadata cannot be a write scope");
      return real;
    });
    if (status.backend === "bubblewrap") {
      const launch = bubblewrapRoot();
      if (options.network) {
        launch.push("--share-net");
        for (const file of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ssl/certs"]) if (existsSync(file)) launch.push("--ro-bind", realpathSync(file), file);
      }
      launch.push("--dir", path.dirname(root), "--ro-bind", root, root);
      for (const runtime of extraRuntimeMounts(runtimes)) launch.push("--dir", path.dirname(runtime.readOnlyRoot), "--ro-bind", runtime.readOnlyRoot, runtime.readOnlyRoot);
      launch.push("--dir", "/tmp/codali-bin");
      for (const runtime of runtimes) launch.push("--symlink", runtime.executable, `/tmp/codali-bin/${runtime.name}`);
      for (const file of writePaths) launch.push("--bind", file, file);
      launch.push("--chdir", root, "--dir", "/tmp/home", "--setenv", "HOME", "/tmp/home", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/tmp/codali-bin:/usr/local/bin:/usr/bin:/bin");
      for (const [key, value] of Object.entries({ CARGO_HOME: "/tmp/home/cargo", XDG_CACHE_HOME: "/tmp/home/cache", PYTHONPYCACHEPREFIX: "/tmp/home/pycache", PYTHONUSERBASE: "/tmp/home/python" })) launch.push("--setenv", key, value);
      // Git hooks/config and private session state are not part of executable workspace access.
      for (const dir of [".git", ".mcoda"]) if (existsSync(path.join(root, dir))) launch.push("--ro-bind", path.join(root, dir), path.join(root, dir));
      launch.push("--", command, ...args);
      return runProcess("/usr/bin/bwrap", launch, context);
    }
    const scratch = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "codali-shell-")));
    try {
      await fs.chmod(scratch, 0o700);
      const privateHome = path.join(scratch, "home"); const privateBin = path.join(scratch, "bin");
      await fs.mkdir(privateHome, { mode: 0o700 }); await fs.mkdir(privateBin, { mode: 0o700 });
      for (const runtime of runtimes) await fs.symlink(runtime.executable, path.join(privateBin, runtime.name));
      const profile = darwinSandboxProfile(root, scratch, writePaths, runtimes, options.network);
      return await runProcess("/usr/bin/sandbox-exec", ["-p", profile, runtimes.find(runtime => runtime.name === command)?.executable ?? command, ...args], context, {
        HOME: privateHome, TMPDIR: scratch, PATH: `${privateBin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        CARGO_HOME: path.join(privateHome, "cargo"), XDG_CACHE_HOME: path.join(privateHome, "cache"),
        PYTHONPYCACHEPREFIX: path.join(privateHome, "pycache"), PYTHONUSERBASE: path.join(privateHome, "python"),
      });
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  };
};
