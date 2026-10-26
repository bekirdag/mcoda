import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteJson } from "../../session/AtomicState.js";
import type { MediaArtifact, MediaJob } from "./MediaJobStore.js";

const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const format = (job: MediaJob) => job.operation === "images.generations" ? { extension: "png", mimeType: "image/png" }
  : job.operation === "audio.generations" ? { extension: "wav", mimeType: "audio/wav" }
    : job.operation === "videos.generations" ? { extension: "webm", mimeType: "video/webm" } : undefined;
const matchesFormat = (bytes: Buffer, extension: string): boolean => extension === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  : extension === "wav" ? bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE"
    : bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

/** Persist received output before acknowledging success; never resubmit inference during recovery. */
export const persistMediaArtifact = async (directory: string, job: MediaJob, bytes: Buffer): Promise<MediaArtifact> => {
  const media = format(job);
  if (!media || bytes.length > 67108864 || !matchesFormat(bytes, media.extension)) throw new Error("Media file format or size does not match the advertised contract");
  const artifact: MediaArtifact = { id: `${job.id}-artifact`, jobId: job.id, path: path.join(directory, `artifact.${media.extension}`), mimeType: media.mimeType,
    bytes: bytes.length, sha256: hash(bytes), model: job.modelId, configHash: job.configHash, createdAt: new Date().toISOString() };
  await atomicWriteJson(path.join(directory, "artifact-receipt.json"), { schemaVersion: 1, sessionId: job.sessionId, artifact });
  const temporary = path.join(directory, `.artifact-${randomUUID()}.partial`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    // link is atomic and fails if the destination exists; a partially written artifact is never published.
    await fs.link(temporary, artifact.path);
    const parent = await fs.open(directory, "r");
    try { await parent.sync(); } catch (error) { if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    finally { await parent.close(); }
  } finally { await handle.close().catch(() => undefined); await fs.unlink(temporary).catch(() => undefined); }
  return artifact;
};

export const recoverMediaArtifact = async (directory: string, job: MediaJob): Promise<MediaArtifact | undefined> => {
  let receipt: { schemaVersion: number; sessionId: string; artifact: MediaArtifact };
  try { receipt = JSON.parse(await fs.readFile(path.join(directory, "artifact-receipt.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const media = format(job); const artifact = receipt.artifact;
  if (!media || receipt.schemaVersion !== 1 || receipt.sessionId !== job.sessionId || artifact.jobId !== job.id || artifact.id !== `${job.id}-artifact` || artifact.configHash !== job.configHash || artifact.model !== job.modelId || artifact.mimeType !== media.mimeType || artifact.path !== path.join(directory, `artifact.${media.extension}`)) throw new Error("Media artifact receipt does not match this job");
  let stat;
  try { stat = await fs.lstat(artifact.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.size !== artifact.bytes || stat.size > 67108864) throw new Error("Media artifact receipt size or path is invalid");
  const bytes = await fs.readFile(artifact.path);
  if (hash(bytes) !== artifact.sha256 || !matchesFormat(bytes, media.extension)) throw new Error("Media artifact receipt checksum or format mismatch");
  return artifact;
};
