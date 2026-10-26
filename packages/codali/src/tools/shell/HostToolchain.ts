import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HostRuntime { name: string; executable: string; readOnlyRoot: string; directory: boolean; }
const packages: Record<string, string[]> = { npm: ["npm"], pnpm: ["pnpm", "@pnpm/exe"], yarn: ["yarn", "@yarnpkg/cli", "@yarnpkg/cli-dist"] };
const within = (file: string, root: string): boolean => file === root || file.startsWith(`${root}${path.sep}`);
const systemPath = (file: string) => ["/usr", "/bin", "/sbin", "/System"].some(root => within(file, root));

const executableBinary = (file: string): boolean => {
  const fd = openSync(file, "r"); const bytes = Buffer.alloc(4);
  try { if (readSync(fd, bytes, 0, 4, 0) !== 4) return false; }
  finally { closeSync(fd); }
  return ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(bytes.toString("hex"));
};

/** Discover only known user-installed Node tools. The workspace can neither
 * supply this PATH nor turn its own package.json into a trusted runtime mount.
 * Mounts are single binaries or matching package roots, never the user's home. */
export const discoverHostToolchain = (workspaceRoot: string, searchPath = process.env.PATH ?? ""): HostRuntime[] => {
  const workspace = realpathSync(workspaceRoot); const home = realpathSync(os.homedir());
  const result: HostRuntime[] = [];
  for (const name of ["node", "npm", "pnpm", "yarn", "bun"]) {
    const candidates = name === "node" ? [process.execPath] : searchPath.split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, name));
    for (const candidate of candidates) {
      try {
        let executable = realpathSync(candidate);
        if (within(candidate, workspace) || within(executable, workspace)) continue;
        accessSync(executable, constants.X_OK);
        if (!statSync(executable).isFile()) continue;
        if (systemPath(executable)) { result.push({ name, executable, readOnlyRoot: executable, directory: false }); break; }
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

export const extraRuntimeMounts = (runtimes: HostRuntime[]): HostRuntime[] => runtimes.filter(runtime => !systemPath(runtime.readOnlyRoot));
