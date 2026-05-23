import type {
  McodaAgentSetupHttpRequest,
  McodaAgentSetupHttpResponse,
  McodaAgentSetupService,
  McodaMswarmConnectionInput,
  McodaMswarmConnectionValidationMode,
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
            connection: parseMswarmConnection(
              record.connection ?? record.mswarm_connection,
              record
            ),
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

function parseMswarmConnection(
  value: unknown,
  fallback: Record<string, unknown> = {}
): McodaMswarmConnectionInput | undefined {
  const record = asRecord(value);
  const connection: McodaMswarmConnectionInput = {
    tenantId:
      stringValue(record.tenantId) ??
      stringValue(record.tenant_id) ??
      stringValue(fallback.tenantId) ??
      stringValue(fallback.tenant_id),
    productSlug:
      stringValue(record.productSlug) ??
      stringValue(record.product_slug) ??
      stringValue(fallback.productSlug) ??
      stringValue(fallback.product_slug),
    apiKeyId:
      stringValue(record.apiKeyId) ??
      stringValue(record.api_key_id) ??
      stringValue(fallback.apiKeyId) ??
      stringValue(fallback.api_key_id),
    ownerUserId:
      stringValue(record.ownerUserId) ??
      stringValue(record.owner_user_id) ??
      stringValue(fallback.ownerUserId) ??
      stringValue(fallback.owner_user_id),
    ownerKeycloakUserId:
      stringValue(record.ownerKeycloakUserId) ??
      stringValue(record.owner_keycloak_user_id) ??
      stringValue(fallback.ownerKeycloakUserId) ??
      stringValue(fallback.owner_keycloak_user_id),
    featureKey:
      stringValue(record.featureKey) ??
      stringValue(record.feature_key) ??
      stringValue(fallback.featureKey) ??
      stringValue(fallback.feature_key),
    installationId:
      stringValue(record.installationId) ??
      stringValue(record.installation_id) ??
      stringValue(fallback.installationId) ??
      stringValue(fallback.installation_id),
    installationStatus:
      stringValue(record.installationStatus) ??
      stringValue(record.installation_status) ??
      stringValue(fallback.installationStatus) ??
      stringValue(fallback.installation_status),
    validationMode: parseValidationMode(
      record.validationMode ??
        record.validation_mode ??
        fallback.validationMode ??
        fallback.validation_mode
    ),
  };
  return Object.values(connection).some((entry) => entry !== undefined)
    ? connection
    : undefined;
}

function parseValidationMode(
  value: unknown
): McodaMswarmConnectionValidationMode | undefined {
  if (value === "auto" || value === "required" || value === "skip") {
    return value;
  }
  return undefined;
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
