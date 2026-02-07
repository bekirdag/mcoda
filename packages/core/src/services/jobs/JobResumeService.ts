import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "./JobService.js";
import { CodeReviewService } from "../review/CodeReviewService.js";
import { QaTasksService } from "../execution/QaTasksService.js";
import { DocsService } from "../docs/DocsService.js";
import { OpenApiService } from "../openapi/OpenApiService.js";

export interface ResumeOptions {
  agentName?: string;
  noTelemetry?: boolean;
}

export class JobResumeService {
  constructor(private workspace: WorkspaceResolution, private jobService: JobService) {}

  static async create(workspace: WorkspaceResolution): Promise<JobResumeService> {
    const jobService = new JobService(workspace, undefined, { requireRepo: true });
    return new JobResumeService(workspace, jobService);
  }

  private async readManifest(jobId: string): Promise<Record<string, unknown> | undefined> {
    return this.jobService.readManifest(jobId);
  }

  private assertResumeAllowed(job: any, manifest?: Record<string, unknown>): void {
    const state = job.jobState ?? job.state ?? "unknown";
    if (["completed", "cancelled"].includes(state)) {
      throw new Error(`Job ${job.id} is ${state}; cannot resume.`);
    }
    if (["running", "queued", "checkpointing"].includes(state)) {
      throw new Error(`Job ${job.id} is ${state}; wait for it to finish or cancel before resuming.`);
    }
    const supported =
      job.resumeSupported ?? job.resume_supported ?? (job.payload as any)?.resumeSupported ?? (job.payload as any)?.resume_supported;
    if (supported === 0 || supported === false) {
      throw new Error(`Job ${job.id} does not support resume.`);
    }
    if (!manifest) {
      throw new Error(`Missing manifest for job ${job.id}; cannot resume safely.`);
    }
    const manifestJobId = (manifest as any).job_id ?? (manifest as any).id;
    if (manifestJobId && manifestJobId !== job.id) {
      throw new Error(`Checkpoint manifest for ${job.id} does not match job id (${manifestJobId}); aborting resume.`);
    }
    const manifestType = (manifest as any).type ?? (manifest as any).job_type;
    if (manifestType && manifestType !== job.type) {
      throw new Error(`Checkpoint manifest type (${manifestType}) does not match job type (${job.type}); cannot resume.`);
    }
    const manifestCommand = (manifest as any).command ?? (manifest as any).command_name ?? (manifest as any).commandName;
    if (manifestCommand && job.commandName && manifestCommand !== job.commandName) {
      throw new Error(`Checkpoint manifest command (${manifestCommand}) does not match job command (${job.commandName}); cannot resume.`);
    }
  }

  async resume(jobId: string, options: ResumeOptions = {}): Promise<void> {
    const job = await this.jobService.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    const checkpoints = await this.jobService.readCheckpoints(jobId);
    if (!checkpoints.length) throw new Error(`No checkpoints found for job ${jobId}; cannot resume.`);
    const manifest = await this.readManifest(jobId);
    this.assertResumeAllowed(job, manifest);
    await this.jobService.updateJobStatus(jobId, "running", { job_state_detail: "resuming" } as any);

    const command = (job.commandName ?? job.type ?? "").toLowerCase();
    if (command === "code-review" || job.type === "review") {
      const service = await CodeReviewService.create(this.workspace);
      try {
        await service.reviewTasks({
          workspace: this.workspace,
          resumeJobId: jobId,
          agentName: options.agentName,
          agentStream: true,
        } as any);
      } finally {
        await service.close();
      }
      return;
    }

    if (command === "qa-tasks" || job.type === "qa") {
      const qaService = await QaTasksService.create(this.workspace, { noTelemetry: options.noTelemetry });
      try {
        await qaService.run({
          workspace: this.workspace,
          resumeJobId: jobId,
          projectKey: (job as any).projectKey ?? (job.payload as any)?.projectKey,
          agentName: options.agentName,
          agentStream: true,
        } as any);
      } finally {
        await qaService.close();
      }
      return;
    }

    if (command.includes("sds") || job.type === "sds_generate" || command.includes("pdr") || job.type === "pdr_generate") {
      const docs = await DocsService.create(this.workspace);
      try {
        if (command.includes("sds") || job.type === "sds_generate") {
          await docs.generateSds({ workspace: this.workspace, resumeJobId: jobId, agentName: options.agentName });
        } else {
          await docs.generatePdr({ workspace: this.workspace, resumeJobId: jobId, agentName: options.agentName });
        }
      } finally {
        await docs.close();
      }
      return;
    }

    if (command.includes("openapi") || job.type === "openapi_change") {
      const openapi = await OpenApiService.create(this.workspace, { noTelemetry: options.noTelemetry });
      try {
        const cliVersion =
          (job.payload as any)?.cliVersion ??
          (manifest as any)?.cliVersion ??
          (manifest as any)?.metadata?.cliVersion ??
          "0.0.0";
        await openapi.generateFromDocs({
          workspace: this.workspace,
          projectKey: (job as any).projectKey ?? (job.payload as any)?.projectKey,
          resumeJobId: jobId,
          agentName: options.agentName,
          agentStream: true,
          cliVersion,
        });
      } finally {
        await openapi.close();
      }
      return;
    }

    throw new Error(`Resume is not implemented for job type ${job.type ?? job.commandName ?? "unknown"}.`);
  }
}
