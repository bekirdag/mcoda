import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HostRuntimeMount { readOnlyRoot: string; directory: boolean; }
export interface HostRuntime extends HostRuntimeMount { name: string; executable: string; support?: HostRuntimeMount[]; }
const packages: Record<string, string[]> = { npm: ["npm"], pnpm: ["pnpm", "@pnpm/exe"], yarn: ["yarn", "@yarnpkg/cli", "@yarnpkg/cli-dist"] };
const within = (file: string, root: string): boolean => file === root || file.startsWith(`${root}${path.sep}`);
const systemPath = (file: string) => ["/usr", "/bin", "/sbin", "/System"].some(root => within(file, root));

const executableBinary = (file: string): boolean => {
  const fd = openSync(file, "r"); const bytes = Buffer.alloc(4);
  try { if (readSync(fd, bytes, 0, 4, 0) !== 4) return false; }
  finally { closeSync(fd); }
  return ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(bytes.toString("hex"));
};

const rustTools = new Set(["cargo", "rustc", "rustdoc"]);

/** Resolve a rustup proxy without executing it or consulting repository overrides.
 * Only an already-installed, host-selected toolchain can become a runtime mount. */
const resolveRustProxy = (name: string, executable: string, home: string): string => {
  if (!rustTools.has(name)) return executable;
  let proxy = path.basename(executable) === "rustup";
  if (!proxy && existsSync(path.join(path.dirname(executable), "rustup"))) {
    const actual = statSync(executable); const rustup = statSync(path.join(path.dirname(executable), "rustup"));
    proxy = actual.dev === rustup.dev && actual.ino === rustup.ino;
  }
  if (!proxy) return executable;
  const rustup = process.env.RUSTUP_HOME ?? path.join(home, ".rustup");
  if (!path.isAbsolute(rustup)) throw new Error("Rustup home must be absolute");
  const settings = path.join(rustup, "settings.toml");
  const configured = process.env.RUSTUP_TOOLCHAIN || (statSync(settings).size <= 16384
    ? readFileSync(settings, "utf8").match(/^default_toolchain\s*=\s*"([A-Za-z0-9_.-]+)"\s*$/m)?.[1] : undefined);
  if (!configured || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(configured)) throw new Error("No installed host Rust toolchain selected");
  const toolchains = path.join(rustup, "toolchains");
  const matches = existsSync(path.join(toolchains, configured)) ? [configured]
    : readdirSync(toolchains).filter(entry => entry.startsWith(`${configured}-`));
  if (matches.length !== 1) throw new Error("Rust toolchain selection is unavailable or ambiguous");
  const root = realpathSync(path.join(toolchains, matches[0]!));
  const target = realpathSync(path.join(root, "bin", name));
  if (!within(target, root)) throw new Error("Rust tool executable escapes selected toolchain");
  return target;
};

const languageRuntime = (name: string, executable: string, workspace: string, home: string): HostRuntime | undefined => {
  if (!executableBinary(executable) || path.basename(path.dirname(executable)) !== "bin") return undefined;
  const prefix = path.dirname(path.dirname(executable));
  if (prefix === home || within(workspace, prefix) || within(prefix, workspace) || prefix === path.parse(prefix).root) return undefined;
  const runtime: HostRuntime = { name, executable, readOnlyRoot: executable, directory: false, support: [] };
  const add = (file: string): void => {
    const resolved = realpathSync(file);
    if (!within(resolved, prefix)) throw new Error("Runtime support path escapes installation");
    runtime.support!.push({ readOnlyRoot: resolved, directory: statSync(resolved).isDirectory() });
  };
  if (rustTools.has(name)) {
    const library = path.join(prefix, "lib");
    if (!readdirSync(path.join(library, "rustlib")).some(file => /^manifest-rustc(?:-|$)/.test(file))) return undefined;
    add(library);
    return runtime;
  }
  if (name === "python" || name === "python3") {
    let standardLibrary = false;
    for (const lib of ["lib", "lib64"]) {
      const directory = path.join(prefix, lib); if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory)) {
        const file = path.join(directory, entry);
        if (/^python3\.\d+t?$/.test(entry) && existsSync(path.join(file, "os.py")) && existsSync(path.join(file, "encodings", "__init__.py"))) {
          add(file); standardLibrary = true;
        } else if (/^libpython3\.\d+t?(?:\.so(?:\.[\d.]+)?|(?:\.\d+)*\.dylib)$/.test(entry)) add(file);
      }
    }
    return standardLibrary ? runtime : undefined;
  }
  return undefined;
};

