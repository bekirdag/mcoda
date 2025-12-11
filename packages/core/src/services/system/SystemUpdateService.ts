import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { ApplyUpdateResponse, PathHelper, UpdateChannel, UpdateInfo } from "@mcoda/shared";
import { GlobalCommandStatus, GlobalRepository } from "@mcoda/db";
import { SystemClient } from "@mcoda/integrations";

const nowIso = (): string => new Date().toISOString();

interface ReleasesState {
  lastCheck?: (UpdateInfo & { checkedAt: string });
  preferences?: { channel?: UpdateChannel };
}

export interface UpdateCheckResult {
  info: UpdateInfo;
  checkedAt: string;
  channel: UpdateChannel;
}

export type ApplyStatus = ApplyUpdateResponse["status"];

export interface ApplyResult extends ApplyUpdateResponse {
  targetVersion: string;
  npmCommand: string;
}

const normalizeChannel = (channel?: string): UpdateChannel => {
  if (!channel) return "stable";
  if (channel === "stable" || channel === "beta" || channel === "nightly") return channel;
  throw new Error(`Unsupported channel: ${channel}`);
};

const parseJson = async <T>(filePath: string): Promise<T | undefined> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

export class SystemUpdateService {
  private mcodaDir: string;

  private constructor(
    private client: SystemClient,
    private repo?: GlobalRepository,
    options: { mcodaDir?: string } = {},
  ) {
    this.mcodaDir = options.mcodaDir ?? PathHelper.getGlobalMcodaDir();
  }

  static async create(
    baseUrl?: string,
    options: { client?: SystemClient; repo?: GlobalRepository; mcodaDir?: string } = {},
  ): Promise<SystemUpdateService> {
    const client =
      options.client ??
      new SystemClient(baseUrl ?? process.env.MCODA_API_BASE_URL ?? process.env.MCODA_SYSTEM_API_URL);
    let repo = options.repo;
    if (!repo) {
      try {
        repo = await GlobalRepository.create();
      } catch {
        repo = undefined;
      }
    }
    return new SystemUpdateService(client, repo, { mcodaDir: options.mcodaDir });
  }

  async close(): Promise<void> {
    if (this.repo) {
      await this.repo.close();
    }
  }

  private releasesPath(): string {
    return path.join(this.mcodaDir, "releases.json");
  }

  async readState(): Promise<ReleasesState> {
    return (await parseJson<ReleasesState>(this.releasesPath())) ?? {};
  }

  private async writeState(state: ReleasesState): Promise<void> {
    await PathHelper.ensureDir(this.mcodaDir);
    await fs.writeFile(this.releasesPath(), JSON.stringify(state, null, 2), "utf8");
  }

  async startRun(payload: Record<string, unknown>): Promise<string | undefined> {
    const startedAt = nowIso();
    const run = await this.repo?.createCommandRun({
      commandName: "update",
      startedAt,
      status: "running",
      payload,
    });
    return run?.id;
  }

  async finishRun(
    id: string | undefined,
    update: { status: GlobalCommandStatus; exitCode?: number; errorSummary?: string | null; result?: Record<string, unknown> },
  ): Promise<void> {
    if (!id || !this.repo) return;
    await this.repo.completeCommandRun(id, {
      status: update.status,
      completedAt: nowIso(),
      exitCode: update.exitCode ?? null,
      errorSummary: update.errorSummary ?? null,
      result: update.result,
    });
  }

  async resolveChannel(preferred?: UpdateChannel): Promise<UpdateChannel> {
    const state = await this.readState();
    return normalizeChannel(preferred ?? state.preferences?.channel ?? "stable");
  }

  async savePreferredChannel(channel: UpdateChannel): Promise<void> {
    const state = await this.readState();
    await this.writeState({
      ...state,
      preferences: { ...(state.preferences ?? {}), channel },
    });
  }

  async checkUpdate(channel?: UpdateChannel): Promise<UpdateCheckResult> {
    const resolved = await this.resolveChannel(channel);
    const info = await this.client.checkUpdate(resolved);
    const checkedAt = nowIso();
    const state = await this.readState();
    await this.writeState({
      ...state,
      preferences: { ...(state.preferences ?? {}), channel: resolved },
      lastCheck: {
        ...info,
        checkedAt,
        channel: resolved,
      },
    });
    return { info, checkedAt, channel: resolved };
  }

  async applyUpdate(channel?: UpdateChannel): Promise<ApplyUpdateResponse> {
    const resolved = channel ? normalizeChannel(channel) : undefined;
    return this.client.applyUpdate(resolved ? { channel: resolved } : undefined);
  }

  async recordApplyState(info: UpdateInfo, channel: UpdateChannel, targetVersion: string): Promise<void> {
    const checkedAt = nowIso();
    const state = await this.readState();
    await this.writeState({
      ...state,
      preferences: { ...(state.preferences ?? {}), channel },
      lastCheck: {
        ...info,
        currentVersion: targetVersion,
        latestVersion: targetVersion,
        updateAvailable: false,
        channel,
        checkedAt,
      },
    });
  }

  async runNpmInstall(targetVersion: string, options: { quiet?: boolean } = {}): Promise<{ code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn("npm", ["install", "-g", `mcoda@${targetVersion}`], {
        stdio: options.quiet ? "ignore" : "inherit",
      });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => resolve({ code: code ?? 0 }));
    });
  }
}
