import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import {
  MswarmApi,
  type MswarmGenericJobOpsSummary,
  type MswarmGenericJobLifecycleSnapshot,
  type MswarmGenericJobReference,
  type MswarmGenericNodeJobEnvelope
} from "@mcoda/core";

interface ParsedArgs {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
}

const GPU_USAGE = `
Usage: mcoda gpu <list|ops> [options]

Commands:
  gpu list                 List owner-local GPU/job capability projection
  gpu ops                  Show owner-local generic job queue, usage, quota, and audit summary

Connection options:
  --node-base-url <URL>    Owner-local node URL (or MCODA_MSWARM_NODE_BASE_URL)
  --node-id <ID>           Node id for signing capability requests
  --signing-secret <KEY>   Owner-local generic job signing secret
  --token <TOKEN>          Pre-signed capability or ops token
  --timeout-ms <N>         Request timeout
  --audit-limit <N>        Audit rows for gpu ops (default 50, max 250)
  --audit-offset <N>       Audit row offset for gpu ops
  --json                   Emit JSON
`.trim();

const JOB_USAGE = `
Usage: mcoda job <artifact|run|status|logs|events|artifacts|cancel|retry> [options]

GPU job commands:
  job artifact upload <FILE>
    --job-id <ID> --request-id <ID> --node-id <ID> --job-type <TYPE>
    [--artifact-path <PATH>] [--artifact-name <NAME>] [--content-type <TYPE>]
  job run --job-file <FILE> [--wait] [--json]
  job run --type <TYPE> --payload-file <FILE> [--wait] [--json]
  job status <JOB_ID> [--job-file <FILE> | --node-id ... --request-id ... --job-type ...]
  job logs <JOB_ID>
  job events <JOB_ID>
  job artifacts <JOB_ID>
  job cancel <JOB_ID>
  job retry <JOB_ID>

Connection options:
  --node-base-url <URL>    Owner-local node URL (or MCODA_MSWARM_NODE_BASE_URL)
  --node-id <ID>           Node id for signing requests
  --signing-secret <KEY>   Owner-local generic job signing secret
  --token <TOKEN>          Pre-signed generic job token
  --timeout-ms <N>         Request timeout
  --json                   Emit JSON
`.trim();

const GPU_JOB_SUBCOMMANDS = new Set(["artifact", "run", "events", "artifacts"]);
const SHARED_JOB_SUBCOMMANDS = new Set(["status", "logs", "cancel", "retry"]);
const GPU_JOB_FLAGS = new Set([
  "--gpu",
  "--node-base-url",
  "--node-id",
  "--signing-secret",
  "--token",
  "--job-file",
  "--payload-file",
  "--job-type",
  "--type",
  "--schema-version",
  "--request-id"
]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "expired", "blocked"]);

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
        if (current === undefined) flags[key] = next;
        else if (Array.isArray(current)) flags[key] = [...current, next];
        else if (typeof current === "string") flags[key] = [current, next];
        else flags[key] = [next];
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

