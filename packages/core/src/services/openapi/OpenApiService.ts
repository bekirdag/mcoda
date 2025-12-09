import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";
import { AgentService } from "@mcoda/agents";
import { DocdexClient, DocdexDocument } from "@mcoda/integrations";
import { GlobalRepository } from "@mcoda/db";
import { Agent } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";

export interface GenerateOpenapiOptions {
  workspace: WorkspaceResolution;
  agentName?: string;
  agentStream?: boolean;
  force?: boolean;
  dryRun?: boolean;
  validateOnly?: boolean;
  cliVersion: string;
  onToken?: (token: string) => void;
}

export interface GenerateOpenapiResult {
  jobId: string;
  commandRunId: string;
  outputPath?: string;
  spec: string;
  docdexId?: string;
  warnings: string[];
}

interface ContextBlock {
  label: string;
  content: string;
  priority: number;
  tokens: number;
}

interface OpenapiContext {
  blocks: ContextBlock[];
  docdexAvailable: boolean;
  warnings: string[];
}

const OPENAPI_TAGS = [
  "Agents",
  "Routing",
  "Tasks",
  "Work",
  "Review",
  "QA",
  "Backlog",
  "Estimate",
  "Telemetry",
  "Jobs",
  "Docdex",
  "Config",
  "System",
];

const REQUIRED_SCHEMAS = [
  "Agent",
  "AgentAuth",
  "AgentPromptManifest",
  "RoutingDefaults",
  "RoutingPreview",
  "Project",
  "Epic",
  "UserStory",
  "Task",
  "TaskSummary",
  "TaskHistoryEntry",
  "TaskComment",
  "Job",
  "CommandRun",
  "TaskRun",
  "TaskQaRun",
  "TokenUsage",
  "TaskLog",
  "LogEntry",
  "ErrorResponse",
];

const OPENAPI_VERSION = "3.1.0";
const CONTEXT_TOKEN_BUDGET = 8000;

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const fileExists = async (candidate: string): Promise<boolean> => {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
};

const readGitBranch = async (workspaceRoot: string): Promise<string | undefined> => {
  const headPath = path.join(workspaceRoot, ".git", "HEAD");
  try {
    const content = await fs.readFile(headPath, "utf8");
    const match = content.match(/ref: refs\/heads\/(.+)/);
    return match ? match[1].trim() : content.trim();
  } catch {
    return undefined;
  }
};

class OpenapiContextAssembler {
  constructor(private docdex: DocdexClient, private workspace: WorkspaceResolution) {}

  private summarize(doc: DocdexDocument): string {
    const text = doc.content ?? "";
    if (!text) return doc.title ?? doc.path ?? doc.id ?? "Document";
    return text.split(/\r?\n/).slice(0, 5).join(" ").slice(0, 400);
  }

