import { MswarmApi, type MswarmCloudAgent, type MswarmCloudAgentDetail, type MswarmSyncSummary } from "@mcoda/core";

interface ParsedArgs {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
}

const USAGE = `
Usage: mcoda cloud agent <list|details|sync> [options]

Subcommands:
  agent list                List mswarm cloud agents (supports --json)
    --provider <NAME>       Filter by provider
    --limit <N>             Limit returned agents
  agent details <SLUG>      Show a single mswarm cloud agent (supports --json)
  agent sync                Sync mswarm cloud agents into the local mcoda registry
    --provider <NAME>       Filter by provider before syncing
    --limit <N>             Limit synced agents
    --agent-slug-prefix <P> Override the local managed-agent slug prefix

Connection options:
  --base-url <URL>          Override MCODA_MSWARM_BASE_URL (default: https://api.mswarm.org/)
  --openai-base-url <URL>   Override MCODA_MSWARM_OPENAI_BASE_URL for synced managed-agent execution
  --api-key <KEY>           Override MCODA_MSWARM_API_KEY
  --timeout-ms <N>          Override MCODA_MSWARM_TIMEOUT_MS

Environment:
  MCODA_MSWARM_BASE_URL
  MCODA_MSWARM_OPENAI_BASE_URL
  MCODA_MSWARM_API_KEY
  MCODA_MSWARM_TIMEOUT_MS
  MCODA_MSWARM_AGENT_SLUG_PREFIX
  Or persist the API key with: mcoda config set mswarm-api-key <KEY>

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

const formatNumber = (value: number | undefined): string =>
  value === undefined || Number.isNaN(value) ? "-" : String(value);

const formatCapabilities = (capabilities: string[] | undefined): string =>
  capabilities && capabilities.length > 0 ? capabilities.join(",") : "-";

const formatBoolean = (value: boolean | undefined): string =>
  value === undefined ? "-" : value ? "yes" : "no";

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

const printAgentList = (agents: MswarmCloudAgent[]): void => {
  if (agents.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No cloud agents found.");
    return;
  }
  const headers = [
    "REMOTE SLUG",
    "PROVIDER",
    "MODEL",
    "RATING",
    "REASON",
    "MAX CPLX",
    "TOOLS",
    "HEALTH",
    "PRICING",
    "CAPABILITIES",
  ];
  const rows = agents.map((agent) => [
    agent.slug,
    agent.provider,
    agent.default_model,
    formatNumber(agent.rating),
    formatNumber(agent.reasoning_rating),
    formatNumber(agent.max_complexity),
    formatBoolean(agent.supports_tools),
    agent.health_status ?? "-",
    agent.pricing_version ?? "-",
    formatCapabilities(agent.capabilities),
  ]);
  // eslint-disable-next-line no-console
  console.log(renderTable(headers, rows));
};

const printAgentDetails = (agent: MswarmCloudAgentDetail): void => {
  const entries: Array<[string, string]> = [
    ["Slug", agent.slug],
    ["Provider", agent.provider],
    ["Model", agent.default_model],
    ["Model ID", agent.model_id ?? "-"],
    ["Display name", agent.display_name ?? "-"],
    ["Description", agent.description ?? "-"],
    ["Rating", formatNumber(agent.rating)],
    ["Reasoning rating", formatNumber(agent.reasoning_rating)],
    ["Max complexity", formatNumber(agent.max_complexity)],
    ["Context window", formatNumber(agent.context_window)],
    ["Supports tools", formatBoolean(agent.supports_tools)],
    ["Supports reasoning", formatBoolean(agent.supports_reasoning)],
    ["Health", agent.health_status ?? "-"],
    ["Pricing version", agent.pricing_version ?? "-"],
    ["Pricing snapshot", agent.pricing_snapshot_id ?? "-"],
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
  console.log(`Synced ${summary.agents.length} cloud agents (created=${summary.created}, updated=${summary.updated}).`);
  if (summary.agents.length === 0) {
    return;
  }
  const rows = summary.agents.map((record) => [
    record.remoteSlug,
    record.localSlug,
    record.action,
    record.provider,
    record.defaultModel,
    record.pricingVersion ?? "-",
  ]);
  // eslint-disable-next-line no-console
  console.log(renderTable(["REMOTE SLUG", "LOCAL SLUG", "ACTION", "PROVIDER", "MODEL", "PRICING"], rows));
};

export class CloudCommands {
  static async run(argv: string[]): Promise<void> {
    const [topic, rawSubcommand, ...rest] = argv;
    if (!topic || argv.includes("--help") || argv.includes("-h")) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return;
    }
    if (topic !== "agent" && topic !== "agents") {
      throw new Error(`Unknown cloud topic: ${topic}`);
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
      agentSlugPrefix: resolveString(parsed.flags["agent-slug-prefix"]),
    });

    try {
      switch (subcommand) {
        case "list": {
          const agents = await api.listCloudAgents({
            provider: resolveString(parsed.flags.provider),
            limit: resolvePositiveInt(parsed.flags.limit, "--limit"),
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
            throw new Error("Usage: mcoda cloud agent details <SLUG> [--json]");
          }
          const agent = await api.getCloudAgent(slug);
          if (parsed.flags.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(agent, null, 2));
          } else {
            printAgentDetails(agent);
          }
          break;
        }
        case "sync": {
          const summary = await api.syncCloudAgents({
            provider: resolveString(parsed.flags.provider),
            limit: resolvePositiveInt(parsed.flags.limit, "--limit"),
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
          throw new Error(`Unknown cloud subcommand: ${subcommand}`);
      }
    } finally {
      await api.close();
    }
  }
}