/** Discover known user-installed language tools. The workspace can neither
 * supply this PATH nor turn its own package.json into a trusted runtime mount.
 * Mounts are single binaries or matching package roots, never the user's home. */
export const discoverHostToolchain = (workspaceRoot: string, searchPath = process.env.PATH ?? ""): HostRuntime[] => {
  const workspace = realpathSync(workspaceRoot); const home = realpathSync(os.homedir());
  const result: HostRuntime[] = [];
  for (const name of ["node", "npm", "pnpm", "yarn", "bun", "python3", "python", "rustc", "cargo", "rustdoc", "cc", "ar"]) {
    const candidates = name === "node" ? [process.execPath] : searchPath.split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, name));
    for (const candidate of candidates) {
      try {
        let executable = realpathSync(candidate);
        if (within(candidate, workspace) || within(executable, workspace)) continue;
        executable = resolveRustProxy(name, executable, home);
        if (within(executable, workspace)) continue;
        accessSync(executable, constants.X_OK);
        if (!statSync(executable).isFile()) continue;
        if (systemPath(executable)) { result.push({ name, executable, readOnlyRoot: executable, directory: false }); break; }
        if (rustTools.has(name) || name === "python" || name === "python3") {
          const runtime = languageRuntime(name, executable, workspace, home);
          if (runtime) { result.push(runtime); break; }
          continue;
        }
        if (executableBinary(executable)) { result.push({ name, executable, readOnlyRoot: executable, directory: false }); break; }
        // Package managers also install .bin shell shims. Never execute the shim:
        // select the known adjacent package's declared JS entry point, which is
        // validated by the same package-root checks as a normal symlink below.
        if (packages[name] && path.basename(path.dirname(candidate)) === ".bin" && !/\.[cm]?js$/.test(executable)) {
          for (const packageName of packages[name]) {
            try {
              const packageRoot = realpathSync(path.resolve(path.dirname(candidate), "..", packageName));
              if (within(packageRoot, workspace) || within(workspace, packageRoot) || packageRoot === home) continue;
              const manifest = path.join(packageRoot, "package.json");
              if (statSync(manifest).size > 65536) continue;
              const metadata = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; bin?: string | Record<string, string> };
              const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[name];
              if (metadata.name !== packageName || !bin) continue;
              const target = realpathSync(path.resolve(packageRoot, bin));
              if (!within(target, packageRoot) || !/\.[cm]?js$/.test(target) || !statSync(target).isFile()) continue;
              accessSync(target, constants.X_OK); executable = target; break;
            } catch { /* Another allowed package layout may exist. */ }
          }
        }
        if (!packages[name] || !/\.[cm]?js$/.test(executable)) continue;
        let directory = path.dirname(executable); let matched: HostRuntime | undefined;
        for (let depth = 0; depth < 6 && directory !== path.parse(directory).root && directory !== home; depth++, directory = path.dirname(directory)) {
          if (within(workspace, directory) || within(directory, workspace)) break;
          const manifest = path.join(directory, "package.json");
          if (!existsSync(manifest)) continue;
          if (statSync(manifest).size > 65536) break;
          const metadata = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; bin?: string | Record<string, string> };
          if (!metadata.name || !packages[name].includes(metadata.name)) break;
          const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[name];
          if (!bin || realpathSync(path.resolve(directory, bin)) !== executable) break;
          matched = { name, executable, readOnlyRoot: directory, directory: true }; break;
        }
        if (matched) { result.push(matched); break; }
      } catch { /* An unavailable or unverified candidate is not mounted. */ }
    }
  }
  return result;
};

export const extraRuntimeMounts = (runtimes: HostRuntime[]): HostRuntimeMount[] => {
  const mounts = new Map<string, HostRuntimeMount>();
  for (const runtime of runtimes) for (const mount of [runtime, ...runtime.support ?? []]) {
    if (!systemPath(mount.readOnlyRoot)) mounts.set(mount.readOnlyRoot, mount);
  }
  return [...mounts.values()];
};
