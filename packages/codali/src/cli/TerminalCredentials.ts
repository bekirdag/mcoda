import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { credentialFilePath, parseCredentialFile, resetCredentialCache } from "../runcontext/CredentialFile.js";
import { withStateLock } from "../session/AtomicState.js";

export const setTerminalCredential = async (key?: string): Promise<void> => {
  if (key !== undefined && (!key.trim() || /[\r\n\0]/.test(key) || key.length > 8192)) throw new Error("Invalid API key");
  const file = credentialFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withStateLock(file, async () => {
    let existing = "";
    try { const stat = await fs.lstat(file); if (stat.isSymbolicLink()) throw new Error("Credential file must not be a symlink"); existing = await fs.readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const lines = existing.split(/\r?\n/).filter(line => !Object.keys(parseCredentialFile(line)).some(name => ["MCODA_MSWARM_API_KEY", "MSWARM_API_KEY", "CODALI_MSWARM_LOGGED_OUT"].includes(name)));
    lines.push(key === undefined ? "CODALI_MSWARM_LOGGED_OUT=1" : `MCODA_MSWARM_API_KEY=${key.trim()}`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${lines.filter(Boolean).join("\n")}\n`); await handle.sync(); await handle.close(); await fs.rename(temporary, file); }
    finally { await handle.close().catch(() => undefined); await fs.unlink(temporary).catch(() => undefined); }
  });
  resetCredentialCache();
};

export const readTerminalCredential = async (fromStdin: boolean): Promise<string> => {
  if (fromStdin) {
    if (process.stdin.isTTY) throw new Error("--stdin requires piped input");
    let value = "";
    for await (const chunk of process.stdin) { value += String(chunk); if (value.length > 8192) throw new Error("API key input is too large"); }
    return value.trim();
  }
  if (!process.stdin.isTTY) throw new Error("Use codali login --stdin with piped input");
  return new Promise((resolve, reject) => {
    let value = ""; const wasRaw = process.stdin.isRaw;
    const finish = (error?: Error) => { process.stdin.off("data", onData); process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stderr.write("\n"); error ? reject(error) : resolve(value); };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") { finish(new Error("Login cancelled")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") { if (value) { value = value.slice(0, -1); process.stderr.write("\b \b"); } }
        else if (character >= " " && character <= "~") { value += character; process.stderr.write("*"); if (value.length > 8192) { finish(new Error("API key is too large")); return; } }
      }
    };
    process.stdin.setRawMode(true); process.stdin.on("data", onData); process.stdin.resume(); process.stderr.write("mSwarm API key: ");
  });
};
