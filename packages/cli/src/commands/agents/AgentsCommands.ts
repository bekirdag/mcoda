import { AgentsApi, AgentResponse, WorkspaceResolver } from "@mcoda/core";
import readline from "node:readline";

interface ParsedArgs {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
}

const parseArgs = (argv: string[]): ParsedArgs => {
  const flags: Record<string, any> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.replace(/^--/, "");
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        if (flags[key]) {
          flags[key] = Array.isArray(flags[key]) ? [...flags[key], next] : [flags[key], next];
        } else {
          flags[key] = next;
        }
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
};

const readSecret = async (promptText: string): Promise<string> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Hide input characters
    // eslint-disable-next-line no-underscore-dangle
    (rl as any)._writeToOutput = () => {};
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

const USAGE = `
Usage: mcoda agent <list|add|update|delete|remove|auth|auth-status|set-default|use> ...

Subcommands:
  list                       List agents (supports --json)
  add <NAME>                 Create a global agent
    --adapter <TYPE>         Adapter slug (openai-api|zhipu-api|codex-cli|gemini-cli|local-model|qa-cli|ollama-remote)
    --model <MODEL>          Default model name
    --rating <N>             Relative capability rating (higher is stronger)
    --reasoning-rating <N>   Relative reasoning strength rating (higher is stronger)
    --best-usage <TEXT>      Primary usage area (e.g., code_write, ui_ux_docs)
    --cost-per-million <N>   Cost per 1M tokens (0 for local models)
    --capability <CAP>       Repeatable capabilities to attach
    --job-path <PATH>        Optional job prompt path
    --character-path <PATH>  Optional character prompt path
    --config-base-url <URL>  Base URL for remote adapters (e.g., http://host:11434 for ollama-remote)
    --config-temperature <N> Temperature override for supported adapters
    --config-thinking <BOOL> Enable thinking mode for supported adapters
  update <NAME>              Update adapter/model/capabilities/prompts for an agent
  delete|remove <NAME>       Remove an agent (use --force to ignore routing/default references)
    --force                  Force deletion even if referenced
  auth set <NAME>            Store credentials (use --api-key or interactive prompt)
    --api-key <KEY>          API key/token
  auth-status <NAME>         Show redacted auth status (supports --json)
  set-default|use <NAME>     Set workspace default agent (use --workspace to override detection)
    --workspace <PATH>       Workspace root to bind defaults
  --json                     Emit JSON for supported commands
  --help                     Show this help
`.trim();

const parseCapabilities = (value: string | string[] | boolean | undefined): string[] | undefined => {
  if (value === undefined) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  return arr.filter((item): item is string => typeof item === "string");
};

const parsePrompts = (flags: Record<string, any>) => {
  const prompts: Record<string, string> = {};
  if (flags["job-path"]) prompts.jobPath = String(flags["job-path"]);
  if (flags["character-path"]) prompts.characterPath = String(flags["character-path"]);
  return Object.keys(prompts).length ? prompts : undefined;
};

const parseRating = (value: string | string[] | boolean | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof raw === "boolean") return undefined;
  const parsed = Number.parseFloat(String(raw));
  if (!Number.isFinite(parsed)) {
    throw new Error("Invalid --rating; expected a number");
  }
  return parsed;
};

const parseReasoningRating = (value: string | string[] | boolean | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof raw === "boolean") return undefined;
  const parsed = Number.parseFloat(String(raw));
  if (!Number.isFinite(parsed)) {
    throw new Error("Invalid --reasoning-rating; expected a number");
  }
  return parsed;
};

const parseCostPerMillion = (value: string | string[] | boolean | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof raw === "boolean") return undefined;
  const parsed = Number.parseFloat(String(raw));
  if (!Number.isFinite(parsed)) {
    throw new Error("Invalid --cost-per-million; expected a number");
  }
  return parsed;
};

const parseConfig = (flags: Record<string, any>) => {
  const config: Record<string, unknown> = {};
  if (flags["config-base-url"]) config.baseUrl = String(flags["config-base-url"]);
  if (flags["config-temperature"] !== undefined) {
    const raw = flags["config-temperature"];
    const parsed = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
    if (!Number.isFinite(parsed)) {
      throw new Error("Invalid --config-temperature; expected a number");
    }
    config.temperature = parsed;
  }
  if (flags["config-thinking"] !== undefined) {
    const raw = flags["config-thinking"];
    if (typeof raw === "boolean") {
      config.thinking = raw;
    } else {
      const normalized = String(raw).trim().toLowerCase();
      if (["true", "1", "yes", "y"].includes(normalized)) {
        config.thinking = true;
      } else if (["false", "0", "no", "n"].includes(normalized)) {
        config.thinking = false;
      } else {
        throw new Error("Invalid --config-thinking; expected true/false");
      }
    }
  }
  return Object.keys(config).length ? config : undefined;
};

