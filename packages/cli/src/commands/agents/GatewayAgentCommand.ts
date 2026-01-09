import fs from "node:fs/promises";
import path from "node:path";
import {
  GatewayAgentService,
  buildGatewayHandoffContent,
  withGatewayHandoff,
  writeGatewayHandoffFile,
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
  agentStream?: boolean;
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
  [--agent-stream <true|false>] \\
  [--no-offload] \\
  [--json] \\
  [--] [job args...]`;

const DOC_ONLY_JOBS = new Set(["sds", "openapi-from-docs"]);

const parseBooleanFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
};

const isIoEnabled = (): boolean => {
  const raw = process.env.MCODA_STREAM_IO;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
};

const isSameAgent = (result: Awaited<ReturnType<GatewayAgentService["run"]>>): boolean =>
  result.chosenAgent.agentId === result.gatewayAgent.id || result.chosenAgent.agentSlug === result.gatewayAgent.slug;

const collectOffloadBlockers = (result: Awaited<ReturnType<GatewayAgentService["run"]>>): string[] => {
  const blockers: string[] = [];
  const missingFieldsWarning = result.warnings.find((w) => w.startsWith("Gateway analysis missing fields:"));
  if (missingFieldsWarning) {
    blockers.push(missingFieldsWarning.replace("Gateway analysis missing fields:", "analysis incomplete:").trim());
  }
  const currentState = result.analysis.currentState.trim();
  const todo = result.analysis.todo.trim();
  if (!currentState) blockers.push("missing current state");
  if (currentState.toLowerCase().includes("current state unknown")) blockers.push("current state not digested");
  if (currentState.toLowerCase().includes("requires investigation")) blockers.push("current state not verified");
  if (!todo) blockers.push("missing todo");
  if (todo.toLowerCase().includes("determine remaining work")) blockers.push("todo not digested");
  if (!result.analysis.understanding.trim()) blockers.push("missing understanding");
  if (result.analysis.filesLikelyTouched.length === 0 && result.analysis.filesToCreate.length === 0) {
    blockers.push("no files identified to change/create");
  }
  const hasDocdexFailure = result.warnings.some((w) => w.toLowerCase().includes("docdex") && w.toLowerCase().includes("failed"));
  if (hasDocdexFailure) blockers.push("docdex lookup failed");
  if (result.analysis.docdexNotes.length === 0 || result.warnings.some((w) => w.includes("missing docdexNotes"))) {
    blockers.push("docdex not digested");
  }
  if (result.warnings.some((w) => w.includes("not valid JSON"))) {
    blockers.push("gateway response not JSON");
  }
  return blockers;
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
    if (arg.startsWith("--agent-stream=")) {
      args.agentStream = parseBooleanFlag(arg.split("=", 2)[1], true);
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
      case "--agent-stream": {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          args.agentStream = parseBooleanFlag(next, true);
          i += 1;
        } else {
          args.agentStream = true;
        }
        break;
      }
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
    if (arg === "--input" || arg === "--input-file" || arg === "--gateway-agent" || arg === "--max-docs" || arg === "--agent-stream") {
      i += 1;
      continue;
    }
    if (
      arg.startsWith("--input=") ||
      arg.startsWith("--input-file=") ||
      arg.startsWith("--gateway-agent=") ||
      arg.startsWith("--max-docs=") ||
      arg.startsWith("--agent-stream=")
    ) {
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
      const streamEnabled = (gatewayArgs.agentStream ?? true) && !gatewayArgs.json;
      const ioEnabled = isIoEnabled();
      const shouldPrintStream = streamEnabled && !ioEnabled;
      let streamStarted = false;
      let streamEndedWithNewline = true;
      const onStreamChunk = shouldPrintStream
        ? (chunk: string) => {
            if (!streamStarted) {
              // eslint-disable-next-line no-console
              console.log("Gateway agent stream:");
              streamStarted = true;
            }
            process.stdout.write(chunk);
            streamEndedWithNewline = chunk.endsWith("\n");
          }
        : undefined;
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
        agentStream: streamEnabled,
        onStreamChunk,
      });
      if (shouldPrintStream && streamStarted && !streamEndedWithNewline) {
        process.stdout.write("\n");
      }

      const shouldRunJob = !gatewayArgs.noOffload && !gatewayArgs.json;
      if (gatewayArgs.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // eslint-disable-next-line no-console
      console.log(`Gateway agent: ${result.gatewayAgent.slug} (run: ${result.commandRunId})`);
      if (result.analysis.reasoningSummary?.trim()) {
        // eslint-disable-next-line no-console
        console.log(`Reasoning summary: ${result.analysis.reasoningSummary.trim()}`);
      }
      // eslint-disable-next-line no-console
      console.log(`Summary: ${result.analysis.summary}`);
      // eslint-disable-next-line no-console
      console.log(`Current state: ${result.analysis.currentState}`);
      // eslint-disable-next-line no-console
      console.log(`Todo: ${result.analysis.todo}`);
      if (result.analysis.understanding.trim()) {
        // eslint-disable-next-line no-console
        console.log(`Understanding: ${result.analysis.understanding}`);
      }
      if (result.analysis.plan.length) {
        // eslint-disable-next-line no-console
        console.log(`Plan:\n- ${result.analysis.plan.join("\n- ")}`);
      }
      if (result.analysis.filesLikelyTouched.length || result.analysis.filesToCreate.length) {
        // eslint-disable-next-line no-console
        console.log(
          `Files: ${[
            ...result.analysis.filesLikelyTouched.map((f) => `touch:${f}`),
            ...result.analysis.filesToCreate.map((f) => `create:${f}`),
          ].join(", ")}`,
        );
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

      if (!shouldRunJob) {
        return;
      }
      const blockers = collectOffloadBlockers(result);
      if (blockers.length) {
        // eslint-disable-next-line no-console
        console.error(`gateway-agent is not ready to offload: ${blockers.join("; ")}.`);
        process.exitCode = 1;
        return;
      }

      const runner = resolveJobRunner(result.job);
      if (!runner) {
        // eslint-disable-next-line no-console
        console.error(`gateway-agent does not support offloading job ${result.job}.`);
        process.exitCode = 1;
        return;
      }
      const forwarded = stripAgentArgs(jobArgs);
      const hasAgentStream = forwarded.some((arg) => arg === "--agent-stream" || arg.startsWith("--agent-stream="));
      const argsWithAgent = [...forwarded];
      if (!hasAgentStream) {
        argsWithAgent.push("--agent-stream", "true");
      }
      argsWithAgent.push("--agent", result.chosenAgent.agentSlug);
      const sameAgent = isSameAgent(result);
      const handoffContent = buildGatewayHandoffContent(result);
      const handoffPath = await writeGatewayHandoffFile(workspace.workspaceRoot, result.commandRunId, handoffContent);
      const actionLabel = sameAgent
        ? `Continuing ${result.job} with gateway agent ${result.gatewayAgent.slug}`
        : `Offloading ${result.job} to ${result.chosenAgent.agentSlug}`;
      // eslint-disable-next-line no-console
      console.log(`\n${actionLabel}...`);
      await withGatewayHandoff(handoffPath, async () => {
        await runner(argsWithAgent);
      });
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
