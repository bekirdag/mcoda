import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import SwaggerParser from "@apidevtools/swagger-parser";
import { AgentService } from "@mcoda/agents";
import { DocdexClient, DocdexDocument } from "@mcoda/integrations";
import { GlobalRepository, WorkspaceRepository } from "@mcoda/db";
import { Agent } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService, type JobRecord, type JobState } from "../jobs/JobService.js";
import { RoutingService } from "../agents/RoutingService.js";
import { AgentRatingService } from "../agents/AgentRatingService.js";
import { buildDocInventory } from "../docs/DocInventory.js";
import type { DocArtifactRecord } from "../docs/DocgenRunContext.js";

export interface GenerateOpenapiOptions {
  workspace: WorkspaceResolution;
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  force?: boolean;
  dryRun?: boolean;
  validateOnly?: boolean;
  cliVersion: string;
  onToken?: (token: string) => void;
  projectKey?: string;
  resumeJobId?: string;
  timeoutMs?: number;
  iteration?: { current: number; max?: number };
}

export interface GenerateOpenapiResult {
  jobId: string;
  commandRunId: string;
  outputPath?: string;
  spec: string;
  adminOutputPath?: string;
  adminSpec?: string;
  docdexId?: string;
  adminDocdexId?: string;
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
  // For project-specific specs, tags come from context; this is only a fallback.
];

const OPENAPI_VERSION = "3.1.0";
const PRIMARY_OPENAPI_FILENAME = "mcoda.yaml";
const ADMIN_OPENAPI_FILENAME = "mcoda-admin.yaml";
const CONTEXT_TOKEN_BUDGET = 8000;
const OPENAPI_TIMEOUT_ENV = "MCODA_OPENAPI_TIMEOUT_SECONDS";
const OPENAPI_HEARTBEAT_INTERVAL_MS = 15000;
const OPENAPI_PRIMARY_DRAFT = "openapi-primary-draft.yaml";
const OPENAPI_ADMIN_DRAFT = "openapi-admin-draft.yaml";

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));
const parseTimeoutSeconds = (value?: string): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed * 1000;
};
const formatIterationLabel = (iteration?: { current: number; max?: number }): string | undefined => {
  if (!iteration || !Number.isFinite(iteration.current)) return undefined;
  const current = iteration.current;
  const max = iteration.max;
  if (Number.isFinite(max) && (max as number) > 0) return `${current}/${max}`;
  return `${current}`;
};
const compactPayload = (payload: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));

export class OpenApiJobError extends Error {
  code: string;
  jobId?: string;

  constructor(code: string, message: string, jobId?: string) {
    super(message);
    this.code = code;
    this.jobId = jobId;
  }
}

interface OpenapiResumeState {
  job: JobRecord;
  completed: boolean;
  outputPath?: string;
  adminOutputPath?: string;
  spec?: string;
  adminSpec?: string;
  primaryDraft?: string;
  adminDraft?: string;
  docdexId?: string;
  adminDocdexId?: string;
  lastStage?: string;
}

export const normalizeOpenApiPath = (value: string): string => {
  if (!value) return "/";
  const trimmed = value.trim();
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailing = withLeading.length > 1 ? withLeading.replace(/\/+$/, "") : withLeading;
  const segments = withoutTrailing
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith("{") && segment.endsWith("}")) return "{param}";
      return segment;
    });
  return segments.length ? `/${segments.join("/")}` : "/";
};

export const extractOpenApiPaths = (raw: string): { paths: string[]; errors: string[] } => {
  const errors: string[] = [];
  if (!raw || !raw.trim()) {
    return { paths: [], errors: ["OpenAPI spec is empty."] };
  }
  let parsed: any;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    return { paths: [], errors: [`OpenAPI parse failed: ${(error as Error).message}`] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { paths: [], errors: ["OpenAPI spec is not a YAML object."] };
  }
  const paths = parsed.paths;
  if (!paths || typeof paths !== "object") {
    return { paths: [], errors: ["OpenAPI spec missing paths section."] };
  }
  return { paths: Object.keys(paths).filter(Boolean), errors };
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const findOpenApiPathLine = (raw: string, target: string): number | undefined => {
  if (!raw || !target) return undefined;
  const lines = raw.split(/\r?\n/);
  const escaped = escapeRegExp(target);
  const pattern = new RegExp(`^\\s*['"]?${escaped}['"]?\\s*:`);
  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i] ?? "")) return i + 1;
  }
  return undefined;
};

const ADMIN_PATH_PATTERN = /\/admin(?:\/|\b)/i;
const ADMIN_CONTEXT_PATTERN =
  /\badmin\b.*\b(api|endpoint|console|dashboard|portal|interface|panel|ui)\b/i;

export interface AdminSurfaceMention {
  line: number;
  excerpt: string;
  heading?: string;
}

