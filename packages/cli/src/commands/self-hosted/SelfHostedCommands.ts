import {
  MswarmApi,
  type MswarmSelfHostedAgent,
  type MswarmSelfHostedAgentDetail,
  type MswarmSyncSummary,
} from "@mcoda/core";

interface ParsedArgs {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
}

const USAGE = `
Usage: mcoda self-hosted agent <list|details|sync> [options]

Subcommands:
  agent list                List mswarm self-hosted agents (supports --json)
    --provider <NAME>       Filter by provider (mcoda|ollama)
    --limit <N>             Limit returned agents
    --include-unreachable   Include unreachable agents in the catalog result
    --include-load-balanced Include auto-routed load-balanced self-hosted aliases
    --max-cost-per-1m-token <N>
                             Exclude agents above the given cost_per_million
    --sorted-by-catalog-rating
                             Sort results by the catalog rating field (descending)
    --min-context <N>       Require at least this context window
    --min-reasoning <N>     Require at least this reasoning rating
  agent details <SLUG>      Show a single mswarm self-hosted agent (supports --json)
    --include-load-balanced Allow details for auto-routed aliases
  agent sync                Sync self-hosted agents into the local mcoda registry
    --provider <NAME>       Filter by provider before syncing
    --include-unreachable   Sync unreachable agents too
    --include-load-balanced Sync auto-routed load-balanced aliases too
    --limit <N>             Limit synced agents
    --prune                 Remove previously synced self-hosted agents missing from the current catalog result
    --agent-slug-prefix <P> Override the local managed-agent slug prefix

Connection options:
  --base-url <URL>          Override MCODA_MSWARM_BASE_URL (default: https://api.mswarm.org/)
  --openai-base-url <URL>   Override execution base URL for synced managed-agent execution
  --api-key <KEY>           Override MCODA_MSWARM_API_KEY
  --timeout-ms <N>          Override MCODA_MSWARM_TIMEOUT_MS

Environment:
  MCODA_MSWARM_BASE_URL
  MCODA_MSWARM_OPENAI_BASE_URL
  MCODA_MSWARM_API_KEY
  MCODA_MSWARM_TIMEOUT_MS
  MCODA_MSWARM_SELF_HOSTED_AGENT_SLUG_PREFIX
  Or persist the API key with: mcoda config set mswarm-api-key <KEY>

To expose this machine's local agents:
  npm install -g @mcoda/mswarm
  mswarm install <KEY>

Flags:
  --json                    Emit JSON for supported commands
  --help                    Show this help
`.trim();

const parseArgs = (argv: string[]): ParsedArgs => {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const key = arg.replace(/^--/, "");
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        const current = flags[key];
        if (current === undefined) {
          flags[key] = next;
        } else if (Array.isArray(current)) {
          flags[key] = [...current, next];
        } else if (typeof current === "string") {
          flags[key] = [current, next];
        } else {
          flags[key] = [next];
        }
        index += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
};

const resolveString = (value: string | string[] | boolean | undefined): string | undefined => {
  if (value === undefined || typeof value === "boolean") return undefined;
  return Array.isArray(value) ? value[value.length - 1] : value;
};

const resolvePositiveInt = (value: string | string[] | boolean | undefined, label: string): number | undefined => {
  const raw = resolveString(value);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}; expected a positive integer`);
  }
  return parsed;
};

const resolveNonNegativeNumber = (
  value: string | string[] | boolean | undefined,
  label: string,
): number | undefined => {
  const raw = resolveString(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}; expected a non-negative number`);
  }
  return parsed;
};

const formatNumber = (value: number | undefined): string =>
  value === undefined || Number.isNaN(value) ? "-" : String(value);

const formatCapabilities = (capabilities: string[] | undefined): string =>
  capabilities && capabilities.length > 0 ? capabilities.join(",") : "-";

const formatBoolean = (value: boolean | undefined): string =>
  value === undefined ? "-" : value ? "yes" : "no";

const agentRoutingMode = (agent: MswarmSelfHostedAgent): "auto" | "direct" =>
  agent.load_balanced ? "auto" : "direct";

const pad = (value: string, width: number): string => value.padEnd(width, " ");

const renderTable = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, columnIndex) =>
    Math.max(header.length, ...rows.map((row) => row[columnIndex]?.length ?? 0)),
  );
  const lines = [
    headers.map((header, index) => pad(header, widths[index] ?? header.length)).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => row.map((cell, index) => pad(cell, widths[index] ?? cell.length)).join("  ")),
  ];
  return lines.join("\n");
};

const printAgentList = (agents: MswarmSelfHostedAgent[]): void => {
  if (agents.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No self-hosted agents found.");
    return;
  }
  const headers = [
    "REMOTE SLUG",
    "ROUTE",
    "PROVIDER",
    "ADAPTER",
    "MODEL",
    "RATING",
    "REASON",
    "MAX CPLX",
    "CTX",
    "COST/$1M",
    "TOOLS",
    "HEALTH",
    "CAPABILITIES",
  ];
  const rows = agents.map((agent) => [
    agent.remote_slug ?? agent.slug,
    agentRoutingMode(agent),
    agent.provider,
    agent.adapter ?? "-",
    agent.default_model,
    formatNumber(agent.rating),
    formatNumber(agent.reasoning_rating),
    formatNumber(agent.max_complexity),
    formatNumber(agent.context_window),
    formatNumber(agent.cost_per_million),
    formatBoolean(agent.supports_tools),
    agent.health_status ?? "-",
    formatCapabilities(agent.capabilities),
  ]);
  // eslint-disable-next-line no-console
  console.log(renderTable(headers, rows));
};

