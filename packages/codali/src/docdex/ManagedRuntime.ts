import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { withStateLock } from "../session/AtomicState.js";

const FEATURES = ["workspace_metadata_control", "embedding_input_type", "strict_repo_embeddings", "deterministic_profile_embeddings"];
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
export interface ManagedRuntimeIdentity { binary: string; binarySha256: string; version: string; }
export interface ManagedRuntimeArtifact { url: string; archiveSha256: string; binarySha256: string; }
export interface ManagedRuntimeManifest { schemaVersion: 1; version?: string; artifacts: Record<string, ManagedRuntimeArtifact>; }

const cleanEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SystemRoot"]) if (process.env[key]) env[key] = process.env[key];
  return env;
};
const execute = (command: string, args: string[], options: { cwd: string; signal?: AbortSignal; maxBuffer?: number }) => new Promise<Buffer>((resolve, reject) => {
  execFile(command, args, { ...options, env: cleanEnvironment(), encoding: "buffer", timeout: 30_000, maxBuffer: options.maxBuffer ?? 64 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) reject(new Error(`Docdex runtime command failed (${path.basename(command)}): ${error.code ?? "unknown"}`));
    else resolve(stdout);
  });
});
export const runtimeFileHash = async (file: string): Promise<string> => {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BINARY_BYTES) throw new Error("Docdex runtime must be a bounded regular file");
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/** No daemon, repo initialization, model request or global configuration access. */
export const inspectManagedDocdexRuntime = async (binary: string, expectedSha256?: string, signal?: AbortSignal, redirected = false): Promise<ManagedRuntimeIdentity> => {
  let resolved = binary;
  if (!path.isAbsolute(binary)) {
    if (binary.includes(path.sep)) throw new Error("Docdex binary must be an absolute path or a PATH command");
    resolved = "";
    for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute)) {
      const candidate = path.join(directory, binary);
      try { await fs.access(candidate, fs.constants.X_OK); resolved = candidate; break; } catch { /* next trusted PATH entry */ }
    }
    if (!resolved) throw new Error("No compatible Docdex runtime found on PATH");
  }
  resolved = await fs.realpath(resolved);
  const binarySha256 = await runtimeFileHash(resolved);
  if (expectedSha256 && expectedSha256 !== binarySha256) throw new Error("Docdex runtime checksum mismatch");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codali-runtime-probe-"));
  try {
    const info = JSON.parse((await execute(resolved, ["runtime-info"], { cwd, signal })).toString()) as { schema_version?: number; version?: string; executable?: string; managed_clients?: Record<string, boolean> };
    if (info.schema_version !== 1 || typeof info.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(info.version) || !FEATURES.every(feature => info.managed_clients?.[feature] === true)) throw new Error("Docdex runtime lacks required managed-client capabilities");
    if (typeof info.executable !== "string" || !path.isAbsolute(info.executable)) throw new Error("Docdex runtime did not identify its native executable");
    const native = await fs.realpath(info.executable);
    if (native !== resolved) {
      if (redirected || expectedSha256) throw new Error("Docdex runtime executable changed during qualification");
      return inspectManagedDocdexRuntime(native, undefined, signal, true);
    }
    return { binary: resolved, binarySha256, version: info.version };
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
};

export const runtimePlatformKey = (): string => {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "linux") {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return `linux-${process.arch}-${report?.header?.glibcVersionRuntime ? "gnu" : "musl"}`;
  }
  throw new Error(`Managed Codali runtime is not qualified for ${process.platform}-${process.arch}`);
};

export const validateRuntimeManifest = (value: unknown): ManagedRuntimeManifest => {
  const manifest = value as ManagedRuntimeManifest;
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.artifacts || typeof manifest.artifacts !== "object" || Array.isArray(manifest.artifacts)) throw new Error("Invalid Docdex runtime manifest");
  if (manifest.version !== undefined && (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))) throw new Error("Invalid Docdex release version");
  for (const [platform, artifact] of Object.entries(manifest.artifacts)) {
    if (!/^(linux-(x64|arm64)-(gnu|musl)|darwin-(x64|arm64))$/.test(platform) || !manifest.version || !artifact || typeof artifact.url !== "string" || typeof artifact.archiveSha256 !== "string" || typeof artifact.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.archiveSha256) || !/^[a-f0-9]{64}$/.test(artifact.binarySha256)) throw new Error("Invalid pinned Docdex artifact");
    const url = new URL(artifact.url);
    if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(`/bekirdag/docdex/releases/download/v${manifest.version}/`) || !url.pathname.endsWith(".tar.gz")) throw new Error("Docdex artifact must come from the pinned publisher release");
  }
  return manifest;
};