export const findAdminSurfaceMentions = (raw: string): AdminSurfaceMention[] => {
  if (!raw || !raw.trim()) return [];
  const lines = raw.split(/\r?\n/);
  const mentions: AdminSurfaceMention[] = [];
  const seen = new Set<number>();
  let inFence = false;
  let currentHeading: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^```|^~~~/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headingMatch = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (headingMatch) {
      currentHeading = headingMatch[1]?.trim() || undefined;
      if (currentHeading && /\badmin\b/i.test(currentHeading)) {
        if (!seen.has(i + 1)) {
          mentions.push({ line: i + 1, excerpt: currentHeading, heading: currentHeading });
          seen.add(i + 1);
        }
      }
      continue;
    }

    if (ADMIN_PATH_PATTERN.test(trimmed) || ADMIN_CONTEXT_PATTERN.test(trimmed)) {
      if (!seen.has(i + 1)) {
        mentions.push({ line: i + 1, excerpt: trimmed, heading: currentHeading });
        seen.add(i + 1);
      }
    }
  }

  return mentions;
};

export interface OpenApiSchemaValidationResult {
  doc?: any;
  errors: string[];
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const operationUsesJsonSchema = (operation: Record<string, any>): boolean => {
  const contentBlocks: Array<Record<string, any>> = [];
  const requestContent = operation.requestBody?.content;
  if (isPlainObject(requestContent)) contentBlocks.push(requestContent as Record<string, any>);
  const responses = operation.responses;
  if (isPlainObject(responses)) {
    for (const response of Object.values(responses)) {
      const responseContent = (response as any)?.content;
      if (isPlainObject(responseContent)) contentBlocks.push(responseContent as Record<string, any>);
    }
  }
  for (const content of contentBlocks) {
    for (const [contentType, media] of Object.entries(content)) {
      if (!contentType.toLowerCase().includes("json")) continue;
      if ((media as any)?.schema) return true;
    }
  }
  return false;
};

export const validateOpenApiSchema = (doc: any): string[] => {
  const errors: string[] = [];
  if (!isPlainObject(doc)) {
    errors.push("OpenAPI spec is not an object.");
    return errors;
  }

  const version = doc.openapi;
  if (!version) {
    errors.push("Missing openapi version.");
  } else if (typeof version !== "string" || !version.startsWith("3.")) {
    errors.push(`Invalid openapi version: ${String(version)}.`);
  }

  const info = doc.info;
  if (!isPlainObject(info)) {
    errors.push("Missing info section.");
  } else {
    if (!info.title) errors.push("Missing info.title.");
    if (!info.version) errors.push("Missing info.version.");
  }

  const paths = doc.paths;
  if (!isPlainObject(paths)) {
    errors.push("Missing paths section.");
  } else if (Object.keys(paths).length === 0) {
    errors.push("paths section is empty.");
  }

  const operationIds = new Map<string, string>();
  let hasOperations = false;
  let hasJsonSchemaUsage = false;
  if (isPlainObject(paths)) {
    for (const [pathKey, pathItem] of Object.entries(paths)) {
      if (!isPlainObject(pathItem)) {
        errors.push(`Path item for ${pathKey} must be an object.`);
        continue;
      }
      const methods = HTTP_METHODS.filter((method) => method in pathItem);
      if (methods.length === 0) {
        errors.push(`Path ${pathKey} has no operations.`);
        continue;
      }
      for (const method of methods) {
        const operation = (pathItem as any)[method];
        if (!isPlainObject(operation)) {
          errors.push(`Operation ${method.toUpperCase()} ${pathKey} must be an object.`);
          continue;
        }
        hasOperations = true;
        if (operationUsesJsonSchema(operation)) {
          hasJsonSchemaUsage = true;
        }
        const operationId = operation.operationId;
        if (!operationId || typeof operationId !== "string") {
          errors.push(`Missing operationId for ${method.toUpperCase()} ${pathKey}.`);
        } else if (/\s/.test(operationId) || !OPERATION_ID_PATTERN.test(operationId)) {
          errors.push(`Invalid operationId "${operationId}" for ${method.toUpperCase()} ${pathKey}.`);
        } else if (operationIds.has(operationId)) {
          errors.push(`Duplicate operationId "${operationId}" detected.`);
        } else {
          operationIds.set(operationId, `${method.toUpperCase()} ${pathKey}`);
        }
      }
    }
  }

  const components = (doc as any).components;
  const schemas = isPlainObject(components) ? (components as any).schemas : undefined;
  const schemaCount = isPlainObject(schemas) ? Object.keys(schemas).length : 0;
  const hasSchemaRefs =
    typeof doc === "object" && JSON.stringify(doc).includes("#/components/schemas/");
  if ((hasJsonSchemaUsage || hasSchemaRefs || hasOperations) && schemaCount === 0) {
    errors.push("Missing components.schemas for JSON payloads.");
  }

  return errors;
};

export const validateOpenApiSchemaContent = (raw: string): OpenApiSchemaValidationResult => {
  if (!raw || !raw.trim()) {
    return { errors: ["OpenAPI spec is empty."] };
  }
  let parsed: any;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    try {
      parsed = JSON.parse(raw);
    } catch (jsonError) {
      return {
        errors: [
          `OpenAPI parse failed: ${(error as Error).message ?? String(error)}`,
        ],
      };
    }
  }
  const errors = validateOpenApiSchema(parsed);
  return { doc: parsed, errors };
};

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
  constructor(private docdex: DocdexClient, private workspace: WorkspaceResolution, private projectKey?: string) {}

  private summarize(doc: DocdexDocument): string {
    const text = doc.content ?? "";
    if (!text) return doc.title ?? doc.path ?? doc.id ?? "Document";
    return text.split(/\r?\n/).slice(0, 5).join(" ").slice(0, 400);
  }

  private async findLatestLocalDoc(docType: string): Promise<DocdexDocument | undefined> {
    const candidates: { path: string; mtime: number }[] = [];
    const docDirs = [
      path.join(this.workspace.mcodaDir, "docs"),
      path.join(this.workspace.workspaceRoot, "docs"),
    ];
    for (const dir of docDirs) {
      const target = path.join(dir, docType.toLowerCase());
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
    let sdsDocs: DocdexDocument[] = [];
    let pdrDocs: DocdexDocument[] = [];
    let rfpDocs: DocdexDocument[] = [];
    let openapiDocs: DocdexDocument[] = [];
    let schemaDocs: DocdexDocument[] = [];
    try {
      [sdsDocs, pdrDocs, rfpDocs, openapiDocs, schemaDocs] = await Promise.all([
        this.docdex.search({ docType: "SDS", profile: "openapi", projectKey: this.projectKey }),
        this.docdex.search({ docType: "PDR", profile: "openapi", projectKey: this.projectKey }),
        this.docdex.search({ docType: "RFP", profile: "openapi", projectKey: this.projectKey }),
        this.docdex.search({ docType: "OPENAPI", profile: "openapi", projectKey: this.projectKey }),
        this.docdex.search({ docType: "Architecture", profile: "openapi", projectKey: this.projectKey }),
      ]);
    } catch (error) {
      docdexAvailable = false;
      warnings.push(
        `Docdex unavailable; falling back to local docs for OpenAPI context (${(error as Error).message ?? "unknown"})`,
      );
    }
    // Fallbacks when docdex returns no hits
    if (sdsDocs.length === 0) {
      const local = await this.findLatestLocalDoc("SDS");
      if (local) {
        blocks.push(this.formatBlock(local, "Local SDS (no docdex)", 1, 8));
        warnings.push("No SDS found in docdex; using latest local SDS file.");
        sdsDocs = [local];
      } else {
        warnings.push("No SDS found in docdex or local workspace.");
      }
    } else {
      blocks.push(this.formatBlock(sdsDocs[0], "SDS OpenAPI contract", 1, 8));
    }
    if (pdrDocs.length === 0) {
      const local = await this.findLatestLocalDoc("PDR");
      if (local) {
        blocks.push(this.formatBlock(local, "Local PDR (no docdex)", 2, 6));
        warnings.push("No PDR found in docdex; using latest local PDR file.");
        pdrDocs = [local];
      } else {
        warnings.push("No PDR found in docdex or local workspace.");
      }
    } else {
      blocks.push(this.formatBlock(pdrDocs[0], "PDR context", 2, 6));
    }
    if (rfpDocs.length === 0) {
      const local = await this.findLatestLocalDoc("RFP");
      if (local) {
        blocks.push(this.formatBlock(local, "Local RFP (no docdex)", 2, 6));
        warnings.push("No RFP found in docdex; using latest local RFP file.");
        rfpDocs = [local];
      } else {
        warnings.push("No RFP found in docdex or local workspace.");
      }
    } else {
      blocks.push(this.formatBlock(rfpDocs[0], "RFP alignment", 2, 6));
    }
    if (openapiDocs.length > 0) {
      blocks.push(this.formatBlock(openapiDocs[0], "Existing OpenAPI docdex", 1, 6));
    }
    if (schemaDocs.length > 0) {
      blocks.push(this.formatBlock(schemaDocs[0], "Data model & persistence", 1, 6));
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
  private routingService: RoutingService;
  private workspace: WorkspaceResolution;
  private repo?: GlobalRepository;
  private ratingService?: AgentRatingService;
  private workspaceRepo?: WorkspaceRepository;

  constructor(
    workspace: WorkspaceResolution,
    deps: {
      docdex?: DocdexClient;
      jobService?: JobService;
      agentService: AgentService;
      routingService: RoutingService;
      repo?: GlobalRepository;
      workspaceRepo?: WorkspaceRepository;
      ratingService?: AgentRatingService;
      noTelemetry?: boolean;
    },
  ) {
    this.workspace = workspace;
    const docdexRepoId =
      workspace.config?.docdexRepoId ?? process.env.MCODA_DOCDEX_REPO_ID ?? process.env.DOCDEX_REPO_ID;
    this.docdex = deps?.docdex ?? new DocdexClient({ workspaceRoot: workspace.workspaceRoot, repoId: docdexRepoId });
    this.jobService = deps?.jobService ?? new JobService(workspace, undefined, { noTelemetry: deps?.noTelemetry });
    this.agentService = deps.agentService;
    this.routingService = deps.routingService;
    this.repo = deps.repo;
    this.workspaceRepo = deps.workspaceRepo;
    this.ratingService = deps.ratingService;
  }

  static async create(workspace: WorkspaceResolution, options: { noTelemetry?: boolean } = {}): Promise<OpenApiService> {
    const repo = await GlobalRepository.create();
    const agentService = new AgentService(repo);
    const routingService = await RoutingService.create();
    const docdexRepoId =
      workspace.config?.docdexRepoId ?? process.env.MCODA_DOCDEX_REPO_ID ?? process.env.DOCDEX_REPO_ID;
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
      repoId: docdexRepoId,
    });
    const jobService = new JobService(workspace, undefined, { noTelemetry: options.noTelemetry });
    return new OpenApiService(workspace, { agentService, routingService, docdex, jobService, repo, noTelemetry: options.noTelemetry });
  }

  async close(): Promise<void> {
    const swallow = async (fn?: () => Promise<void>) => {
      try {
        if (fn) await fn();
      } catch {
        // Best-effort close; ignore errors (including "database is closed").
      }
    };
    await swallow((this.agentService as any).close?.bind(this.agentService));
    await swallow((this.jobService as any).close?.bind(this.jobService));
    await swallow((this.repo as any)?.close?.bind(this.repo));
    await swallow((this.workspaceRepo as any)?.close?.bind(this.workspaceRepo));
  }

  private async resolveAgent(agentName?: string): Promise<Agent> {
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: "openapi-from-docs",
      overrideAgentSlug: agentName,
    });
    return resolved.agent;
  }

  private async ensureRatingService(): Promise<AgentRatingService> {
    if (this.ratingService) return this.ratingService;
    if (process.env.MCODA_DISABLE_DB === "1") {
      throw new Error("Workspace DB disabled; agent rating requires DB access.");
    }
    if (!this.workspaceRepo) {
      this.workspaceRepo = await WorkspaceRepository.create(this.workspace.workspaceRoot);
    }
    if (!this.repo) {
      this.repo = await GlobalRepository.create();
    }
    this.ratingService = new AgentRatingService(this.workspace, {
      workspaceRepo: this.workspaceRepo,
      globalRepo: this.repo,
      agentService: this.agentService,
      routingService: this.routingService,
    });
    return this.ratingService;
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
    let body = trimmed;
    if (body.startsWith("```")) {
      body = body.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```$/, "");
    }
    const openapiIndex = body.search(/^openapi:\s*\d/m);
    if (openapiIndex > 0) {
      body = body.slice(openapiIndex);
    }
    return body.trim();
  }

  private validateSpec(doc: any): string[] {
    return validateOpenApiSchema(doc);
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

  private buildPrompt(
    context: OpenapiContext,
    cliVersion: string,
    retryReasons: string[] | undefined,
    variant: "primary" | "admin" = "primary",
  ): string {
    const contextBlocks = context.blocks
      .map((block) => `### ${block.label}\n${block.content}`)
      .join("\n\n");
    const retryNote = retryReasons?.length
      ? `\nPrevious attempt issues:\n${retryReasons.map((r) => `- ${r}`).join("\n")}\nFix them in this draft.\n`
      : "";
    const adminNote =
      variant === "admin"
        ? [
            "This is the ADMIN OpenAPI spec. Include only administrative/control-plane endpoints.",
            "Focus on admin consoles, moderation, user management, and internal admin workflows described in docs.",
            "Prefer /admin or /internal/admin style prefixes; omit public/customer-facing APIs.",
          ].join("\n")
        : "";
    return [
      "You are generating an OpenAPI 3.1 YAML for THIS workspace/project using only the provided PDR/SDS/RFP context.",
      "Derive resources, schemas, and HTTP endpoints directly from the product requirements (e.g., todos CRUD, filters, search, bulk actions).",
      "If the documents describe a frontend-only/localStorage app, design a minimal REST API that could back those features (e.g., /todos, /todos/{id}, bulk operations, search/filter params) instead of returning an empty spec.",
      "Prefer concise tags derived from domain resources (e.g., Todos). Avoid generic mcoda/system endpoints unless explicitly described in the context.",
      `Use OpenAPI version ${OPENAPI_VERSION}, set info.title to the project name from context (fallback \"mcoda API\"), and info.version ${cliVersion}.`,
      adminNote,
      "Return only valid YAML (no Markdown fences, no commentary).",
      retryNote,
      "Scope rules:",
      "- Derive endpoints, schemas, and tags from the provided PDR/SDS/RFP context only.",
      "- Do NOT emit generic mcoda CLI/system endpoints unless explicitly described.",
      "- Prefer concise schemas and operations that map to described APIs; omit unused boilerplate.",
      "Context:",
      contextBlocks || "No context available; if none, produce a minimal empty spec with paths: {}.",
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

  private async registerOpenapi(
    outPath: string,
    content: string,
    variant: "primary" | "admin" = "primary",
  ): Promise<DocdexDocument> {
    const branch = this.workspace.config?.branch ?? (await readGitBranch(this.workspace.workspaceRoot));
    return this.docdex.registerDocument({
      docType: "OPENAPI",
      path: outPath,
      content,
      metadata: {
        workspace: this.workspace.workspaceId,
        branch,
        status: "canonical",
        projectKey: (this.workspace.config as any)?.projectKey,
        variant,
      },
    });
  }

  private async validateExistingSpec(
    target: string,
  ): Promise<{ spec: string; issues: string[]; doc: any }> {
    const content = await fs.readFile(target, "utf8");
    const parsed = YAML.parse(content);
    const issues = this.validateSpec(parsed);
    const validatorIssues = await this.runOpenapiValidator(parsed);
    issues.push(...validatorIssues);
    return { spec: content, issues, doc: parsed };
  }

  private async collectAdminMentions(): Promise<{
    required: boolean;
    mentions: Array<{ record: DocArtifactRecord; mention: AdminSurfaceMention }>;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    let inventory: Awaited<ReturnType<typeof buildDocInventory>> | undefined;
    try {
      inventory = await buildDocInventory({ workspace: this.workspace });
    } catch (error) {
      warnings.push(`Doc inventory build failed: ${(error as Error).message ?? String(error)}`);
    }
    const records = [inventory?.pdr, inventory?.sds].filter(
      (record): record is DocArtifactRecord => Boolean(record),
    );
    if (records.length === 0) {
      return { required: false, mentions: [], warnings };
    }
    const mentions: Array<{ record: DocArtifactRecord; mention: AdminSurfaceMention }> = [];
    for (const record of records) {
      try {
        const content = await fs.readFile(record.path, "utf8");
        const found = findAdminSurfaceMentions(content);
        for (const mention of found) {
          mentions.push({ record, mention });
        }
      } catch (error) {
        warnings.push(
          `Unable to read doc ${record.path}: ${(error as Error).message ?? String(error)}`,
        );
      }
    }
    return { required: mentions.length > 0, mentions, warnings };
  }

  private openapiDraftPath(jobId: string, variant: "primary" | "admin"): string {
    const filename = variant === "admin" ? OPENAPI_ADMIN_DRAFT : OPENAPI_PRIMARY_DRAFT;
    return path.join(this.workspace.mcodaDir, "jobs", jobId, filename);
  }

  private async readOpenapiDraft(
    jobId: string,
    variant: "primary" | "admin",
    draftPathOverride?: string,
  ): Promise<string | undefined> {
    const draftPath = draftPathOverride ?? this.openapiDraftPath(jobId, variant);
    try {
      return await fs.readFile(draftPath, "utf8");
    } catch {
      return undefined;
    }
  }

  private async writeOpenapiDraft(jobId: string, variant: "primary" | "admin", content: string): Promise<void> {
    const draftPath = this.openapiDraftPath(jobId, variant);
    await fs.mkdir(path.dirname(draftPath), { recursive: true });
    await fs.writeFile(draftPath, content, "utf8");
  }

  private async isJobCancelled(jobId: string): Promise<boolean> {
    const job = await this.jobService.getJob(jobId);
    const state = job?.jobState ?? job?.state;
    return state === "cancelled";
  }

  private async updateOpenapiJobStatus(
    jobId: string,
    state: JobState,
    options: {
      stage?: string;
      variant?: "primary" | "admin";
      iteration?: { current: number; max?: number };
      totalUnits?: number;
      completedUnits?: number;
      payload?: Record<string, unknown>;
      jobStateDetail?: string;
      errorSummary?: string;
    } = {},
  ): Promise<void> {
    const iterationLabel = formatIterationLabel(options.iteration);
    const detail =
      options.jobStateDetail ??
      [
        options.stage ? `openapi:${options.stage}` : undefined,
        options.variant ? `variant:${options.variant}` : undefined,
        iterationLabel ? `iter:${iterationLabel}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    const payload = compactPayload({
      ...options.payload,
      openapi_stage: options.stage,
      openapi_variant: options.variant,
      openapi_iteration_current: options.iteration?.current,
      openapi_iteration_max: options.iteration?.max,
      openapi_iteration_label: iterationLabel,
    });
    const totalItems = options.totalUnits;
    const processedItems = options.completedUnits;
    await this.jobService.updateJobStatus(jobId, state, {
      job_state_detail: detail || undefined,
      totalUnits: options.totalUnits,
      completedUnits: options.completedUnits,
      totalItems,
      processedItems,
      payload,
      errorSummary: options.errorSummary,
    });
  }

  private async writeOpenapiCheckpoint(
    jobId: string,
    stage: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.jobService.writeCheckpoint(jobId, {
      stage,
      timestamp: new Date().toISOString(),
      details,
    });
  }

  private startOpenapiHeartbeat(
    jobId: string,
    getStatus: () => {
      stage?: string;
      variant?: "primary" | "admin";
      iteration?: { current: number; max?: number };
      totalUnits?: number;
      completedUnits?: number;
      payload?: Record<string, unknown>;
    },
  ): { stop: () => void; getError: () => OpenApiJobError | undefined } {
    let stopped = false;
    let error: OpenApiJobError | undefined;
    const interval = setInterval(() => {
      void (async () => {
        if (stopped || error) return;
        if (await this.isJobCancelled(jobId)) {
          error = new OpenApiJobError("cancelled", `OpenAPI job ${jobId} was cancelled.`, jobId);
          return;
        }
        const status = getStatus();
        if (!status.stage) return;
        await this.updateOpenapiJobStatus(jobId, "running", {
          stage: status.stage,
          variant: status.variant,
          iteration: status.iteration,
          totalUnits: status.totalUnits,
          completedUnits: status.completedUnits,
          payload: status.payload,
        });
      })().catch(() => {
        // best-effort heartbeat
      });
    }, OPENAPI_HEARTBEAT_INTERVAL_MS);
    return {
      stop: () => {
        stopped = true;
        clearInterval(interval);
      },
      getError: () => error,
    };
  }

  private async tryResumeOpenapi(
    resumeJobId: string,
    warnings: string[],
  ): Promise<OpenapiResumeState | undefined> {
    const manifest = await this.jobService.readManifest(resumeJobId);
    if (!manifest) {
      warnings.push(`No resume data found for job ${resumeJobId}; starting a new OpenAPI job.`);
      return undefined;
    }
    const manifestType = (manifest as any).type ?? (manifest as any).job_type ?? (manifest as any).jobType;
    if (manifestType && manifestType !== "openapi_change") {
      throw new Error(
        `Job ${resumeJobId} is type ${manifestType}, not openapi_change. Use a matching job id or rerun without --resume.`,
      );
    }
    const status = (manifest as any).status ?? (manifest as any).state ?? (manifest as any).jobState;
    if (status === "running" || status === "queued" || status === "checkpointing") {
      throw new Error(`Job ${resumeJobId} is still running; use "mcoda job watch --id ${resumeJobId}" to monitor.`);
    }
    const payload = (manifest as any).payload ?? {};
    const outputPath =
      (payload as any).outputPath ??
      (payload as any).openapi_primary_output_path ??
      (payload as any).openapi_output_path ??
      (payload as any).output_path;
    const adminOutputPath =
      (payload as any).adminOutputPath ??
      (payload as any).openapi_admin_output_path ??
      (payload as any).admin_output_path;
    const primaryDraftPath =
      (payload as any).openapi_primary_draft_path ?? this.openapiDraftPath(resumeJobId, "primary");
    const adminDraftPath =
      (payload as any).openapi_admin_draft_path ?? this.openapiDraftPath(resumeJobId, "admin");
    let primaryDraft: string | undefined;
    let adminDraft: string | undefined;
    let spec: string | undefined;
    let adminSpec: string | undefined;
    primaryDraft = await this.readOpenapiDraft(resumeJobId, "primary", primaryDraftPath);
    adminDraft = await this.readOpenapiDraft(resumeJobId, "admin", adminDraftPath);
    if (outputPath && (await fileExists(outputPath))) {
      try {
        spec = await fs.readFile(outputPath, "utf8");
      } catch {
        // ignore output read failures
      }
    }
    if (adminOutputPath && (await fileExists(adminOutputPath))) {
      try {
        adminSpec = await fs.readFile(adminOutputPath, "utf8");
      } catch {
        // ignore output read failures
      }
    }
    const docdexId = (payload as any).docdexId ?? (payload as any).openapi_docdex_id ?? (payload as any).docdex_id;
    const adminDocdexId =
      (payload as any).adminDocdexId ?? (payload as any).openapi_admin_docdex_id ?? (payload as any).admin_docdex_id;
    const lastStage = (payload as any).openapi_stage ?? (manifest as any).lastCheckpoint ?? (manifest as any).last_checkpoint;
    const jobId = (manifest as any).id ?? (manifest as any).job_id ?? resumeJobId;

    const outputReady = Boolean(spec || primaryDraft);
    if (status === "completed" || status === "succeeded") {
      if (outputReady) {
        warnings.push(`Resume requested; returning completed OpenAPI from job ${resumeJobId}.`);
        return {
          job: { ...(manifest as any), id: jobId } as JobRecord,
          completed: true,
          outputPath,
          adminOutputPath,
          spec: spec ?? primaryDraft,
          adminSpec: adminSpec ?? adminDraft,
          primaryDraft,
          adminDraft,
          docdexId,
          adminDocdexId,
          lastStage,
        };
      }
      warnings.push(`Resume requested for job ${resumeJobId}, but output is missing; restarting generation.`);
    }

    if (primaryDraft) {
      warnings.push(`Resuming OpenAPI primary draft from job ${resumeJobId}.`);
    } else {
      warnings.push(`Resume requested for ${resumeJobId}; regenerating OpenAPI primary draft.`);
    }
    return {
      job: { ...(manifest as any), id: jobId } as JobRecord,
      completed: false,
      outputPath,
      adminOutputPath,
      spec,
      adminSpec,
      primaryDraft,
      adminDraft,
      docdexId,
      adminDocdexId,
      lastStage,
    };
  }

  async generateFromDocs(options: GenerateOpenapiOptions): Promise<GenerateOpenapiResult> {
    const warnings: string[] = [];
    const commandRun = await this.jobService.startCommandRun("openapi-from-docs", options.projectKey);
    let job: JobRecord | undefined;
    let resumePrimaryDraft: string | undefined;
    let resumeAdminDraft: string | undefined;
    let resumeDocdexId: string | undefined;
    let resumeAdminDocdexId: string | undefined;
    let resumeOutputPath: string | undefined;
    let resumeAdminOutputPath: string | undefined;
    let resumeSpec: string | undefined;
    let resumeAdminSpec: string | undefined;

    if (options.resumeJobId) {
      const resumed = await this.tryResumeOpenapi(options.resumeJobId, warnings);
      if (resumed) {
        job = resumed.job;
        if (resumed.completed) {
          await this.jobService.finishCommandRun(commandRun.id, "succeeded");
          return {
            jobId: job.id,
            commandRunId: commandRun.id,
            outputPath: resumed.outputPath,
            spec: resumed.spec ?? "",
            adminOutputPath: resumed.adminOutputPath,
            adminSpec: resumed.adminSpec,
            docdexId: resumed.docdexId,
            adminDocdexId: resumed.adminDocdexId,
            warnings,
          };
        }
        await this.updateOpenapiJobStatus(job.id, "running", {
          stage: "resuming",
          iteration: options.iteration,
          payload: compactPayload({ resumedBy: commandRun.id }),
        });
        await this.writeOpenapiCheckpoint(job.id, "resume_started", { resumedBy: commandRun.id });
        resumePrimaryDraft = resumed.primaryDraft;
        resumeAdminDraft = resumed.adminDraft;
        resumeDocdexId = resumed.docdexId;
        resumeAdminDocdexId = resumed.adminDocdexId;
        resumeOutputPath = resumed.outputPath;
        resumeAdminOutputPath = resumed.adminOutputPath;
        resumeSpec = resumed.spec;
        resumeAdminSpec = resumed.adminSpec;
      }
    }

    if (!job) {
      job = await this.jobService.startJob("openapi_change", commandRun.id, options.projectKey, {
        commandName: commandRun.commandName,
        payload: {
          workspaceRoot: this.workspace.workspaceRoot,
          projectKey: options.projectKey,
          resumeSupported: true,
          cliVersion: options.cliVersion,
        },
      });
    }

    const timeoutMs = options.timeoutMs ?? parseTimeoutSeconds(process.env[OPENAPI_TIMEOUT_ENV]);
    const timeoutAt = timeoutMs ? Date.now() + timeoutMs : undefined;
    const iteration = options.iteration;
    const iterationLabel = formatIterationLabel(iteration);
    const openapiDir = await this.ensureOpenapiDir();
    const outputPath = resumeOutputPath ?? path.join(openapiDir, PRIMARY_OPENAPI_FILENAME);
    const adminOutputPath = resumeAdminOutputPath ?? path.join(openapiDir, ADMIN_OPENAPI_FILENAME);
    const primaryDraftPath = this.openapiDraftPath(job.id, "primary");
    const adminDraftPath = this.openapiDraftPath(job.id, "admin");

    const basePayload = compactPayload({
      workspaceRoot: this.workspace.workspaceRoot,
      projectKey: options.projectKey,
      resumeSupported: true,
      cliVersion: options.cliVersion,
      openapi_timeout_ms: timeoutMs,
      openapi_primary_output_path: outputPath,
      openapi_admin_output_path: adminOutputPath,
      openapi_primary_draft_path: primaryDraftPath,
      openapi_admin_draft_path: adminDraftPath,
      openapi_iteration_current: iteration?.current,
      openapi_iteration_max: iteration?.max,
      openapi_iteration_label: iterationLabel,
    });
    const buildPayload = (payload?: Record<string, unknown>): Record<string, unknown> =>
      compactPayload({ ...basePayload, ...payload });

    let totalUnits = 1;
    let completedUnits = 0;
    const perVariantUnits = options.validateOnly ? 1 : 2;

    let currentStage = "starting";
    let currentVariant: "primary" | "admin" | undefined;
    const setStage = async (
      stage: string,
      variant?: "primary" | "admin",
      payload?: Record<string, unknown>,
    ): Promise<void> => {
      currentStage = stage;
      currentVariant = variant;
      await this.updateOpenapiJobStatus(job.id, "running", {
        stage,
        variant,
        iteration,
        totalUnits,
        completedUnits,
        payload: buildPayload(payload),
      });
    };
    const completeStage = async (
      stage: string,
      variant?: "primary" | "admin",
      payload?: Record<string, unknown>,
    ): Promise<void> => {
      completedUnits += 1;
      await this.updateOpenapiJobStatus(job.id, "running", {
        stage,
        variant,
        iteration,
        totalUnits,
        completedUnits,
        payload: buildPayload(payload),
      });
    };

    const runWithTimeout = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      void label;
      if (await this.isJobCancelled(job.id)) {
        throw new OpenApiJobError("cancelled", `OpenAPI job ${job.id} was cancelled.`, job.id);
      }
      if (!timeoutAt) return fn();
      const remaining = timeoutAt - Date.now();
      const timeoutSeconds = Math.max(1, Math.round((timeoutMs ?? 0) / 1000));
      if (remaining <= 0) {
        throw new OpenApiJobError(
          "timeout",
          `OpenAPI job ${job.id} timed out after ${timeoutSeconds}s.`,
          job.id,
        );
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          fn(),
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                new OpenApiJobError(
                  "timeout",
                  `OpenAPI job ${job.id} timed out after ${timeoutSeconds}s.`,
                  job.id,
                ),
              );
            }, remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const heartbeat = this.startOpenapiHeartbeat(job.id, () => ({
      stage: currentStage,
      variant: currentVariant,
      iteration,
      totalUnits,
      completedUnits,
      payload: buildPayload({ openapi_last_heartbeat_at: new Date().toISOString() }),
    }));
    const assertHeartbeat = (): void => {
      const error = heartbeat.getError();
      if (error) throw error;
    };

    try {
      await setStage("context");
      const projectKey = options.projectKey ?? (this.workspace.config as any)?.projectKey;
      const assembler = new OpenapiContextAssembler(this.docdex, this.workspace, projectKey);
      const context = await runWithTimeout("context", () => assembler.build());
      warnings.push(...context.warnings);
      await this.writeOpenapiCheckpoint(job.id, "context_built", {
        docdexAvailable: context.docdexAvailable,
      });
      await this.jobService.recordTokenUsage({
        timestamp: new Date().toISOString(),
        workspaceId: this.workspace.workspaceId,
        commandName: "openapi-from-docs",
        jobId: job.id,
        commandRunId: commandRun.id,
        action: "docdex_context",
        promptTokens: 0,
        completionTokens: 0,
        metadata: { docdexAvailable: context.docdexAvailable },
      });
      await completeStage("context", undefined, { docdexAvailable: context.docdexAvailable });

      const adminCheck = await runWithTimeout("admin_check", () => this.collectAdminMentions());
      warnings.push(...adminCheck.warnings);
      const adminRequired = adminCheck.required;
      totalUnits = 1 + perVariantUnits * (adminRequired ? 2 : 1);
      await this.updateOpenapiJobStatus(job.id, "running", {
        stage: currentStage,
        variant: currentVariant,
        iteration,
        totalUnits,
        completedUnits,
        payload: buildPayload({ openapi_admin_required: adminRequired }),
      });

      assertHeartbeat();

      if (options.validateOnly) {
        await setStage("validate", "primary");
        if (!(await fileExists(outputPath))) {
          throw new Error(`Cannot validate missing spec: ${outputPath}`);
        }
        const primaryResult = await runWithTimeout("validate_primary", () =>
          this.validateExistingSpec(outputPath),
        );
        const issues = primaryResult.issues.map((issue) => `Primary spec: ${issue}`);
        let adminSpec: string | undefined;
        let adminResult: Awaited<ReturnType<typeof this.validateExistingSpec>> | undefined;
        const adminExists = await fileExists(adminOutputPath);
        if (adminRequired && !adminExists) {
          throw new Error(`Admin spec required but missing: ${adminOutputPath}`);
        }
        if (adminExists) {
          adminResult = await runWithTimeout("validate_admin", () =>
            this.validateExistingSpec(adminOutputPath),
          );
          adminSpec = adminResult.spec;
          issues.push(
            ...adminResult.issues.map((issue) => `Admin spec (${adminOutputPath}): ${issue}`),
          );
        }
        if (adminResult?.doc && primaryResult.doc) {
          const primaryVersion = primaryResult.doc?.info?.version;
          const adminVersion = adminResult.doc?.info?.version;
          if (primaryVersion && adminVersion && primaryVersion !== adminVersion) {
            issues.push(
              `Admin spec info.version (${adminVersion}) does not match primary spec (${primaryVersion}).`,
            );
          }
          const primaryOpenapi = primaryResult.doc?.openapi;
          const adminOpenapi = adminResult.doc?.openapi;
          if (primaryOpenapi && adminOpenapi && primaryOpenapi !== adminOpenapi) {
            issues.push(
              `Admin spec openapi version (${adminOpenapi}) does not match primary spec (${primaryOpenapi}).`,
            );
          }
        }
        const validationNote = issues.length ? `Validation issues:\n${issues.join("\n")}` : "Validation passed.";
        await this.jobService.appendLog(job.id, `${validationNote}\n`);
        await completeStage("validate", "primary", { validation: validationNote });
        if (adminExists) {
          await completeStage("validate", "admin", { validation: validationNote });
        }
        const jobState = issues.length ? "failed" : "completed";
        const commandState = issues.length ? "failed" : "succeeded";
        await this.jobService.updateJobStatus(job.id, jobState, {
          errorSummary: issues.length ? issues.join("; ") : undefined,
          payload: buildPayload({ validation: validationNote, openapi_admin_required: adminRequired }),
        });
        await this.jobService.finishCommandRun(commandRun.id, commandState, issues.join("; "));
        return {
          jobId: job.id,
          commandRunId: commandRun.id,
          outputPath,
          spec: primaryResult.spec,
          adminOutputPath: adminExists ? adminOutputPath : undefined,
          adminSpec,
          warnings,
        };
      }

      if (!options.force && (await fileExists(outputPath))) {
        throw new Error(`File exists, use --force to overwrite (${outputPath})`);
      }

      const agent = await this.resolveAgent(options.agentName);
      const stream = options.agentStream ?? true;
      let agentUsed = false;

      const generateVariant = async (
        variant: "primary" | "admin",
        resumeDraft?: string,
      ): Promise<{
        specYaml: string;
        parsed: any;
        adapter: string;
        agentMetadata?: Record<string, unknown>;
      }> => {
        const fallbackTitle =
          variant === "admin"
            ? `${projectKey ?? "mcoda"} Admin API`
            : projectKey ?? "mcoda API";

        if (resumeDraft) {
          try {
            const parsed = YAML.parse(resumeDraft);
            if (!parsed.info) parsed.info = {};
            parsed.info.title = parsed.info.title ?? fallbackTitle;
            parsed.info.version = options.cliVersion;
            parsed.openapi = OPENAPI_VERSION;
            const errors = this.validateSpec(parsed);
            const validatorErrors = await runWithTimeout("validate_resume", () =>
              this.runOpenapiValidator(parsed),
            );
            errors.push(...validatorErrors);
            if (errors.length === 0) {
              const specYaml = YAML.stringify(parsed);
              await this.writeOpenapiDraft(job.id, variant, specYaml);
              await this.writeOpenapiCheckpoint(job.id, `draft_${variant}_completed`, {
                variant,
                draftPath: variant === "admin" ? adminDraftPath : primaryDraftPath,
                resumed: true,
              });
              return { specYaml, parsed, adapter: "resume" };
            }
            warnings.push(`Saved ${variant} draft invalid; regenerating: ${errors.join("; ")}`);
          } catch (error) {
            warnings.push(
              `Saved ${variant} draft could not be parsed; regenerating: ${(error as Error).message ?? String(error)}`,
            );
          }
        }

        let specYaml = "";
        let parsed: any;
        let adapter = agent.adapter;
        let agentMetadata: Record<string, unknown> | undefined;
        let lastErrors: string[] | undefined;
        await setStage("draft", variant);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const prompt = this.buildPrompt(context, options.cliVersion, lastErrors, variant);
          agentUsed = true;
          const { output, adapter: usedAdapter, metadata } = await runWithTimeout(
            "draft_agent",
            async () => this.invokeAgent(agent, prompt, stream, job.id, options.onToken),
          );
          adapter = usedAdapter;
          agentMetadata = metadata;
          specYaml = this.sanitizeOutput(output);
          try {
            parsed = YAML.parse(specYaml);
            if (!parsed.info) parsed.info = {};
            parsed.info.title = parsed.info.title ?? fallbackTitle;
            parsed.info.version = options.cliVersion;
            parsed.openapi = OPENAPI_VERSION;
            const errors = this.validateSpec(parsed);
            const validatorErrors = await runWithTimeout("validate_generated", () =>
              this.runOpenapiValidator(parsed),
            );
            errors.push(...validatorErrors);
            const action =
              variant === "admin"
                ? attempt === 0
                  ? "draft_openapi_admin"
                  : "draft_openapi_admin_retry"
                : attempt === 0
                  ? "draft_openapi"
                  : "draft_openapi_retry";
            await this.jobService.recordTokenUsage({
              timestamp: new Date().toISOString(),
              workspaceId: this.workspace.workspaceId,
              commandName: "openapi-from-docs",
              jobId: job.id,
              commandRunId: commandRun.id,
              agentId: agent.id,
              modelName: agent.defaultModel,
              action,
              promptTokens: estimateTokens(prompt),
              completionTokens: estimateTokens(output),
              metadata: {
                adapter,
                provider: adapter,
                attempt: attempt + 1,
                phase: action,
                variant,
              },
            });
            if (errors.length === 0) {
              specYaml = YAML.stringify(parsed);
              break;
            }
            if (attempt === 1) {
              throw new Error(`Generated ${variant} spec failed validation: ${errors.join("; ")}`);
            }
            lastErrors = errors;
          } catch (error) {
            if (attempt === 1) {
              throw new Error(
                (error as Error).message || `Failed to parse generated ${variant} YAML`,
              );
            }
            lastErrors = [(error as Error).message ?? "Invalid YAML"];
          }
          assertHeartbeat();
        }
        await this.writeOpenapiDraft(job.id, variant, specYaml);
        await this.writeOpenapiCheckpoint(job.id, `draft_${variant}_completed`, {
          variant,
          draftPath: variant === "admin" ? adminDraftPath : primaryDraftPath,
        });
        return { specYaml, parsed, adapter, agentMetadata };
      };

      const primarySpec = await generateVariant("primary", resumePrimaryDraft ?? resumeSpec);
      await completeStage("draft", "primary", { openapi_variant: "primary" });
      const adminSpec = adminRequired
        ? await generateVariant("admin", resumeAdminDraft ?? resumeAdminSpec)
        : undefined;
      if (adminSpec) {
        await completeStage("draft", "admin", { openapi_variant: "admin" });
      }

      let backup: string | undefined;
      let adminBackup: string | undefined;
      let docdexId: string | undefined = resumeDocdexId;
      let adminDocdexId: string | undefined = resumeAdminDocdexId;

      await setStage("write", "primary");
      if (!options.dryRun) {
        backup = await this.backupIfNeeded(outputPath);
        await runWithTimeout("write_primary", async () => fs.writeFile(outputPath, primarySpec.specYaml, "utf8"));
        if (context.docdexAvailable) {
          try {
            const registered = await runWithTimeout("docdex_primary", async () =>
              this.registerOpenapi(outputPath, primarySpec.specYaml, "primary"),
            );
            docdexId = registered.id;
          } catch (error) {
            warnings.push(`Docdex registration skipped: ${(error as Error).message}`);
          }
        }
      } else {
        warnings.push("Dry run enabled; spec not written to disk.");
      }
      await completeStage("write", "primary", {
        outputPath,
        backupPath: backup,
        docdexId,
        adapter: primarySpec.adapter,
        adminAdapter: adminSpec?.adapter,
        agentMetadata: primarySpec.agentMetadata,
        adminAgentMetadata: adminSpec?.agentMetadata,
        openapi_admin_required: adminRequired,
      });

      if (adminSpec) {
        await setStage("write", "admin");
        if (!options.dryRun) {
          adminBackup = await this.backupIfNeeded(adminOutputPath);
          await runWithTimeout("write_admin", async () =>
            fs.writeFile(adminOutputPath, adminSpec.specYaml, "utf8"),
          );
          if (context.docdexAvailable) {
            try {
              const registered = await runWithTimeout("docdex_admin", async () =>
                this.registerOpenapi(adminOutputPath, adminSpec.specYaml, "admin"),
              );
              adminDocdexId = registered.id;
            } catch (error) {
              warnings.push(`Admin Docdex registration skipped: ${(error as Error).message}`);
            }
          }
        }
        await completeStage("write", "admin", {
          adminOutputPath,
          adminBackupPath: adminBackup,
          adminDocdexId,
          openapi_admin_required: adminRequired,
        });
      }

      await this.updateOpenapiJobStatus(job.id, "completed", {
        stage: "complete",
        iteration,
        totalUnits,
        completedUnits: totalUnits,
        payload: buildPayload({
          outputPath,
          backupPath: backup,
          adminOutputPath: adminSpec ? adminOutputPath : undefined,
          adminBackupPath: adminBackup,
          docdexId,
          adminDocdexId,
          adapter: primarySpec.adapter,
          adminAdapter: adminSpec?.adapter,
          agentMetadata: primarySpec.agentMetadata,
          adminAgentMetadata: adminSpec?.agentMetadata,
          openapi_admin_required: adminRequired,
        }),
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");
      if (options.rateAgents && agentUsed) {
        try {
          const ratingService = await this.ensureRatingService();
          await ratingService.rate({
            workspace: this.workspace,
            agentId: agent.id,
            commandName: "openapi-from-docs",
            jobId: job.id,
            commandRunId: commandRun.id,
          });
        } catch (error) {
          warnings.push(`Agent rating failed: ${(error as Error).message ?? String(error)}`);
        }
      }
      return {
        jobId: job.id,
        commandRunId: commandRun.id,
        outputPath: options.dryRun ? undefined : outputPath,
        spec: primarySpec.specYaml,
        adminOutputPath: options.dryRun ? undefined : adminSpec ? adminOutputPath : undefined,
        adminSpec: adminSpec?.specYaml,
        docdexId,
        adminDocdexId,
        warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isOpenapiError = error instanceof OpenApiJobError;
      if (job) {
        if (isOpenapiError && error.code === "cancelled") {
          await this.updateOpenapiJobStatus(job.id, "cancelled", {
            stage: "cancelled",
            iteration: options.iteration,
            totalUnits,
            completedUnits,
            payload: buildPayload({ openapi_admin_required: undefined }),
            errorSummary: message,
          });
          await this.jobService.finishCommandRun(commandRun.id, "cancelled", message);
        } else {
          await this.updateOpenapiJobStatus(job.id, "failed", {
            stage: isOpenapiError && error.code === "timeout" ? "timeout" : "failed",
            iteration: options.iteration,
            totalUnits,
            completedUnits,
            payload: buildPayload({ openapi_admin_required: undefined }),
            errorSummary: message,
          });
          await this.jobService.finishCommandRun(commandRun.id, "failed", message);
        }
      } else {
        await this.jobService.finishCommandRun(commandRun.id, "failed", message);
      }
      throw error;
    } finally {
      heartbeat.stop();
    }
  }
}
