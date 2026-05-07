import {
  MswarmApi,
  type MswarmSyncSummary,
  type MswarmWorkerAgent,
  type MswarmWorkerAgentDetail,
} from "@mcoda/core";

interface ParsedArgs {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
}

const USAGE = `
Usage: mcoda workers <list|details|sync|run> [options]

Subcommands:
  list                     List mswarm Workers as mcoda agents (supports --json)
    --limit <N>            Limit returned workers
    --include-disabled     Include disabled Workers in the catalog result
  details <SLUG>           Show a single mswarm Worker (supports --json)
  sync                     Sync mswarm Workers into the local mcoda registry
    --limit <N>            Limit synced workers
    --include-disabled     Sync disabled Workers too
    --prune                Remove previously synced Workers missing from the current catalog result
    --agent-slug-prefix <P>
                             Override the local managed-worker slug prefix
  run <SLUG> [TEXT...]     Run a Worker through mswarm
    --input <TEXT>         Worker input text
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
    worker.default_model,
    formatNumber(worker.rating),
    formatNumber(worker.reasoning_rating),
    formatNumber(worker.max_complexity),
    formatBoolean(worker.supports_tools),
    worker.health_status ?? "-",
    formatCapabilities(worker.capabilities),
  ]);
  // eslint-disable-next-line no-console
  console.log(
    renderTable(
      ["WORKER SLUG", "NAME", "MODEL", "RATING", "REASON", "MAX CPLX", "TOOLS", "HEALTH", "CAPABILITIES"],
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
          const workers = await api.listWorkers({
            limit: resolvePositiveInt(parsed.flags.limit, "--limit"),
            includeDisabled: Boolean(parsed.flags["include-disabled"]),
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
            includeDisabled: Boolean(parsed.flags["include-disabled"]),
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
          const input = resolveString(parsed.flags.input) ?? parsed.positionals.slice(1).join(" ");
          const result = await api.runWorker(
            slug,
            { text: input },
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
