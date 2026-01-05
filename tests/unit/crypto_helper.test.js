import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CryptoHelper } from "../../packages/shared/src/crypto/CryptoHelper.js";

test("CryptoHelper round-trips secrets with a generated key", async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  try {
    const secret = "mcoda-secret";
    const encrypted = await CryptoHelper.encryptSecret(secret);
    const decrypted = await CryptoHelper.decryptSecret(encrypted);
    assert.equal(decrypted, secret);

    const keyPath = path.join(tempHome, ".mcoda", "mcoda.key");
    const key = await fs.readFile(keyPath);
    assert.equal(key.length, 32);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});
