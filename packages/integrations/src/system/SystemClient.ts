import { ApplyUpdateResponse, UpdateChannel, UpdateInfo } from "@mcoda/shared";

const toQueryChannel = (channel?: UpdateChannel): string | undefined => {
  if (!channel) return undefined;
  if (channel === "nightly") return "nightly";
  return channel;
};

export class SystemClient {
  constructor(private baseUrl?: string) {}

  private ensureBaseUrl(): string {
    if (!this.baseUrl) {
      throw new Error("System update API is not configured (set MCODA_API_BASE_URL or MCODA_SYSTEM_API_URL).");
    }
    return this.baseUrl;
  }

  private async fetchJson<T>(input: URL, init?: RequestInit): Promise<T> {
    const resp = await fetch(input, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers as Record<string, string> | undefined) },
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`System update request failed (${resp.status}): ${detail || resp.statusText}`);
    }
    return (await resp.json()) as T;
  }

  async checkUpdate(channel?: UpdateChannel): Promise<UpdateInfo> {
    const base = this.ensureBaseUrl();
    const url = new URL("/system/update", base);
    const queryChannel = toQueryChannel(channel);
    if (queryChannel) {
      url.searchParams.set("channel", queryChannel);
    }
    return this.fetchJson<UpdateInfo>(url);
  }

  async applyUpdate(body?: { channel?: UpdateChannel }): Promise<ApplyUpdateResponse> {
    const base = this.ensureBaseUrl();
    const url = new URL("/system/update", base);
    return this.fetchJson<ApplyUpdateResponse>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body && body.channel ? JSON.stringify({ channel: toQueryChannel(body.channel) }) : undefined,
    });
  }
}