const download = async (artifact: ManagedRuntimeArtifact, destination: string, signal?: AbortSignal): Promise<void> => {
  const response = await fetch(artifact.url, { signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]), credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok || !response.body) throw new Error(`Docdex runtime download failed (${response.status})`);
  if (response.url && new URL(response.url).protocol !== "https:") throw new Error("Insecure Docdex download redirect");
  if (Number(response.headers.get("content-length")) > MAX_ARCHIVE_BYTES) { await response.body.cancel(); throw new Error("Docdex runtime archive exceeds the download limit"); }
  const handle = await fs.open(destination, "wx", 0o600); const hash = createHash("sha256"); let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > MAX_ARCHIVE_BYTES) throw new Error("Docdex runtime archive exceeds the download limit");
      hash.update(chunk); await handle.writeFile(chunk);
    }
    await handle.sync();
    if (hash.digest("hex") !== artifact.archiveSha256) throw new Error("Docdex runtime archive checksum mismatch");
  } finally { await handle.close(); }
};

/** Content-addressed private install. A failed upgrade leaves existing versions untouched. */
export const ensureManagedDocdexRuntime = async (options: { binary?: string; stateRoot?: string; manifest?: ManagedRuntimeManifest; signal?: AbortSignal } = {}): Promise<ManagedRuntimeIdentity> => {
  if (options.binary) return inspectManagedDocdexRuntime(options.binary, undefined, options.signal);
  const manifest = validateRuntimeManifest(options.manifest ?? JSON.parse(await fs.readFile(new URL("../../config/docdex-runtime.json", import.meta.url), "utf8")));
  const artifact = manifest.artifacts[runtimePlatformKey()];
  if (!artifact) {
    throw new Error("This build has no qualified Docdex release for this platform. Supply --docdex-binary with a compatible runtime or install a qualified Codali release.");
  }
  const root = path.resolve(options.stateRoot ?? path.join(os.homedir(), ".local", "state", "codali", "runtimes", "docdex"));
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.mode & 0o077 || (process.getuid && rootStat.uid !== process.getuid())) throw new Error("Docdex runtime directory must be private and owned by the current user");
  const destination = path.join(root, artifact.binarySha256);
  return withStateLock(path.join(root, "install"), async () => {
    options.signal?.throwIfAborted();
    // The OS-owned lock is released after a killed installer. Only its private
    // staging directories are disposable; committed versions are never pruned.
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (/^\.install-[A-Za-z0-9]+$/.test(entry.name) && entry.isDirectory()) await fs.rm(path.join(root, entry.name), { recursive: true });
    }
    let cached = false;
    try {
      const directory = await fs.lstat(destination);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || (process.getuid && directory.uid !== process.getuid())) throw new Error("Docdex cached release must be a private directory");
      cached = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (cached) {
      if (await runtimeFileHash(path.join(destination, "docdexd")) !== artifact.binarySha256) throw new Error("Docdex runtime checksum mismatch");
      const info = await inspectManagedDocdexRuntime(path.join(destination, "docdexd"), artifact.binarySha256, options.signal);
      if (info.version !== manifest.version) throw new Error("Docdex runtime version does not match the manifest");
      return info;
    }
    const staging = await fs.mkdtemp(path.join(root, ".install-"));
    try {
      const archive = path.join(staging, "runtime.tar.gz"); await download(artifact, archive, options.signal);
      // Extract only the single pinned member to bytes, never paths from
      // an archive. No package lifecycle scripts or machine-wide installers run.
      const bytes = await execute("tar", ["-xOf", archive, "docdexd"], { cwd: staging, signal: options.signal, maxBuffer: MAX_BINARY_BYTES });
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.binarySha256) throw new Error("Docdex extracted binary checksum mismatch");
      const binary = path.join(staging, "docdexd"); const handle = await fs.open(binary, "wx", 0o700);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const info = await inspectManagedDocdexRuntime(binary, artifact.binarySha256, options.signal);
      if (info.version !== manifest.version) throw new Error("Docdex runtime version does not match the manifest");
      options.signal?.throwIfAborted();
      await fs.unlink(archive); await fs.rename(staging, destination);
      const directory = await fs.open(root, "r");
      try { await directory.sync(); } catch (error) { if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      finally { await directory.close(); }
      return { ...info, binary: path.join(destination, "docdexd") };
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }, 180_000);
};
