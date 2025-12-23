import fs from "node:fs/promises";
import path from "node:path";
import {
  GatewayAgentService,
  WorkspaceResolver,
} from "@mcoda/core";
import { canonicalizeCommandName } from "@mcoda/shared";
import { CreateTasksCommand } from "../planning/CreateTasksCommand.js";
import { RefineTasksCommand } from "../planning/RefineTasksCommand.js";
import { WorkOnTasksCommand } from "../work/WorkOnTasksCommand.js";
import { CodeReviewCommand } from "../review/CodeReviewCommand.js";
import { QaTasksCommand } from "../planning/QaTasksCommand.js";
import { DocsCommands } from "../docs/DocsCommands.js";
import { OpenapiCommands } from "../openapi/OpenapiCommands.js";
import { OrderTasksCommand } from "../backlog/OrderTasksCommand.js";

interface GatewayArgs {
  workspaceRoot?: string;
  projectKey?: string;
  inputText?: string;
  inputFile?: string;
  gatewayAgent?: string;
  maxDocs?: number;
  noOffload: boolean;
  json: boolean;
}

interface TaskFilters {
  projectKey?: string;
  epicKey?: string;
  storyKey?: string;
  taskKeys: string[];
  statusFilter: string[];
  limit?: number;
}

const usage = `mcoda gateway-agent <job> \\
  [--workspace-root <PATH>] \\
  [--project <KEY>] \\
  [--input "<text>"] \\
  [--input-file <PATH>] \\
  [--gateway-agent <NAME>] \\
  [--max-docs <N>] \\
  [--no-offload] \\
  [--json] \\
  [--] [job args...]`;

const HANDOFF_ENV_PATH = "MCODA_GATEWAY_HANDOFF_PATH";

const DOC_ONLY_JOBS = new Set(["sds", "openapi-from-docs"]);

