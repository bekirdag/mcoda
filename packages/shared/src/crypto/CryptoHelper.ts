import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PathHelper } from "../paths/PathHelper.js";

const KEY_FILENAME = "mcoda.key";
const IV_LENGTH = 12; // AES-GCM recommended IV size
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256-bit

export class CryptoHelper {
  private static async loadOrCreateKey(): Promise<Buffer> {
    const dir = PathHelper.getGlobalMcodaDir();
    await PathHelper.ensureDir(dir);
    const keyPath = path.join(dir, KEY_FILENAME);
    try {
      const existing = await fs.readFile(keyPath);
      if (existing.length === KEY_LENGTH) return existing;
    } catch {
      /* ignored */
    }
    const key = randomBytes(KEY_LENGTH);
    await fs.writeFile(keyPath, key, { mode: 0o600 });
    return key;
  }

  /**
   * Encrypts a plaintext payload using AES-256-GCM and returns a base64 blob
   * that contains IV + auth tag + ciphertext. The encryption key is stored
   * under ~/.mcoda/ with user-only permissions.
   */
  static async encryptSecret(plaintext: string): Promise<string> {
    const key = await this.loadOrCreateKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  }

  /**
   * Decrypts a secret previously produced by encryptSecret. Throws if the
   * payload is malformed or the authentication tag does not validate.
   */
  static async decryptSecret(payload: string): Promise<string> {
    const buffer = Buffer.from(payload, "base64");
    const iv = buffer.subarray(0, IV_LENGTH);
    const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const key = await this.loadOrCreateKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  }
}
