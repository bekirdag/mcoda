import { JobService, RoutingService, WorkspaceResolver } from "@mcoda/core";
import {
  canonicalizeCommandName,
  getKnownCommands,
  getKnownDocdexScopes,
  getKnownQaProfiles,
} from "@mcoda/shared";

type Subcommand = "defaults" | "preview" | "explain";

interface DefaultsArgs {
  workspace?: string;
  set: Record<string, string>;
  reset: string[];
  list: boolean;
  showIds: boolean;
  noTelemetry?: boolean;
  qaProfile?: string;
  docdexScope?: string;
  json: boolean;
}

interface PreviewArgs {
  workspace?: string;
  command?: string;
  taskType?: string;
  agent?: string;
  project?: string;
  noTelemetry?: boolean;
  json: boolean;
  debug: boolean;
}

const DEFAULTS_USAGE = `mcoda routing defaults \\
  [--workspace <PATH>] \\
  [--list] \\
  [--show-ids] \\
  [--set-command <COMMAND>=<AGENT>]... \\
  [--set-qa-profile <PROFILE>] \\
  [--set-docdex-scope <SCOPE>] \\
  [--reset-command <COMMAND>]... \\
  [--no-telemetry] \\
  [--json]`;

const DEFAULTS_HELP = `${DEFAULTS_USAGE}

Manage per-workspace routing defaults backed by the global DB (~/.mcoda/mcoda.db).

Flags:
  --list                      List workspace + __GLOBAL__ defaults (default if no setters are passed)
  --show-ids                  Include agent ids in list output (e.g., slug (id))
  --set-command c=a           Set default agent for command c (validates capabilities)
  --reset-command c           Remove workspace override so __GLOBAL__ applies
  --set-qa-profile name       Set workspace QA profile override (validated against OpenAPI profiles)
  --set-docdex-scope name     Set docdex scope override (validated against OpenAPI scopes)
  --workspace PATH            Resolve workspace via PATH (otherwise uses CWD)
  --json                      Emit raw RoutingDefaults DTOs
  --no-telemetry              Skip local token usage recording for this run
`;

const PREVIEW_USAGE = `mcoda routing preview \\
  [--workspace <PATH>] \\
  --command <COMMAND_NAME> \\
  [--task-type <TYPE>] \\
  [--agent <OVERRIDE_SLUG>] \\
  [--project <PROJECT_KEY>] \\
  [--no-telemetry] \\
  [--json]`;

const PREVIEW_HELP = `${PREVIEW_USAGE}

Preview which agent would be selected for a command using full routing (override → workspace default → global default).

Flags:
  --command NAME              CLI command to preview (validated against OpenAPI x-mcoda-cli.name)
  --agent SLUG                Force a specific agent (capability-validated)
  --task-type TYPE            Optional task type hint (adds QA-required capabilities)
  --project KEY               Optional project key for context
  --workspace PATH            Resolve workspace via PATH (otherwise uses CWD)
  --json                      Emit raw RoutingPreview DTO
  --no-telemetry              Skip local token usage recording for this run
`;

const EXPLAIN_USAGE = `mcoda routing explain \\
  [--workspace <PATH>] \\
  --command <COMMAND_NAME> \\
  [--task-type <TYPE>] \\
  [--agent <OVERRIDE_SLUG>] \\
  [--no-telemetry] \\
  [--json] \\
  [--debug]`;

const EXPLAIN_HELP = `${EXPLAIN_USAGE}

Explain routing decisions with candidates, health, capabilities, and provenance.
Same flags as preview; add --debug to surface extra trace fields when available.
`;

const pad = (value: string, width: number): string => value.padEnd(width, " ");

const formatTable = (headers: string[], rows: string[][]): string => {
  if (rows.length === 0) return headers.join(" | ");
  const widths = headers.map((header, idx) => Math.max(header.length, ...rows.map((row) => (row[idx] ?? "").length)));
  const headerLine = headers.map((h, idx) => pad(h, widths[idx])).join(" | ");
  const sepLine = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = rows.map((row) => row.map((cell, idx) => pad(cell ?? "", widths[idx])).join(" | ")).join("\n");
  return [headerLine, sepLine, body].filter(Boolean).join("\n");
};

