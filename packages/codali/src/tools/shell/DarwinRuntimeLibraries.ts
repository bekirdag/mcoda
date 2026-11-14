import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { HostRuntimeMount } from "./HostToolchain.js";

interface LoadCommands { libraries: string[]; rpaths: string[]; }
const within = (file: string, root: string): boolean => file === root || file.startsWith(`${root}${path.sep}`);
const systemLibrary = (file: string): boolean => within(file, "/usr/lib") || within(file, "/System");

/** Inspect installed binaries, never execute a runtime or import repository code. */
export const inspectMachOLibraries = (files: string[]): Map<string, LoadCommands> => {
  const result = spawnSync("/usr/bin/otool", ["-l", ...files], {
    cwd: os.tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeout: 3000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("Cannot inspect installed runtime libraries");
  return parseMachOLoadCommands(result.stdout, files);
};

export const parseMachOLoadCommands = (output: string, files: string[]): Map<string, LoadCommands> => {
  const allowed = new Set(files); const result = new Map<string, LoadCommands>();
  let current: LoadCommands | undefined; let command = "";
  for (const line of output.split("\n")) {
    if (!/^\s/.test(line) && line.endsWith(":")) {
      const file = line.slice(0, -1).replace(/ \(architecture [^)]+\)$/, "");
      current = allowed.has(file) ? result.get(file) ?? { libraries: [], rpaths: [] } : undefined;
      if (current) result.set(file, current);
      command = "";
    } else if (/^Load command \d+$/.test(line)) command = "";
    else if (current) {
      const kind = line.match(/^\s+cmd (LC_[A-Z_]+)\s*$/);
      if (kind) command = kind[1]!;
      const value = line.match(/^\s+(?:name|path) (.+) \(offset \d+\)\s*$/)?.[1];
      if (value && command === "LC_RPATH") current.rpaths.push(value);
      else if (value && ["LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LOAD_UPWARD_DYLIB"].includes(command)) current.libraries.push(value);
    }
  }
  if (files.some(file => !result.has(file))) throw new Error("Incomplete runtime library inspection");
  return result;
};

const nativeFile = (file: string): boolean => {
  if (!statSync(file).isFile()) return false;
  const fd = openSync(file, "r"); const header = Buffer.alloc(4);
  try { if (readSync(fd, header, 0, 4, 0) !== 4) return false; }
  finally { closeSync(fd); }
  return ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(header.toString("hex"));
};

/** Admit only concrete native dependencies, including symlink spellings used by
 * dyld. Never grant a package-manager prefix, home, or arbitrary library folder. */
export const discoverDarwinRuntimeLibraries = (
  executable: string, extensionFiles: string[], workspace: string, home: string,
  inspect: (files: string[]) => Map<string, LoadCommands> = inspectMachOLibraries,
): HostRuntimeMount[] => {
  const mounts = new Map<string, HostRuntimeMount>(); const visited = new Set<string>();
  const initial = [...new Set([executable, ...extensionFiles])];
  const safe = (file: string): string => {
    if (!path.isAbsolute(file) || /[\r\n\0]/.test(file)) throw new Error("Invalid runtime library path");
    const resolved = realpathSync(file);
    if (within(file, workspace) || within(resolved, workspace) || resolved === home || !nativeFile(resolved)) {
      throw new Error("Runtime library is not an installed native file");
    }
    return resolved;
  };
  let pending = initial.map(file => ({ file: safe(file), inherited: [] as string[] }));
  let executableRpaths: string[] = [];
  const expand = (value: string, loader: string): string | undefined => {
    if (value === "@loader_path") return path.dirname(loader);
    if (value === "@executable_path") return path.dirname(executable);
    if (value.startsWith("@loader_path/")) return path.resolve(path.dirname(loader), value.slice(13));
    if (value.startsWith("@executable_path/")) return path.resolve(path.dirname(executable), value.slice(17));
    return path.isAbsolute(value) ? path.normalize(value) : undefined;
  };
  for (let depth = 0; pending.length; depth++) {
    if (depth >= 12 || visited.size + pending.length > 256) throw new Error("Runtime library graph exceeds discovery limit");
    const files = [...new Set(pending.map(item => item.file))];
    const inspected = inspect(files); const next: typeof pending = [];
    for (const { file, inherited } of pending) {
      if (visited.has(file)) continue;
      visited.add(file);
      const info = inspected.get(file);
      if (!info) throw new Error("Missing runtime library metadata");
      const rpaths = info.rpaths.map(value => expand(value, file)).filter((value): value is string => value !== undefined);
      if (file === executable) executableRpaths = rpaths;
      const searchRoots = [...rpaths, ...inherited, ...executableRpaths];
      for (const library of info.libraries) {
        const candidates = library.startsWith("@rpath/") ? searchRoots.map(root => path.resolve(root, library.slice(7))) : [expand(library, file)];
        for (const candidate of candidates) {
          if (!candidate) continue;
          if (systemLibrary(candidate)) break; // May exist only in the system dyld cache.
          let resolved: string;
          try { resolved = safe(candidate); }
          catch { continue; } // Missing optional libraries stay inaccessible.
          for (const alias of [candidate, resolved]) mounts.set(alias, { readOnlyRoot: alias, directory: false });
          if (!visited.has(resolved) && !next.some(item => item.file === resolved)) next.push({ file: resolved, inherited: searchRoots });
          break;
        }
      }
    }
    pending = next;
  }
  return [...mounts.values()];
};
