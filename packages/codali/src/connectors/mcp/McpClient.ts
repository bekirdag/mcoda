import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

/**
 * Minimal MCP client.
 *
 * Deliberately covers only `tools/list` and `tools/call`. Resources and prompts
 * are deferred because no requirement in `codali_workflow.txt` needs them, and
 * an unused surface is still a surface to maintain and secure.
 *
 * The transports come from the official SDK rather than being hand-rolled, so
 * protocol lifecycle, framing, and session handling stay the SDK's problem.
 * Only the two transports the spec currently defines are offered — stdio and
 * Streamable HTTP. There is no separate legacy HTTP+SSE transport: current MCP
 * carries SSE *within* Streamable HTTP where it is needed.
 */

/**
 * Protocol version this build was written and tested against. Asserted in
 * tests so an SDK bump that changes the wire protocol fails loudly here rather
 * than silently against a live server.
 */
export const CODALI_MCP_PROTOCOL_VERSION = "2025-11-25";
export const CODALI_MCP_SDK_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

export const CODALI_MCP_CLIENT_INFO = {
  name: "codali",
  version: "1.0.0",
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;

export type McpTransportKind = "stdio" | "http";

export interface McpStdioTransportConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpTransportConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig;

export interface McpServerConfig {
  name: string;
  enabled?: boolean;
  timeoutMs?: number;
  /**
   * Operator's declaration that this server's exposed tools are read-only.
   *
   * Defaults to `false`, and that default is deliberate. A server's own
   * `readOnlyHint` cannot be trusted — it is the party being constrained
   * vouching for itself — and Codali has no other way to know whether
   * `edit_file` edits a file. So an unvetted server's tools are treated as
   * capable of mutation, which keeps them out of the default tool set until an
   * operator either declares the server read-only or names the specific tools
   * to expose via `allowTools`.
   */
  readOnly?: boolean;
  /**
   * Tools to expose from this server. Absent means all discovered tools.
   * Deny always wins over allow.
   */
  allowTools?: string[];
  denyTools?: string[];
}

export type McpServerDefinition = McpServerConfig & McpTransportConfig;

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /**
   * Server-supplied hints (`readOnlyHint`, `destructiveHint`, …).
   *
   * Retained for display and diagnostics only. These are **not** trusted for
   * security decisions: a server declaring itself read-only is an assertion by
   * the very party being constrained. Codali policy decides what may run.
   */
  annotations?: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  raw: unknown;
}

export class McpClientError extends Error {
  readonly code: string;
  readonly server: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    server: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "McpClientError";
    this.code = code;
    this.server = server;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Flattens MCP content blocks into text the model can read. Non-text blocks are
 * described rather than dropped, so a run never silently loses a result it
 * cannot render.
 */
export const flattenMcpContent = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (type === "resource" && isRecord(block.resource)) {
      const resource = block.resource;
      const text = typeof resource.text === "string" ? resource.text : undefined;
      const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
      parts.push(text ?? `[resource ${uri}]`);
    } else if (type) {
      parts.push(`[${type} content omitted]`);
    }
  }
  return parts.join("\n").trim();
};

export interface McpClientOptions {
  definition: McpServerDefinition;
  /** Injected in tests to avoid spawning processes or opening sockets. */
  createClient?: () => Promise<McpTransportClient>;
}

/** The slice of the SDK client this wrapper depends on. */
export interface McpTransportClient {
  listTools(
    params?: Record<string, unknown>,
    options?: { timeout?: number },
  ): Promise<{ tools: unknown[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export class McpClient {
  private client?: McpTransportClient;
  private connecting?: Promise<McpTransportClient>;

  constructor(private readonly options: McpClientOptions) {}

  get name(): string {
    return this.options.definition.name;
  }

  private get timeoutMs(): number {
    return this.options.definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Connects lazily; concurrent callers share one in-flight connection. */
  private async ensureClient(): Promise<McpTransportClient> {
    if (this.client) return this.client;
    this.connecting ??= this.connect();
    try {
      this.client = await this.connecting;
      return this.client;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<McpTransportClient> {
    if (this.options.createClient) {
      return this.options.createClient();
    }

    const definition = this.options.definition;
    const client = new Client(CODALI_MCP_CLIENT_INFO, {
      capabilities: {},
    });

    try {
      if (definition.transport === "stdio") {
        await client.connect(
          new StdioClientTransport({
            command: definition.command,
            args: definition.args,
            env: definition.env,
            cwd: definition.cwd,
            // Server diagnostics must not be interleaved into Codali's own
            // stdout, which carries the answer.
            stderr: "pipe",
          }),
        );
      } else {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(definition.url), {
            requestInit: definition.headers ? { headers: definition.headers } : undefined,
          }),
        );
      }
    } catch (error) {
      throw new McpClientError(
        "mcp_connect_failed",
        definition.name,
        `Could not connect to MCP server "${definition.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { retryable: true, cause: error },
      );
    }

    return client as unknown as McpTransportClient;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const client = await this.ensureClient();
    let response: { tools: unknown[] };
    try {
      response = await client.listTools(undefined, { timeout: this.timeoutMs });
    } catch (error) {
      throw new McpClientError(
        "mcp_list_tools_failed",
        this.name,
        `tools/list failed for "${this.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { retryable: true, cause: error },
      );
    }

    const definition = this.options.definition;
    const allow = definition.allowTools ? new Set(definition.allowTools) : undefined;
    const deny = new Set(definition.denyTools ?? []);

    const tools: McpToolDefinition[] = [];
    for (const entry of response.tools ?? []) {
      if (!isRecord(entry) || typeof entry.name !== "string") continue;
      // Deny wins over allow, always.
      if (deny.has(entry.name)) continue;
      if (allow && !allow.has(entry.name)) continue;
      tools.push({
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : undefined,
        inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : undefined,
        outputSchema: isRecord(entry.outputSchema) ? entry.outputSchema : undefined,
        annotations: isRecord(entry.annotations) ? entry.annotations : undefined,
      });
    }
    return tools;
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const client = await this.ensureClient();
    let raw: unknown;
    try {
      raw = await client.callTool(
        { name, arguments: isRecord(args) ? args : {} },
        undefined,
        { timeout: this.timeoutMs },
      );
    } catch (error) {
      throw new McpClientError(
        "mcp_call_tool_failed",
        this.name,
        `tools/call ${name} failed on "${this.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { retryable: true, cause: error },
      );
    }

    const record = isRecord(raw) ? raw : {};
    // MCP reports tool-level failures in-band via isError rather than as a
    // protocol error, so a successful transport round trip can still be a
    // failed call.
    const isError = record.isError === true;
    const text = flattenMcpContent(record.content);

    return {
      ok: !isError,
      text: text || (isError ? "Tool reported an error with no message." : ""),
      structured: record.structuredContent,
      raw,
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    try {
      await client.close();
    } catch {
      // A server that fails to close cleanly must not fail the run; the process
      // is exiting or the connection is already gone.
    }
  }
}

export const createMcpClient = (options: McpClientOptions): McpClient =>
  new McpClient(options);
