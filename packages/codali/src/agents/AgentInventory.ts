import { spawn } from "node:child_process";

/**
 * Loads the mcoda agent inventory that {@link resolveCodaliGatewayAgentTiers}
 * resolves roles against.
 *
 * Loaded **once** and cached for the process lifetime. Shelling out to
 * `mcoda agent list` costs hundreds of milliseconds and the inventory does not
 * change mid-request, so doing it per query would put a subprocess spawn on the
 * critical path of every question asked.
 */

export interface AgentInventoryEntry extends Record<string, unknown> {
  id?: string;
  slug?: string;
  adapter?: string;
  defaultModel?: string;
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  capabilities?: string[];
  rating?: number;
  reasoningRating?: number;
  costPerMillion?: number;
  maxComplexity?: number;
  health?: { status?: string };
}

export interface AgentInventoryLoadOptions {
  command?: string;
  timeoutMs?: number;
  /** Include agents whose health is unknown. Unhealthy is always excluded. */
  includeUnknownHealth?: boolean;
  /** Injected in tests. */
  runCommand?: (
    command: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface AgentInventoryLoadResult {
  agents: AgentInventoryEntry[];
  warnings: string[];
  source: "mcoda" | "empty";
}

const DEFAULT_COMMAND = "mcoda";
const DEFAULT_TIMEOUT_MS = 20_000;

const runCommandImpl = (
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });

const parseInventory = (stdout: string): AgentInventoryEntry[] => {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? (parsed as AgentInventoryEntry[]) : [];
  } catch {
    return [];
  }
};

const isUsable = (
  agent: AgentInventoryEntry,
  includeUnknownHealth: boolean,
): boolean => {
  const status = agent.health?.status;
  if (status === "healthy") return true;
  // An agent reporting `limited` has exhausted its quota; `unhealthy` is
  // self-explanatory. Both would fail at call time, so exclude them here where
  // the reason can still be reported.
  if (status === "unhealthy" || status === "limited") return false;
  return includeUnknownHealth;
};

/**
 * Normalizes to the shape AgentTierResolver reads, so an entry always exposes a
 * `model` even when mcoda only reports `defaultModel`.
 */
const normalize = (agent: AgentInventoryEntry): AgentInventoryEntry => ({
  ...agent,
  model: agent.model ?? agent.defaultModel,
});

export const loadAgentInventory = async (
  options: AgentInventoryLoadOptions = {},
): Promise<AgentInventoryLoadResult> => {
  const command = options.command ?? DEFAULT_COMMAND;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = options.runCommand ?? runCommandImpl;
  const warnings: string[] = [];

  // Prefer fresh health; fall back for older mcoda builds without the flag.
  let result = await run(command, ["agent", "list", "--json", "--refresh-health"], timeoutMs);
  if (result.code !== 0) {
    warnings.push("agent_inventory_refresh_health_unavailable");
    result = await run(command, ["agent", "list", "--json"], timeoutMs);
  }

  if (result.code !== 0) {
    warnings.push(
      `agent_inventory_unavailable:${(result.stderr || "unknown error").trim().slice(0, 200)}`,
    );
    return { agents: [], warnings, source: "empty" };
  }

  const parsed = parseInventory(result.stdout);
  if (parsed.length === 0) {
    warnings.push("agent_inventory_empty");
    return { agents: [], warnings, source: "empty" };
  }

  const usable = parsed.filter((agent) => isUsable(agent, options.includeUnknownHealth ?? true));
  const excluded = parsed.length - usable.length;
  if (excluded > 0) {
    warnings.push(`agent_inventory_excluded_unhealthy:${excluded}`);
  }

  return { agents: usable.map(normalize), warnings, source: "mcoda" };
};

/**
 * Adapters the local CLI can drive in-process.
 *
 * mswarm self-hosted agents were excluded here until 2026-08-05: the gateway's
 * dedicated self-hosted route reused the generic chat handler, so a local model
 * id missed the catalog lookup and was forwarded to OpenRouter, which rejected
 * it. That is fixed (gateway runtime 0e9e877) — the route is self-hosted-only,
 * serves the exact ids from `/v1/swarm/self-hosted/openai/models`, and returns
 * 404/503 instead of falling through to a cloud provider. They are drivable now.
 */
const LOCAL_DRIVABLE_ADAPTERS = new Set([
  "claude-cli",
  "codex-cli",
  "gemini-cli",
  "openai-cli",
  "ollama-cli",
  "ollama-remote",
  "openai-api",
  "anthropic-api",
  "zhipu-api",
]);

export const isLocallyDrivable = (agent: AgentInventoryEntry): boolean => {
  const adapter = typeof agent.adapter === "string" ? agent.adapter.toLowerCase() : "";
  return LOCAL_DRIVABLE_ADAPTERS.has(adapter);
};

/** Narrows an inventory to agents the in-process CLI can actually call. */
export const filterLocallyDrivable = (
  agents: readonly AgentInventoryEntry[],
): AgentInventoryEntry[] => agents.filter(isLocallyDrivable);

let cached: Promise<AgentInventoryLoadResult> | undefined;

/**
 * Process-lifetime cached inventory. Call once at startup; every later caller
 * gets the same promise rather than spawning another subprocess.
 */
export const getAgentInventory = (
  options: AgentInventoryLoadOptions = {},
): Promise<AgentInventoryLoadResult> => {
  cached ??= loadAgentInventory(options);
  return cached;
};

/** Test-only: drops the cache so a fresh load can be exercised. */
export const resetAgentInventoryCache = (): void => {
  cached = undefined;
};
