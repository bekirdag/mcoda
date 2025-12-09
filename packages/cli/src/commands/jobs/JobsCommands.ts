import path from "node:path";
import { JobService, WorkspaceResolver } from "@mcoda/core";

const usage = [
  "mcoda job <list|status|watch|resume> [--id JOB_ID] [--workspace-root <path>] [--interval 2000] [--iterations 10]",
  "",
  "Inspect and watch long-running jobs (local workspace store).",
].join("\n");

interface ParsedArgs {
  subcommand: "list" | "status" | "watch" | "resume";
  jobId?: string;
  workspaceRoot?: string;
  intervalMs: number;
  maxIterations?: number | null;
}

const parseArgs = (argv: string[]): ParsedArgs => {
  let subcommand: ParsedArgs["subcommand"] | undefined;
  let jobId: string | undefined;
  let workspaceRoot: string | undefined;
  let intervalMs = 2000;
  let maxIterations: number | null | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--") && !subcommand) {
      subcommand = arg as ParsedArgs["subcommand"];
      continue;
    }
    switch (arg) {
      case "--id":
        jobId = argv[i + 1];
        i += 1;
        break;
      case "--workspace-root":
        workspaceRoot = argv[i + 1] ? path.resolve(argv[i + 1]) : undefined;
        i += 1;
        break;
      case "--interval":
        intervalMs = Number(argv[i + 1] ?? intervalMs);
        i += 1;
        break;
      case "--iterations":
        maxIterations = Number(argv[i + 1] ?? "0") || null;
        i += 1;
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
  if (!subcommand || !["list", "status", "watch", "resume"].includes(subcommand)) {
    throw new Error(`Command must be one of list|status|watch|resume\n\n${usage}`);
  }
  if (["status", "watch", "resume"].includes(subcommand) && !jobId) {
    throw new Error(`${subcommand} requires --id JOB_ID`);
  }
  return { subcommand, jobId, workspaceRoot, intervalMs, maxIterations };
};

const formatJob = (job: any): string => {
  const payload = job.payload ?? job.metadata ?? {};
  return [
    `ID: ${job.id}`,
    `Type: ${job.type}`,
    `State: ${job.state ?? job.status}`,
    `Created: ${job.createdAt}`,
    `Updated: ${job.updatedAt}`,
    `Duration(s): ${job.durationSeconds ?? "-"}`,
    `Output: ${payload.outputPath ?? "-"}`,
    `Docdex: ${payload.docdexId ?? "-"}`,
  ].join("\n");
};

const formatCheckpoint = (ckpt: any): string =>
  [`- [${ckpt.stage}] ${ckpt.timestamp}`, ckpt.details ? JSON.stringify(ckpt.details) : ""]
    .filter(Boolean)
    .join(" ");

export class JobsCommands {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseArgs(argv);
    const workspace = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });
    const jobs = new JobService(workspace.workspaceRoot);
    try {
      if (parsed.subcommand === "list") {
        const records = await jobs.listJobs();
        if (records.length === 0) {
          // eslint-disable-next-line no-console
          console.log("No jobs found.");
          return;
        }
        for (const job of records) {
          const state = (job as any).state ?? (job as any).status;
          // eslint-disable-next-line no-console
          console.log(`${job.id}\t${job.type}\t${state as string}\t${job.updatedAt}`);
        }
        return;
      }

      let job = parsed.jobId ? await jobs.getJob(parsed.jobId) : undefined;
      if (!job) throw new Error(`Job not found: ${parsed.jobId}`);

      const printStatus = async (current: any) => {
        // eslint-disable-next-line no-console
        console.log(formatJob(current));
        const checkpoints = await jobs.readCheckpoints(current.id);
        if (checkpoints.length) {
          // eslint-disable-next-line no-console
          console.log("Checkpoints:");
          checkpoints.forEach((ckpt) => {
            // eslint-disable-next-line no-console
            console.log(formatCheckpoint(ckpt));
          });
        }
        const log = await jobs.readLog(current.id);
        if (log) {
          // eslint-disable-next-line no-console
          console.log("---- logs ----");
          // eslint-disable-next-line no-console
          console.log(log.trimEnd());
        }
      };

      if (parsed.subcommand === "status") {
        await printStatus(job);
        return;
      }

      if (parsed.subcommand === "watch") {
        let iterations = 0;
        // eslint-disable-next-line no-console
        console.log(`Watching job ${job.id} (Ctrl+C to exit)`);
        while (parsed.maxIterations == null || iterations < parsed.maxIterations) {
          const current = await jobs.getJob(job.id);
          if (current) {
            // eslint-disable-next-line no-console
            console.log("\n=== Job Update ===");
            await printStatus(current);
            job = current;
            const state = (current as any).state ?? (current as any).status;
            if (state !== "running") break;
          }
          iterations += 1;
          await new Promise((r) => setTimeout(r, parsed.intervalMs));
        }
        return;
      }

      if (parsed.subcommand === "resume") {
        // Placeholder for resumable engine: currently just surfaces latest status/logs.
        // eslint-disable-next-line no-console
        console.log(`Resume not implemented; showing latest status for ${job.id}`);
        await printStatus(job);
        return;
      }
    } finally {
      await jobs.close();
    }
  }
}
