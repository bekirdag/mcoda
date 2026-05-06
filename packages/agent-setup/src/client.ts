import type {
  McodaAgentSetupClient,
  McodaAgentSetupSnapshot,
  McodaAgentTestResult,
} from "./types.js";

type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface CreateMcodaAgentSetupClientInput {
  baseUrl: string;
  getAuthHeaders?:
    | (() => Promise<Record<string, string>> | Record<string, string>)
    | Record<string, string>;
  fetch?: FetchLike;
}

export function createMcodaAgentSetupClient(
  input: CreateMcodaAgentSetupClientInput
): McodaAgentSetupClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const fetchImpl = input.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) {
    throw new Error("fetch is required to create a mcoda agent setup client");
  }

  const requestJson = async <T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
    } = {}
  ): Promise<T> => {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(await resolveAuthHeaders(input.getAuthHeaders)),
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const payload = await response.json();
        if (
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof (payload as { error?: unknown }).error === "string"
        ) {
          message = (payload as { error: string }).error;
        }
      } catch {
        const text = await response.text().catch(() => "");
        if (text.trim()) message = text.trim();
      }
      throw new Error(`mcoda agent setup request failed: ${message}`);
    }
    return (await response.json()) as T;
  };

  return {
    fetchSnapshot: () =>
      requestJson<McodaAgentSetupSnapshot>("/agent-settings"),
    configureMswarmApiKey: (request) =>
      requestJson<McodaAgentSetupSnapshot>("/mswarm-api-key", {
        method: "POST",
        body: {
          mswarm_api_key: request.apiKey,
          reason_code: request.reasonCode,
          metadata: request.metadata,
        },
      }),
    syncAgents: (request = {}) =>
      requestJson<McodaAgentSetupSnapshot>("/agents/sync", {
        method: "POST",
        body: {
          reason_code: request.reasonCode,
          metadata: request.metadata,
        },
      }),
    updateAssignments: (request) =>
      requestJson<McodaAgentSetupSnapshot>("/agent-settings", {
        method: "PATCH",
        body: {
          assignments: request.assignments,
          reason_code: request.reasonCode,
          metadata: request.metadata,
        },
      }),
    testAgent: (request) =>
      requestJson<McodaAgentTestResult>("/agents/test", {
        method: "POST",
        body: {
          slug: request.slug,
          prompt: request.prompt,
          timeout_ms: request.timeoutMs,
        },
      }),
  };
}

async function resolveAuthHeaders(
  input:
    | CreateMcodaAgentSetupClientInput["getAuthHeaders"]
    | undefined
): Promise<Record<string, string>> {
  if (!input) return {};
  if (typeof input === "function") return input();
  return input;
}
