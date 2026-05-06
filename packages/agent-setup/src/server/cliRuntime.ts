import { spawn } from "node:child_process";
import { normalizeAgentCatalogEntries } from "../headless/normalization.js";
import { isCloudAgent, isSelfHostedAgent } from "../headless/catalog.js";
import type {
  McodaAgentCatalogEntry,
  McodaAgentListInput,
  McodaAgentSyncInput,
  McodaRuntimeAdapter,
} from "../types.js";

export interface CliMcodaRuntimeAdapterInput {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  runCommand?: (
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number }
  ) => Promise<unknown>;
}

export function createCliMcodaRuntimeAdapter(
  input: CliMcodaRuntimeAdapterInput = {}
): McodaRuntimeAdapter {
  const command = input.command ?? "mcoda";
  const run =
    input.runCommand ??
    ((cmd, args, options) => runJsonCommand(cmd, args, options));

  const runAgents = async (
    args: string[],
    fallback: Parameters<typeof normalizeAgentCatalogEntries>[1]
  ): Promise<McodaAgentCatalogEntry[]> =>
    normalizeAgentCatalogEntries(
      await run(command, args, {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      }),
      fallback
    );

  const listLocal = async (
    options: McodaAgentListInput | undefined
  ): Promise<McodaAgentCatalogEntry[]> =>
    runAgents(
      [
        "agent",
        "list",
        "--json",
        ...(options?.refreshHealth ? ["--refresh-health"] : []),
      ],
      {
        source: "local_registry",
        synced: true,
      }
    );

  return {
    runtime: {
      mode: "cli_fallback",
      requiresMcodaCli: true,
    },
    async configureMswarmApiKey() {
      throw new Error(
        "The CLI mcoda runtime adapter does not configure mswarm API keys until mcoda exposes a stdin-safe secret command."
      );
    },
    async listCloudAgents(options) {
      return runAgents(
        [
          "cloud",
          "agent",
          "list",
          "--json",
          ...(options?.provider ? ["--provider", options.provider] : []),
        ],
        {
          source: "cloud_catalog",
          synced: false,
          managedKind: "cloud",
        }
      );
    },
    async syncCloudAgents(options?: McodaAgentSyncInput) {
      await run(command, [
        "cloud",
        "agent",
        "sync",
        "--prune",
        "--json",
        ...(options?.provider ? ["--provider", options.provider] : []),
      ], {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });
      return (await listLocal(options)).filter(isCloudAgent);
    },
    async listSelfHostedAgents(options) {
      return runAgents(
        [
          "self-hosted",
          "agent",
          "list",
          "--provider",
          options?.provider ?? "mcoda",
          "--json",
        ],
        {
          source: "self_hosted_catalog",
          synced: false,
          managedKind: "self_hosted",
        }
      );
    },
    async syncSelfHostedAgents(options?: McodaAgentSyncInput) {
      await run(command, [
        "self-hosted",
        "agent",
        "sync",
        "--provider",
        options?.provider ?? "mcoda",
        "--prune",
        "--json",
      ], {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      });
      return (await listLocal(options)).filter(isSelfHostedAgent);
    },
    listLocalAgents: listLocal,
  };
}

async function runJsonCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number }
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Command failed with exit code ${code}`));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : {});
      } catch (error) {
        reject(
          new Error(
            `Command did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
  });
}
