import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Connection } from "@mcoda/db";
import { assertRegularStateFile } from "./SessionStoragePath.js";

/** Windows cannot flush a directory handle through Node's fsync. File contents
 * are still flushed before publication; POSIX directory durability is retained. */
export const syncStateDirectory = async (directory: string): Promise<void> => {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!["EINVAL", "ENOTSUP"].includes(code) && !(process.platform === "win32" && code === "EPERM")) throw error;
  } finally { await handle.close(); }
};

export const atomicWriteJson = async (file: string, value: unknown): Promise<void> => {
  await assertRegularStateFile(file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, file);
    await syncStateDirectory(path.dirname(file));
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
};

/** Short storage transaction lock. Never hold across inference or tool execution. */
const localTransactions = new Map<string, Promise<void>>();
/** Probe an execution lock without relying on process IDs or waiting behind a live owner. */
export const tryStateLock = async <T>(file: string, operation: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> => {
  if (localTransactions.has(file)) return { acquired: false };
  let entered = false;
  try { return { acquired: true, value: await withStateLock(file, async () => { entered = true; return operation(); }, 0) }; }
  catch (error) { if (!entered && (error as { code?: string }).code === "SQLITE_BUSY") return { acquired: false }; throw error; }
};
export const withStateLock = async <T>(file: string, operation: () => Promise<T>, timeoutMs = 10_000): Promise<T> => {
  const previous = localTransactions.get(file) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => next);
  localTransactions.set(file, tail);
  await previous;
  try { return await transact(file, operation, timeoutMs); }
  finally { release(); if (localTransactions.get(file) === tail) localTransactions.delete(file); }
};

const transact = async <T>(file: string, operation: () => Promise<T>, timeoutMs: number): Promise<T> => {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Reuse mcoda's SQLite dependency for an OS-owned transaction lock. A killed
  // process releases it automatically, without PID reuse or stale recovery files.
  const databasePath = `${file}.transactions.sqlite`;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await assertRegularStateFile(databasePath + suffix);
  const connection = await Connection.open(databasePath);
  try {
    await fs.chmod(databasePath, 0o600);
    // Do not park SQLite busy handlers on libuv threads needed by the owner to
    // finish its filesystem transaction. Retry asynchronously across processes.
    await connection.db.exec("PRAGMA busy_timeout = 0;");
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try { await connection.db.exec("BEGIN IMMEDIATE;"); break; }
      catch (error) {
        if ((error as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try {
      const result = await operation();
      await connection.db.exec("COMMIT;");
      return result;
    } catch (error) {
      await connection.db.exec("ROLLBACK;").catch(() => undefined);
      throw error;
    }
  } finally {
    await connection.close();
  }
};
