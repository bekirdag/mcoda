import { JobService, RoutingService, WorkspaceResolver } from "@mcoda/core";

type Subcommand = "defaults" | "preview" | "explain";

interface DefaultsArgs {
  workspace?: string;
  set: Record<string, string>;
  reset: string[];
  list: boolean;
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
  [--set-command <COMMAND>=<AGENT>]... \\
  [--set-qa-profile <PROFILE>] \\
  [--set-docdex-scope <SCOPE>] \\
  [--reset-command <COMMAND>]... \\
  [--no-telemetry] \\
  [--json]`;

const PREVIEW_USAGE = `mcoda routing preview \\
  [--workspace <PATH>] \\
  --command <COMMAND_NAME> \\
  [--task-type <TYPE>] \\
  [--agent <OVERRIDE_SLUG>] \\
  [--project <PROJECT_KEY>] \\
  [--no-telemetry] \\
  [--json]`;

const EXPLAIN_USAGE = `mcoda routing explain \\
  [--workspace <PATH>] \\
  --command <COMMAND_NAME> \\
  [--task-type <TYPE>] \\
  [--agent <OVERRIDE_SLUG>] \\
  [--no-telemetry] \\
  [--json] \\
  [--debug]`;

const KNOWN_COMMANDS = [
  "create-tasks",
  "refine-tasks",
  "work-on-tasks",
  "code-review",
  "qa-tasks",
  "pdr",
  "sds",
  "openapi-from-docs",
  "order-tasks",
];

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
  const args: DefaultsArgs = { workspace: undefined, set: {}, reset: [], list: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      // eslint-disable-next-line no-console
      console.log(DEFAULTS_USAGE);
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
      console.log(PREVIEW_USAGE);
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
  const normalized = routing.normalizeCommand(name);
  const allowed = new Set(KNOWN_COMMANDS.map((c) => routing.normalizeCommand(c)));
  if (!allowed.has(normalized)) {
    throw new Error(
      `Unknown command ${name}; must be one of: ${Array.from(allowed)
        .sort()
        .join(", ")}`,
    );
  }
  return normalized;
};

export class RoutingCommands {
  static async run(argv: string[]): Promise<void> {
    try {
      const [maybeSub, ...rest] = argv;
      let subcommand: Subcommand = "defaults";
      let tail = rest;
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
      if (args.list) {
        const defaults = await routing.getWorkspaceDefaults(workspace.workspaceId);
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
          for (const cmd of Array.from(commands).sort()) {
            const ws = defaults.find((d) => routing.normalizeCommand(d.commandName) === cmd);
            const global = globalDefaults.find((d) => routing.normalizeCommand(d.commandName) === cmd);
            const wsAgentSummary = ws ? await routing.getAgentSummary(ws.agentId) : undefined;
            const globalAgentSummary = global ? await routing.getAgentSummary(global.agentId) : undefined;
            const wsAgent = wsAgentSummary?.slug ?? ws?.agentId ?? "-";
            const globalAgent = globalAgentSummary?.slug ?? global?.agentId ?? "-";
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
          resolved.qaProfile ?? "-",
          resolved.docdexScope ?? "-",
        ];
        // eslint-disable-next-line no-console
        console.log(
          formatTable(
            ["Command", "Workspace", "Agent", "Source", "Health", "Capabilities", "QA Profile", "Docdex Scope"],
            [row],
          ),
        );
        if (resolved.routingPreview.notes) {
          // eslint-disable-next-line no-console
          console.log(`Notes: ${resolved.routingPreview.notes}`);
        }
      }
      await jobService.recordTokenUsage({
        workspaceId: workspace.workspaceId,
        commandRunId: commandRun.id,
        commandName: explain ? "routing explain" : "routing preview",
        agentId: resolved.agentId,
        modelName: resolved.model,
        tokensPrompt: 0,
        tokensCompletion: 0,
        timestamp: new Date().toISOString(),
        metadata: { routing: resolved.routingPreview },
      });
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
