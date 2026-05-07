import {
  MswarmApi,
  type MswarmSyncSummary,
  type MswarmWorkerAgent,
  type MswarmWorkerAgentDetail,
} from "@mcoda/core";
import { readFile } from "node:fs/promises";

interface ParsedArgs {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
}

const USAGE = `
Usage: mcoda workers <list|details|sync|run> [options]

Subcommands:
  list                     List mswarm Workers as mcoda agents (supports --json)
    --limit <N>            Limit returned workers
    --include-disabled     Include disabled Workers in the catalog result (default)
    --enabled-only         Hide disabled Workers
  details <SLUG>           Show a single mswarm Worker (supports --json)
  sync                     Sync mswarm Workers into the local mcoda registry
    --limit <N>            Limit synced workers
    --include-disabled     Sync disabled Workers too (default)
    --enabled-only         Sync active Workers only
    --prune                Remove previously synced Workers missing from the current catalog result
    --agent-slug-prefix <P>
                             Override the local managed-worker slug prefix
  run <SLUG> [TEXT...]     Run a Worker through mswarm
    --input <TEXT>         Worker input text
    --payload-file <FILE>  Read JSON payload from a file
    --payload-stdin        Read JSON or text payload from stdin
    --idempotency-key <K>  Forward an idempotency key

Connection options:
  --base-url <URL>         Override MCODA_MSWARM_BASE_URL (default: https://api.mswarm.org/)
  --api-key <KEY>          Override MCODA_MSWARM_API_KEY
  --timeout-ms <N>         Override MCODA_MSWARM_TIMEOUT_MS

Environment:
  MCODA_MSWARM_BASE_URL
  MCODA_MSWARM_API_KEY
  MCODA_MSWARM_TIMEOUT_MS
  MCODA_MSWARM_WORKER_AGENT_SLUG_PREFIX

Flags:
  --json                   Emit JSON for supported commands
  --help                   Show this help
`.trim();

const MAX_WORKER_PAYLOAD_BYTES = 5 * 1024 * 1024;

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

const formatNumber = (value: number | undefined): string =>
  value === undefined || Number.isNaN(value) ? "-" : String(value);

const formatBoolean = (value: boolean | undefined): string =>
  value === undefined ? "-" : value ? "yes" : "no";

const formatCapabilities = (capabilities: string[] | undefined): string =>
  capabilities && capabilities.length > 0 ? capabilities.join(",") : "-";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const formatString = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : "-";

const formatWorkerAgent = (worker: MswarmWorkerAgent): string => {
  const selected = asRecord(worker.worker?.selected_agent);
  return formatString(selected?.slug ?? selected?.model ?? worker.default_model);
};

const pad = (value: string, width: number): string => value.padEnd(width, " ");

const renderTable = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((header, columnIndex) =>
    Math.max(header.length, ...rows.map((row) => row[columnIndex]?.length ?? 0)),
  );
  return [
    headers.map((header, index) => pad(header, widths[index] ?? header.length)).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => row.map((cell, index) => pad(cell, widths[index] ?? cell.length)).join("  ")),
  ].join("\n");
};

const printWorkerList = (workers: MswarmWorkerAgent[]): void => {
  if (workers.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No mswarm Workers found.");
    return;
  }
  const rows = workers.map((worker) => [
    worker.slug,
    worker.worker?.name ?? worker.display_name ?? "-",
    formatBoolean(worker.worker?.enabled),
    worker.worker?.status ?? worker.health_status ?? "-",
    formatWorkerAgent(worker),
    formatBoolean(worker.worker?.docdex_enabled),
    formatString(asRecord(worker.worker?.config_health)?.status),
  ]);
  // eslint-disable-next-line no-console
  console.log(
    renderTable(
      ["WORKER SLUG", "NAME", "ENABLED", "STATUS", "AGENT", "DOCDEX", "CONFIG"],
      rows,
    ),
  );
};

const printWorkerDetails = (worker: MswarmWorkerAgentDetail): void => {
  const entries: Array<[string, string]> = [
    ["Slug", worker.slug],
    ["Remote slug", worker.remote_slug ?? "-"],
    ["Name", worker.worker?.name ?? worker.display_name ?? "-"],
    ["Provider", worker.provider],
    ["Adapter", worker.adapter ?? "-"],
    ["Model", worker.default_model],
    ["Rating", formatNumber(worker.rating)],
    ["Reasoning rating", formatNumber(worker.reasoning_rating)],
    ["Max complexity", formatNumber(worker.max_complexity)],
    ["Supports tools", formatBoolean(worker.supports_tools)],
    ["Health", worker.health_status ?? "-"],
    ["Capabilities", formatCapabilities(worker.capabilities)],
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
    `Synced ${summary.agents.length} Workers (created=${summary.created}, updated=${summary.updated}, deleted=${summary.deleted}).`,
  );
  if (summary.agents.length === 0) return;
  const rows = summary.agents.map((record) => [
    record.remoteSlug,
    record.localSlug,
    record.action,
    record.defaultModel,
  ]);
  // eslint-disable-next-line no-console
  console.log(renderTable(["REMOTE SLUG", "LOCAL SLUG", "ACTION", "MODEL"], rows));
};

