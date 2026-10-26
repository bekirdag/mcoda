import { constants, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { atomicWriteJson, withStateLock } from "../session/AtomicState.js";
import { hashWorkspacePath, workspaceHash, type WorkspaceSnapshot } from "./WorkspaceSnapshot.js";

interface Preimage { hash: string; blob?: string; bytes?: number; }
interface OwnershipRecord { schemaVersion: 1; files: Record<string, Preimage>; knownPaths?: string[]; }
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const inScope = (file: string, scopes: string[]): boolean => scopes.some(scope => scope === "." || file === scope || file.startsWith(`${scope}/`));

/** Private original contents separate the agent's diff from a dirty checkout. */
export class WorkspaceLedger {
  constructor(readonly root: string, readonly workspaceRoot: string) {
    this.workspaceRoot = realpathSync(workspaceRoot);
  }
  private get manifest(): string { return path.join(this.root, "ownership.json"); }
  private async read(): Promise<OwnershipRecord> {
    try {
      const value = JSON.parse(await fs.readFile(this.manifest, "utf8")) as OwnershipRecord;
      if (value.schemaVersion !== 1 || !value.files) throw new Error("Invalid workspace ownership ledger");
      if (value.knownPaths !== undefined && (!Array.isArray(value.knownPaths) || value.knownPaths.some(file => typeof file !== "string" || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")))) throw new Error("Invalid workspace baseline inventory");
      for (const [file, entry] of Object.entries(value.files)) if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || !entry || typeof entry.hash !== "string" || entry.blob && !/^[a-f0-9]{64}$/.test(entry.blob)) throw new Error("Invalid workspace preimage reference");
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, files: {} }; throw error; }
  }

  private async readWorkspaceContent(file: string, expectedHash: string): Promise<Buffer> {
    const target = path.resolve(this.workspaceRoot, file);
    const parent = await fs.realpath(path.dirname(target));
    if (!target.startsWith(`${this.workspaceRoot}${path.sep}`) || parent !== this.workspaceRoot && !parent.startsWith(`${this.workspaceRoot}${path.sep}`)) throw new Error("Workspace preimage path escapes the repository");
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error("Workspace content exceeds the 8 MiB file limit");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += chunk.length;
        if (bytes > MAX_FILE_BYTES) throw new Error("Workspace content exceeds the 8 MiB file limit");
        chunks.push(Buffer.from(chunk));
      }
      const after = await handle.stat(); const content = Buffer.concat(chunks);
      if (before.size !== after.size || before.ctimeMs !== after.ctimeMs || workspaceHash(content) !== expectedHash) throw new Error(`File changed while preparing the edit or diff: ${file}`);
      return content;
    } finally { await handle.close(); }
  }

  async capture(snapshot: WorkspaceSnapshot, scopes: string[], explicitPaths: string[] = []): Promise<void> {
    await withStateLock(this.manifest, async () => {
      const record = await this.read();
      record.knownPaths ??= Object.keys(snapshot.hashes);
      const candidates = new Set([...Object.keys(snapshot.hashes).filter(file => inScope(file, scopes)), ...explicitPaths]);
      let bytes = Object.values(record.files).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
      for (const file of candidates) {
        if (record.files[file]) continue;
        const hash = snapshot.hashes[file] ?? await hashWorkspacePath(this.workspaceRoot, file);
        const entry: Preimage = { hash };
        if (/^[a-f0-9]{64}$/.test(hash)) {
          const stat = await fs.lstat(path.join(this.workspaceRoot, file));
          if (stat.size > 8 * 1024 * 1024 || bytes + stat.size > 64 * 1024 * 1024) throw new Error("Task preimages exceed the 64 MiB ledger or 8 MiB file limit; narrow the task scope");
          const content = await this.readWorkspaceContent(file, hash);
          if (workspaceHash(content) !== hash || await hashWorkspacePath(this.workspaceRoot, file) !== hash) throw new Error(`File changed while preparing the edit: ${file}`);
          const blob = path.join(this.root, "blobs", hash);
          await fs.mkdir(path.dirname(blob), { recursive: true, mode: 0o700 });
          try { await fs.writeFile(blob, content, { flag: "wx", mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          entry.blob = hash; entry.bytes = content.length; bytes += content.length;
        }
        record.files[file] = entry;
      }
      await atomicWriteJson(this.manifest, record);
    });
  }

  async diff(files: string[], limit = 60_000): Promise<string> {
    const record = await this.read(); const sections: string[] = []; let length = 0;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const file of files) {
      if (length >= limit) break;
      const entry = record.files[file] ?? (record.knownPaths && !record.knownPaths.includes(file) ? { hash: "missing" } : undefined);
      if (!entry) throw new Error(`No saved preimage for ${file}; session ownership cannot be established`);
      const currentHash = await hashWorkspacePath(this.workspaceRoot, file);
      if (currentHash === entry.hash) continue;
      if ((!entry.blob && entry.hash !== "missing") || currentHash.startsWith("symlink:") || currentHash.startsWith("directory:")) {
        const summary = `${file}: ${entry.hash} -> ${currentHash}\n`; sections.push(summary); length += summary.length; continue;
      }
      if (currentHash !== "missing" && (await fs.lstat(path.join(this.workspaceRoot, file))).size > MAX_FILE_BYTES) {
        const summary = `${file}: ${entry.hash} -> ${currentHash} (content diff omitted above 8 MiB; validate the artifact separately)\n`;
        sections.push(summary); length += summary.length; continue;
      }
      const directory = await fs.mkdtemp(path.join(this.root, "diff-"));
      try {
        const before = entry.blob ? await fs.readFile(path.join(this.root, "blobs", entry.blob)) : Buffer.alloc(0);
        const after = currentHash === "missing" ? Buffer.alloc(0) : await this.readWorkspaceContent(file, currentHash);
        if (entry.blob && workspaceHash(before) !== entry.hash) throw new Error("Workspace preimage checksum mismatch");
        if (after.length && workspaceHash(after) !== currentHash) throw new Error(`File changed during diff: ${file}`);
        await fs.writeFile(path.join(directory, "before"), before, { mode: 0o600 });
        await fs.writeFile(path.join(directory, "after"), after, { mode: 0o600 });
        const diff = await new Promise<string>((resolve, reject) => execFile("git", ["--no-pager", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "before", "after"], { cwd: directory, timeout: 10_000, maxBuffer: 32 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }, (error, stdout) => error && error.code !== 1 ? reject(error) : resolve(stdout)));
        const section = `Session changes: ${JSON.stringify(file)}\n${diff}`.slice(0, limit - length);
        sections.push(section); length += section.length;
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
    return sections.join("\n");
  }
}