  private async findLatestLocalDoc(docType: string): Promise<DocdexDocument | undefined> {
    const candidates: { path: string; mtime: number }[] = [];
    const dirNames = [".mcoda/docs", "docs"];
    for (const dir of dirNames) {
      const target = path.join(this.workspace.workspaceRoot, dir, docType.toLowerCase());
      try {
        const entries = await fs.readdir(target);
        for (const entry of entries.filter((e) => e.endsWith(".md"))) {
          const full = path.join(target, entry);
          const stat = await fs.stat(full);
          candidates.push({ path: full, mtime: stat.mtimeMs });
        }
      } catch {
        // ignore
      }
    }
    const latest = candidates.sort((a, b) => b.mtime - a.mtime)[0];
    if (!latest) return undefined;
    const content = await fs.readFile(latest.path, "utf8");
    const timestamp = new Date(latest.mtime).toISOString();
    return {
      id: `local-${docType.toLowerCase()}-${path.basename(latest.path)}`,
      docType,
      path: latest.path,
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private formatBlock(doc: DocdexDocument, label: string, priority: number, maxSegments = 5): ContextBlock {
    const segments = (doc.segments ?? []).slice(0, maxSegments);
    const heading = `[${doc.docType}] ${label}`;
    const source = doc.path ?? doc.id ?? label;
    const body = segments.length
      ? segments
          .map((seg, idx) => {
            const head = seg.heading ?? `Segment ${idx + 1}`;
            const trimmed = seg.content.length > 1000 ? `${seg.content.slice(0, 1000)}...` : seg.content;
            return `### ${head}\n${trimmed}`;
          })
          .join("\n\n")
      : doc.content ?? this.summarize(doc);
    const content = [heading, `Source: ${source}`, body].filter(Boolean).join("\n");
    return {
      label,
      content,
      priority,
      tokens: estimateTokens(content),
    };
  }

  private enforceBudget(blocks: ContextBlock[], warnings: string[]): ContextBlock[] {
    let total = blocks.reduce((sum, b) => sum + b.tokens, 0);
    if (total <= CONTEXT_TOKEN_BUDGET) return blocks;
    const ordered = [...blocks].sort((a, b) => a.priority - b.priority);
    for (const block of ordered) {
      if (total <= CONTEXT_TOKEN_BUDGET) break;
      const summary = `${block.label}: ${block.content.slice(0, 400)}`;
      total -= block.tokens;
      block.content = summary;
      block.tokens = estimateTokens(summary);
      total += block.tokens;
      warnings.push(`Context for ${block.label} truncated to fit budget.`);
    }
    return blocks;
  }

  async build(): Promise<OpenapiContext> {
    const warnings: string[] = [];
    const blocks: ContextBlock[] = [];
    let docdexAvailable = true;
    try {
      const [sdsDocs, pdrDocs, rfpDocs, openapiDocs, schemaDocs] = await Promise.all([
        this.docdex.search({ docType: "SDS", profile: "openapi" }),
        this.docdex.search({ docType: "PDR", profile: "openapi" }),
        this.docdex.search({ docType: "RFP", profile: "openapi" }),
        this.docdex.search({ docType: "OPENAPI", profile: "openapi" }),
        this.docdex.search({ docType: "Architecture", profile: "openapi" }),
      ]);
      if (sdsDocs.length > 0) {
        blocks.push(this.formatBlock(sdsDocs[0], "SDS OpenAPI contract", 1, 8));
      }
      if (pdrDocs.length > 0) {
        blocks.push(this.formatBlock(pdrDocs[0], "PDR context", 2, 6));
      }
      if (rfpDocs.length > 0) {
        blocks.push(this.formatBlock(rfpDocs[0], "RFP alignment", 2, 6));
      }
      if (openapiDocs.length > 0) {
        blocks.push(this.formatBlock(openapiDocs[0], "Existing OpenAPI docdex", 1, 6));
      }
      if (schemaDocs.length > 0) {
        blocks.push(this.formatBlock(schemaDocs[0], "Data model & persistence", 1, 6));
      }
    } catch (error) {
      docdexAvailable = false;
      warnings.push(
        `Docdex unavailable; falling back to local docs for OpenAPI context (${(error as Error).message ?? "unknown"})`,
      );
    }

    if (!blocks.length) {
      const localSds = await this.findLatestLocalDoc("SDS");
      if (localSds) blocks.push(this.formatBlock(localSds, "Local SDS", 1, 6));
      const localPdr = await this.findLatestLocalDoc("PDR");
      if (localPdr) blocks.push(this.formatBlock(localPdr, "Local PDR", 2, 6));
    }
    return {
      blocks: this.enforceBudget(blocks, warnings),
      docdexAvailable,
      warnings,
    };
  }
}

export class OpenApiService {
  private docdex: DocdexClient;
  private jobService: JobService;
  private agentService: AgentService;
  private repo: GlobalRepository;
  private workspace: WorkspaceResolution;

  constructor(workspace: WorkspaceResolution, deps: { docdex?: DocdexClient; jobService?: JobService; agentService: AgentService; repo: GlobalRepository }) {
    this.workspace = workspace;
    this.docdex = deps?.docdex ?? new DocdexClient({ workspaceRoot: workspace.workspaceRoot });
    this.jobService = deps?.jobService ?? new JobService(workspace.workspaceRoot);
    this.agentService = deps.agentService;
    this.repo = deps.repo;
  }

  static async create(workspace: WorkspaceResolution): Promise<OpenApiService> {
    const repo = await GlobalRepository.create();
    const agentService = new AgentService(repo);
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
    });
    const jobService = new JobService(workspace.workspaceRoot);
    return new OpenApiService(workspace, { repo, agentService, docdex, jobService });
  }

  async close(): Promise<void> {
    if ((this.agentService as any).close) await this.agentService.close();
    if ((this.repo as any).close) await this.repo.close();
    if ((this.jobService as any).close) await this.jobService.close();
  }

