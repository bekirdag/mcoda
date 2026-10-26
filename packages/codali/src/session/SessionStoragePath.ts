import { constants, promises as fs } from "node:fs";
import path from "node:path";

/** Existing state files must not alias another file or an external endpoint. */
export async function assertRegularStateFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error(`Unsafe session state file: ${path.basename(file)}`);
      if (stat.nlink === 1) return;
      // An atomic rename may unlink the old inode while the asynchronous stat
      // is completing. Validate the new named file; never accept the old one.
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  throw new Error(`Session state file changed during validation: ${path.basename(file)}`);
}

/** Resolve trusted outer aliases (e.g. macOS /var) once, then reject symlinks
 * beneath the storage boundary. The terminal sandbox prevents model processes
 * from replacing these parents; this is not isolation from a hostile OS user. */
export async function sessionStoragePath(options: {
  workspaceRoot: string; storageRoot: string; file: string; allowExternal: boolean; createParents?: boolean; directory?: boolean;
}): Promise<string> {
  const workspace = path.resolve(options.workspaceRoot); const root = path.resolve(options.storageRoot); const file = path.resolve(options.file);
  const inside = (base: string, target: string) => target === base || target.startsWith(`${base}${path.sep}`);
  if (!inside(root, file)) throw new Error("Session state path escapes its storage root");
  let anchor: string;
  if (inside(workspace, root)) anchor = workspace;
  else {
    if (!options.allowExternal) throw new Error("Session storage path is outside workspace root");
    // Only the host can select this external boundary. Existing outer aliases
    // are trusted, while the root and all descendants must be real directories.
    anchor = path.dirname(root);
    while (true) {
      try { await fs.realpath(anchor); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(anchor) === anchor) throw error;
        anchor = path.dirname(anchor);
      }
    }
  }
  let canonical = await fs.realpath(anchor);
  const directory = options.directory ? file : path.dirname(file);
  const relative = path.relative(anchor, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Invalid session storage boundary");
  for (const component of relative.split(path.sep).filter(Boolean)) {
    canonical = path.join(canonical, component);
    let stat;
    try { stat = await fs.lstat(canonical); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.createParents) throw error;
      try { await fs.mkdir(canonical, { mode: 0o700 }); }
      catch (creation) { if ((creation as NodeJS.ErrnoException).code !== "EEXIST") throw creation; }
      stat = await fs.lstat(canonical);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe session storage directory");
  }
  if (options.directory) return canonical;
  const resolved = path.join(canonical, path.basename(file));
  await assertRegularStateFile(resolved);
  return resolved;
}

export async function readStateFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1) throw new Error("Unsafe session state file");
      if (stat.nlink === 1) return await handle.readFile("utf8");
    } finally { await handle.close(); }
  }
  throw new Error(`Session state file changed during validation: ${path.basename(file)}`);
}
