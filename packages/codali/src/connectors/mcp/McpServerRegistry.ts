import type { ToolDefinition } from "../../tools/ToolTypes.js";
import { ToolExecutionError } from "../../tools/ToolTypes.js";
import {
  McpClient,
  McpClientError,
  type McpServerDefinition,
  type McpToolDefinition,
} from "./McpClient.js";
import { mcpToolsToDefinitions } from "./McpToolAdapter.js";

/**
 * Owns the lifetime of every configured MCP server.
 *
 * Three properties matter more than features here:
 *
 *   - **Isolation.** One broken server degrades its own tools to unavailable
 *     and never fails the run or affects another server.
 *   - **Boundedness.** Every call has a timeout, at most one retry, and
 *     competes for a global concurrency budget, so a slow server cannot
 *     monopolise a run.
 *   - **Cleanup.** stdio servers are child processes. They must be shut down
 *     even when a run fails, or the CLI leaves orphans behind.
 */

/** Concurrent in-flight MCP calls across all servers. */
export const DEFAULT_MAX_CONCURRENT_CALLS = 4;

/** One retry, and only for transport-level failures. */
const MAX_CALL_ATTEMPTS = 2;

export interface McpServerHealth {
  name: string;
  status: "connected" | "failed" | "disabled";
  toolCount: number;
  error?: string;
  discoveryMs?: number;
}

export interface McpServerRegistryOptions {
  servers: readonly McpServerDefinition[];
  maxConcurrentCalls?: number;
  /** Injected in tests. */
  createClient?: (definition: McpServerDefinition) => McpClient;
  onEvent?: (event: McpRegistryEvent) => void;
}

export type McpRegistryEvent =
  | { type: "server_connected"; server: string; toolCount: number; durationMs: number }
  | { type: "server_failed"; server: string; error: string }
  | { type: "server_skipped"; server: string; reason: string };

/** A minimal semaphore. Keeps concurrent MCP work inside a known bound. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}

export class McpServerRegistry {
  private readonly clients = new Map<string, McpClient>();
  private readonly health = new Map<string, McpServerHealth>();
  private readonly semaphore: Semaphore;
  private discovered = false;

  constructor(private readonly options: McpServerRegistryOptions) {
    this.semaphore = new Semaphore(
      options.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS,
    );
  }

  /**
   * Connects to every enabled server and returns their tools as Codali tool
   * definitions. Servers are contacted in parallel; a failure is recorded as
   * unhealthy rather than thrown, so one bad entry in a tenant's config cannot
   * take down the run.
   */
  async discoverTools(): Promise<ToolDefinition[]> {
    const definitions: ToolDefinition[] = [];

    const results = await Promise.all(
      this.options.servers.map(async (definition) => {
        if (definition.enabled === false) {
          this.health.set(definition.name, {
            name: definition.name,
            status: "disabled",
            toolCount: 0,
          });
          this.options.onEvent?.({
            type: "server_skipped",
            server: definition.name,
            reason: "disabled",
          });
          return [];
        }

        const startedMs = Date.now();
        const client = this.options.createClient
          ? this.options.createClient(definition)
          : new McpClient({ definition });
        this.clients.set(definition.name, client);

        let tools: McpToolDefinition[];
        try {
          tools = await client.listTools();
        } catch (error) {
          const message =
            error instanceof McpClientError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error);
          this.health.set(definition.name, {
            name: definition.name,
            status: "failed",
            toolCount: 0,
            error: message,
          });
          this.options.onEvent?.({
            type: "server_failed",
            server: definition.name,
            error: message,
          });
          // Drop the client so a later call does not retry a dead connection.
          this.clients.delete(definition.name);
          await client.close();
          return [];
        }

        const durationMs = Date.now() - startedMs;
        this.health.set(definition.name, {
          name: definition.name,
          status: "connected",
          toolCount: tools.length,
          discoveryMs: durationMs,
        });
        this.options.onEvent?.({
          type: "server_connected",
          server: definition.name,
          toolCount: tools.length,
          durationMs,
        });

        return mcpToolsToDefinitions(tools, {
          client: this.wrapClient(client),
          server: definition.name,
          capability: definition.name,
          // Operator declaration only. Claiming read-only for an unvetted
          // server would mislabel tools like `edit_file` and `move_file`, which
          // is worse than admitting we do not know.
          readOnly: definition.readOnly === true,
        });
      }),
    );

    for (const group of results) definitions.push(...group);
    this.discovered = true;
    return definitions;
  }

  /**
   * Wraps a client so every tool call is bounded by the concurrency budget and
   * retried once on a transport failure. Retrying is safe here because Phase 2
   * connectors are read-only.
   */
  private wrapClient(client: McpClient): McpClient {
    const semaphore = this.semaphore;
    const wrapped: McpClient = Object.create(client) as McpClient;
    wrapped.callTool = async (name: string, args: unknown) => {
      const release = await semaphore.acquire();
      try {
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_CALL_ATTEMPTS; attempt += 1) {
          try {
            return await client.callTool(name, args);
          } catch (error) {
            lastError = error;
            const retryable = error instanceof McpClientError && error.retryable;
            if (!retryable || attempt === MAX_CALL_ATTEMPTS) break;
          }
        }
        throw new ToolExecutionError(
          "tool_execution_failed",
          lastError instanceof Error ? lastError.message : String(lastError),
          { retryable: false, details: { tool: name } },
        );
      } finally {
        release();
      }
    };
    return wrapped;
  }

  healthReport(): McpServerHealth[] {
    return [...this.health.values()];
  }

  get isDiscovered(): boolean {
    return this.discovered;
  }

  /**
   * Shuts down every connection. Must run even when a run fails: stdio servers
   * are child processes and would otherwise be orphaned.
   */
  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close()));
  }
}

export const createMcpServerRegistry = (
  options: McpServerRegistryOptions,
): McpServerRegistry => new McpServerRegistry(options);