  private async resolveAgent(agentName?: string): Promise<Agent> {
    const required = ["docdex_query", "doc_generation"];
    if (agentName) {
      const agent = await this.agentService.resolveAgent(agentName);
      const capabilities = await this.agentService.getCapabilities(agent.id);
      for (const cap of required) {
        if (!capabilities.includes(cap)) {
          throw new Error(`Agent ${agent.slug} missing required capability ${cap}`);
        }
      }
      return agent;
    }
    const defaults = await this.repo.getWorkspaceDefaults(this.workspace.workspaceId);
    const preferred =
      defaults.find((d) => ["openapi-from-docs", "openapi_from_docs", "openapi"].includes(d.commandName)) ??
      defaults.find((d) => d.commandName === "default");
    if (preferred) {
      return this.agentService.resolveAgent(preferred.agentId);
    }
    const agents = await this.repo.listAgents();
    for (const agent of agents) {
      const caps = await this.repo.getAgentCapabilities(agent.id);
      if (required.every((cap) => caps.includes(cap))) {
        return agent;
      }
    }
    throw new Error("No agent configured with docdex_query capability. Create or update an agent first.");
  }

  private async invokeAgent(
    agent: Agent,
    prompt: string,
    stream: boolean,
    jobId: string,
    onToken?: (token: string) => void,
  ): Promise<{ output: string; adapter: string; metadata?: Record<string, unknown> }> {
    if (stream) {
      try {
        const generator = await this.agentService.invokeStream(agent.id, { input: prompt, metadata: { jobId } });
        const chunks: string[] = [];
        for await (const chunk of generator) {
          chunks.push(chunk.output);
          await this.jobService.appendLog(jobId, chunk.output);
          if (onToken) onToken(chunk.output);
        }
        return { output: chunks.join(""), adapter: agent.adapter };
      } catch {
        const fallback = await this.agentService.invoke(agent.id, { input: prompt, metadata: { jobId } });
        await this.jobService.appendLog(jobId, fallback.output);
        if (onToken) onToken(fallback.output);
        return { output: fallback.output, adapter: fallback.adapter, metadata: fallback.metadata };
      }
    }
    const result = await this.agentService.invoke(agent.id, { input: prompt, metadata: { jobId } });
    await this.jobService.appendLog(jobId, result.output);
    if (onToken) onToken(result.output);
    return { output: result.output, adapter: result.adapter, metadata: result.metadata };
  }

