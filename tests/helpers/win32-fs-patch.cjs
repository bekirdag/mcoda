const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { setTimeout: delay } = require("node:timers/promises");

const retryable = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const retries = Number.parseInt(process.env.MCODA_FS_RM_RETRIES ?? "6", 10);
const baseDelayMs = Number.parseInt(process.env.MCODA_FS_RM_DELAY_MS ?? "50", 10);

const shouldRetry = (error) => {
  if (!error || typeof error !== "object") return false;
  return retryable.has(error.code);
};

const origRm = fsp.rm ? fsp.rm.bind(fsp) : fs.promises.rm.bind(fs.promises);
const origRmSync = fs.rmSync ? fs.rmSync.bind(fs) : undefined;
const origUnlink = fsp.unlink ? fsp.unlink.bind(fsp) : fs.promises.unlink.bind(fs.promises);
const origUnlinkSync = fs.unlinkSync ? fs.unlinkSync.bind(fs) : undefined;

const rmWithRetries = async (target, options) => {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await origRm(target, options);
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === retries - 1) {
        throw error;
      }
      await delay(baseDelayMs * (attempt + 1));
    }
  }
  throw lastError;
};

const rmSyncWithRetries = (target, options) => {
  if (!origRmSync) {
    throw new Error("fs.rmSync is not available in this Node version");
  }
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      origRmSync(target, options);
      return;
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === retries - 1) {
        throw error;
      }
      const wait = baseDelayMs * (attempt + 1);
      const end = Date.now() + wait;
      while (Date.now() < end) {
        // busy wait to avoid async in sync path
      }
    }
  }
  throw lastError;
};

fsp.rm = rmWithRetries;
fs.promises.rm = rmWithRetries;
fs.rmSync = rmSyncWithRetries;

const unlinkWithRetries = async (target) => rmWithRetries(target, { force: true });
const unlinkSyncWithRetries = (target) => rmSyncWithRetries(target, { force: true });

fsp.unlink = unlinkWithRetries;
fs.promises.unlink = unlinkWithRetries;
if (origUnlinkSync) {
  fs.unlinkSync = unlinkSyncWithRetries;
}