const parseDefaultsArgs = (argv: string[]): DefaultsArgs => {
  const args: DefaultsArgs = { workspace: undefined, set: {}, reset: [], list: false, showIds: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      // eslint-disable-next-line no-console
      console.log(DEFAULTS_HELP);
      process.exit(0);
    }
    if (arg === "--workspace") {
      args.workspace = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--list") {
      args.list = true;
      continue;
    }
    if (arg === "--show-ids") {
      args.showIds = true;
      continue;
    }
    if (arg.startsWith("--set-command")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[i + 1];
      if (!value) throw new Error("Missing value for --set-command (expected <command>=<agent>)");
      if (!arg.includes("=")) i += 1;
      const [cmd, agent] = value.split("=", 2);
      if (!cmd || !agent) throw new Error("Invalid --set-command format, expected <command>=<agent>");
      args.set[cmd] = agent;
      continue;
    }
    if (arg.startsWith("--reset-command")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[i + 1];
      if (!value) throw new Error("Missing value for --reset-command");
      if (!arg.includes("=")) i += 1;
      args.reset.push(value);
      continue;
    }
    if (arg === "--set-qa-profile") {
      args.qaProfile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--set-qa-profile=")) {
      args.qaProfile = arg.split("=", 2)[1];
      continue;
    }
    if (arg === "--set-docdex-scope") {
      args.docdexScope = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--set-docdex-scope=")) {
      args.docdexScope = arg.split("=", 2)[1];
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--no-telemetry") {
      args.noTelemetry = true;
      continue;
    }
  }
  if (
    !args.list &&
    Object.keys(args.set).length === 0 &&
    args.reset.length === 0 &&
    !args.qaProfile &&
    !args.docdexScope
  ) {
    args.list = true;
  }
  return args;
};

const parsePreviewArgs = (argv: string[]): PreviewArgs => {
  const args: PreviewArgs = { json: false, debug: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      // eslint-disable-next-line no-console
      console.log(PREVIEW_HELP);
      process.exit(0);
    }
    if (arg === "--workspace") {
      args.workspace = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--command") {
      args.command = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--command=")) {
      args.command = arg.split("=", 2)[1];
      continue;
    }
    if (arg === "--task-type") {
      args.taskType = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--task-type=")) {
      args.taskType = arg.split("=", 2)[1];
      continue;
    }
    if (arg === "--agent") {
      args.agent = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) {
      args.agent = arg.split("=", 2)[1];
      continue;
    }
    if (arg === "--project") {
      args.project = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      args.project = arg.split("=", 2)[1];
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--debug") {
      args.debug = true;
      continue;
    }
    if (arg === "--no-telemetry") {
      args.noTelemetry = true;
    }
  }
  return args;
};

const validateCommandName = (routing: RoutingService, name?: string): string => {
  if (!name) {
    throw new Error("routing preview/explain requires --command.\n\n" + PREVIEW_USAGE);
  }
  const normalized = canonicalizeCommandName(name);
  const allowed = new Set(getKnownCommands().map((c) => routing.normalizeCommand(c)));
  if (!allowed.has(normalized)) {
    throw new Error(
      `Unknown command ${name}; must be one of: ${Array.from(allowed)
        .sort()
        .join(", ")}`,
    );
  }
  return normalized;
};

const normalizeValue = (value?: string): string | undefined =>
  value ? value.trim().toLowerCase().replace(/[_\s]+/g, "-") : undefined;