  private sanitizeOutput(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      const withoutFence = trimmed.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```$/, "");
      return withoutFence.trim();
    }
    return trimmed;
  }

  private validateSpec(doc: any): string[] {
    const errors: string[] = [];
    if (!doc || typeof doc !== "object") {
      errors.push("Spec is not a YAML object.");
      return errors;
    }
    if (!doc.openapi) errors.push("Missing openapi version");
    if (!doc.info?.title) errors.push("Missing info.title");
    if (!doc.info?.version) errors.push("Missing info.version");
    if (!doc.paths || Object.keys(doc.paths).length === 0) errors.push("paths section is required");
    const schemas = doc.components?.schemas;
    if (!schemas) {
      errors.push("components.schemas section is required");
    } else {
      for (const name of REQUIRED_SCHEMAS) {
        if (!schemas[name]) errors.push(`Missing schema: ${name}`);
      }
    }
    return errors;
  }

  private async runOpenapiValidator(doc: any): Promise<string[]> {
    try {
      await SwaggerParser.validate(doc as any);
      return [];
    } catch (error) {
      const details = (error as any)?.details as { message?: string }[] | undefined;
      if (Array.isArray(details) && details.length) {
        return details.map((d) => d.message ?? String(error));
      }
      return [(error as Error).message];
    }
  }

  private buildPrompt(context: OpenapiContext, cliVersion: string, retryReasons?: string[]): string {
    const commands = [
      "create-tasks",
      "refine-tasks",
      "work-on-tasks",
      "code-review",
      "qa-tasks",
      "backlog",
      "estimate",
      "task-detail",
      "order-tasks",
      "agent",
      "test-agent",
      "routing",
      "tokens",
      "telemetry",
      "job",
      "update",
      "openapi-from-docs",
    ];
    const tagList = OPENAPI_TAGS.map((t) => `- ${t}`).join("\n");
    const requiredSchemas = REQUIRED_SCHEMAS.map((s) => `- ${s}`).join("\n");
    const contextBlocks = context.blocks
      .map((block) => `### ${block.label}\n${block.content}`)
      .join("\n\n");
    const retryNote = retryReasons?.length
      ? `\nPrevious attempt issues:\n${retryReasons.map((r) => `- ${r}`).join("\n")}\nFix them in this draft.\n`
      : "";
    return [
      "You are the mcoda OpenAPI editor. Generate a complete OpenAPI YAML (`openapi/mcoda.yaml`) for the mcoda CLI and system.",
      `Use OpenAPI version ${OPENAPI_VERSION}, info.title "mcoda API", and info.version ${cliVersion}.`,
      "Return only valid YAML (no Markdown fences, no commentary).",
      retryNote,
      "Required tags (attach appropriately):",
      tagList,
      "Required schemas:",
      requiredSchemas,
      "Required vendor extensions: include x-mcoda-cli.name, x-mcoda-cli.output-shape, x-mcoda-db-table where applicable, x-mcoda-job-type for job-creating endpoints, x-mcoda-agent-roles, x-mcoda-prompts, x-mcoda-tools, x-mcoda-docdex-profile.",
      "Core operation groups to model:",
      "- Agents: CRUD + test-agent endpoints for global agents",
      "- Routing: workspace defaults (get/put) and routing preview",
      "- Tasks/Backlog/Estimate: task detail/comments, backlog listing, estimation over token_usage/command_runs",
      "- Planning pipeline: create-tasks, refine-tasks, work-on-tasks, code-review, qa-tasks (job-creating)",
      "- Dependency ordering: order tasks for a workspace",
      "- Jobs & telemetry: job listing/status/resume and telemetry/token usage views",
      "- Docdex/Config/System: minimal stubs reflecting CLI and SDS expectations",
      "CLI commands known to the system:",
      commands.map((c) => `- ${c}`).join("\n"),
      "mcoda-specific expectations:",
      "- Align data shapes with mcoda DB tables when possible.",
      "- Use x-mcoda-db-table on schemas that map directly to DB tables (tasks, epics, user_stories, jobs, command_runs, task_runs, task_comments, token_usage, task_logs, agents, routing_defaults, etc.).",
      "- Use x-mcoda-cli.name and x-mcoda-job-type to map endpoints back to mcoda commands and job engine types (create_tasks, task_refinement, work, review, qa, openapi_change).",
      "- Include x-mcoda-tools (e.g., docdex, vcs, qa_runner) and x-mcoda-docdex-profile (e.g., sds, pdr, workspace-code) where appropriate.",
      "Context from SDS/PDR/docdex and existing specs:",
      contextBlocks || "No context available; synthesize from SDS expectations.",
    ].join("\n\n");
  }

