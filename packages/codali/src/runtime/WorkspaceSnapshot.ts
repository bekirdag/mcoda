import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export interface WorkspaceSnapshot { git: boolean; head?: string; hashes: Record<string, string>; dirtyPaths: string[]; }
export const workspaceGit = (root: string, args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd: root, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  }, (error, output) => error ? reject(new Error(`Git inspection failed (${error.code ?? "unknown"})`)) : resolve(output));
});
export const workspaceHash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
/** The same content identity is used by baselines, validation and completion. */
export const hashWorkspacePath = async (root: string, relative: string): Promise<string> => {
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Unsafe workspace inventory path");
  try {
    const parent = await fs.realpath(path.dirname(file));
    if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("Workspace parent symlink escapes the repository");
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return `symlink:${await fs.readlink(file)}`;
    if (!stat.isFile()) return `directory:${stat.ino}`;
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      const digest = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      const after = await handle.stat();
      if (before.ino !== stat.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`Workspace file changed during inspection: ${relative}`);
      return digest.digest("hex");
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
};
export const captureWorkspace = async (root: string): Promise<WorkspaceSnapshot> => {
  const snapshot: WorkspaceSnapshot = { git: true, hashes: {}, dirtyPaths: [] };
  let files: string[];
  try {
    files = (await workspaceGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
    snapshot.head = await workspaceGit(root, ["rev-parse", "HEAD"]).then(v => v.trim()).catch(() => "unborn");
    const dirty = await Promise.all([
      workspaceGit(root, ["diff", "--relative", "--no-ext-diff", "--no-textconv", "--name-only", "-z"]),
      workspaceGit(root, ["diff", "--cached", "--relative", "--no-ext-diff", "--no-textconv", "--name-only", "-z"]),
      workspaceGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    snapshot.dirtyPaths = [...new Set(dirty.flatMap(value => value.split("\0").filter(Boolean)))].sort();
  } catch {
    snapshot.git = false; files = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
        if ([".git", "node_modules", ".docdex", ".mcoda", ".codali", "dist", "build"].includes(entry.name)) continue;
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(relative); else files.push(relative);
        if (files.length > 20_000) throw new Error("Workspace inventory exceeds 20000 files; narrow the workspace");
      }
    };
    await walk("");
  }
  files = [...new Set(files)].filter(file => !/^(?:\.docdex|\.mcoda|\.codali)\//.test(file));
  if (files.length > 20_000) throw new Error("Workspace inventory exceeds 20000 files; narrow the workspace");
  for (const relative of files) {
    snapshot.hashes[relative] = await hashWorkspacePath(root, relative);
  }
  return snapshot;
};
export const changedWorkspacePaths = (before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] =>
  [...new Set([...Object.keys(before.hashes), ...Object.keys(after.hashes)])].filter(file => before.hashes[file] !== after.hashes[file]);