const ensurePayloadSize = (raw: string, label: string): void => {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_WORKER_PAYLOAD_BYTES) {
    throw new Error(`${label} exceeds ${MAX_WORKER_PAYLOAD_BYTES} bytes`);
  }
};

const readStdin = async (): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data, "utf8") > MAX_WORKER_PAYLOAD_BYTES) {
        reject(new Error(`stdin payload exceeds ${MAX_WORKER_PAYLOAD_BYTES} bytes`));
      }
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(data));
  });

const parsePayloadText = (raw: string, label: string): unknown => {
  ensurePayloadSize(raw, label);
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { text: raw };
};

const resolveRunPayload = async (parsed: ParsedArgs): Promise<unknown> => {
  const sources = [
    resolveString(parsed.flags["payload-file"]) !== undefined,
    parsed.flags["payload-stdin"] === true,
    resolveString(parsed.flags.input) !== undefined || parsed.positionals.length > 1,
  ].filter(Boolean).length;
  if (sources > 1) {
    throw new Error("Use only one of --payload-file, --payload-stdin, --input, or positional TEXT");
  }
  const payloadFile = resolveString(parsed.flags["payload-file"]);
  if (payloadFile) {
    return parsePayloadText(await readFile(payloadFile, "utf8"), "--payload-file");
  }
  if (parsed.flags["payload-stdin"] === true) {
    return parsePayloadText(await readStdin(), "--payload-stdin");
  }
  const input = resolveString(parsed.flags.input) ?? parsed.positionals.slice(1).join(" ");
  return { text: input };
};

const resolveIncludeDisabled = (parsed: ParsedArgs): boolean =>
  parsed.flags["enabled-only"] === true ? false : true;

export class WorkersCommands {
  static async run(argv: string[]): Promise<void> {
    const [rawSubcommand, ...rest] = argv;
    if (!rawSubcommand || argv.includes("--help") || argv.includes("-h")) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return;
    }
    const subcommand =
      rawSubcommand === "detail" || rawSubcommand === "show" ? "details" : rawSubcommand;
    const parsed = parseArgs(rest);
    const api = await MswarmApi.create({
      baseUrl: resolveString(parsed.flags["base-url"]),
      apiKey: resolveString(parsed.flags["api-key"]),
      timeoutMs: resolvePositiveInt(parsed.flags["timeout-ms"], "--timeout-ms"),
      workerAgentSlugPrefix: resolveString(parsed.flags["agent-slug-prefix"]),
    });

    try {
      switch (subcommand) {
        case "list": {
          const workers = await api.listAllWorkers({
            limit: resolvePositiveInt(parsed.flags.limit, "--limit"),
            includeDisabled: resolveIncludeDisabled(parsed),
          });
          if (parsed.flags.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(workers, null, 2));
          } else {
            printWorkerList(workers);
          }
          break;
        }
        case "details": {
          const slug = parsed.positionals[0];
          if (!slug) throw new Error("Usage: mcoda workers details <SLUG> [--json]");
          const worker = await api.getWorker(slug);
          if (parsed.flags.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(worker, null, 2));
          } else {
            printWorkerDetails(worker);
          }
          break;
        }
        case "sync": {
          const summary = await api.syncWorkers({
            limit: resolvePositiveInt(parsed.flags.limit, "--limit"),
            includeDisabled: resolveIncludeDisabled(parsed),
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
        case "run": {
          const slug = parsed.positionals[0];
          if (!slug) throw new Error("Usage: mcoda workers run <SLUG> [TEXT...]");
          const result = await api.runWorker(
            slug,
            await resolveRunPayload(parsed),
            { idempotencyKey: resolveString(parsed.flags["idempotency-key"]) },
          );
          if (parsed.flags.json) {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(result, null, 2));
          } else {
            const output =
              typeof result.output === "string"
                ? result.output
                : typeof (result.result as Record<string, unknown> | undefined)?.output === "string"
                  ? String((result.result as Record<string, unknown>).output)
                  : JSON.stringify(result, null, 2);
            // eslint-disable-next-line no-console
            console.log(output);
          }
          break;
        }
        default:
          throw new Error(`Unknown workers subcommand: ${subcommand}`);
      }
    } finally {
      await api.close();
    }
  }
}