export class RoutingCommands {
  static async run(argv: string[]): Promise<void> {
    try {
      const [maybeSub, ...rest] = argv;
      let subcommand: Subcommand = "defaults";
      let tail = rest;
      if (maybeSub === "--help" || maybeSub === "-h") {
        // eslint-disable-next-line no-console
        console.log(
          [
            "mcoda routing <defaults|preview|explain> [flags]",
            "",
            "Subcommands:",
            "  defaults   List/update routing defaults (workspace + global)",
            "  preview    Preview agent selection with routing provenance",
            "  explain    Explain routing decision with candidates/health",
            "",
            "Use --help with each subcommand for detailed flags.",
          ].join("\n"),
        );
        return;
      }
      if (maybeSub && !maybeSub.startsWith("--")) {
        if (!["defaults", "preview", "explain"].includes(maybeSub)) {
          throw new Error(
            `Unknown routing subcommand: ${maybeSub}\n\nAvailable: defaults | preview | explain`,
          );
        }
        subcommand = maybeSub as Subcommand;
        tail = rest;
      } else {
        tail = argv;
      }

      if (subcommand === "defaults") {
        await this.runDefaults(tail);
        return;
      }
      if (subcommand === "preview") {
        await this.runPreview(tail, false);
        return;
      }
      if (subcommand === "explain") {
        await this.runPreview(tail, true);
        return;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error((error as Error).message);
      process.exitCode = 1;
    }
  }

  private static async resolveWorkspace(explicit?: string) {
    return WorkspaceResolver.resolveWorkspace({ cwd: process.cwd(), explicitWorkspace: explicit });
  }

  private static async runDefaults(argv: string[]): Promise<void> {
    const args = parseDefaultsArgs(argv);
    const workspace = await this.resolveWorkspace(args.workspace);
    const routing = await RoutingService.create();
    const jobService = new JobService(workspace, undefined, { noTelemetry: args.noTelemetry });
    const commandRun = await jobService.startCommandRun("routing defaults");
    try {
      const knownQa = getKnownQaProfiles().map((p) => normalizeValue(p));
      const knownDocdex = getKnownDocdexScopes().map((p) => normalizeValue(p));
      if (args.qaProfile && knownQa.length && !knownQa.includes(normalizeValue(args.qaProfile))) {
        throw new Error(
          `Unknown QA profile ${args.qaProfile}; allowed values: ${knownQa.filter(Boolean).join(", ")}`,
        );
      }
      if (args.docdexScope && knownDocdex.length && !knownDocdex.includes(normalizeValue(args.docdexScope))) {
        throw new Error(
          `Unknown docdex scope ${args.docdexScope}; allowed values: ${knownDocdex.filter(Boolean).join(", ")}`,
        );
      }
      if (!args.list) {
        for (const command of Object.keys(args.set)) {
          validateCommandName(routing, command);
        }
      }
      if (args.list) {
        const defaults = await routing.getWorkspaceDefaults(workspace);
        const globalDefaults = await routing.getWorkspaceDefaults("__GLOBAL__");
        if (args.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              { workspaceId: workspace.workspaceId, defaults, globalDefaults },
              null,
              2,
            ),
          );
        } else {
          const commands = new Set<string>();
          defaults.forEach((d) => commands.add(routing.normalizeCommand(d.commandName)));
          globalDefaults.forEach((d) => commands.add(routing.normalizeCommand(d.commandName)));
          const rows: string[][] = [];
          const agentCache = new Map<string, Awaited<ReturnType<typeof routing.getAgentSummary>>>();
          const getAgentSummary = async (agentId?: string) => {
            if (!agentId) return undefined;
            if (agentCache.has(agentId)) return agentCache.get(agentId);
            const summary = await routing.getAgentSummary(agentId);
            agentCache.set(agentId, summary);
            return summary;
          };
          const formatAgent = (summary: { slug?: string; id?: string } | undefined, fallbackId?: string) => {
            if (args.showIds) {
              if (summary?.slug) {
                const id = summary.id ?? fallbackId;
                return id ? `${summary.slug} (${id})` : summary.slug;
              }
              return fallbackId ?? "-";
            }
            return summary?.slug ?? fallbackId ?? "-";
          };
          for (const cmd of Array.from(commands).sort()) {
            const ws = defaults.find((d) => routing.normalizeCommand(d.commandName) === cmd);
            const global = globalDefaults.find((d) => routing.normalizeCommand(d.commandName) === cmd);
            const wsAgentSummary = ws ? await getAgentSummary(ws.agentId) : undefined;
            const globalAgentSummary = global ? await getAgentSummary(global.agentId) : undefined;
            const wsAgent = formatAgent(wsAgentSummary, ws?.agentId);
            const globalAgent = formatAgent(globalAgentSummary, global?.agentId);
            rows.push([
              cmd,
              wsAgent,
              ws?.qaProfile ?? "-",
              ws?.docdexScope ?? "-",
              globalAgent,
              global?.qaProfile ?? "-",
              global?.docdexScope ?? "-",
            ]);
          }
          // eslint-disable-next-line no-console
          console.log(
            formatTable(
              [
                "Command",
                "Workspace Agent",
                "Workspace QA",
                "Workspace Docdex",
                "Global Agent",
                "Global QA",
                "Global Docdex",
              ],
              rows,
            ),
          );
        }
      } else {
        const updated = await routing.updateWorkspaceDefaults(workspace.workspaceId, {
          set: args.set,
          reset: args.reset,
          qaProfile: args.qaProfile,
          docdexScope: args.docdexScope,
        });
        if (args.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify({ workspaceId: workspace.workspaceId, defaults: updated }, null, 2),
          );
        } else {
          // eslint-disable-next-line no-console
          console.log(`Updated routing defaults for workspace ${workspace.workspaceId}`);
          const rows = await Promise.all(
            updated.map(async (d) => {
              const agent = await routing.getAgentSummary(d.agentId);
              return [
                d.commandName,
                agent?.slug ?? d.agentId,
                d.qaProfile ?? "-",
                d.docdexScope ?? "-",
                d.updatedAt ?? "",
              ];
            }),
          );
          // eslint-disable-next-line no-console
          console.log(formatTable(["Command", "Agent", "QA Profile", "Docdex Scope", "Updated"], rows));
        }
      }
      await jobService.finishCommandRun(commandRun.id, "succeeded");
    } catch (error) {
      await jobService.finishCommandRun(commandRun.id, "failed", (error as Error).message);
      throw error;
    } finally {
      await routing.close();
      await jobService.close();
    }
  }

  private static async runPreview(argv: string[], explain: boolean): Promise<void> {
    const args = parsePreviewArgs(argv);
    if (argv.includes("--help") || argv.includes("-h")) {
      // eslint-disable-next-line no-console
      console.log(explain ? EXPLAIN_HELP : PREVIEW_HELP);
      return;
    }
    const routing = await RoutingService.create();
    const workspace = await this.resolveWorkspace(args.workspace);
    const commandName = validateCommandName(routing, args.command);
    const jobService = new JobService(workspace, undefined, { noTelemetry: args.noTelemetry });
    const commandRun = await jobService.startCommandRun(explain ? "routing explain" : "routing preview");
    try {
      const resolved = await routing.resolveAgentForCommand({
        workspace,
        commandName,
        taskType: args.taskType,
        overrideAgentSlug: args.agent,
        projectKey: args.project,
      });
      if (args.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(resolved.routingPreview, null, 2));
      } else if (explain) {
        // eslint-disable-next-line no-console
        console.log(`Workspace: ${workspace.workspaceId}`);
        // eslint-disable-next-line no-console
        console.log(`Command:   ${commandName}`);
        if (args.taskType) {
          // eslint-disable-next-line no-console
          console.log(`Task type: ${args.taskType}`);
        }
        const rows =
          resolved.routingPreview.candidates?.map((c) => [
            c.agentSlug ?? c.agentId,
            c.source,
            c.health?.status ?? "unknown",
            (c.capabilities ?? []).join(",") || "-",
            c.missingCapabilities?.join(",") ?? "",
            c.notes ?? "",
          ]) ?? [];
        // eslint-disable-next-line no-console
        console.log(
          formatTable(
            ["Candidate", "Source", "Health", "Capabilities", "Missing", "Notes"],
            rows,
          ),
        );
        // eslint-disable-next-line no-console
        console.log(
          `Selected: ${resolved.agentSlug} (source=${resolved.source}, health=${resolved.healthStatus})`,
        );
        if (resolved.requiredCapabilities.length) {
          // eslint-disable-next-line no-console
          console.log(`Required capabilities: ${resolved.requiredCapabilities.join(",")}`);
        }
        if (resolved.qaProfile) {
          // eslint-disable-next-line no-console
          console.log(`QA Profile: ${resolved.qaProfile}`);
        }
        if (resolved.docdexScope) {
          // eslint-disable-next-line no-console
          console.log(`Docdex Scope: ${resolved.docdexScope}`);
        }
        if (resolved.routingPreview.notes) {
          // eslint-disable-next-line no-console
          console.log(`Notes: ${resolved.routingPreview.notes}`);
        }
      } else {
        const row = [
          commandName,
          workspace.workspaceId,
          resolved.agentSlug,
          resolved.source,
          resolved.healthStatus,
          resolved.capabilities.join(",") || "-",
          resolved.requiredCapabilities.join(",") || "-",
          resolved.qaProfile ?? "-",
          resolved.docdexScope ?? "-",
        ];
        // eslint-disable-next-line no-console
        console.log(
          formatTable(
            [
              "Command",
              "Workspace",
              "Agent",
              "Source",
              "Health",
              "Capabilities",
              "Required Capabilities",
              "QA Profile",
              "Docdex Scope",
            ],
            [row],
          ),
        );
        if (resolved.routingPreview.notes) {
          // eslint-disable-next-line no-console
          console.log(`Notes: ${resolved.routingPreview.notes}`);
        }
      }
      if (!args.noTelemetry) {
        await jobService.recordTokenUsage({
          workspaceId: workspace.workspaceId,
          commandRunId: commandRun.id,
          commandName: explain ? "routing explain" : "routing preview",
          agentId: resolved.agentId,
          modelName: resolved.model,
          tokensPrompt: 0,
          tokensCompletion: 0,
          tokensTotal: 0,
          timestamp: new Date().toISOString(),
          metadata: {
            routing: resolved.routingPreview,
            provenance: resolved.source,
            requiredCapabilities: resolved.requiredCapabilities,
            overrideAgent: args.agent,
            qaProfile: resolved.qaProfile,
            docdexScope: resolved.docdexScope,
            taskType: args.taskType,
            projectKey: args.project,
          },
        });
      }
      await jobService.finishCommandRun(commandRun.id, "succeeded");
    } catch (error) {
      await jobService.finishCommandRun(commandRun.id, "failed", (error as Error).message);
      throw error;
    } finally {
      await routing.close();
      await jobService.close();
    }
  }
}