const resolveNonNegativeInt = (value: string | string[] | boolean | undefined, label: string): number | undefined => {
  const raw = resolveString(value);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}; expected a non-negative integer`);
  }
  return parsed;
};

const nodeBaseUrl = (parsed: ParsedArgs): string | undefined =>
  resolveString(parsed.flags["node-base-url"]) || process.env.MCODA_MSWARM_NODE_BASE_URL;

const nodeId = (parsed: ParsedArgs): string | undefined =>
  resolveString(parsed.flags["node-id"]) || process.env.MCODA_MSWARM_NODE_ID || process.env.MSWARM_SELF_HOSTED_NODE_ID;

const signingSecret = (parsed: ParsedArgs): string | undefined =>
  resolveString(parsed.flags["signing-secret"]) ||
  process.env.MCODA_MSWARM_NODE_SIGNING_SECRET ||
  process.env.MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET;

const baseAuth = (parsed: ParsedArgs) => ({
  nodeBaseUrl: nodeBaseUrl(parsed),
  token: resolveString(parsed.flags.token),
  signingSecret: signingSecret(parsed),
  tokenTtlSeconds: resolvePositiveInt(parsed.flags["token-ttl-seconds"], "--token-ttl-seconds")
});

const createApi = async (parsed: ParsedArgs): Promise<MswarmApi> =>
  MswarmApi.create({
    baseUrl: nodeBaseUrl(parsed),
    apiKey: resolveString(parsed.flags["api-key"]),
    timeoutMs: resolvePositiveInt(parsed.flags["timeout-ms"], "--timeout-ms")
  });

const readStructuredFile = async (file: string): Promise<unknown> => {
  const raw = await readFile(file, "utf8");
  if (file.endsWith(".yaml") || file.endsWith(".yml")) {
    return YAML.parse(raw);
  }
  return JSON.parse(raw);
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readJobEnvelope = async (parsed: ParsedArgs): Promise<MswarmGenericNodeJobEnvelope> => {
  const file = resolveString(parsed.flags["job-file"]) || resolveString(parsed.flags["payload-file"]);
  if (!file) {
    throw new Error("GPU job run requires --job-file or --payload-file");
  }
  const payload = asRecord(await readStructuredFile(file));
  if (typeof payload.job_id === "string" && typeof payload.request_id === "string" && typeof payload.node_id === "string") {
    return payload as unknown as MswarmGenericNodeJobEnvelope;
  }
  const schemaVersion =
    resolveString(parsed.flags["schema-version"]) ||
    (typeof payload.schema_version === "string" ? payload.schema_version : "2026-06-14");
  const jobType =
    resolveString(parsed.flags.type) ||
    resolveString(parsed.flags["job-type"]) ||
    (typeof payload.job_type === "string" ? payload.job_type : undefined);
  if (!jobType) {
    throw new Error("--job-file/--payload-file must contain job_type or use --type/--job-type");
  }
  return {
    job_id: resolveString(parsed.flags["job-id"]) || `job-${randomUUID()}`,
    request_id: resolveString(parsed.flags["request-id"]) || `req-${randomUUID()}`,
    node_id: requireText(nodeId(parsed), "--node-id"),
    job: {
      ...payload,
      schema_version: schemaVersion,
      job_type: jobType
    } as unknown as MswarmGenericNodeJobEnvelope["job"]
  };
};

const referenceFromArgs = async (
  parsed: ParsedArgs,
  explicitJobId?: string
): Promise<MswarmGenericJobReference> => {
  const jobFile = resolveString(parsed.flags["job-file"]) || resolveString(parsed.flags["payload-file"]);
  if (jobFile) {
    const job = await readJobEnvelope(parsed);
    return {
      ...baseAuth(parsed),
      jobId: explicitJobId || job.job_id,
      nodeId: job.node_id,
      requestId: job.request_id,
      schemaVersion: job.job.schema_version,
      jobType: job.job.job_type
    };
  }
  return {
    ...baseAuth(parsed),
    jobId: requireText(explicitJobId || resolveString(parsed.flags["job-id"]), "JOB_ID"),
    nodeId: nodeId(parsed),
    requestId: resolveString(parsed.flags["request-id"]),
    schemaVersion: resolveString(parsed.flags["schema-version"]) || "2026-06-14",
    jobType: resolveString(parsed.flags["job-type"]) || resolveString(parsed.flags.type)
  };
};

function requireText(value: string | undefined, label: string): string {
  if (!value || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

const printJsonOrValue = (value: unknown, json: boolean): void => {
  // eslint-disable-next-line no-console
  console.log(json ? JSON.stringify(value, null, 2) : formatValue(value));
};

const formatValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
};

const printSnapshot = (snapshot: MswarmGenericJobLifecycleSnapshot, json: boolean): void => {
  if (json) {
    printJsonOrValue(snapshot, true);
    return;
  }
  const job = snapshot.job;
  // eslint-disable-next-line no-console
  console.log(`${job.job_id} ${job.state}`);
  if (job.backpressure?.message) {
    // eslint-disable-next-line no-console
    console.log(job.backpressure.message);
  }
  if (job.result?.error?.message) {
    // eslint-disable-next-line no-console
    console.log(job.result.error.message);
  }
};

const formatOpsSummary = (summary: MswarmGenericJobOpsSummary): string => {
  const lines = [
    `${summary.node.node_id} ${summary.node.generic_jobs_enabled ? "generic-jobs-enabled" : "generic-jobs-disabled"}`,
    `queue active=${summary.queue.active_jobs} queued=${summary.queue.queued_jobs} terminal=${summary.queue.terminal_jobs}`,
    `quota available=${summary.quota.available_slots}/${summary.quota.max_concurrent_jobs} production_enforced=${summary.quota.production_enforced}`,
    `usage total=${summary.usage.total_jobs} succeeded=${summary.usage.succeeded_jobs} failed=${summary.usage.failed_jobs} cancelled=${summary.usage.cancelled_jobs} blocked=${summary.usage.blocked_jobs} gpu_seconds=${summary.usage.gpu_seconds}`,
  ];
  if (summary.queue.jobs.length) {
    lines.push("jobs:");
    for (const job of summary.queue.jobs.slice(0, 10)) {
      lines.push(`  ${job.job_id} ${job.state} ${job.job_type} tenant=${job.tenant_id}`);
    }
  }
  if (summary.audit.events.length) {
    lines.push(`audit offset=${summary.audit.offset} limit=${summary.audit.limit} total=${summary.audit.total}:`);
    for (const event of summary.audit.events.slice(0, 10)) {
      lines.push(`  ${event.timestamp} ${event.action} ${event.job_id}`);
    }
  }
  return lines.join("\n");
};

const waitForJob = async (
  api: MswarmApi,
  reference: MswarmGenericJobReference,
  intervalMs: number
): Promise<MswarmGenericJobLifecycleSnapshot> => {
  let snapshot = await api.getGenericJob(reference);
  while (!TERMINAL_STATES.has(snapshot.job.state)) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    snapshot = await api.getGenericJob(reference);
  }
  return snapshot;
};

export class GpuCommands {
  static async run(argv: string[]): Promise<void> {
    const [subcommand, ...rest] = argv;
    if (!subcommand || argv.includes("--help") || argv.includes("-h")) {
      // eslint-disable-next-line no-console
      console.log(GPU_USAGE);
      return;
    }
    if (subcommand !== "list" && subcommand !== "ops") {
      throw new Error(`Unknown gpu subcommand: ${subcommand}`);
    }
    const parsed = parseArgs(rest);
    const api = await createApi(parsed);
    try {
      if (subcommand === "list") {
        const capabilities = await api.listGpuCapabilities({
          ...baseAuth(parsed),
          nodeId: nodeId(parsed)
        });
        printJsonOrValue(capabilities, Boolean(parsed.flags.json));
        return;
      }
      const ops = await api.getGenericJobOps({
        ...baseAuth(parsed),
        nodeId: nodeId(parsed),
        auditLimit: resolvePositiveInt(parsed.flags["audit-limit"], "--audit-limit"),
        auditOffset: resolveNonNegativeInt(parsed.flags["audit-offset"], "--audit-offset")
      });
      // eslint-disable-next-line no-console
      console.log(parsed.flags.json ? JSON.stringify(ops, null, 2) : formatOpsSummary(ops));
    } finally {
      await api.close();
    }
  }
}

export class GpuJobCommands {
  static shouldHandle(argv: string[]): boolean {
    const [subcommand] = argv;
    if (!subcommand) return false;
    if (GPU_JOB_SUBCOMMANDS.has(subcommand)) return true;
    if (!SHARED_JOB_SUBCOMMANDS.has(subcommand)) return false;
    return argv.some((arg) => GPU_JOB_FLAGS.has(arg) || arg.startsWith("--node-base-url="));
  }

  static async run(argv: string[]): Promise<void> {
    const [subcommand, ...rest] = argv;
    if (!subcommand || argv.includes("--help") || argv.includes("-h")) {
      // eslint-disable-next-line no-console
      console.log(JOB_USAGE);
      return;
    }
    const parsed = parseArgs(rest);
    const api = await createApi(parsed);
    try {
      switch (subcommand) {
        case "artifact": {
          const action = parsed.positionals[0];
          const file = parsed.positionals[1];
          if (action !== "upload" || !file) {
            throw new Error("Usage: mcoda job artifact upload <FILE> [options]");
          }
          const content = await readFile(file);
          const artifactPath = resolveString(parsed.flags["artifact-path"]) || basename(file);
          const result = await api.uploadGenericJobArtifact({
            ...(await referenceFromArgs(parsed, resolveString(parsed.flags["job-id"]))),
            name: resolveString(parsed.flags["artifact-name"]) || basename(file),
            path: artifactPath,
            contentBase64: content.toString("base64"),
            contentType: resolveString(parsed.flags["content-type"]),
            sha256: createHash("sha256").update(content).digest("hex"),
            sizeBytes: content.length
          });
          printJsonOrValue(result, Boolean(parsed.flags.json));
          break;
        }
        case "run": {
          const job = await readJobEnvelope(parsed);
          const snapshot = await api.runGenericJob(job, baseAuth(parsed));
          const finalSnapshot = parsed.flags.wait
            ? await waitForJob(
                api,
                await referenceFromArgs(parsed, job.job_id),
                resolvePositiveInt(parsed.flags["interval-ms"], "--interval-ms") || 1000
              )
            : snapshot;
          printSnapshot(finalSnapshot, Boolean(parsed.flags.json));
          break;
        }
        case "status": {
          const snapshot = await api.getGenericJob(
            await referenceFromArgs(parsed, parsed.positionals[0])
          );
          printSnapshot(snapshot, Boolean(parsed.flags.json));
          break;
        }
        case "logs": {
          const result = await api.getGenericJobLogs(
            await referenceFromArgs(parsed, parsed.positionals[0])
          );
          if (parsed.flags.json) printJsonOrValue(result, true);
          else printJsonOrValue(result.logs.map((log) => log.message).join("\n"), false);
          break;
        }
        case "events": {
          const result = await api.getGenericJobEvents(
            await referenceFromArgs(parsed, parsed.positionals[0])
          );
          printJsonOrValue(result, Boolean(parsed.flags.json));
          break;
        }
        case "artifacts": {
          const result = await api.getGenericJobArtifacts(
            await referenceFromArgs(parsed, parsed.positionals[0])
          );
          printJsonOrValue(result, Boolean(parsed.flags.json));
          break;
        }
        case "cancel": {
          const result = await api.cancelGenericJob(
            await referenceFromArgs(parsed, parsed.positionals[0])
          );
          printSnapshot(result, Boolean(parsed.flags.json));
          break;
        }
        case "retry": {
          const result = await api.retryGenericJob(
            await referenceFromArgs(parsed, parsed.positionals[0])
          );
          printSnapshot(result, Boolean(parsed.flags.json));
          break;
        }
        default:
          throw new Error(`Unknown GPU job subcommand: ${subcommand}`);
      }
    } finally {
      await api.close();
    }
  }
}