const printAgentDetails = (agent: MswarmSelfHostedAgentDetail): void => {
  const entries: Array<[string, string]> = [
    ["Slug", agent.slug],
    ["Remote slug", agent.remote_slug ?? "-"],
    ["Route", agentRoutingMode(agent)],
    ["Load-balanced group", agent.load_balanced_group_id ?? "-"],
    ["Provider", agent.provider],
    ["Adapter", agent.adapter ?? "-"],
    ["Source agent", agent.source_agent_slug ?? "-"],
    ["Model", agent.default_model],
    ["Model ID", agent.model_id ?? "-"],
    ["Display name", agent.display_name ?? "-"],
    ["Description", agent.description ?? "-"],
    ["Rating", formatNumber(agent.rating)],
    ["Reasoning rating", formatNumber(agent.reasoning_rating)],
    ["Max complexity", formatNumber(agent.max_complexity)],
    ["Cost / 1M tokens", formatNumber(agent.cost_per_million)],
    ["Context window", formatNumber(agent.context_window)],
    ["Supports tools", formatBoolean(agent.supports_tools)],
    ["Supports reasoning", formatBoolean(agent.supports_reasoning)],
    ["Health", agent.health_status ?? "-"],
    ["Members", formatNumber(agent.member_count)],
    ["Capabilities", formatCapabilities(agent.capabilities)],
  ];
  const labelWidth = Math.max(...entries.map(([label]) => label.length));
  for (const [label, value] of entries) {
    // eslint-disable-next-line no-console
    console.log(`${label.padEnd(labelWidth, " ")} : ${value}`);
  }
};

const printSyncSummary = (summary: MswarmSyncSummary): void => {
  // eslint-disable-next-line no-console
  console.log(
    `Synced ${summary.agents.length} self-hosted agents (created=${summary.created}, updated=${summary.updated}, deleted=${summary.deleted}).`,
  );
  if (summary.agents.length === 0) return;
  const rows = summary.agents.map((record) => [
    record.remoteSlug,
    record.localSlug,
    record.action,
    record.routingMode ?? "-",
    record.provider,
    record.defaultModel,
  ]);
  // eslint-disable-next-line no-console
  console.log(renderTable(["REMOTE SLUG", "LOCAL SLUG", "ACTION", "ROUTE", "PROVIDER", "MODEL"], rows));
};

export class SelfHostedCommands {
  static async run(argv: string[]): Promise<void> {
    const [topic, rawSubcommand, ...rest] = argv;
    if (!topic || argv.includes("--help") || argv.includes("-h")) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return;
    }
    if (topic !== "agent" && topic !== "agents") {
      throw new Error(`Unknown self-hosted topic: ${topic}`);
    }

    const subcommand =
      rawSubcommand === "detail" || rawSubcommand === "show"
        ? "details"
        : rawSubcommand;
    if (!subcommand) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return;
    }

    const parsed = parseArgs(rest);
    const api = await MswarmApi.create({
      baseUrl: resolveString(parsed.flags["base-url"]),
      openAiBaseUrl: resolveString(parsed.flags["openai-base-url"]),
      apiKey: resolveString(parsed.flags["api-key"]),
      timeoutMs: resolvePositiveInt(parsed.flags["timeout-ms"], "--timeout-ms"),
      selfHostedAgentSlugPrefix: resolveString(parsed.flags["agent-slug-prefix"]),
    });

    try {
      switch (subcommand) {
        case "list": {
          const agents = await api.listSelfHostedAgents({
            provider: resolveString(parsed.flags.provider),
            limit: resolvePositiveInt(parsed.flags.limit, "--limit"),
            includeUnreachable: Boolean(parsed.flags["include-unreachable"]),
            includeLoadBalanced: Boolean(parsed.flags["include-load-balanced"]),
            maxCostPerMillion: resolveNonNegativeNumber(
              parsed.flags["max-cost-per-1m-token"],
              "--max-cost-per-1m-token",
            ),
            minContextWindow: resolvePositiveInt(parsed.flags["min-context"], "--min-context"),
            minReasoningRating: resolveNonNegativeNumber(
              parsed.flags["min-reasoning"],
              "--min-reasoning",
            ),
            sortByCatalogRating: Boolean(
              parsed.flags["sorted-by-catalog-rating"] || parsed.flags["sort-by-catalog-rating"],
            ),
          });
          if (parsed.flags.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(agents, null, 2));
          } else {
            printAgentList(agents);
          }
          break;
        }
        case "details": {
          const slug = parsed.positionals[0];
          if (!slug) {
            throw new Error("Usage: mcoda self-hosted agent details <SLUG> [--json]");
          }
          const agent = await api.getSelfHostedAgent(slug, {
            includeLoadBalanced: Boolean(parsed.flags["include-load-balanced"]),
          });
          if (parsed.flags.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(agent, null, 2));
          } else {
            printAgentDetails(agent);
          }
          break;
        }
        case "sync": {
          const summary = await api.syncSelfHostedAgents({
            provider: resolveString(parsed.flags.provider),
            limit: resolvePositiveInt(parsed.flags.limit, "--limit"),
            includeUnreachable: Boolean(parsed.flags["include-unreachable"]),
            includeLoadBalanced: Boolean(parsed.flags["include-load-balanced"]),
            pruneMissing: Boolean(parsed.flags.prune),
          });
          if (parsed.flags.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(summary, null, 2));
          } else {
            printSyncSummary(summary);
          }
          break;
        }
        default:
          throw new Error(`Unknown self-hosted subcommand: ${subcommand}`);
      }
    } finally {
      await api.close();
    }
  }
}