  private async ensureOpenapiDir(): Promise<string> {
    const dir = path.join(this.workspace.workspaceRoot, "openapi");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async backupIfNeeded(target: string): Promise<string | undefined> {
    if (!(await fileExists(target))) return undefined;
    const backup = `${target}.bak`;
    await fs.copyFile(target, backup);
    return backup;
  }

  private async registerOpenapi(outPath: string, content: string): Promise<DocdexDocument> {
    const branch = this.workspace.config?.branch ?? (await readGitBranch(this.workspace.workspaceRoot));
    return this.docdex.registerDocument({
      docType: "OPENAPI",
      path: outPath,
      content,
      metadata: {
        workspace: this.workspace.workspaceId,
        branch,
        status: "canonical",
      },
    });
  }

  private async validateExistingSpec(target: string): Promise<{ spec: string; issues: string[] }> {
    const content = await fs.readFile(target, "utf8");
    const parsed = YAML.parse(content);
    const issues = this.validateSpec(parsed);
    const validatorIssues = await this.runOpenapiValidator(parsed);
    issues.push(...validatorIssues);
    return { spec: content, issues };
  }

  async generateFromDocs(options: GenerateOpenapiOptions): Promise<GenerateOpenapiResult> {
    const commandRun = await this.jobService.startCommandRun("openapi-from-docs", undefined);
    const job = await this.jobService.startJob("openapi_change", commandRun.id, undefined, {
      commandName: commandRun.commandName,
      payload: { workspaceRoot: this.workspace.workspaceRoot },
    });
    const warnings: string[] = [];
    try {
      const assembler = new OpenapiContextAssembler(this.docdex, this.workspace);
      const context = await assembler.build();
      warnings.push(...context.warnings);
      await this.jobService.writeCheckpoint(job.id, {
        stage: "context_built",
        timestamp: new Date().toISOString(),
        details: { docdexAvailable: context.docdexAvailable },
      });
      await this.jobService.recordTokenUsage({
        timestamp: new Date().toISOString(),
        workspaceId: this.workspace.workspaceId,
        commandName: "openapi-from-docs",
        jobId: job.id,
        action: "docdex_context",
        promptTokens: 0,
        completionTokens: 0,
        metadata: { docdexAvailable: context.docdexAvailable },
      });

      const openapiDir = await this.ensureOpenapiDir();
      const outputPath = path.join(openapiDir, "mcoda.yaml");
      if (options.validateOnly) {
        if (!(await fileExists(outputPath))) {
          throw new Error(`Cannot validate missing spec: ${outputPath}`);
        }
        const { spec, issues } = await this.validateExistingSpec(outputPath);
        const validationNote = issues.length ? `Validation issues:\n${issues.join("\n")}` : "Validation passed.";
        await this.jobService.appendLog(job.id, `${validationNote}\n`);
        const jobState = issues.length ? "failed" : "completed";
        const commandState = issues.length ? "failed" : "succeeded";
        await this.jobService.updateJobStatus(job.id, jobState, { payload: { validation: validationNote } });
        await this.jobService.finishCommandRun(commandRun.id, commandState, issues.join("; "));
        return {
          jobId: job.id,
          commandRunId: commandRun.id,
          outputPath,
          spec,
          warnings,
        };
      }

      if (!options.force && (await fileExists(outputPath))) {
        throw new Error(`File exists, use --force to overwrite (${outputPath})`);
      }

      const agent = await this.resolveAgent(options.agentName);
      const stream = options.agentStream ?? true;

      let specYaml = "";
      let parsed: any;
      let adapter = agent.adapter;
      let agentMetadata: Record<string, unknown> | undefined;
      let lastErrors: string[] | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prompt = this.buildPrompt(context, options.cliVersion, lastErrors);
        const { output, adapter: usedAdapter, metadata } = await this.invokeAgent(
          agent,
          prompt,
          stream,
          job.id,
          options.onToken,
        );
        adapter = usedAdapter;
        agentMetadata = metadata;
        specYaml = this.sanitizeOutput(output);
        try {
          parsed = YAML.parse(specYaml);
          if (!parsed.info) parsed.info = {};
          parsed.info.title = parsed.info.title ?? "mcoda API";
          parsed.info.version = options.cliVersion;
          parsed.openapi = parsed.openapi ?? OPENAPI_VERSION;
          const errors = this.validateSpec(parsed);
          const validatorErrors = await this.runOpenapiValidator(parsed);
          errors.push(...validatorErrors);
          await this.jobService.recordTokenUsage({
            timestamp: new Date().toISOString(),
            workspaceId: this.workspace.workspaceId,
            commandName: "openapi-from-docs",
            jobId: job.id,
            agentId: agent.id,
            modelName: agent.defaultModel,
            action: attempt === 0 ? "draft_openapi" : "draft_openapi_retry",
            promptTokens: estimateTokens(prompt),
            completionTokens: estimateTokens(output),
            metadata: { adapter, provider: adapter, attempt },
          });
          if (errors.length === 0) {
            specYaml = YAML.stringify(parsed);
            break;
          }
          if (attempt === 1) {
            throw new Error(`Generated spec failed validation: ${errors.join("; ")}`);
          }
          lastErrors = errors;
        } catch (error) {
          if (attempt === 1) {
            throw new Error((error as Error).message || "Failed to parse generated YAML");
          }
          lastErrors = [(error as Error).message ?? "Invalid YAML"];
        }
      }

      let backup: string | undefined;
      if (!options.dryRun) {
        backup = await this.backupIfNeeded(outputPath);
        await fs.writeFile(outputPath, specYaml, "utf8");
      } else {
        warnings.push("Dry run enabled; spec not written to disk.");
      }

      let docdexId: string | undefined;
      if (!options.dryRun && context.docdexAvailable) {
        try {
          const registered = await this.registerOpenapi(outputPath, specYaml);
          docdexId = registered.id;
        } catch (error) {
          warnings.push(`Failed to register OpenAPI in docdex: ${(error as Error).message}`);
        }
      }

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: {
          outputPath,
          backupPath: backup,
          docdexId,
          adapter,
          agentMetadata,
        },
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");
      return {
        jobId: job.id,
        commandRunId: commandRun.id,
        outputPath: options.dryRun ? undefined : outputPath,
        spec: specYaml,
        docdexId,
        warnings,
      };
    } catch (error) {
      await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: (error as Error).message });
      await this.jobService.finishCommandRun(commandRun.id, "failed", (error as Error).message);
      throw error;
    }
  }
}