const buildHandoffContent = (result: Awaited<ReturnType<GatewayAgentService["run"]>>): string => {
  const lines: string[] = [];
  lines.push(`# Gateway Handoff`);
  lines.push("");
  lines.push(`Job: ${result.job}`);
  lines.push(`Gateway agent: ${result.gatewayAgent.slug}`);
  lines.push(`Chosen agent: ${result.chosenAgent.agentSlug}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(result.analysis.summary || "(none)");
  lines.push("");
  lines.push("## Understanding");
  lines.push(result.analysis.understanding || "(none)");
  lines.push("");
  lines.push("## Plan");
  if (result.analysis.plan.length) {
    result.analysis.plan.forEach((step, idx) => lines.push(`${idx + 1}. ${step}`));
  } else {
    lines.push("(none)");
  }
  if (result.analysis.assumptions.length) {
    lines.push("");
    lines.push("## Assumptions");
    result.analysis.assumptions.forEach((item) => lines.push(`- ${item}`));
  }
  if (result.analysis.risks.length) {
    lines.push("");
    lines.push("## Risks");
    result.analysis.risks.forEach((item) => lines.push(`- ${item}`));
  }
  if (result.analysis.docdexNotes.length) {
    lines.push("");
    lines.push("## Docdex Notes");
    result.analysis.docdexNotes.forEach((item) => lines.push(`- ${item}`));
  }
  return lines.join("\n");
};

const parseGatewayArgs = (argv: string[]): GatewayArgs => {
  const args: GatewayArgs = { noOffload: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--workspace=") || arg.startsWith("--workspace-root=")) {
      const value = arg.split("=", 2)[1];
      args.workspaceRoot = value ? path.resolve(value) : undefined;
      continue;
    }
    if (arg.startsWith("--project=") || arg.startsWith("--project-key=")) {
      args.projectKey = arg.split("=", 2)[1];
      continue;
    }
    if (arg.startsWith("--input=")) {
      args.inputText = arg.split("=", 2)[1];
      continue;
    }
    if (arg.startsWith("--input-file=")) {
      args.inputFile = arg.split("=", 2)[1];
      continue;
    }
    if (arg.startsWith("--gateway-agent=")) {
      args.gatewayAgent = arg.split("=", 2)[1];
      continue;
    }
    if (arg.startsWith("--max-docs=")) {
      args.maxDocs = Number(arg.split("=", 2)[1]);
      continue;
    }
    switch (arg) {
      case "--workspace":
      case "--workspace-root":
        args.workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--project":
      case "--project-key":
        args.projectKey = argv[i + 1];
        i += 1;
        break;
      case "--input":
        args.inputText = argv[i + 1];
        i += 1;
        break;
      case "--input-file":
        args.inputFile = argv[i + 1];
        i += 1;
        break;
      case "--gateway-agent":
        args.gatewayAgent = argv[i + 1];
        i += 1;
        break;
      case "--max-docs":
        args.maxDocs = Number(argv[i + 1]);
        i += 1;
        break;
      case "--no-offload":
      case "--plan-only":
        args.noOffload = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        // eslint-disable-next-line no-console
        console.log(usage);
        process.exit(0);
        break;
      default:
        break;
    }
  }
  if (!Number.isFinite(args.maxDocs ?? NaN)) {
    args.maxDocs = undefined;
  }
  return args;
};

const stripGatewayOnlyArgs = (argv: string[]): string[] => {
  const stripped: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input" || arg === "--input-file" || arg === "--gateway-agent" || arg === "--max-docs") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--input=") || arg.startsWith("--input-file=") || arg.startsWith("--gateway-agent=") || arg.startsWith("--max-docs=")) {
      continue;
    }
    if (arg === "--no-offload" || arg === "--plan-only" || arg === "--json") {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
};

const stripAgentArgs = (argv: string[]): string[] => {
  const stripped: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
};

const parseTaskFilters = (argv: string[]): TaskFilters => {
  const filters: TaskFilters = { taskKeys: [], statusFilter: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--project=")) {
      filters.projectKey = arg.split("=", 2)[1];
      continue;
    }
    if (arg.startsWith("--task=")) {
      const value = arg.split("=", 2)[1];
      if (value) filters.taskKeys.push(value);
      continue;
    }
    if (arg.startsWith("--epic=")) {
      filters.epicKey = arg.split("=", 2)[1];
      continue;
    }
    if (arg.startsWith("--story=")) {
      filters.storyKey = arg.split("=", 2)[1];
      continue;
    }
    if (arg.startsWith("--status=")) {
      const value = arg.split("=", 2)[1];
      if (value) {
        filters.statusFilter.push(
          ...value.split(",").map((s) => s.trim()).filter(Boolean),
        );
      }
      continue;
    }
    if (arg.startsWith("--limit=")) {
      filters.limit = Number(arg.split("=", 2)[1]);
      continue;
    }
    switch (arg) {
      case "--project":
      case "--project-key":
        filters.projectKey = argv[i + 1];
        i += 1;
        break;
      case "--task":
        if (argv[i + 1]) {
          filters.taskKeys.push(argv[i + 1]);
          i += 1;
        }
        break;
      case "--epic":
        filters.epicKey = argv[i + 1];
        i += 1;
        break;
      case "--story":
        filters.storyKey = argv[i + 1];
        i += 1;
        break;
      case "--status":
        if (argv[i + 1]) {
          filters.statusFilter.push(
            ...argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean),
          );
          i += 1;
        }
        break;
      case "--limit":
        filters.limit = Number(argv[i + 1]);
        i += 1;
        break;
      default:
        break;
    }
  }
  if (!Number.isFinite(filters.limit ?? NaN)) {
    filters.limit = undefined;
  }
  return filters;
};

const findWorkspaceRoot = (argv: string[]): string | undefined => {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "--workspace-root") {
      return argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
    }
    if (arg.startsWith("--workspace=") || arg.startsWith("--workspace-root=")) {
      const value = arg.split("=", 2)[1];
      return value ? path.resolve(value) : undefined;
    }
  }
  return undefined;
};

const normalizeJob = (job: string): string => canonicalizeCommandName(job);

const resolveJobRunner = (job: string) => {
  switch (job) {
    case "work-on-tasks":
      return (args: string[]) => WorkOnTasksCommand.run(args);
    case "refine-tasks":
      return (args: string[]) => RefineTasksCommand.run(args);
    case "create-tasks":
      return (args: string[]) => CreateTasksCommand.run(args);
    case "code-review":
      return (args: string[]) => CodeReviewCommand.run(args);
    case "qa-tasks":
      return (args: string[]) => QaTasksCommand.run(args);
    case "order-tasks":
      return (args: string[]) => OrderTasksCommand.run(args);
    case "openapi-from-docs":
      return (args: string[]) => OpenapiCommands.run(args);
    case "pdr":
      return (args: string[]) => DocsCommands.run(["pdr", "generate", ...args]);
    case "sds":
      return (args: string[]) => DocsCommands.run(["sds", "generate", ...args]);
    default:
      return undefined;
  }
};

export class GatewayAgentCommand {
  static async run(argv: string[]): Promise<void> {
    const [rawJob, ...rest] = argv;
    if (!rawJob) {
      // eslint-disable-next-line no-console
      console.log(usage);
      process.exitCode = 1;
      return;
    }
    if (rawJob === "--help" || rawJob === "-h") {
      // eslint-disable-next-line no-console
      console.log(usage);
      process.exit(0);
      return;
    }
    const separatorIndex = rest.indexOf("--");
    const gatewayArgv = separatorIndex >= 0 ? rest.slice(0, separatorIndex) : rest;
    let jobArgs = separatorIndex >= 0 ? rest.slice(separatorIndex + 1) : rest.slice();
    const gatewayArgs = parseGatewayArgs(gatewayArgv);
    if (separatorIndex < 0) {
      jobArgs = stripGatewayOnlyArgs(jobArgs);
    }
    const normalizedJob = normalizeJob(rawJob);
    if (normalizedJob === "gateway-agent") {
      // eslint-disable-next-line no-console
      console.error("gateway-agent cannot invoke itself.");
      process.exitCode = 1;
      return;
    }
    const workspaceRoot = gatewayArgs.workspaceRoot ?? findWorkspaceRoot(jobArgs);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: workspaceRoot,
    });

    const taskFilters = parseTaskFilters(jobArgs);
    const projectKey = gatewayArgs.projectKey ?? taskFilters.projectKey;
    let inputText = gatewayArgs.inputText;
    if (gatewayArgs.inputFile) {
      try {
        const content = await fs.readFile(gatewayArgs.inputFile, "utf8");
        inputText = inputText ? `${inputText}\n\n${content}` : content;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Failed to read input file: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
    }
    const requiresInputOrSelection = !DOC_ONLY_JOBS.has(normalizedJob);
    if (
      requiresInputOrSelection &&
      !inputText &&
      taskFilters.taskKeys.length === 0 &&
      !taskFilters.epicKey &&
      !taskFilters.storyKey
    ) {
      // eslint-disable-next-line no-console
      console.error("gateway-agent requires --input or at least one task selector (e.g., --task, --epic, --story).");
      process.exitCode = 1;
      return;
    }

    const service = await GatewayAgentService.create(workspace);
    try {
      const result = await service.run({
        workspace,
        job: normalizedJob,
        projectKey,
        epicKey: taskFilters.epicKey,
        storyKey: taskFilters.storyKey,
        taskKeys: taskFilters.taskKeys.length ? taskFilters.taskKeys : undefined,
        statusFilter: taskFilters.statusFilter.length ? taskFilters.statusFilter : undefined,
        limit: taskFilters.limit,
        inputText,
        gatewayAgentName: gatewayArgs.gatewayAgent,
        maxDocs: gatewayArgs.maxDocs,
      });

      const shouldOffload = !gatewayArgs.noOffload && !gatewayArgs.json;
      if (gatewayArgs.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`Gateway agent: ${result.gatewayAgent.slug} (run: ${result.commandRunId})`);
      // eslint-disable-next-line no-console
      console.log(`Summary: ${result.analysis.summary}`);
      if (result.analysis.plan.length) {
        // eslint-disable-next-line no-console
        console.log(`Plan:\n- ${result.analysis.plan.join("\n- ")}`);
      }
      // eslint-disable-next-line no-console
      console.log(`Complexity: ${result.analysis.complexity}/10`);
      // eslint-disable-next-line no-console
      console.log(`Discipline: ${result.analysis.discipline}`);
      // eslint-disable-next-line no-console
      console.log(
        `Chosen agent for ${result.job}: ${result.chosenAgent.agentSlug} (rating=${result.chosenAgent.rating ?? "?"}, cost=${result.chosenAgent.costPerMillion ?? "?"})`,
      );
      // eslint-disable-next-line no-console
      console.log(`Rationale: ${result.chosenAgent.rationale}`);
      if (result.warnings.length) {
        // eslint-disable-next-line no-console
        console.warn(result.warnings.map((w) => `! ${w}`).join("\n"));
      }

      if (!shouldOffload) {
        return;
      }
      const runner = resolveJobRunner(result.job);
      if (!runner) {
        // eslint-disable-next-line no-console
        console.error(`gateway-agent does not support offloading job ${result.job}.`);
        process.exitCode = 1;
        return;
      }
      const handoffContent = buildHandoffContent(result);
      const handoffDir = path.join(workspace.workspaceRoot, ".mcoda", "handoffs");
      await fs.mkdir(handoffDir, { recursive: true });
      const handoffPath = path.join(handoffDir, `gateway-${result.commandRunId}.md`);
      await fs.writeFile(handoffPath, handoffContent, "utf8");
      const previousHandoff = process.env[HANDOFF_ENV_PATH];
      process.env[HANDOFF_ENV_PATH] = handoffPath;
      const forwarded = stripAgentArgs(jobArgs);
      const argsWithAgent = [...forwarded, "--agent", result.chosenAgent.agentSlug];
      // eslint-disable-next-line no-console
      console.log(`\nOffloading ${result.job} to ${result.chosenAgent.agentSlug}...`);
      try {
        await runner(argsWithAgent);
      } finally {
        if (previousHandoff === undefined) {
          delete process.env[HANDOFF_ENV_PATH];
        } else {
          process.env[HANDOFF_ENV_PATH] = previousHandoff;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`gateway-agent failed: ${message}`);
      process.exitCode = 1;
    } finally {
      await service.close();
    }
  }
}
