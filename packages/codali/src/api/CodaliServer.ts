import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleChatCompletion, type ChatCompletionRequest } from "./ChatCompletionsAdapter.js";
import { runCodali, type CodaliRequest } from "./CodaliApi.js";
import type { RunContext, RunContextTenant } from "../runcontext/RunContextResolver.js";

/**
 * Local HTTP surface for Codali.
 *
 * Exposes the same result contract the CLI produces, so a product integrating
 * over HTTP and an engineer debugging on a terminal are exercising one
 * implementation.
 *
 * ## Tenant identity
 *
 * Tenant is derived from the **authenticated caller**, never read from a
 * request body or a client-supplied header. A tenant id in a body field is an
 * assertion by an untrusted party; honouring it would let any caller read
 * another tenant's tools and credentials by editing one JSON value.
 */

export interface CodaliServerPrincipal {
  tenant: RunContextTenant;
  /** Tools, credentials and limits this principal's tenant may use. */
  runContext?: RunContext;
  requesterId?: string;
}

export interface CodaliServerOptions {
  port?: number;
  host?: string;
  /**
   * Resolves an API key to a principal. Returning undefined rejects the
   * request. There is no anonymous mode: an unauthenticated caller has no
   * tenant, and a run without a tenant scope has no business reaching
   * connectors.
   */
  authenticate: (apiKey: string | undefined) => Promise<CodaliServerPrincipal | undefined>;
  workspaceRoot?: string;
  run?: typeof runCodali;
}

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
};

const send = (
  response: ServerResponse,
  status: number,
  payload: unknown,
): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
};

const readApiKey = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const apiKey = request.headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey.trim() : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Strips any caller-supplied tenant or run context and substitutes what the
 * authenticated principal is actually entitled to. This is the single point
 * where cross-tenant access is prevented, so it is deliberately unconditional
 * rather than a validation the caller could satisfy.
 */
const applyPrincipalScope = <T extends { runContext?: RunContext }>(
  payload: T,
  principal: CodaliServerPrincipal,
): T => ({
  ...payload,
  runContext: {
    ...(principal.runContext ?? {}),
    tenant: principal.tenant,
  },
});

export const createCodaliServer = (options: CodaliServerOptions): Server => {
  const run = options.run ?? runCodali;

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/healthz") {
      send(response, 200, { ok: true });
      return;
    }

    if (request.method !== "POST") {
      send(response, 405, { error: { code: "method_not_allowed" } });
      return;
    }

    const principal = await options.authenticate(readApiKey(request));
    if (!principal) {
      send(response, 401, { error: { code: "unauthorized" } });
      return;
    }

    const body = await readBody(request);
    if (!isRecord(body)) {
      send(response, 400, { error: { code: "invalid_request_body" } });
      return;
    }

    try {
      if (url.pathname === "/v1/chat/completions") {
        const chatRequest = body as unknown as ChatCompletionRequest;
        const scoped: ChatCompletionRequest = {
          ...chatRequest,
          codali: {
            ...(chatRequest.codali ?? {}),
            // Caller-supplied context is discarded, not merged.
            runContext: {
              ...(principal.runContext ?? {}),
              tenant: principal.tenant,
            },
            workspaceRoot: options.workspaceRoot ?? chatRequest.codali?.workspaceRoot,
          },
        };
        send(response, 200, await handleChatCompletion(scoped, { run }));
        return;
      }

      if (url.pathname === "/v1/codali/run") {
        const codaliRequest = applyPrincipalScope(
          body as unknown as CodaliRequest,
          principal,
        );
        send(
          response,
          200,
          await run({
            ...codaliRequest,
            workspaceRoot: options.workspaceRoot ?? codaliRequest.workspaceRoot,
          }),
        );
        return;
      }

      send(response, 404, { error: { code: "not_found" } });
    } catch (error) {
      send(response, 500, {
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
};

export const startCodaliServer = async (
  options: CodaliServerOptions,
): Promise<{ server: Server; port: number }> => {
  const server = createCodaliServer(options);
  const port = options.port ?? 8787;
  await new Promise<void>((resolve) => {
    server.listen(port, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    port: typeof address === "object" && address ? address.port : port,
  };
};
