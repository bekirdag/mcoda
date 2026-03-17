import fs from "node:fs/promises";
import path from "node:path";
import { CryptoHelper, PathHelper } from "@mcoda/shared";

export interface StoredMswarmConfigState {
  baseUrl?: string;
  encryptedApiKey?: string;
  timeoutMs?: number;
  agentSlugPrefix?: string;
}

export interface MswarmConfigFileState extends Record<string, unknown> {
  mswarm?: StoredMswarmConfigState;
}

export interface MswarmConfigState {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  agentSlugPrefix?: string;
}

export class MswarmConfigStore {
  constructor(private readonly configFilePath: string = PathHelper.getGlobalConfigPath()) {}

  configPath(): string {
    return this.configFilePath;
  }

  async readState(): Promise<MswarmConfigState> {
    const fileState = await this.readConfigFile();
    const stored = fileState.mswarm ?? {};
    let apiKey: string | undefined;
    if (stored.encryptedApiKey) {
      try {
        apiKey = await CryptoHelper.decryptSecret(stored.encryptedApiKey);
      } catch (error) {
        throw new Error(
          `Stored mswarm API key at ${this.configPath()} could not be decrypted: ${(error as Error).message ?? String(error)}`,
        );
      }
    }
    return {
      baseUrl: stored.baseUrl,
      apiKey,
      timeoutMs: stored.timeoutMs,
      agentSlugPrefix: stored.agentSlugPrefix,
    };
  }

  async saveApiKey(apiKey: string): Promise<MswarmConfigState> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("mswarm api key is required");
    }
    const fileState = await this.readConfigFile();
    const encryptedApiKey = await CryptoHelper.encryptSecret(trimmed);
    await this.writeConfigFile({
      ...fileState,
      mswarm: {
        ...(fileState.mswarm ?? {}),
        encryptedApiKey,
      },
    });
    return this.readState();
  }

  private async readConfigFile(): Promise<MswarmConfigFileState> {
    try {
      const raw = await fs.readFile(this.configPath(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as MswarmConfigFileState;
      }
    } catch {
      return {};
    }
    return {};
  }

  private async writeConfigFile(config: MswarmConfigFileState): Promise<void> {
    await PathHelper.ensureDir(path.dirname(this.configPath()));
    await fs.writeFile(this.configPath(), JSON.stringify(config, null, 2), "utf8");
  }
}
