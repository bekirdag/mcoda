import { AgentsApi, AgentResponse } from "@mcoda/core";
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

const printAgentsTable = (agents: AgentResponse[]): void => {
  if (agents.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No agents found.");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    "| slug | adapter | default_model | capabilities | health_status | last_checked_at |",
  );
  // eslint-disable-next-line no-console
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const agent of agents) {
    const capabilities = agent.capabilities.join(",");
    const health = agent.health?.status ?? "unknown";
    const checked = agent.health?.lastCheckedAt ?? "";
    // eslint-disable-next-line no-console
    console.log(
      `| ${agent.slug} | ${agent.adapter} | ${agent.defaultModel ?? ""} | ${capabilities} | ${health} | ${checked} |`,
    );
  }
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

export class AgentsCommands {
  static async run(argv: string[]): Promise<void> {
    const [subcommand, ...rest] = argv;
    if (!subcommand) {
      throw new Error("Usage: mcoda agent <list|add|update|delete|auth|auth-status|set-default> ...");
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
            printAgentsTable(agents);
          }
          break;
        }
        case "add": {
          const name = parsed.positionals[0];
          if (!name) throw new Error("agent add requires a slug/name");
          const capabilities = parsed.flags.capability
            ? (Array.isArray(parsed.flags.capability)
                ? parsed.flags.capability
                : [parsed.flags.capability]
              ).filter((value): value is string => typeof value === "string")
            : [];
          const agent = await api.createAgent({
            slug: name,
            adapter: String(parsed.flags.adapter ?? "openai-api"),
            defaultModel: parsed.flags.model ? String(parsed.flags.model) : undefined,
            capabilities,
          });
          // eslint-disable-next-line no-console
          console.log(`Created agent ${agent.slug}`);
          break;
        }
        case "update": {
          const name = parsed.positionals[0];
          if (!name) throw new Error("agent update requires a slug/name");
          const capabilities = parsed.flags.capability
            ? (Array.isArray(parsed.flags.capability)
                ? parsed.flags.capability
                : [parsed.flags.capability]
              ).filter((value): value is string => typeof value === "string")
            : undefined;
          const agent = await api.updateAgent(name, {
            adapter: parsed.flags.adapter ? String(parsed.flags.adapter) : undefined,
            defaultModel: parsed.flags.model ? String(parsed.flags.model) : undefined,
            capabilities,
          });
          // eslint-disable-next-line no-console
          console.log(`Updated agent ${agent.slug}`);
          break;
        }
        case "delete": {
          const name = parsed.positionals[0];
          if (!name) throw new Error("agent delete requires a slug/name");
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
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                slug: agent.slug,
                configured: agent.auth?.configured ?? false,
                lastUpdatedAt: agent.auth?.lastUpdatedAt,
                lastVerifiedAt: agent.auth?.lastVerifiedAt,
              },
              null,
              2,
            ),
          );
          break;
        }
        case "set-default": {
          const name = parsed.positionals[0];
          if (!name) throw new Error("Usage: mcoda agent set-default <NAME> [--workspace <path>]");
          const workspace = parsed.flags.workspace
            ? String(parsed.flags.workspace)
            : "__GLOBAL__";
          await api.setDefaultAgent(name, workspace);
          // eslint-disable-next-line no-console
          console.log(`Default agent set to ${name} for workspace ${workspace}`);
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
