import type {
  McodaAgentSetupHttpRequest,
  McodaAgentSetupHttpResponse,
  McodaAgentSetupService,
} from "../types.js";

export interface McodaAgentSetupHttpHandlers {
  getAgentSettings(request?: unknown): Promise<McodaAgentSetupHttpResponse>;
  postMswarmApiKey(
    body: unknown,
    request?: unknown
  ): Promise<McodaAgentSetupHttpResponse>;
  postAgentsSync(
    body?: unknown,
    request?: unknown
  ): Promise<McodaAgentSetupHttpResponse>;
  patchAgentSettings(
    body: unknown,
    request?: unknown
  ): Promise<McodaAgentSetupHttpResponse>;
  postAgentsTest(
    body: unknown,
    request?: unknown
  ): Promise<McodaAgentSetupHttpResponse>;
}

export function createMcodaAgentSetupHttpHandlers(
  service: McodaAgentSetupService
): McodaAgentSetupHttpHandlers {
  return {
    async getAgentSettings(request) {
      return jsonResponse(200, await service.fetchSnapshot(request));
    },
    async postMswarmApiKey(body, request) {
      const record = asRecord(body);
      return jsonResponse(
        200,
        await service.configureMswarmApiKey(
          {
            apiKey:
              stringValue(record.mswarm_api_key) ??
              stringValue(record.mswarmApiKey) ??
              stringValue(record.apiKey) ??
              "",
            reasonCode:
              stringValue(record.reason_code) ??
              stringValue(record.reasonCode) ??
              undefined,
            metadata: asOptionalRecord(record.metadata),
          },
          request
        )
      );
    },
    async postAgentsSync(body, request) {
      const record = asRecord(body);
      return jsonResponse(
        200,
        await service.syncAgents(
          {
            reasonCode:
              stringValue(record.reason_code) ??
              stringValue(record.reasonCode) ??
              undefined,
            metadata: asOptionalRecord(record.metadata),
          },
          request
        )
      );
    },
    async patchAgentSettings(body, request) {
      const record = asRecord(body);
      return jsonResponse(
        200,
        await service.updateAssignments(
          {
            assignments: asStringNullRecord(record.assignments),
            reasonCode:
              stringValue(record.reason_code) ??
              stringValue(record.reasonCode) ??
              undefined,
            metadata: asOptionalRecord(record.metadata),
          },
          request
        )
      );
    },
    async postAgentsTest(body, request) {
      const record = asRecord(body);
      return jsonResponse(
        200,
        await service.testAgent(
          {
            slug: stringValue(record.slug) ?? "",
            prompt: stringValue(record.prompt) ?? undefined,
            timeoutMs: numberValue(record.timeout_ms) ?? numberValue(record.timeoutMs) ?? undefined,
          },
          request
        )
      );
    },
  };
}

export function createMcodaAgentSetupHttpHandler(
  service: McodaAgentSetupService,
  options: { basePath?: string } = {}
): (request: McodaAgentSetupHttpRequest) => Promise<McodaAgentSetupHttpResponse> {
  const handlers = createMcodaAgentSetupHttpHandlers(service);
  const basePath = normalizePath(options.basePath ?? "/api/mcoda");
  return async (request) => {
    try {
      const method = request.method.trim().toUpperCase();
      const route = normalizeRoute(request.path ?? request.url ?? "/", basePath);
      const rawRequest = request.raw ?? request;
      if (method === "GET" && route === "/agent-settings") {
        return handlers.getAgentSettings(rawRequest);
      }
      if (method === "POST" && route === "/mswarm-api-key") {
        return handlers.postMswarmApiKey(request.body, rawRequest);
      }
      if (method === "POST" && route === "/agents/sync") {
        return handlers.postAgentsSync(request.body, rawRequest);
      }
      if (method === "PATCH" && route === "/agent-settings") {
        return handlers.patchAgentSettings(request.body, rawRequest);
      }
      if (method === "POST" && route === "/agents/test") {
        return handlers.postAgentsTest(request.body, rawRequest);
      }
      return jsonResponse(404, { error: "not found" });
    } catch (error) {
      return jsonResponse(400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

function jsonResponse(
  status: number,
  body: unknown
): McodaAgentSetupHttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json",
    },
    body,
  };
}

function normalizeRoute(pathOrUrl: string, basePath: string): string {
  let pathname = pathOrUrl;
  try {
    pathname = new URL(pathOrUrl, "http://localhost").pathname;
  } catch {
    pathname = pathOrUrl.split("?")[0] ?? pathOrUrl;
  }
  const normalized = normalizePath(pathname);
  if (normalized === basePath) return "/";
  if (normalized.startsWith(`${basePath}/`)) {
    return normalized.slice(basePath.length) || "/";
  }
  return normalized;
}

function normalizePath(pathname: string): string {
  const prefixed = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return prefixed.replace(/\/+$/, "") || "/";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return Object.keys(record).length ? record : undefined;
}

function asStringNullRecord(value: unknown): Record<string, string | null> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      typeof entry === "string" && entry.trim() ? entry : null,
    ])
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
