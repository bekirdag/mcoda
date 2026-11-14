import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Each test process gets a private scheduler; tests never acquire a production GPU lock. */
export function configureMediaBridgeEnvironment(test, scriptsDirectory) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mcoda-media-tests-"));
  const previous = { PYTHONPATH: process.env.PYTHONPATH, MCODA_MEDIA_GPU_LOCK_PATH: process.env.MCODA_MEDIA_GPU_LOCK_PATH };
  process.env.PYTHONPATH = [scriptsDirectory, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  process.env.MCODA_MEDIA_GPU_LOCK_PATH = path.join(directory, "gpu.lock");
  test.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
}