const DEFAULT_OLLAMA_CAPABILITIES = ["plan", "code_write", "code_review"];

const pad = (value: string, width: number): string => value.padEnd(width, " ");

const truncate = (value: string, max: number): string => {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
};

const formatDate = (value?: string): string => {
  if (!value) return "-";
  if (value.length >= 16) {
    return value.replace("T", " ").slice(0, 16);
  }
  return value;
};

const formatCost = (value?: number): string => {
  if (value === undefined || value === null || Number.isNaN(value)) return "-";
  return Number(value).toFixed(2);
};

const formatCapabilities = (caps: string[] | undefined): string => {
  const list = (caps ?? []).slice().sort();
  if (list.length === 0) return "none";
  const shown = list.slice(0, 4);
  const suffix = list.length > shown.length ? `, +${list.length - shown.length}` : "";
  return `${shown.join(", ")}${suffix}`;
};

const formatBoxTable = (headers: string[], rows: string[][], maxWidths: number[]): string => {
  if (rows.length === 0) return headers.join(" | ");
  const rawWidths = headers.map((header, idx) =>
    Math.max(header.length, ...rows.map((row) => (row[idx] ?? "").length)),
  );
  const widths = rawWidths.map((width, idx) => Math.min(width, maxWidths[idx] ?? width));
  const cell = (value: string, idx: number) => pad(truncate(value, widths[idx]), widths[idx]);
  const top = `╭${widths.map((w) => "─".repeat(w + 2)).join("┬")}╮`;
  const mid = `├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
  const bottom = `╰${widths.map((w) => "─".repeat(w + 2)).join("┴")}╯`;
  const headerLine = `│ ${headers.map((h, idx) => cell(h, idx)).join(" │ ")} │`;
  const body = rows.map((row) => `│ ${row.map((val, idx) => cell(val ?? "", idx)).join(" │ ")} │`).join("\n");
  return [top, headerLine, mid, body, bottom].join("\n");
};

export class AgentsCommands {
  static async run(argv: string[]): Promise<void> {
    const [rawSubcommand, ...rest] = argv;
    const subcommand =
      rawSubcommand === "use" ? "set-default" : rawSubcommand === "remove" ? "delete" : rawSubcommand;
    if (!subcommand || rest.includes("--help")) {
      throw new Error(USAGE);
    }

    const api = await AgentsApi.create();
    const parsed = parseArgs(rest);
    try {
      switch (subcommand) {
        case "list": {
          const agents = await api.listAgents();
          if (parsed.flags.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(agents, null, 2));
          } else {
            if (agents.length === 0) {
              // eslint-disable-next-line no-console
              console.log("No agents found.");
            } else {
              const headers = [
                "SLUG",
                "ADAPTER",
                "MODEL",
                "RATING",
                "REASON",
                "USAGE",
                "COST/1M",
                "HEALTH",
                "LAST CHECK",
                "CAPABILITIES",
              ];
              const maxWidths = [14, 14, 24, 6, 9, 10, 12, 10, 16, 36];
              const rows = agents.map((agent) => [
                agent.slug,
                agent.adapter,
                agent.defaultModel ?? "-",
                agent.rating !== undefined ? String(agent.rating) : "-",
                agent.reasoningRating !== undefined ? String(agent.reasoningRating) : "-",
                agent.bestUsage ?? "-",
                formatCost(agent.costPerMillion),
                agent.health?.status ?? "unknown",
                formatDate(agent.health?.lastCheckedAt),
                formatCapabilities(agent.capabilities),
              ]);
              // eslint-disable-next-line no-console
              console.log(formatBoxTable(headers, rows, maxWidths));
            }
          }
          break;
        }
        case "add": {
          const name = parsed.positionals[0];
          if (!name) throw new Error("agent add requires a slug/name\n\n" + USAGE);
          const capabilities =
            parseCapabilities(parsed.flags.capability) ??
            (String(parsed.flags.adapter ?? "openai-api") === "ollama-remote" ? DEFAULT_OLLAMA_CAPABILITIES : []);
          const prompts = parsePrompts(parsed.flags);
          const config = parseConfig(parsed.flags);
          const rating = parseRating(parsed.flags.rating);
          const reasoningRating = parseReasoningRating(parsed.flags["reasoning-rating"]);
          const bestUsage = parsed.flags["best-usage"] ? String(parsed.flags["best-usage"]) : undefined;
          const costPerMillion = parseCostPerMillion(parsed.flags["cost-per-million"]);
          const agent = await api.createAgent({
            slug: name,
            adapter: String(parsed.flags.adapter ?? "openai-api"),
            defaultModel: parsed.flags.model ? String(parsed.flags.model) : undefined,
            rating,
            reasoningRating,
            bestUsage,
            costPerMillion,
            capabilities,
            prompts,
            config,
          });
          // eslint-disable-next-line no-console
          console.log(`Created agent ${agent.slug}`);
          break;
        }
        case "update": {
          const name = parsed.positionals[0];
          if (!name) throw new Error("agent update requires a slug/name\n\n" + USAGE);
          const capabilities = parseCapabilities(parsed.flags.capability);
          const prompts = parsePrompts(parsed.flags);
          const config = parseConfig(parsed.flags);
          const rating = parseRating(parsed.flags.rating);
          const reasoningRating = parseReasoningRating(parsed.flags["reasoning-rating"]);
          const bestUsage = parsed.flags["best-usage"] ? String(parsed.flags["best-usage"]) : undefined;
          const costPerMillion = parseCostPerMillion(parsed.flags["cost-per-million"]);
          const agent = await api.updateAgent(name, {
            adapter: parsed.flags.adapter ? String(parsed.flags.adapter) : undefined,
            defaultModel: parsed.flags.model ? String(parsed.flags.model) : undefined,
            rating,
            reasoningRating,
            bestUsage,
            costPerMillion,
            capabilities,
            prompts,
            config,
          });
          // eslint-disable-next-line no-console
          console.log(`Updated agent ${agent.slug}`);
          break;
        }
        case "delete": {
          const name = parsed.positionals[0];
          if (!name) throw new Error("agent delete requires a slug/name\n\n" + USAGE);
          const force = Boolean(parsed.flags.force);
          await api.deleteAgent(name, force);
          // eslint-disable-next-line no-console
          console.log(`Deleted agent ${name}`);
          break;
        }
        case "auth": {
          const mode = parsed.positionals[0];
          const name = parsed.positionals[1];
          if (mode !== "set" || !name) {
            throw new Error("Usage: mcoda agent auth set <NAME> [--api-key <key>]");
          }
          let secret = parsed.flags["api-key"] ? String(parsed.flags["api-key"]) : "";
          if (!secret) {
            secret = await readSecret("Enter API key/token: ");
          }
          if (!secret) throw new Error("No secret provided");
          const result = await api.setAgentAuth(name, secret);
          // eslint-disable-next-line no-console
          console.log(`Stored credentials for ${name}; lastUpdatedAt=${result.lastUpdatedAt ?? "now"}`);
          break;
        }
        case "auth-status": {
          const name = parsed.positionals[0];
          if (!name) throw new Error("Usage: mcoda agent auth-status <NAME>");
          const agent = await api.getAgent(name);
          const payload = {
            slug: agent.slug,
            adapter: agent.adapter,
            configured: agent.auth?.configured ?? false,
            lastUpdatedAt: agent.auth?.lastUpdatedAt,
            lastVerifiedAt: agent.auth?.lastVerifiedAt,
          };
          if (parsed.flags.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(payload, null, 2));
          } else {
            // eslint-disable-next-line no-console
            console.log("| slug | adapter | configured | lastUpdatedAt | lastVerifiedAt |");
            // eslint-disable-next-line no-console
            console.log("| --- | --- | --- | --- | --- |");
            // eslint-disable-next-line no-console
            console.log(
              `| ${payload.slug} | ${payload.adapter} | ${payload.configured} | ${payload.lastUpdatedAt ?? ""} | ${payload.lastVerifiedAt ?? ""} |`,
            );
          }
          break;
        }
        case "set-default": {
          const name = parsed.positionals[0];
          if (!name) throw new Error("Usage: mcoda agent set-default <NAME> [--workspace <path>]");
          const workspace = await WorkspaceResolver.resolveWorkspace({
            cwd: process.cwd(),
            explicitWorkspace: parsed.flags.workspace ? String(parsed.flags.workspace) : undefined,
          });
          await api.setDefaultAgent(name, workspace.workspaceId);
          // eslint-disable-next-line no-console
          console.log(`Default agent set to ${name} for workspace ${workspace.workspaceRoot}`);
          break;
        }
        default:
          throw new Error(`Unknown agent subcommand: ${subcommand}`);
      }
    } finally {
      await api.close();
    }
  }
}
