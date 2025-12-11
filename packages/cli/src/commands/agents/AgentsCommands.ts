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
    --adapter <TYPE>         Adapter slug (openai-api|codex-cli|gemini-cli|local-model|qa-cli)
    --model <MODEL>          Default model name
    --capability <CAP>       Repeatable capabilities to attach
    --job-path <PATH>        Optional job prompt path
    --character-path <PATH>  Optional character prompt path
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

const formatAgentRow = (agent: AgentResponse): string =>
  [
    agent.slug,
    agent.adapter,
    agent.defaultModel ?? "",
    (agent.capabilities ?? []).join(","),
    agent.health?.status ?? "unknown",
    agent.health?.lastCheckedAt ?? "",
  ].join(" | ");

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
              // eslint-disable-next-line no-console
              console.log("| slug | adapter | default_model | capabilities | health | last_checked_at |");
              // eslint-disable-next-line no-console
              console.log("| --- | --- | --- | --- | --- | --- |");
              agents.forEach((agent) => {
                // eslint-disable-next-line no-console
                console.log(`| ${formatAgentRow(agent)} |`);
              });
            }
          }
          break;
        }
        case "add": {
          const name = parsed.positionals[0];
          if (!name) throw new Error("agent add requires a slug/name\n\n" + USAGE);
          const capabilities = parseCapabilities(parsed.flags.capability) ?? [];
          const prompts = parsePrompts(parsed.flags);
          const agent = await api.createAgent({
            slug: name,
            adapter: String(parsed.flags.adapter ?? "openai-api"),
            defaultModel: parsed.flags.model ? String(parsed.flags.model) : undefined,
            capabilities,
            prompts,
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
          const agent = await api.updateAgent(name, {
            adapter: parsed.flags.adapter ? String(parsed.flags.adapter) : undefined,
            defaultModel: parsed.flags.model ? String(parsed.flags.model) : undefined,
            capabilities,
            prompts,
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
