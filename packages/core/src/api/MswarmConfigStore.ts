import fs from 'node:fs/promises';
import path from 'node:path';
import { CryptoHelper, PathHelper } from '@mcoda/shared';

export interface StoredMswarmConfigState {
  baseUrl?: string;
  encryptedApiKey?: string;
  timeoutMs?: number;
  agentSlugPrefix?: string;
  consentAccepted?: boolean;
  consentPolicyVersion?: string;
  consentToken?: string;
  clientId?: string;
  clientType?: string;
  registeredAtMs?: number;
  uploadSigningSecret?: string;
  deletionRequestedAtMs?: number;
}

export interface MswarmConfigFileState extends Record<string, unknown> {
  mswarm?: StoredMswarmConfigState;
}

export interface MswarmConfigState {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  agentSlugPrefix?: string;
  consentAccepted?: boolean;
  consentPolicyVersion?: string;
  consentToken?: string;
  clientId?: string;
  clientType?: string;
  registeredAtMs?: number;
  uploadSigningSecret?: string;
  deletionRequestedAtMs?: number;
}

export interface MswarmConsentState {
  consentAccepted: boolean;
  consentPolicyVersion?: string;
  consentToken?: string;
  clientId?: string;
  clientType?: string;
  registeredAtMs?: number;
  uploadSigningSecret?: string;
  deletionRequestedAtMs?: number;
}

export class MswarmConfigStore {
  constructor(
    private readonly configFilePath: string = PathHelper.getGlobalConfigPath()
  ) {}

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
          `Stored mswarm API key at ${this.configPath()} could not be decrypted: ${(error as Error).message ?? String(error)}`
        );
      }
    }
    return {
      baseUrl: stored.baseUrl,
      apiKey,
      timeoutMs: stored.timeoutMs,
      agentSlugPrefix: stored.agentSlugPrefix,
      consentAccepted: stored.consentAccepted,
      consentPolicyVersion: stored.consentPolicyVersion,
      consentToken: stored.consentToken,
      clientId: stored.clientId,
      clientType: stored.clientType,
      registeredAtMs: stored.registeredAtMs,
      uploadSigningSecret: stored.uploadSigningSecret,
      deletionRequestedAtMs: stored.deletionRequestedAtMs,
    };
  }

  async saveApiKey(apiKey: string): Promise<MswarmConfigState> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error('mswarm api key is required');
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

  async saveConsentState(
    consent: MswarmConsentState
  ): Promise<MswarmConfigState> {
    const fileState = await this.readConfigFile();
    await this.writeConfigFile({
      ...fileState,
      mswarm: {
        ...(fileState.mswarm ?? {}),
        consentAccepted: consent.consentAccepted,
        consentPolicyVersion: normalizeOptionalString(
          consent.consentPolicyVersion
        ),
        consentToken: normalizeOptionalString(consent.consentToken),
        clientId: normalizeOptionalString(consent.clientId),
        clientType: normalizeOptionalString(consent.clientType),
        registeredAtMs: normalizeOptionalPositiveInt(consent.registeredAtMs),
        uploadSigningSecret: normalizeOptionalString(
          consent.uploadSigningSecret
        ),
        deletionRequestedAtMs: normalizeOptionalPositiveInt(
          consent.deletionRequestedAtMs
        ),
      },
    });
    return this.readState();
  }

  async clearConsentState(): Promise<MswarmConfigState> {
    const fileState = await this.readConfigFile();
    await this.writeConfigFile({
      ...fileState,
      mswarm: {
        ...(fileState.mswarm ?? {}),
        consentAccepted: false,
        consentToken: undefined,
        uploadSigningSecret: undefined,
      },
    });
    return this.readState();
  }

  private async readConfigFile(): Promise<MswarmConfigFileState> {
    try {
      const raw = await fs.readFile(this.configPath(), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as MswarmConfigFileState;
      }
    } catch {
      return {};
    }
    return {};
  }

  private async writeConfigFile(config: MswarmConfigFileState): Promise<void> {
    await PathHelper.ensureDir(path.dirname(this.configPath()));
    await fs.writeFile(
      this.configPath(),
      JSON.stringify(config, null, 2),
      'utf8'
    );
  }
}

function normalizeOptionalString(
  value: string | undefined
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalPositiveInt(
  value: number | undefined
): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}
