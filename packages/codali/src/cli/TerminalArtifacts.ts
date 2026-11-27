import { spawn } from "node:child_process";
import type { MediaJobStore } from "../connectors/media/MediaJobStore.js";

export const artifactViewer = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string => {
  if (platform === "darwin") return "open";
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) return "xdg-open";
  throw new Error("No supported desktop viewer is available here. Use /artifacts export JOB_ID PATH, then download the file to your desktop.");
};

/** Only an explicit terminal action can launch a local viewer; never a model tool. */
export const openTerminalArtifact = async (store: MediaJobStore, id: string, signal: AbortSignal): Promise<string> => {
  signal.throwIfAborted();
  const artifact = await store.verifiedArtifact(id);
  const executable = artifactViewer(process.platform, process.env);
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [artifact.path], { shell: false, detached: false, stdio: "ignore", signal });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Viewer launcher timed out; export the file and open it manually")); }, 10000);
    const finish = (error?: Error) => { clearTimeout(timeout); if (error) reject(error); else resolve(); };
    child.once("error", finish);
    child.once("exit", (code, signal) => finish(code === 0 ? undefined : new Error(`Viewer launcher failed (${signal ?? code}); export the file and open it manually`)));
  });
  return artifact.path;
};
