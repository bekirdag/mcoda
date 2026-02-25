import path from "node:path";
import { promises as fs } from "node:fs";
import { AgentService } from "@mcoda/agents";
import { DocsScaffolder } from "@mcoda/generators";
import { GlobalRepository, WorkspaceRepository } from "@mcoda/db";
import { Agent, AgentHealth, AgentPromptManifest } from "@mcoda/shared";
import { DocdexClient, DocdexDocument } from "@mcoda/integrations";
import {
  DEFAULT_PDR_CHARACTER_PROMPT,
  DEFAULT_PDR_JOB_PROMPT,
  DEFAULT_PDR_RUNBOOK_PROMPT,
} from "../../prompts/PdrPrompts.js";
import {
  DEFAULT_SDS_CHARACTER_PROMPT,
  DEFAULT_SDS_JOB_PROMPT,
  DEFAULT_SDS_RUNBOOK_PROMPT,
  DEFAULT_SDS_TEMPLATE,
} from "../../prompts/SdsPrompts.js";
import {
  type DocgenCommandName,
  type DocgenRunContext,
  type DocArtifactRecord,
  createEmptyArtifacts,
} from "./DocgenRunContext.js";
import { buildDocInventory } from "./DocInventory.js";
import {
  DocPatchEngine,
  type DocPatchApplyResult,
  type DocPatchRequest,
} from "./patch/DocPatchEngine.js";
import { runApiPathConsistencyGate } from "./review/gates/ApiPathConsistencyGate.js";
import { runOpenApiCoverageGate } from "./review/gates/OpenApiCoverageGate.js";
import { runBuildReadyCompletenessGate } from "./review/gates/BuildReadyCompletenessGate.js";
import { runDeploymentBlueprintGate } from "./review/gates/DeploymentBlueprintGate.js";
import { runPlaceholderArtifactGate } from "./review/gates/PlaceholderArtifactGate.js";
import { runSqlSyntaxGate } from "./review/gates/SqlSyntaxGate.js";
import { runSqlRequiredTablesGate } from "./review/gates/SqlRequiredTablesGate.js";
import { runTerminologyNormalizationGate } from "./review/gates/TerminologyNormalizationGate.js";
import { runOpenQuestionsGate } from "./review/gates/OpenQuestionsGate.js";
import { runNoMaybesGate } from "./review/gates/NoMaybesGate.js";
import { runRfpConsentGate } from "./review/gates/RfpConsentGate.js";
import { runRfpDefinitionGate } from "./review/gates/RfpDefinitionGate.js";
import { runPdrInterfacesGate } from "./review/gates/PdrInterfacesGate.js";
import { runPdrOwnershipGate } from "./review/gates/PdrOwnershipGate.js";
import { runPdrOpenQuestionsGate } from "./review/gates/PdrOpenQuestionsGate.js";
import { runPdrTechStackRationaleGate } from "./review/gates/PdrTechStackRationaleGate.js";
import { runPdrFolderTreeGate } from "./review/gates/PdrFolderTreeGate.js";
import { runPdrNoUnresolvedItemsGate } from "./review/gates/PdrNoUnresolvedItemsGate.js";
import { runSdsDecisionsGate } from "./review/gates/SdsDecisionsGate.js";
import { runSdsTechStackRationaleGate } from "./review/gates/SdsTechStackRationaleGate.js";
import { runSdsFolderTreeGate } from "./review/gates/SdsFolderTreeGate.js";
import { runSdsNoUnresolvedItemsGate } from "./review/gates/SdsNoUnresolvedItemsGate.js";
import { runSdsPolicyTelemetryGate } from "./review/gates/SdsPolicyTelemetryGate.js";
import { runSdsOpsGate } from "./review/gates/SdsOpsGate.js";
import { runSdsAdaptersGate } from "./review/gates/SdsAdaptersGate.js";
import { runAdminOpenApiSpecGate } from "./review/gates/AdminOpenApiSpecGate.js";
import { runOpenApiSchemaSanityGate } from "./review/gates/OpenApiSchemaSanityGate.js";
import { renderReviewReport } from "./review/ReviewReportRenderer.js";
import {
  serializeReviewReport,
  type ReviewReport,
  type ReviewReportDelta,
} from "./review/ReviewReportSchema.js";
import {
  aggregateReviewOutcome,
  type ReviewGateResult,
  type ReviewIssue,
  type ReviewFix,
  type ReviewDecision,
} from "./review/ReviewTypes.js";
import { findAdminSurfaceMentions, validateOpenApiSchemaContent } from "../openapi/OpenApiService.js";
import { JobService, JobCheckpoint } from "../jobs/JobService.js";
import {
  WorkspaceResolution,
  cleanupWorkspaceStateDirs,
  resolveDocgenStatePath,
} from "../../workspace/WorkspaceManager.js";
import { RoutingService, type ResolvedAgent } from "../agents/RoutingService.js";
import {
  AgentRatingService,
  selectBestAgentForCapabilities,
  type AgentCapabilityCandidate,
} from "../agents/AgentRatingService.js";
import { DocAlignmentPatcher } from "./alignment/DocAlignmentPatcher.js";
import { ToolDenylist } from "../system/ToolDenylist.js";

export interface GeneratePdrOptions {
  workspace: WorkspaceResolution;
  projectKey?: string;
  rfpId?: string;
  rfpPath?: string;
  outPath?: string;
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  fast?: boolean;
  iterate?: boolean;
  buildReady?: boolean;
  noPlaceholders?: boolean;
  resolveOpenQuestions?: boolean;
  noMaybes?: boolean;
  crossAlign?: boolean;
  dryRun?: boolean;
  json?: boolean;
  onToken?: (token: string) => void;
  resumeJobId?: string;
}

export interface GeneratePdrResult {
  jobId: string;
  commandRunId: string;
  outputPath?: string;
  draft: string;
  docdexId?: string;
  warnings: string[];
}

export interface GenerateSdsOptions {
  workspace: WorkspaceResolution;
  projectKey?: string;
  outPath?: string;
  agentName?: string;
  templateName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  fast?: boolean;
  iterate?: boolean;
  buildReady?: boolean;
  noPlaceholders?: boolean;
  resolveOpenQuestions?: boolean;
  noMaybes?: boolean;
  crossAlign?: boolean;
  dryRun?: boolean;
  json?: boolean;
  force?: boolean;
  resumeJobId?: string;
  onToken?: (token: string) => void;
}

export interface GenerateSdsResult {
  jobId: string;
  commandRunId: string;
  outputPath?: string;
  draft: string;
  docdexId?: string;
  warnings: string[];
}

interface ContextBuildInput {
  rfpId?: string;
  rfpPath?: string;
  projectKey?: string;
}

interface PdrContext {
  rfp: DocdexDocument;
  related: DocdexDocument[];
  openapi: DocdexDocument[];
  docdexAvailable: boolean;
  summary: string;
  bullets: string[];
  warnings: string[];
}

interface SdsContextInput {
  projectKey?: string;
}

interface DocContextBlock {
  label: string;
  content: string;
  summary: string;
  priority: number;
  tokens: number;
}

interface SdsContext {
  rfp?: DocdexDocument;
  pdrs: DocdexDocument[];
  existingSds: DocdexDocument[];
  openapi: DocdexDocument[];
  misc: DocdexDocument[];
  blocks: DocContextBlock[];
  docdexAvailable: boolean;
  summary: string;
  warnings: string[];
}

const ensureDir = async (targetPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
};

const parseDelimitedList = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const ALWAYS_BLOCKING_GATES = new Set([
  "gate-placeholder-artifacts",
  "gate-no-maybes",
  "gate-pdr-open-questions-quality",
]);

const BUILD_READY_ONLY_GATES = new Set([
  "gate-api-path-consistency",
  "gate-openapi-schema-sanity",
  "gate-openapi-coverage",
  "gate-sql-syntax",
  "gate-sql-required-tables",
  "gate-admin-openapi-spec",
  "gate-terminology-normalization",
  "gate-open-questions",
  "gate-rfp-consent-contradictions",
  "gate-rfp-definition-coverage",
  "gate-pdr-interfaces-pipeline",
  "gate-pdr-ownership-consent-flow",
  "gate-pdr-tech-stack-rationale",
  "gate-pdr-folder-tree",
  "gate-pdr-no-unresolved-items",
  "gate-sds-explicit-decisions",
  "gate-sds-tech-stack-rationale",
  "gate-sds-folder-tree",
  "gate-sds-no-unresolved-items",
  "gate-sds-policy-telemetry-metering",
  "gate-sds-ops-observability-testing",
  "gate-sds-external-adapters",
  "gate-deployment-blueprint-validator",
  "gate-build-ready-completeness",
]);

const readPromptIfExists = async (workspace: WorkspaceResolution, relative: string): Promise<string | undefined> => {
  const candidate = path.join(workspace.mcodaDir, relative);
  try {
    return await fs.readFile(candidate, "utf8");
  } catch {
    return undefined;
  }
};

const PDR_REQUIRED_HEADINGS: string[][] = [
  ["Introduction"],
  ["Scope"],
  ["Goals", "Goals & Success Metrics", "Success Metrics"],
  ["Technology Stack", "Tech Stack"],
  ["Requirements", "Requirements & Constraints"],
  ["Architecture", "Architecture Overview"],
  ["Interfaces", "Interfaces / APIs"],
  ["Delivery", "Delivery & Dependency Sequencing", "Dependency Sequencing"],
  ["Target Folder Tree", "Folder Tree", "Directory Structure", "Repository Structure"],
  ["Non-Functional", "Non-Functional Requirements"],
  ["Risks", "Risks & Mitigations"],
  ["Resolved Decisions"],
  ["Open Questions"],
  ["Acceptance Criteria"],
];

const missingPdrHeadings = (draft: string): string[] => {
  const normalized = draft.trim();
  if (!normalized) return PDR_REQUIRED_HEADINGS.map((v) => v[0]);
  return PDR_REQUIRED_HEADINGS.filter(
    (variants) => !variants.some((section) => new RegExp(`^#{1,6}\\s+${section}\\b`, "im").test(normalized)),
  ).map((variants) => variants[0]);
};

const validateDraft = (draft: string): boolean => {
  if (!draft || draft.trim().length < 50) return false;
  return missingPdrHeadings(draft).length === 0;
};

const ensureSectionContent = (draft: string, title: string, fallback: string): string => {
  const headingRegex = new RegExp(`^#{1,6}\\s+${title}\\b.*$`, "im");
  if (!headingRegex.test(draft)) {
    return `${draft.trimEnd()}\n\n## ${title}\n${fallback}\n`;
  }
  const blockRegex = new RegExp(`(^#{1,6}\\s+${title}\\b.*$)([\\s\\S]*?)(?=^#{1,6}\\s+|$)`, "im");
  return draft.replace(blockRegex, (_match, heading, body) => {
    const trimmed = (body as string).trim();
    if (trimmed.length > 0) return `${heading}${body}`;
    return `${heading}\n\n${fallback}\n`;
  });
};

const validateSdsDraft = (draft: string): boolean => {
  if (!draft || draft.trim().length < 100) return false;
  const headings = draft
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").toLowerCase());
  const requiredGroups = [
    ["introduction", "purpose"],
    ["scope"],
    ["architecture"],
    ["data"],
    ["interface"],
    ["security"],
    ["failure", "recovery", "rollback"],
    ["risk"],
    ["operations", "observability", "quality"],
    ["open questions"],
    ["acceptance criteria"],
  ];
  return requiredGroups.every((group) =>
    headings.some((heading) => group.some((term) => heading.includes(term))),
  );
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "draft";

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const SDS_CONTEXT_TOKEN_BUDGET = 8000;

const extractBullets = (content: string, limit = 20): string[] => {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*+]\s+/.test(line))
    .map((line) => line.replace(/^[-*+]\s+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, limit);
};

const DEFAULT_TECH_STACK_FALLBACK = [
  "- Frontend: React + TypeScript",
  "- Backend/services: TypeScript (Node.js)",
  "- Database: MySQL",
  "- Cache/queues: Redis",
  "- Scripting/ops: Bash",
  "- Override defaults if the RFP specifies a different stack.",
].join("\n");

const ML_TECH_STACK_FALLBACK = [
  "- Language: Python",
  "- ML stack: PyTorch or TensorFlow (pick based on model requirements)",
  "- Services/API: Python web framework (FastAPI/Flask) as needed",
  "- Database: MySQL",
  "- Cache/queues: Redis",
  "- Scripting/ops: Bash",
  "- Override defaults if the RFP specifies a different stack.",
].join("\n");

const contextIndicatesMlStack = (context: PdrContext): boolean => {
  const sources = [context.rfp?.content, ...context.related.map((doc) => doc.content ?? "")].filter(Boolean);
  if (!sources.length) return false;
  const text = sources.join("\n").toLowerCase();
  const patterns = [
    /\bmachine learning\b/,
    /\bdeep learning\b/,
    /\bneural\b/,
    /\bmodel training\b/,
    /\bmodel inference\b/,
    /\bml\b/,
    /\bllm\b/,
    /\bembeddings?\b/,
  ];
  return patterns.some((pattern) => pattern.test(text));
};

const resolveTechStackFallback = (context: PdrContext): string => {
  return contextIndicatesMlStack(context) ? ML_TECH_STACK_FALLBACK : DEFAULT_TECH_STACK_FALLBACK;
};

const DEFAULT_PDR_FOLDER_TREE_BLOCK = [
  "```text",
  ".",
  "├── docs/                      # product, design, and architecture docs",
  "│   ├── rfp/                   # requirement sources",
  "│   ├── pdr/                   # product design reviews",
  "│   └── sds/                   # software design specifications",
  "├── packages/                  # application/service modules",
  "│   ├── cli/                   # command and operator interfaces",
  "│   ├── core/                  # business/domain services",
  "│   └── integrations/          # provider adapters",
  "├── openapi/                   # API contracts",
  "├── db/                        # schema, migrations, seed data",
  "├── deploy/                    # runtime manifests/compose/k8s",
  "├── tests/                     # unit/integration/e2e checks",
  "└── scripts/                   # automation and release scripts",
  "```",
].join("\n");

const normalizePdrResolvedEntry = (line: string): string | undefined => {
  const stripped = line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
  if (!stripped) return undefined;
  if (/no unresolved questions remain|no open questions remain/i.test(stripped)) {
    return "Resolved: No unresolved questions remain.";
  }
  const withoutPrefix = stripped.replace(/^resolved:\s*/i, "").trim();
  const withoutQuestions = withoutPrefix.replace(/\?+$/, "").trim();
  if (!withoutQuestions) return undefined;
  const withTerminal = /[.!?]$/.test(withoutQuestions) ? withoutQuestions : `${withoutQuestions}.`;
  return `Resolved: ${withTerminal}`;
};

const enforcePdrResolvedOpenQuestionsContract = (draft: string): string => {
  const section =
    extractSection(draft, "Open Questions") ??
    extractSection(draft, "Open Questions (Resolved)");
  if (!section) return draft;
  const resolvedEntries = section.body
    .split(/\r?\n/)
    .map(normalizePdrResolvedEntry)
    .filter((value): value is string => Boolean(value));
  const uniqueEntries = Array.from(
    new Map(resolvedEntries.map((entry) => [entry.toLowerCase(), entry])).values(),
  );
  const body =
    uniqueEntries.length > 0
      ? uniqueEntries.map((entry) => `- ${entry}`).join("\n")
      : "- Resolved: No unresolved questions remain.";
  return replaceSection(draft, "Open Questions", body);
};

const enforcePdrTechStackContract = (draft: string): string => {
  const section =
    extractSection(draft, "Technology Stack") ??
    extractSection(draft, "Tech Stack");
  if (!section) return draft;
  const body = cleanBody(section.body ?? "");
  const additions: string[] = [];
  if (!/chosen stack|selected stack|primary stack|we use/i.test(body)) {
    additions.push("- Chosen stack: declare runtime, language, persistence, and tooling baseline.");
  }
  if (!/alternatives? considered|options? considered|alternative/i.test(body)) {
    additions.push("- Alternatives considered: list realistic options evaluated but not selected.");
  }
  if (!/rationale|trade[- ]?off|because|why/i.test(body)) {
    additions.push("- Rationale: explain why the selected stack is preferred for delivery and operations.");
  }
  if (additions.length === 0) return draft;
  const merged = [body, ...additions].filter(Boolean).join("\n");
  return replaceSection(draft, "Technology Stack", merged);
};

const enforcePdrFolderTreeContract = (draft: string): string => {
  const section =
    extractSection(draft, "Target Folder Tree") ??
    extractSection(draft, "Folder Tree");
  if (!section) return draft;
  const body = section.body ?? "";
  const treeBlock = body.match(/```(?:text)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const treeEntries =
    treeBlock?.split(/\r?\n/).filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed === ".") return true;
      if (/^[├└│]/.test(trimmed)) return true;
      return /[A-Za-z0-9_.-]+\/?/.test(trimmed);
    }).length ?? 0;
  const hasResponsibilityHints = treeBlock
    ? /#|responsibilit|owner|module|service|tests?|scripts?/i.test(treeBlock)
    : false;
  const hasFence = /```(?:text)?[\s\S]*?```/i.test(body);
  if (hasFence && treeEntries >= 8 && hasResponsibilityHints) return draft;
  const mergedBody =
    cleanBody(body).length > 0
      ? `${cleanBody(body)}\n\n${DEFAULT_PDR_FOLDER_TREE_BLOCK}`
      : DEFAULT_PDR_FOLDER_TREE_BLOCK;
  return replaceSection(draft, "Target Folder Tree", mergedBody);
};

const applyPdrHardContracts = (draft: string): string => {
  let updated = draft;
  updated = enforcePdrTechStackContract(updated);
  updated = enforcePdrFolderTreeContract(updated);
  updated = enforcePdrResolvedOpenQuestionsContract(updated);
  return updated;
};

class DocContextAssembler {
  constructor(private docdex: DocdexClient, private workspace: WorkspaceResolution) {}

  private summarize(doc: DocdexDocument): string {
    const lines = (doc.content ?? "").split(/\r?\n/).filter(Boolean);
    const head = lines.slice(0, 5).join(" ");
    return head || doc.title || doc.path || "Document";
  }

  private async findLatestLocalDoc(docType: string): Promise<DocdexDocument | undefined> {
    const candidates: { path: string; mtime: number }[] = [];
    const lower = docType.toLowerCase();
    const explicitFiles = [
      path.join(this.workspace.mcodaDir, "docs", `${lower}.md`),
      path.join(this.workspace.workspaceRoot, "docs", `${lower}.md`),
    ];
    const addCandidate = async (candidatePath: string) => {
      try {
        const stat = await fs.stat(candidatePath);
        if (stat.isFile()) {
          candidates.push({ path: candidatePath, mtime: stat.mtimeMs });
        }
      } catch {
        // ignore
      }
    };
    for (const filePath of explicitFiles) {
      await addCandidate(filePath);
    }
    const dirs = [
      path.join(this.workspace.mcodaDir, "docs", lower),
      path.join(this.workspace.workspaceRoot, "docs", lower),
    ];
    for (const dir of dirs) {
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries.filter((e) => e.endsWith(".md"))) {
          const full = path.join(dir, entry);
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

  private formatBlock(doc: DocdexDocument, label: string, priority: number, maxSegments = 8): DocContextBlock {
    const segments = (doc.segments ?? []).slice(0, maxSegments);
    const heading = `[${doc.docType}] ${label}`;
    const source = doc.path ?? doc.id ?? label;
    const body = segments.length
      ? segments
          .map((seg, idx) => {
            const head = seg.heading ?? `Segment ${idx + 1}`;
            const trimmed = seg.content.length > 800 ? `${seg.content.slice(0, 800)}...` : seg.content;
            return `### ${head}\n${trimmed}`;
          })
          .join("\n\n")
      : doc.content ?? this.summarize(doc);
    const content = [heading, `Source: ${source}`, body].filter(Boolean).join("\n");
    return {
      label,
      content,
      summary: `${heading}: ${this.summarize(doc)}`,
      priority,
      tokens: estimateTokens(content),
    };
  }

  private enforceBudget(blocks: DocContextBlock[], budget: number, warnings: string[]): DocContextBlock[] {
    let total = blocks.reduce((sum, b) => sum + b.tokens, 0);
    if (total <= budget) return blocks;
    const ordered = [...blocks].sort((a, b) => a.priority - b.priority); // degrade lowest priority first
    for (const block of ordered) {
      if (total <= budget) break;
      if (block.content !== block.summary) {
        total -= block.tokens;
        block.content = block.summary;
        block.tokens = estimateTokens(block.content);
        total += block.tokens;
        warnings.push(`Context for ${block.label} truncated to summary to fit token budget.`);
      }
    }
    if (total > budget) {
      for (const block of ordered) {
        if (total <= budget) break;
        const trimmed = block.content.slice(0, Math.max(400, Math.floor((budget / ordered.length) * 4)));
        const tokens = estimateTokens(trimmed);
        if (tokens < block.tokens) {
          total -= block.tokens;
          block.content = `${trimmed}\n\n[truncated]`;
          block.tokens = tokens;
          total += block.tokens;
          warnings.push(`Context for ${block.label} truncated further to meet token budget.`);
        }
      }
    }
    return blocks;
  }

  async buildSdsContext(input: SdsContextInput): Promise<SdsContext> {
    const warnings: string[] = [];
    let docdexAvailable = true;
    let rfp: DocdexDocument | undefined;
    let pdrs: DocdexDocument[] = [];
    let existingSds: DocdexDocument[] = [];
    let openapi: DocdexDocument[] = [];
    const misc: DocdexDocument[] = [];

    try {
      const [pdrDocs, sdsDocs, openapiDocs, rfpDocs, constraintsDocs] = await Promise.all([
        this.docdex.search({ projectKey: input.projectKey, docType: "PDR", profile: "sds_default" }),
        this.docdex.search({ projectKey: input.projectKey, docType: "SDS", profile: "sds_default" }),
        this.docdex.search({ projectKey: input.projectKey, docType: "OPENAPI", profile: "sds_default" }),
        this.docdex.search({ projectKey: input.projectKey, docType: "RFP", profile: "sds_default" }),
        this.docdex.search({ projectKey: input.projectKey, docType: "Architecture", profile: "sds_default" }),
      ]);
      pdrs = pdrDocs;
      existingSds = sdsDocs;
      openapi = openapiDocs;
      rfp = rfpDocs[0];
      misc.push(...constraintsDocs);
      if (!rfp && pdrs.length === 0) {
        warnings.push("RFP not found in docdex; SDS will rely on PDR content only.");
      }
      if (!pdrs.length) {
        const localPdr = await this.findLatestLocalDoc("PDR");
        if (localPdr) {
          pdrs = [localPdr];
          warnings.push("No PDR found in docdex; using latest local PDR file.");
        }
      }
      if (!rfp) {
        const localRfp = await this.findLatestLocalDoc("RFP");
        if (localRfp) {
          rfp = localRfp;
          warnings.push("No RFP found in docdex; using latest local RFP file.");
        }
      }
    } catch (error) {
      docdexAvailable = false;
      warnings.push(`Docdex unavailable; attempting to use local docs (${(error as Error).message ?? "unknown"}).`);
      rfp = await this.findLatestLocalDoc("RFP");
      const localPdr = await this.findLatestLocalDoc("PDR");
      if (localPdr) pdrs = [localPdr];
      const localSds = await this.findLatestLocalDoc("SDS");
      if (localSds) existingSds = [localSds];
    }

    if (!pdrs.length && !rfp) {
      throw new Error(
        `No PDR or RFP content could be resolved. Ensure docdex is reachable with an sds_default profile or add local docs under ${path.join(
          this.workspace.mcodaDir,
          "docs",
          "pdr",
        )} and docs/rfp (or docs/rfp.md).`,
      );
    }

    const blocks: DocContextBlock[] = [];
    if (rfp) blocks.push(this.formatBlock(rfp, "RFP context", 1, 10));
    pdrs.slice(0, 2).forEach((doc, idx) => blocks.push(this.formatBlock(doc, `PDR ${idx + 1}`, 1, 8)));
    existingSds.slice(0, 1).forEach((doc) => blocks.push(this.formatBlock(doc, "Existing SDS", 2, 6)));
    if (openapi.length > 0) {
      const doc = openapi[0];
      const segments = (doc.segments ?? []).slice(0, 6);
      const body = segments.length
        ? segments
            .map((seg) => `- ${seg.heading ?? "operation"}: ${seg.content.slice(0, 400)}`)
            .join("\n")
        : doc.content ?? this.summarize(doc);
      const content = [`[OPENAPI] ${doc.title ?? doc.path ?? doc.id}`, body].join("\n");
      blocks.push({
        label: "OpenAPI",
        content,
        summary: `OpenAPI: ${this.summarize(doc)}`,
        priority: 1,
        tokens: estimateTokens(content),
      });
    }
    if (misc.length > 0) {
      const doc = misc[0];
      blocks.push(this.formatBlock(doc, "Constraints & Principles", 0, 5));
    }

    const boundedBlocks = this.enforceBudget(blocks, SDS_CONTEXT_TOKEN_BUDGET, warnings);
    const summaryParts = [
      `PDRs: ${pdrs.length}`,
      existingSds.length ? `Existing SDS: ${existingSds.length}` : "Existing SDS: none",
      rfp ? `RFP: ${this.summarize(rfp)}` : "RFP: missing",
      openapi.length ? `OpenAPI: ${openapi.length}` : "OpenAPI: none",
      misc.length ? `Constraints: ${misc.length}` : "Constraints: none",
    ];

    return {
      rfp,
      pdrs,
      existingSds,
      openapi,
      misc,
      blocks: boundedBlocks,
      docdexAvailable,
      summary: summaryParts.join(" | "),
      warnings,
    };
  }

  async buildContext(input: ContextBuildInput): Promise<PdrContext> {
    const warnings: string[] = [];
    let rfp: DocdexDocument | undefined;
    let docdexAvailable = true;
    let openapi: DocdexDocument[] = [];
    try {
      if (input.rfpId) {
        rfp = await this.docdex.fetchDocumentById(input.rfpId);
      } else if (input.rfpPath) {
        const resolved = path.isAbsolute(input.rfpPath)
          ? input.rfpPath
          : path.join(this.workspace.workspaceRoot, input.rfpPath);
        rfp = await this.docdex.ensureRegisteredFromFile(resolved, "RFP", {
          workspace: this.workspace.workspaceId,
          projectKey: input.projectKey,
        });
      }
    } catch (error) {
      docdexAvailable = false;
      if (input.rfpPath) {
        const resolved = path.isAbsolute(input.rfpPath)
          ? input.rfpPath
          : path.join(this.workspace.workspaceRoot, input.rfpPath);
        const content = await fs.readFile(resolved, "utf8");
        rfp = {
          id: "rfp-local",
          docType: "RFP",
          path: resolved,
          content,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        warnings.push(
          `Docdex unavailable; using local RFP content only (${(error as Error).message ?? "unknown error"}).`,
        );
      } else {
        throw error;
      }
    }

    if (!rfp) {
      throw new Error("RFP content could not be resolved. Provide --rfp-id or --rfp-path.");
    }

    let related: DocdexDocument[] = [];
    if (docdexAvailable) {
      try {
        related = await this.docdex.search({ projectKey: input.projectKey, docType: "PDR", profile: "rfp_default" });
        const sds = await this.docdex.search({ projectKey: input.projectKey, docType: "SDS", profile: "rfp_default" });
        openapi = await this.docdex.search({
          projectKey: input.projectKey,
          docType: "OPENAPI",
          profile: "rfp_default",
        });
        related = [...related, ...sds];
      } catch (error) {
        docdexAvailable = false;
        related = [];
        openapi = [];
        warnings.push(
          `Docdex unavailable; continuing without related docs (${(error as Error).message ?? "unknown error"}).`,
        );
      }
    }

    const summaryParts = [
      `RFP: ${this.summarize(rfp)}`,
      related.length > 0 ? `Related: ${related.map((d) => this.summarize(d)).join("; ")}` : "Related: none found",
      openapi.length > 0 ? `OpenAPI: ${openapi.length} docs` : "OpenAPI: none",
    ];

    return {
      rfp,
      related,
      openapi,
      docdexAvailable,
      summary: summaryParts.join(" | "),
      bullets: extractBullets(rfp.content ?? ""),
      warnings,
    };
  }
}

const buildRunPrompt = (
  context: PdrContext,
  projectKey: string | undefined,
  prompts: AgentPromptManifest | undefined,
  runbook: string,
): string => {
  const runbookPrompt = runbook || DEFAULT_PDR_RUNBOOK_PROMPT;
  const docdexNote = context.docdexAvailable
    ? ""
    : "Docdex context is unavailable. Use only the provided RFP content and clearly mark missing references.";
  const relatedSection =
    context.related.length === 0
      ? "No related PDR/SDS documents were found."
      : `Related docs:\n${context.related
          .map((doc) => `- ${doc.docType} ${doc.path ?? doc.id}: ${doc.title ?? ""}`.trim())
          .join("\n")}`;
  const promptsSection = [
    prompts?.jobPrompt ?? DEFAULT_PDR_JOB_PROMPT,
    prompts?.characterPrompt ?? DEFAULT_PDR_CHARACTER_PROMPT,
    prompts?.commandPrompts?.["docs:pdr"] ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    promptsSection,
    `Workspace project: ${projectKey ?? "(not specified)"}`,
    `Context summary: ${context.summary}`,
    `RFP bullet cues:\n${context.bullets.map((b) => `- ${b}`).join("\n") || "- (none extracted)"}`,
    relatedSection,
    context.openapi.length
      ? `OpenAPI excerpts:\n${context.openapi
          .map((doc) => (doc.segments ?? []).slice(0, 2).map((seg) => `- ${seg.heading ?? "segment"}: ${seg.content.slice(0, 200)}`))
          .flat()
          .join("\n")}`
      : "No OpenAPI excerpts available; do not invent endpoints.",
    docdexNote,
    [
      "Return markdown with exactly these sections as H2 headings, one time each:",
      "Introduction, Scope, Goals & Success Metrics, Technology Stack, Requirements & Constraints, Architecture Overview, Interfaces / APIs, Delivery & Dependency Sequencing, Target Folder Tree, Non-Functional Requirements, Risks & Mitigations, Resolved Decisions, Open Questions, Acceptance Criteria",
      "Do not use bold headings; use `##` headings only. Do not repeat sections.",
      "Quality requirements:",
      "- Produce implementation-ready, self-consistent content (no TODO/TBD/maybe placeholders).",
      "- Include chosen stack, alternatives considered, and rationale in Technology Stack.",
      "- Include a fenced `text` folder tree with responsibilities in Target Folder Tree.",
      "- Keep Open Questions resolved-only (lines beginning with `Resolved:`).",
    ].join("\n"),
    runbookPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
};

const buildSdsRunPrompt = (
  context: SdsContext,
  projectKey: string | undefined,
  prompts: AgentPromptManifest | undefined,
  runbook: string,
  template: string,
): string => {
  const promptsSection = [
    prompts?.jobPrompt ?? DEFAULT_SDS_JOB_PROMPT,
    prompts?.characterPrompt ?? DEFAULT_SDS_CHARACTER_PROMPT,
    prompts?.commandPrompts?.["docs:sds"] ?? "",
    prompts?.commandPrompts?.["docs:sds:generate"] ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const docdexNote = context.docdexAvailable
    ? ""
    : "Docdex context is unavailable; rely on provided local PDR/RFP content and explicitly mark missing references.";
  const blocks = context.blocks
    .map((block) => [`## ${block.label}`, block.content].join("\n"))
    .join("\n\n");

  return [
    promptsSection,
    `Workspace project: ${projectKey ?? "(not specified)"}`,
    `Template:\n${template}`,
    `Context summary: ${context.summary}`,
    blocks,
    docdexNote,
    [
      "SDS quality requirements:",
      "- Produce implementation-ready, self-consistent content (no TODO/TBD/maybe placeholders).",
      "- Make architecture and stack choices explicit; include alternatives considered with rationale.",
      "- Include a detailed folder tree in a fenced text block with file/folder responsibilities.",
      "- Keep Open Questions resolved-only (lines beginning with 'Resolved:').",
      "- Keep terminology, API contracts, data model, security, deployment, and operations aligned.",
    ].join("\n"),
    runbook,
  ]
    .filter(Boolean)
    .join("\n\n");
};

const ensureStructuredDraft = (
  draft: string,
  projectKey: string | undefined,
  context: PdrContext,
  rfpSource: string,
): string => {
  const canonicalTitles = PDR_REQUIRED_HEADINGS.map((variants) => variants[0]);
  const normalized = normalizeHeadingsToH2(draft, canonicalTitles);
  const techStackFallback = resolveTechStackFallback(context);
  const required = [
    { title: "Introduction", fallback: `This PDR summarizes project ${projectKey ?? "N/A"} based on ${rfpSource}.` },
    {
      title: "Scope",
      fallback:
        "In-scope: capabilities, interfaces, and delivery outcomes explicitly defined in the RFP/context. Out-of-scope: speculative features, undocumented integrations, and requirements without source grounding.",
    },
    {
      title: "Goals & Success Metrics",
      fallback:
        "- Goal: deliver prioritized product outcomes from the RFP with a production-viable implementation path.\n- Success metric: core user workflows are complete and testable with defined acceptance criteria.\n- Success metric: release blockers are reduced to zero unresolved items before build-ready handoff.",
    },
    { title: "Technology Stack", fallback: techStackFallback },
    {
      title: "Requirements & Constraints",
      fallback:
        context.bullets.map((b) => `- ${b}`).join("\n") ||
        "- Capture functional, contract, data, security, compliance, and operational constraints from the source context.",
    },
    { title: "Architecture Overview", fallback: "Describe the system architecture, components, and interactions." },
    { title: "Interfaces / APIs", fallback: "List key interfaces and constraints. Do not invent endpoints." },
    {
      title: "Delivery & Dependency Sequencing",
      fallback:
        "- Define foundational capabilities first, then dependent services/features.\n- Sequence work by dependency direction (providers before consumers).\n- Identify readiness gates and handoff criteria between phases.",
    },
    {
      title: "Target Folder Tree",
      fallback: DEFAULT_PDR_FOLDER_TREE_BLOCK,
    },
    { title: "Non-Functional Requirements", fallback: "- Performance, reliability, compliance, and operational needs." },
    { title: "Risks & Mitigations", fallback: "- Enumerate risks from the RFP and proposed mitigations." },
    {
      title: "Resolved Decisions",
      fallback:
        "- Decision: architecture and contract baselines are fixed for this implementation cycle.\n- Decision: dependency sequencing and release gates are mandatory.",
    },
    { title: "Open Questions", fallback: "- Resolved: No unresolved questions remain." },
    {
      title: "Acceptance Criteria",
      fallback:
        "- Functional flows defined by the RFP are implemented and testable.\n- Interface and contract assumptions are explicit, validated, and traceable.\n- Operational and quality gates (tests, observability, release readiness) are satisfied for build-ready handoff.",
    },
  ];

  const parts: string[] = [];
  parts.push(`# Product Design Review${projectKey ? `: ${projectKey}` : ""}`);
  for (const section of required) {
    const best = getBestSectionBody(normalized, section.title);
    const cleaned = cleanBody(best ?? "");
    let body = cleaned && cleaned.length > 0 ? cleaned : cleanBody(section.fallback);
    if (section.title === "Interfaces / APIs" && (context.openapi?.length ?? 0) === 0) {
      const scrubbed = stripInventedEndpoints(body);
      const openApiFallback =
        "No OpenAPI excerpts available. Document required interfaces as explicit contracts/assumptions without inventing endpoint paths.";
      if (!scrubbed || scrubbed.length === 0 || /endpoint/i.test(scrubbed)) {
        body = cleanBody(openApiFallback);
      } else {
        body = scrubbed;
      }
      if (!/openapi/i.test(body)) {
        body = `${body}\n- No OpenAPI excerpts available; avoid inventing endpoint paths.`;
      }
    }
    parts.push(`## ${section.title}`);
    parts.push(body);
  }
  parts.push("## Source RFP");
  parts.push(rfpSource);
  return applyPdrHardContracts(parts.join("\n\n"));
};

const tidyPdrDraft = async (
  draft: string,
  agent: Agent,
  invoke: (prompt: string) => Promise<{ output: string; adapter: string }>,
): Promise<string> => {
  const prompt = [
    "Tidy the following Product Design Review markdown:",
    draft,
    "",
    "Requirements:",
    "- Keep exactly one instance of each H2 section: Introduction, Scope, Goals & Success Metrics, Technology Stack, Requirements & Constraints, Architecture Overview, Interfaces / APIs, Delivery & Dependency Sequencing, Target Folder Tree, Non-Functional Requirements, Risks & Mitigations, Resolved Decisions, Open Questions, Acceptance Criteria, Source RFP.",
    "- Remove duplicate sections, bold headings posing as sections, placeholder sentences, and repeated bullet blocks. If the same idea appears twice, keep the richer/longer version and drop the restatement.",
    "- Do not add new sections or reorder the required outline.",
    "- Keep content concise and aligned to the headings. Do not alter semantics.",
    "- Return only the cleaned markdown.",
  ].join("\n");
  const { output } = await invoke(prompt);
  return output.trim();
};

const PDR_ENRICHMENT_SECTIONS: { title: string; guidance: string[] }[] = [
  {
    title: "Technology Stack",
    guidance: [
      "List frontend, backend/services, databases, caches/queues, infra/runtime, and scripting/tooling choices.",
      "If the RFP omits stack details, state the default stack (TypeScript/React/MySQL/Redis/Bash) or a Python ML stack when neural/ML workloads are explicit.",
    ],
  },
  {
    title: "Architecture Overview",
    guidance: [
      "List concrete components/services/modules from the source context and define responsibilities and boundaries for each.",
      "Describe primary data/control flows across those components and include failure-handling boundaries.",
      "State operational assumptions explicitly (readiness, dependencies, and degradation behavior) without domain-specific bias.",
    ],
  },
  {
    title: "Requirements & Constraints",
    guidance: [
      "Define domain entities, invariants, validation constraints, compatibility rules, and evolution/migration expectations where applicable.",
      "Capture security/compliance constraints and any operational limitations explicitly tied to the source context.",
      "Quantify measurable quality expectations (performance, reliability, accessibility, etc.) when available from context.",
    ],
  },
  {
    title: "Interfaces / APIs",
    guidance: [
      "Define internal and external interfaces/contracts, including responsibilities, inputs/outputs, and error semantics.",
      "When OpenAPI is missing, state bounded interface assumptions and avoid inventing concrete endpoint paths.",
    ],
  },
  {
    title: "Delivery & Dependency Sequencing",
    guidance: [
      "Describe foundational-to-dependent delivery order and why that order reduces rework.",
      "Identify hard dependencies, readiness criteria, and phase handoff checks.",
    ],
  },
  {
    title: "Target Folder Tree",
    guidance: [
      "Provide a fenced text tree with directories/files and short responsibility comments.",
      "Include docs, source modules, contracts, database, deploy, tests, and scripts paths.",
    ],
  },
  {
    title: "Non-Functional Requirements",
    guidance: [
      "Quantify performance/reliability/security/operability targets that are justified by source context.",
      "Include observability and failure-containment expectations required for production readiness.",
    ],
  },
  {
    title: "Risks & Mitigations",
    guidance: [
      "Enumerate concrete delivery/architecture/operational risks derived from source context.",
      "Provide explicit mitigations, fallback behavior, and verification checks for each high-impact risk.",
    ],
  },
  {
    title: "Open Questions",
    guidance: [
      "Convert unresolved items to resolved decisions with explicit outcomes.",
      "Keep entries in `Resolved: ...` form and remove TODO/TBD language.",
    ],
  },
];

const DEFAULT_SDS_SECTION_OUTLINE = [
  "0. Introduction, Document Governance, and Change Policy",
  "1. Purpose and Scope",
  "2. System Boundaries and Non-Goals",
  "3. Core Decisions (Baseline)",
  "4. Platform Model and Technology Stack",
  "5. Service Architecture and Dependency Contracts",
  "6. Data Architecture and Ownership",
  "7. Eventing, APIs, and Interface Contracts",
  "8. Security, IAM, and Compliance",
  "9. Risk and Control Model",
  "10. Compute, Deployment, and Startup Sequencing",
  "11. Target Folder Tree (Expanded with File Responsibilities)",
  "12. Operations, Observability, and Quality Gates",
  "13. External Integrations and Adapter Contracts",
  "14. Policy, Telemetry, and Metering",
  "15. Failure Modes, Recovery, and Rollback",
  "16. Assumptions and Constraints",
  "17. Resolved Decisions",
  "18. Open Questions (Resolved)",
  "19. Acceptance Criteria and Verification Plan",
];

const DEFAULT_SDS_FOLDER_TREE_BLOCK = [
  "```text",
  ".",
  "├── docs/                      # product and architecture docs",
  "│   ├── rfp/                   # requirement sources",
  "│   ├── pdr/                   # product design reviews",
  "│   └── sds/                   # software design specifications",
  "├── packages/                  # source modules/services",
  "│   ├── cli/                   # command interfaces",
  "│   ├── core/                  # business/application services",
  "│   └── integrations/          # external adapters/providers",
  "├── openapi/                   # API contracts",
  "├── db/                        # schema and migrations",
  "├── deploy/                    # compose/k8s/runtime manifests",
  "├── tests/                     # unit/integration/e2e suites",
  "└── scripts/                   # build/release/ops automation",
  "```",
].join("\n");

const findSdsSectionTitle = (
  sections: string[],
  pattern: RegExp,
  fallback: string,
): string => sections.find((section) => pattern.test(section)) ?? fallback;

const ensureTrailingPeriod = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/[.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
};

const normalizeResolvedEntry = (line: string): string | undefined => {
  const stripped = line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
  if (!stripped) return undefined;
  if (/no unresolved questions remain|no open questions remain/i.test(stripped)) {
    return "Resolved: No unresolved questions remain.";
  }
  const withoutPrefix = stripped.replace(/^resolved:\s*/i, "").trim();
  const withoutQuestions = withoutPrefix.replace(/\?+$/, "").trim();
  if (!withoutQuestions) return undefined;
  return `Resolved: ${ensureTrailingPeriod(withoutQuestions)}`;
};

const enforceResolvedOpenQuestionsContract = (draft: string, sections: string[]): string => {
  const title = findSdsSectionTitle(sections, /open questions?/i, "Open Questions (Resolved)");
  const section = extractSection(draft, title);
  if (!section) return draft;
  const resolvedEntries = section.body
    .split(/\r?\n/)
    .map(normalizeResolvedEntry)
    .filter((value): value is string => Boolean(value));
  const deduped = Array.from(new Set(resolvedEntries.map((entry) => entry.toLowerCase()))).map((lower) =>
    resolvedEntries.find((entry) => entry.toLowerCase() === lower)!,
  );
  const body =
    deduped.length > 0
      ? deduped.map((entry) => `- ${entry}`).join("\n")
      : "- Resolved: No unresolved questions remain.";
  return replaceSection(draft, title, body);
};

const enforceTechStackContract = (draft: string, sections: string[]): string => {
  const title = findSdsSectionTitle(sections, /platform model|technology stack|tech stack/i, sections[0] ?? "Architecture");
  const section = extractSection(draft, title);
  if (!section) return draft;
  const body = cleanBody(section.body ?? "");
  const additions: string[] = [];
  if (!/chosen stack|selected stack|primary stack|we use/i.test(body)) {
    additions.push("- Chosen stack: declare the selected runtime, language, persistence, and tooling baseline.");
  }
  if (!/alternatives? considered|options? considered|alternative/i.test(body)) {
    additions.push("- Alternatives considered: list realistic options that were evaluated but not selected.");
  }
  if (!/rationale|trade[- ]?off|because|why/i.test(body)) {
    additions.push("- Rationale: document why the selected stack is preferred for delivery, operations, and maintenance.");
  }
  if (additions.length === 0) return draft;
  const merged = [body, ...additions].filter(Boolean).join("\n");
  return replaceSection(draft, title, merged);
};

const enforceFolderTreeContract = (draft: string, sections: string[]): string => {
  const title = findSdsSectionTitle(
    sections,
    /folder tree|directory structure|repository structure|target structure/i,
    "Target Folder Tree (Expanded with File Responsibilities)",
  );
  const section = extractSection(draft, title);
  if (!section) return draft;
  const body = section.body ?? "";
  const treeBlock = body.match(/```(?:text)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const treeEntries =
    treeBlock?.split(/\r?\n/).filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed === ".") return true;
      if (/^[├└│]/.test(trimmed)) return true;
      return /[A-Za-z0-9_.-]+\/?/.test(trimmed);
    }).length ?? 0;
  const hasResponsibilityHints = treeBlock ? /#|responsibilit|owner|module|service|tests?|scripts?/i.test(treeBlock) : false;
  const hasFence = /```(?:text)?[\s\S]*?```/i.test(body);

  if (hasFence && treeEntries >= 8 && hasResponsibilityHints) return draft;

  const mergedBody = cleanBody(body).length > 0 ? `${cleanBody(body)}\n\n${DEFAULT_SDS_FOLDER_TREE_BLOCK}` : DEFAULT_SDS_FOLDER_TREE_BLOCK;
  return replaceSection(draft, title, mergedBody);
};

const applySdsHardContracts = (draft: string, sections: string[]): string => {
  let updated = draft;
  updated = enforceTechStackContract(updated, sections);
  updated = enforceFolderTreeContract(updated, sections);
  updated = enforceResolvedOpenQuestionsContract(updated, sections);
  return updated;
};

const ensureSdsStructuredDraft = (
  draft: string,
  projectKey: string | undefined,
  context: SdsContext,
  template: string,
): string => {
  const normalized = draft.trim();
  const templateHeadings = template
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim());

  const defaultSections = DEFAULT_SDS_SECTION_OUTLINE;

  const sections = templateHeadings.length ? templateHeadings : defaultSections;
  const cues = extractBullets(context.pdrs[0]?.content ?? context.rfp?.content ?? "", 10);
  const assumptionFallback =
    context.warnings.length > 0
      ? context.warnings.map((w) => `- Assumption/Gap: ${w}`).join("\n")
      : "- Document assumptions and dependencies.";

  const fallbackFor = (section: string): string => {
    const key = section.toLowerCase();
    if (key.includes("governance") || key.includes("change policy")) {
      return [
        "- Versioning: major/minor SDS revisions are tracked with implementation impact notes.",
        "- Change control: architectural, schema, API, and security changes require explicit decision entries.",
        "- Review cadence: update this SDS before task generation and before release hardening.",
      ].join("\n");
    }
    if (key.includes("purpose") || key.includes("scope")) {
      return cues.length ? cues.map((c) => `- ${c}`).join("\n") : "- Scope and objectives derived from PDR/RFP.";
    }
    if (key.includes("boundaries") || key.includes("non-goals")) {
      return [
        "- In-scope capabilities are limited to documented product outcomes and owned interfaces.",
        "- Out-of-scope paths are explicitly excluded to prevent accidental scope drift.",
      ].join("\n");
    }
    if (key.includes("core decisions")) {
      return [
        "- Runtime and language decisions are explicit and finalized for this delivery phase.",
        "- Data ownership boundaries and source-of-truth services are fixed.",
        "- API contract authority and compatibility policy are fixed before implementation.",
      ].join("\n");
    }
    if (key.includes("platform model") || key.includes("technology stack")) {
      return [
        "- Chosen stack: TypeScript services, relational persistence, and deterministic CI/CD workflows.",
        "- Alternatives considered: Python-first service core and JVM stack; rejected for this phase due to operational complexity and delivery latency.",
        "- Rationale: the chosen stack aligns with current team skills, release constraints, and maintainability goals.",
      ].join("\n");
    }
    if (key.includes("service architecture") || key.includes("dependency contracts")) {
      return [
        "- Define service boundaries, ownership, and contract direction (provider -> consumer).",
        "- Define startup dependency sequencing (foundational services first, dependent services after readiness).",
        "- Include health/readiness contracts and failure containment boundaries per service.",
      ].join("\n");
    }
    if (key.includes("data architecture") || key.includes("ownership")) {
      return [
        "- Define primary entities, write ownership, read models, and migration strategy.",
        "- Document retention, auditability, and schema evolution rules.",
      ].join("\n");
    }
    if (key.includes("eventing") || key.includes("interfaces") || key.includes("api")) {
      return [
        "- Define synchronous API contracts, async events, and schema compatibility rules.",
        "- Bind all external/public operations to OpenAPI references when available.",
      ].join("\n");
    }
    if (key.includes("security") || key.includes("iam") || key.includes("compliance")) {
      return [
        "- Document authentication, authorization, secret handling, and audit trails.",
        "- Define compliance boundaries for data handling and privileged operations.",
      ].join("\n");
    }
    if (key.includes("risk and control")) {
      return [
        "- Define risk gates, escalation paths, and release veto conditions.",
        "- Define controls for data quality, rollback triggers, and emergency stop criteria.",
      ].join("\n");
    }
    if (key.includes("compute") || key.includes("deployment") || key.includes("startup sequencing")) {
      return [
        "- Define runtime topology, environment contracts, and deployment wave order.",
        "- Define startup/readiness dependencies and rollback-safe rollout strategy.",
      ].join("\n");
    }
    if (key.includes("folder tree")) {
      return [
        "```text",
        ".",
        "├── docs/                      # product and architecture docs",
        "│   ├── rfp/                   # requirement sources",
        "│   ├── pdr/                   # product design reviews",
        "│   └── sds/                   # software design specifications",
        "├── packages/                  # source modules/services",
        "│   ├── cli/                   # command interfaces",
        "│   ├── core/                  # business/application services",
        "│   └── integrations/          # external adapters/providers",
        "├── openapi/                   # API contracts",
        "├── db/                        # schema and migrations",
        "├── deploy/                    # compose/k8s/runtime manifests",
        "├── tests/                     # unit/integration/e2e suites",
        "└── scripts/                   # build/release/ops automation",
        "```",
      ].join("\n");
    }
    if (key.includes("operations") || key.includes("observability") || key.includes("quality")) {
      return [
        "- Define SLOs with alert thresholds and runbook actions for breaches.",
        "- Define required test gates (unit/component/integration/e2e) before promotion.",
        "- Define operational dashboards, logging standards, and incident drill cadence.",
      ].join("\n");
    }
    if (key.includes("external integrations") || key.includes("adapter")) {
      return [
        "- For each external provider, document contract, rate limit/quota constraints, and timeout budgets.",
        "- Document adapter error handling, retry/backoff policy, and fallback behavior.",
      ].join("\n");
    }
    if (key.includes("policy") || key.includes("telemetry") || key.includes("metering")) {
      return [
        "- Policy: define cache key construction, TTL tiers, and consent matrix handling.",
        "- Telemetry: define schema for anonymous and identified events, including validation rules.",
        "- Metering: define usage collection, rate limits, quota enforcement, and billing/audit traces.",
      ].join("\n");
    }
    if (key.includes("failure") || key.includes("recovery") || key.includes("rollback")) {
      return [
        "- Enumerate failure modes, detection signals, rollback triggers, and recovery playbooks.",
        "- Define RTO/RPO or equivalent recovery objectives and escalation policy.",
      ].join("\n");
    }
    if (key.includes("assumption")) return assumptionFallback;
    if (key.includes("resolved decisions")) {
      return [
        "- Decision: Architecture, stack, and contract baselines are fixed for this implementation cycle.",
        "- Decision: Dependency sequencing and release gates are mandatory and deterministic.",
      ].join("\n");
    }
    if (key.includes("open question")) {
      return "- Resolved: No unresolved questions remain; implementation blockers are closed.";
    }
    if (key.includes("acceptance") || key.includes("verification")) {
      return [
        "- All required sections are complete, internally consistent, and traceable to source context.",
        "- Deployment and rollback procedures are validated in CI with reproducible artifacts.",
        "- Test gates pass and release readiness checks are green.",
      ].join("\n");
    }
    if (key.includes("goal") || key.includes("scope")) {
      return cues.length ? cues.map((c) => `- ${c}`).join("\n") : "- Goals and scope derived from PDR/RFP.";
    }
    if (key.includes("architecture")) return "- High-level architecture, deployment, and key data flows.";
    if (key.includes("component")) return "- Component responsibilities and interactions.";
    if (key.includes("data")) return "- Data entities, schemas, storage, and migrations.";
    if (key.includes("interface") || key.includes("contract"))
      return "- Interfaces/APIs aligned to OpenAPI; list operation ids or mark TODOs.";
    if (key.includes("non-functional")) return "- Performance, reliability, observability, capacity assumptions.";
    if (key.includes("security")) return "- Authentication, authorization, secrets, compliance, data protection.";
    if (key.includes("failure") || key.includes("resilience"))
      return "- Failure modes, detection, rollback, and recovery paths.";
    if (key.includes("risk")) return "- Enumerate major risks and proposed mitigations.";
    if (key.includes("question")) return "- Resolved: No unresolved questions remain.";
    if (key.includes("acceptance")) return "- Criteria for sign-off and verification.";
    if (key.includes("introduction"))
      return `SDS for ${projectKey ?? "project"} derived from available PDR/RFP context.`;
    return "- Provide explicit implementation-ready decisions, ownership, and verification details.";
  };

  const hasHeading = (title: string) => new RegExp(`^#{1,6}\\s+${title}\\b`, "im").test(normalized);
  const parts: string[] = [];
  if (!/^#\s+/m.test(normalized)) {
    parts.push(`# Software Design Specification${projectKey ? `: ${projectKey}` : ""}`);
  }
  if (normalized) parts.push(normalized);
  for (const section of sections) {
    if (hasHeading(section)) continue;
    parts.push(`## ${section}`);
    parts.push(fallbackFor(section));
  }
  let structured = parts.join("\n\n");
  for (const section of sections) {
    structured = ensureSectionContent(structured, section, fallbackFor(section));
  }
  if ((context.openapi?.length ?? 0) === 0) {
    const interfaceTitle = sections.find((section) => /interface|contract/i.test(section)) ?? "Interfaces & Contracts";
    const extracted = extractSection(structured, interfaceTitle);
    if (extracted) {
      const scrubbed = stripInventedEndpoints(cleanBody(extracted.body ?? ""));
      const openApiFallback =
        "No OpenAPI excerpts available. Capture interface needs as open questions (auth/identity, restaurant suggestions, voting cycles, results/analytics).";
      let body = scrubbed.length > 0 && !/endpoint/i.test(scrubbed) ? scrubbed : cleanBody(openApiFallback);
      if (!/openapi/i.test(body)) {
        body = `${body}\n- No OpenAPI excerpts available; keep endpoints as open questions.`;
      }
      structured = replaceSection(structured, interfaceTitle, body);
    }
  }
  return applySdsHardContracts(structured, sections);
};

const getSdsSections = (template: string): string[] => {
  const templateHeadings = template
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim());

  const defaultSections = DEFAULT_SDS_SECTION_OUTLINE;

  const sections = templateHeadings.length ? templateHeadings : defaultSections;
  const seen = new Set<string>();
  const unique = sections.filter((title) => {
    const key = title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique;
};

const tidySdsDraft = async (
  draft: string,
  sections: string[],
  agent: Agent,
  invoke: (prompt: string) => Promise<{ output: string; adapter: string }>,
): Promise<string> => {
  const prompt = [
    "Tidy the following Software Design Specification markdown:",
    draft,
    "",
    "Requirements:",
    `- Keep exactly one instance of each H2 section in this order: ${sections.join(", ")}.`,
    "- Remove duplicate sections, bold headings pretending to be sections, placeholder sentences, and repeated bullet blocks. If content is duplicated, keep the richer/longer version.",
    "- Do not add new sections or reorder the required outline.",
    "- Keep content concise and aligned to the headings. Do not alter semantics.",
    "- Return only the cleaned markdown.",
  ].join("\n");
  const { output } = await invoke(prompt);
  return output.trim();
};

const enrichSdsDraft = async (
  draft: string,
  sections: string[],
  agent: Agent,
  context: SdsContext,
  projectKey: string | undefined,
  invoke: (prompt: string) => Promise<{ output: string; adapter: string }>,
): Promise<string> => {
  let enriched = draft;
  const contextLines = context.blocks.map((b) => `- ${b.label}: ${b.summary}`).join("\n") || "- (no additional context)";
  for (const sectionTitle of sections) {
    const current = extractSection(enriched, sectionTitle);
    const currentBody = current?.body ?? "";
    const prompt = [
      `You are enriching an SDS section "${sectionTitle}" for project ${projectKey ?? "(unspecified)"} using only provided context.`,
      `Context summary: ${context.summary}`,
      `Context blocks:\n${contextLines}`,
      `Current section "${sectionTitle}":\n${currentBody || "(empty)"}`,
      "Enrich this section with concrete, actionable content. Keep it concise (bullets acceptable).",
      "Do NOT remove the heading. Return only the updated section, starting with the heading. Do not include any other sections.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const { output } = await invoke(prompt);
    const replacement = parseSectionFromAgentOutput(output, sectionTitle);
    if (replacement && replacement.trim().length > 0) {
      enriched = replaceSection(enriched, sectionTitle, replacement);
    }
  }
  return enriched;
};

const parseTocHeadings = (toc: string, fallback: string[]): string[] => {
  const lines = toc
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const headings: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const stripped = line
      .replace(/^[\d]+\.\s*/, "")
      .replace(/^[-*+]\s*/, "")
      .replace(/^#+\s*/, "")
      .trim();
    if (!stripped) continue;
    const key = stripped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    headings.push(stripped);
  }
  if (headings.length === 0) return fallback;
  return headings;
};

const parseTocEntries = (
  toc: string,
  fallback: string[],
): { title: string; label?: string }[] => {
  const lines = toc
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const entries: { title: string; label?: string }[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const stripped = line.replace(/^[-*+]\s*/, "");
    const match = stripped.match(/^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/);
    const label = match?.[1] ? `${match[1]}.` : undefined;
    const title = (match?.[2] ?? stripped).replace(/^#+\s*/, "").trim();
    if (!title) continue;
    const key = `${(label ?? "").toLowerCase()}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ title, label });
  }
  if (entries.length === 0) {
    return fallback.map((title, idx) => ({ title, label: `${idx + 1}.` }));
  }
  // Ensure every entry has a label for numbering; fill gaps sequentially.
  let counter = 1;
  for (const entry of entries) {
    if (!entry.label) {
      entry.label = `${counter}.`;
    }
    counter += 1;
  }
  return entries;
};

const buildIterativePdr = async (
  projectKey: string | undefined,
  context: PdrContext,
  firstDraft: string,
  outputPath: string,
  invoke: (prompt: string) => Promise<{ output: string; adapter: string }>,
): Promise<string> => {
  const header = `# Product Design Review${projectKey ? `: ${projectKey}` : ""}`;
  await ensureDir(outputPath);
  const tocPrompt = [
    "Generate ONLY a concise table of contents for the Product Design Review using the provided RFP and first draft. Do not include any section content.",
    "Return bullets or numbered lines that represent the H2 sections in order.",
    `RFP path: ${context.rfp.path ?? context.rfp.id ?? "RFP"}`,
    "RFP excerpt:",
    (context.rfp.content ?? "").slice(0, 4000),
    "Current PDR draft:",
    firstDraft,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { output: tocOutput } = await invoke(tocPrompt);
  const tocHeadings = parseTocHeadings(tocOutput, PDR_REQUIRED_HEADINGS.map((variants) => variants[0]));
  let currentDoc = [header, "## Table of Contents", cleanBody(tocOutput)].join("\n\n");
  await fs.writeFile(outputPath, currentDoc, "utf8");
  for (const heading of tocHeadings) {
    const sectionPrompt = [
      `Generate the section "${heading}" for a Product Design Review.`,
      `Project: ${projectKey ?? "(unspecified)"}`,
      `RFP path: ${context.rfp.path ?? context.rfp.id ?? "RFP"}`,
      "RFP excerpt:",
      (context.rfp.content ?? "").slice(0, 4000),
      "First PDR draft (saved as first-draft):",
      firstDraft.slice(0, 8000),
      "Current improved document so far:",
      currentDoc.slice(0, 8000),
      "Other available docs: none beyond RFP and first draft (no SDS exists yet).",
      "Table of contents:",
      tocHeadings.map((h) => `- ${h}`).join("\n"),
      "Requirements:",
      "- Return only this section starting with the proper H2 heading.",
      "- Be concrete, avoid placeholders, and align with the TOC heading text.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const { output: sectionOutput } = await invoke(sectionPrompt);
    const parsed = parseSectionFromAgentOutput(sectionOutput, heading) ?? cleanBody(sectionOutput);
    currentDoc = `${currentDoc}\n\n## ${heading}\n${parsed}`;
    await fs.writeFile(outputPath, currentDoc, "utf8");
  }
  if (!/^\s*##\s+Source RFP\b/im.test(currentDoc)) {
    currentDoc = `${currentDoc}\n\n## Source RFP\n${context.rfp.path ?? context.rfp.id ?? "RFP"}`;
    await fs.writeFile(outputPath, currentDoc, "utf8");
  }
  return currentDoc;
};

const buildIterativeSds = async (
  projectKey: string | undefined,
  context: SdsContext,
  firstDraft: string,
  sections: string[],
  outputPath: string,
  invoke: (prompt: string) => Promise<{ output: string; adapter: string }>,
): Promise<string> => {
  const header = `# Software Design Specification${projectKey ? `: ${projectKey}` : ""}`;
  await ensureDir(outputPath);
  const tocPrompt = [
    "Generate ONLY a concise table of contents for the Software Design Specification using the provided context and first draft. Do not include section content.",
    "Return numbered lines that represent the H2 sections in order (e.g., '1. Introduction', '2. Goals & Scope'). Include numbers so they can be mirrored in section headings.",
    `Context summary: ${context.summary}`,
    "Existing SDS draft:",
    firstDraft,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { output: tocOutput } = await invoke(tocPrompt);
  const tocEntries = parseTocEntries(tocOutput, sections);
  const tocHeadings = tocEntries.map((e) => (e.label ? `${e.label} ${e.title}` : e.title));
  let currentDoc = [header, "## Table of Contents", cleanBody(tocOutput)].join("\n\n");
  await fs.writeFile(outputPath, currentDoc, "utf8");
  const referenceDocs = [
    context.rfp?.content ?? "",
    ...context.pdrs.map((p) => p.content ?? ""),
    ...context.existingSds.map((s) => s.content ?? ""),
  ]
    .filter(Boolean)
    .map((c) => c.slice(0, 4000))
    .join("\n\n---\n\n");
  for (const entry of tocEntries) {
    const heading = entry.label ? `${entry.label} ${entry.title}` : entry.title;
    const sectionPrompt = [
      `Generate the section "${heading}" for a Software Design Specification.`,
      `Project: ${projectKey ?? "(unspecified)"}`,
      `Context summary: ${context.summary}`,
      "Reference materials:",
      referenceDocs || "(no additional docs)",
      "First SDS draft (saved as first-draft):",
      firstDraft.slice(0, 8000),
      "Current improved document so far:",
      currentDoc.slice(0, 8000),
      "PDR and RFP content have been provided above as reference.",
      "Table of contents:",
      tocHeadings.map((h) => `- ${h}`).join("\n"),
      "Requirements:",
      "- Return only this section starting with the proper H2 heading.",
      "- Be concrete, avoid placeholders, and align with the TOC heading text.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const { output: sectionOutput } = await invoke(sectionPrompt);
    const parsed = parseSectionFromAgentOutput(sectionOutput, heading) ?? cleanBody(sectionOutput);
    currentDoc = `${currentDoc}\n\n## ${heading}\n${parsed}`;
    await fs.writeFile(outputPath, currentDoc, "utf8");
  }
  return currentDoc;
};

const headingHasContent = (draft: string, title: string): boolean => {
  const regex = new RegExp(`^#{1,6}\\s+${title}\\b([\\s\\S]*?)(^#{1,6}\\s+|$)`, "im");
  const match = draft.match(regex);
  if (match) {
    // If the heading exists, assume it has content (we already inject fallbacks elsewhere).
    return true;
  }
  // Fallback: treat bolded headings like "**Introduction**" as valid.
  const boldRegex = new RegExp(`\\*\\*${title}\\*\\*`, "i");
  return boldRegex.test(draft);
};

const normalizeHeadingsToH2 = (draft: string, titles: string[]): string => {
  let updated = draft;
  for (const title of titles) {
    const bold = new RegExp(`^\\s*\\*\\*${title}\\*\\*\\s*$`, "im");
    updated = updated.replace(bold, `## ${title}`);
  }
  return updated;
};

const PLACEHOLDER_PATTERNS = [
  /^[-*+.]?\s*Describe the system architecture/i,
  /^[-*+.]?\s*List key interfaces/i,
  /^[-*+.]?\s*Outline the functional boundaries/i,
  /^[-*+.]?\s*Outstanding questions/i,
  /^[-*+.]?\s*Performance, reliability, compliance/i,
  /^[-*+.]?\s*Enumerate risks from the RFP/i,
  /^I (will|am going to|plan to|am)\s+(read|review|analy[sz]e|gather|start|begin|look|scan)\b/i,
];

const cleanBody = (body: string): string => {
  const requiredTitles = PDR_REQUIRED_HEADINGS.flat().map((t) => t.toLowerCase());
  const normalizeLine = (line: string) =>
    line
      .toLowerCase()
      .replace(/[`*_]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (/^#{1,6}\s+/.test(l)) return false; // strip stray headings
      if (/^\*{2}.+?\*{2}$/.test(l) && requiredTitles.includes(l.replace(/\*/g, "").toLowerCase())) return false;
      if (PLACEHOLDER_PATTERNS.some((p) => p.test(l))) return false;
      if (requiredTitles.includes(l.toLowerCase())) return false; // drop stray title text
      return true;
    });
  const deduped: string[] = [];
  const seen: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    const key = normalizeLine(line);
    if (!key) continue;
    const isDuplicate = seen.some((prev) => prev === key || prev.includes(key) || key.includes(prev));
    if (isDuplicate) continue;
    seen.push(key);
    deduped.push(line);
  }
  return deduped.join("\n").trim();
};

const stripInventedEndpoints = (body: string): string => {
  const lines = body.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const normalized = line.replace(/[`*_]/g, "");
    return !/(^|\s)\b(GET|POST|PUT|PATCH|DELETE)\b[^\n]*\//i.test(normalized);
  });
  return filtered.join("\n").trim();
};

const extractSection = (draft: string, title: string): { heading: string; body: string } | undefined => {
  const regex = new RegExp(`(^#{1,6}\\s+${title}\\b)([\\s\\S]*?)(?=^#{1,6}\\s+|(?![\\s\\S]))`, "im");
  const match = draft.match(regex);
  if (!match) return undefined;
  return { heading: match[1], body: (match[2] ?? "").trim() };
};

const getBestSectionBody = (draft: string, title: string): string | undefined => {
  const variants: string[] = [];
  const headingPattern = `(^#{1,6}\\s+${title}\\b[^\\n]*$|^\\*\\*${title}\\*\\*\\s*$)`;
  const regex = new RegExp(
    `${headingPattern}([\\s\\S]*?)(?=^#{1,6}\\s+|^\\*\\*[^\\n]+\\*\\*\\s*$|(?![\\s\\S]))`,
    "gim",
  );
  let match: RegExpExecArray | null;
  while ((match = regex.exec(draft)) !== null) {
    variants.push(match[2] ?? "");
  }
  const cleaned = variants
    .map((body) => cleanBody(body))
    .filter((body) => body.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  return cleaned[0];
};

const replaceSection = (draft: string, title: string, newBody: string): string => {
  const normalizedBody = cleanBody(newBody);
  const regex = new RegExp(
    `(^#{1,6}\\s+${title}\\b)([\\s\\S]*?)(?=^#{1,6}\\s+|(?![\\s\\S]))`,
    "im",
  );
  if (regex.test(draft)) {
    return draft.replace(regex, `$1\n\n${normalizedBody}\n\n`);
  }
  return `${draft.trimEnd()}\n\n## ${title}\n${normalizedBody}\n`;
};

const parseSectionFromAgentOutput = (output: string, title: string): string | undefined => {
  // Prefer content under a heading matching the title.
  const extracted = extractSection(output, title);
  if (extracted && extracted.body.length > 0) return cleanBody(extracted.body);
  // Fallback: if the agent returned without heading, use text before any other heading.
  const preHeading = output.split(/^#{1,6}\s+/m)[0]?.trim();
  if (preHeading && preHeading.length > 0) return cleanBody(preHeading);
  const trimmed = output.trim();
  return trimmed.length > 0 ? cleanBody(trimmed) : undefined;
};

const enrichPdrDraft = async (
  draft: string,
  agent: Agent,
  context: PdrContext,
  projectKey: string | undefined,
  invoke: (prompt: string) => Promise<{ output: string; adapter: string }>,
): Promise<string> => {
  let enriched = draft;
  for (const section of PDR_ENRICHMENT_SECTIONS) {
    const current = extractSection(enriched, section.title);
    const currentBody = current?.body ?? "";
    const guidance = section.guidance.join("\n- ");
    const prompt = [
      `You are enriching a Product Design Review section for project ${projectKey ?? "(unspecified)"} using only provided context.`,
      `Context summary: ${context.summary}`,
      `RFP cues:\n${context.bullets.map((b) => `- ${b}`).join("\n") || "- (none)"}`,
      `Current section "${section.title}":\n${currentBody || "(empty)"}`,
      "Enrich this section with concrete, actionable content. Keep it concise (bullets ok).",
      "Do NOT remove the heading. Return only the updated section, starting with the heading. Do not include any other sections.",
      `Guidance:\n- ${guidance}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const { output } = await invoke(prompt);
    const replacement = parseSectionFromAgentOutput(output, section.title);
    if (replacement && replacement.trim().length > 0) {
      enriched = replaceSection(enriched, section.title, replacement);
    }
  }
  return enriched;
};

const ensureHeadingContent = (draft: string, title: string, fallback: string): string => {
  const regex = new RegExp(`(^#{1,6}\\s+${title}\\b)([\\s\\S]*?)(^#{1,6}\\s+|$)`, "im");
  const match = draft.match(regex);
  if (!match) {
    return `${draft.trimEnd()}\n\n## ${title}\n${fallback}\n`;
  }
  const body = match[2].trim();
  if (body.length > 0) return draft;
  return draft.replace(regex, `${match[1]}\n\n${fallback}\n\n${match[3] ?? ""}`);
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

export class DocsService {
  private docdex: DocdexClient;
  private jobService: JobService;
  private agentService: AgentService;
  private repo: GlobalRepository;
  private routingService: RoutingService;
  private ratingService?: AgentRatingService;
  private workspaceRepo?: WorkspaceRepository;

  constructor(
    private workspace: WorkspaceResolution,
    deps: {
      docdex?: DocdexClient;
      jobService?: JobService;
      agentService: AgentService;
      repo: GlobalRepository;
      routingService: RoutingService;
      workspaceRepo?: WorkspaceRepository;
      ratingService?: AgentRatingService;
      noTelemetry?: boolean;
    },
  ) {
    const docdexRepoId =
      workspace.config?.docdexRepoId ?? process.env.MCODA_DOCDEX_REPO_ID ?? process.env.DOCDEX_REPO_ID;
    this.docdex = deps?.docdex ?? new DocdexClient({ workspaceRoot: workspace.workspaceRoot, repoId: docdexRepoId });
    this.jobService = deps?.jobService ?? new JobService(workspace, undefined, { noTelemetry: deps?.noTelemetry });
    this.repo = deps.repo;
    this.agentService = deps.agentService;
    this.routingService = deps.routingService;
    this.workspaceRepo = deps.workspaceRepo;
    this.ratingService = deps.ratingService;
  }

  static async create(workspace: WorkspaceResolution, options: { noTelemetry?: boolean } = {}): Promise<DocsService> {
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
    return new DocsService(workspace, { repo, agentService, routingService, docdex, jobService, noTelemetry: options.noTelemetry });
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
    await swallow((this.repo as any).close?.bind(this.repo));
    await swallow((this.jobService as any).close?.bind(this.jobService));
    await swallow((this.workspaceRepo as any)?.close?.bind(this.workspaceRepo));
  }

  private defaultPdrOutputPath(projectKey: string | undefined, rfpPath?: string): string {
    const slug = slugify(projectKey ?? (rfpPath ? path.basename(rfpPath, path.extname(rfpPath)) : "pdr"));
    return path.join(this.workspace.mcodaDir, "docs", "pdr", `${slug}.md`);
  }

  private defaultSdsOutputPath(projectKey?: string): string {
    const slug = slugify(projectKey ?? "sds");
    return path.join(this.workspace.mcodaDir, "docs", "sds", `${slug}.md`);
  }

  private async loadSdsTemplate(templateName?: string): Promise<{ name: string; content: string }> {
    const names = templateName
      ? [templateName.replace(/\.md$/i, "")]
      : ["SDS_default", "sds", "SDS"];
    const dirs = [
      path.join(this.workspace.mcodaDir, "docs", "templates"),
      path.join(this.workspace.workspaceRoot, "docs", "templates"),
    ];
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = path.join(dir, `${name}.md`);
        try {
          const content = await fs.readFile(candidate, "utf8");
          return { name, content };
        } catch {
          // try next
        }
      }
    }
    return { name: templateName ?? "default", content: DEFAULT_SDS_TEMPLATE };
  }

  private buildDocgenCapabilityProfile(input: {
    commandName: DocgenCommandName;
    iterationEnabled: boolean;
  }): { required: string[]; preferred: string[] } {
    const required = ["doc_generation", "docdex_query"];
    const preferred: string[] = [];
    if (input.commandName === "docs-pdr-generate") {
      preferred.push("rfp_creation", "spec_generation");
    }
    if (input.commandName === "docs-sds-generate") {
      preferred.push("sds_writing", "spec_generation");
    }
    if (input.iterationEnabled) {
      preferred.push("multiple_draft_generation", "quick_bug_patching", "code_review");
    }
    return {
      required: Array.from(new Set(required)),
      preferred: Array.from(new Set(preferred)),
    };
  }

  private async collectDocgenCandidates(resolved?: ResolvedAgent): Promise<AgentCapabilityCandidate[]> {
    const candidates = new Map<string, AgentCapabilityCandidate>();
    let agents: Agent[] = [];
    try {
      agents = await this.repo.listAgents();
    } catch {
      agents = [];
    }
    let healthRows: AgentHealth[] = [];
    try {
      healthRows = await this.repo.listAgentHealthSummary();
    } catch {
      healthRows = [];
    }
    const healthById = new Map(healthRows.map((row) => [row.agentId, row.status]));
    for (const agent of agents) {
      let caps: string[] = [];
      try {
        caps = await this.repo.getAgentCapabilities(agent.id);
      } catch {
        caps = agent.capabilities ?? [];
      }
      candidates.set(agent.id, {
        agent,
        capabilities: caps,
        healthStatus: healthById.get(agent.id),
      });
    }
    if (resolved) {
      const existing = candidates.get(resolved.agent.id);
      if (!existing || existing.capabilities.length === 0) {
        candidates.set(resolved.agent.id, {
          agent: resolved.agent,
          capabilities: resolved.capabilities ?? [],
          healthStatus: resolved.healthStatus,
        });
      }
    }
    return Array.from(candidates.values());
  }

  private async selectDocgenAgent(input: {
    agentName?: string;
    commandName: DocgenCommandName;
    commandAliases: string[];
    jobId: string;
    warnings: string[];
    iterationEnabled: boolean;
  }): Promise<Agent> {
    const commandName = input.commandAliases[input.commandAliases.length - 1] ?? input.commandName;
    const profile = this.buildDocgenCapabilityProfile({
      commandName: input.commandName,
      iterationEnabled: input.iterationEnabled,
    });
    let resolved: ResolvedAgent | undefined;
    let resolveError: Error | undefined;
    try {
      resolved = await this.routingService.resolveAgentForCommand({
        workspace: this.workspace,
        commandName,
        overrideAgentSlug: input.agentName,
        requiredCapabilities: profile.required,
      });
    } catch (error) {
      resolveError = error instanceof Error ? error : new Error(String(error));
      resolved = undefined;
    }
    if (!resolved) {
      const candidates = await this.collectDocgenCandidates();
      const selection = selectBestAgentForCapabilities({
        candidates,
        required: profile.required,
        preferred: profile.preferred,
      });
      if (!selection) {
        throw resolveError ?? new Error("No agents available for doc generation.");
      }
      const selected = selection.agent;
      const selectedLabel = selected.slug ?? selected.id;
      const preferredLabel = input.agentName ?? "routing-default";
      const warn = (message: string) => {
        if (!input.warnings.includes(message)) {
          input.warnings.push(message);
        }
      };
      warn(
        `Docgen preflight selected fallback agent ${selectedLabel} (preferred ${preferredLabel}).`,
      );
      if (selection.missingRequired.length > 0) {
        warn(
          `Docgen preflight selected agent ${selectedLabel} missing required capabilities: ${selection.missingRequired.join(", ")}.`,
        );
      }
      const logLines = [
        `[docgen preflight] command=${input.commandName} routing=${commandName}`,
        `[docgen preflight] preferred=${preferredLabel} selected=${selectedLabel} fallback=yes`,
        `[docgen preflight] required=${profile.required.join(", ") || "none"}`,
        `[docgen preflight] preferred_caps=${profile.preferred.join(", ") || "none"}`,
        `[docgen preflight] missing_required=${selection.missingRequired.join(", ") || "none"}`,
        `[docgen preflight] missing_preferred=${selection.missingPreferred.join(", ") || "none"}`,
        `[docgen preflight] reason=${selection.reason}`,
        resolveError ? `[docgen preflight] routing_error=${resolveError.message}` : undefined,
      ].filter(Boolean) as string[];
      await this.jobService.appendLog(input.jobId, `${logLines.join("\n")}\n`);
      await this.jobService.writeCheckpoint(input.jobId, {
        stage: "agent_preflight",
        timestamp: new Date().toISOString(),
        details: {
          commandName: input.commandName,
          routingCommand: commandName,
          preferredAgent: preferredLabel,
          selectedAgent: selectedLabel,
          fallbackUsed: true,
          requiredCapabilities: profile.required,
          preferredCapabilities: profile.preferred,
          missingRequired: selection.missingRequired,
          missingPreferred: selection.missingPreferred,
          reason: selection.reason,
          routingError: resolveError?.message,
        },
      });
      return selected;
    }
    const resolvedMissing = profile.required.filter(
      (cap) => !(resolved.capabilities ?? []).includes(cap),
    );
    const needsFallback = resolvedMissing.length > 0 || resolved.healthStatus === "unreachable";
    const candidates = needsFallback ? await this.collectDocgenCandidates(resolved) : [];
    const selection = needsFallback
      ? selectBestAgentForCapabilities({
          candidates,
          required: profile.required,
          preferred: profile.preferred,
        })
      : undefined;
    const selected = selection?.agent ?? resolved.agent;
    const missingRequired = selection?.missingRequired ?? resolvedMissing;
    const missingPreferred =
      selection?.missingPreferred ??
      profile.preferred.filter((cap) => !(resolved.capabilities ?? []).includes(cap));
    const fallbackUsed = selected.id !== resolved.agent.id;
    const preferredLabel = resolved.agent.slug ?? resolved.agent.id;
    const selectedLabel = selected.slug ?? selected.id;
    const warn = (message: string) => {
      if (!input.warnings.includes(message)) {
        input.warnings.push(message);
      }
    };
    if (fallbackUsed) {
      warn(
        `Docgen preflight selected fallback agent ${selectedLabel} (preferred ${preferredLabel}).`,
      );
    }
    if (missingRequired.length > 0) {
      warn(
        `Docgen preflight selected agent ${selectedLabel} missing required capabilities: ${missingRequired.join(", ")}.`,
      );
    }
    const logLines = [
      `[docgen preflight] command=${input.commandName} routing=${commandName}`,
      `[docgen preflight] preferred=${preferredLabel} selected=${selectedLabel} fallback=${fallbackUsed ? "yes" : "no"}`,
      `[docgen preflight] required=${profile.required.join(", ") || "none"}`,
      `[docgen preflight] preferred_caps=${profile.preferred.join(", ") || "none"}`,
      `[docgen preflight] missing_required=${missingRequired.join(", ") || "none"}`,
      `[docgen preflight] missing_preferred=${missingPreferred.join(", ") || "none"}`,
      `[docgen preflight] reason=${selection?.reason ?? "routing default"}`,
    ];
    await this.jobService.appendLog(input.jobId, `${logLines.join("\n")}\n`);
    await this.jobService.writeCheckpoint(input.jobId, {
      stage: "agent_preflight",
      timestamp: new Date().toISOString(),
      details: {
        commandName: input.commandName,
        routingCommand: commandName,
        preferredAgent: preferredLabel,
        selectedAgent: selectedLabel,
        fallbackUsed,
        requiredCapabilities: profile.required,
        preferredCapabilities: profile.preferred,
        missingRequired,
        missingPreferred,
        reason: selection?.reason,
      },
    });

    return selected;
  }

  private async ensureRatingService(): Promise<AgentRatingService> {
    if (this.ratingService) return this.ratingService;
    if (process.env.MCODA_DISABLE_DB === "1") {
      throw new Error("Workspace DB disabled; agent rating requires DB access.");
    }
    if (!this.workspaceRepo) {
      this.workspaceRepo = await WorkspaceRepository.create(this.workspace.workspaceRoot);
    }
    this.ratingService = new AgentRatingService(this.workspace, {
      workspaceRepo: this.workspaceRepo,
      globalRepo: this.repo,
      agentService: this.agentService,
      routingService: this.routingService,
    });
    return this.ratingService;
  }

  private createRunContext(input: {
    commandName: DocgenCommandName;
    commandRunId: string;
    jobId: string;
    projectKey?: string;
    rfpId?: string;
    rfpPath?: string;
    templateName?: string;
    outputPath: string;
    flags: {
      dryRun: boolean;
      fast: boolean;
      iterate: boolean;
      json: boolean;
      stream: boolean;
      buildReady: boolean;
      noPlaceholders: boolean;
      resolveOpenQuestions: boolean;
      noMaybes: boolean;
      crossAlign: boolean;
    };
    warnings: string[];
  }): DocgenRunContext {
    return {
      version: 1,
      commandName: input.commandName,
      commandRunId: input.commandRunId,
      jobId: input.jobId,
      workspace: this.workspace,
      projectKey: input.projectKey,
      rfpId: input.rfpId,
      rfpPath: input.rfpPath,
      templateName: input.templateName,
      outputPath: input.outputPath,
      createdAt: new Date().toISOString(),
      flags: input.flags,
      iteration: { current: 0, max: 0 },
      artifacts: createEmptyArtifacts(),
      warnings: input.warnings,
    };
  }

  private async recordDocgenStage(
    runContext: DocgenRunContext,
    input: {
      stage: string;
      message: string;
      phase?: string;
      details?: Record<string, unknown>;
      totalItems?: number;
      processedItems?: number;
      heartbeat?: boolean;
    },
  ): Promise<void> {
    const iteration =
      runContext.iteration.max > 0 && runContext.iteration.current > 0
        ? { current: runContext.iteration.current, max: runContext.iteration.max, phase: input.phase }
        : undefined;
    await this.jobService.recordJobProgress(runContext.jobId, {
      stage: input.stage,
      message: input.message,
      iteration,
      details: input.details,
      totalItems: input.totalItems,
      processedItems: input.processedItems,
      heartbeat: input.heartbeat,
    });
  }

  private async enforceToolDenylist(input: {
    runContext: DocgenRunContext;
    agent: Agent;
  }): Promise<void> {
    const denylist = await ToolDenylist.load({
      mcodaDir: this.workspace.mcodaDir,
      env: process.env,
    });
    const identifiers = [input.agent.slug, input.agent.adapter, input.agent.id].filter(
      (value): value is string => Boolean(value),
    );
    const matched = denylist.findMatch(identifiers);
    if (!matched) return;

    const message = denylist.formatViolation(matched);
    const artifact = input.runContext.commandName === "docs-pdr-generate" ? "pdr" : "sds";
    const issue: ReviewIssue = {
      id: `gate-tool-denylist-${matched}`,
      gateId: "gate-tool-denylist",
      severity: "blocker",
      category: "compliance",
      artifact,
      message,
      remediation: "Select a non-deprecated agent or update the tool denylist configuration.",
      location: {
        kind: "heading",
        heading: "Tooling Preflight",
        path: input.runContext.outputPath,
      },
      metadata: {
        matchedTool: matched,
        identifiers,
        agentId: input.agent.id,
        agentSlug: input.agent.slug,
        agentAdapter: input.agent.adapter,
        denylist: denylist.list(),
      },
    };
    const gateResult: ReviewGateResult = {
      gateId: "gate-tool-denylist",
      gateName: "Tool Denylist",
      status: "fail",
      issues: [issue],
      notes: [message],
      metadata: {
        matchedTool: matched,
      },
    };
    if (input.runContext.iteration.max === 0) {
      input.runContext.iteration.max = 1;
    }
    const report = this.buildReviewReport({
      runContext: input.runContext,
      gateResults: [gateResult],
      remainingOpenItems: [issue],
      fixesApplied: [],
      iterationStatus: "completed",
    });
    await this.persistReviewReport(input.runContext, "review-final", report);
    await this.jobService.appendLog(input.runContext.jobId, `${message}\n`);
    await this.jobService.writeCheckpoint(input.runContext.jobId, {
      stage: "tool_denylist_blocked",
      timestamp: new Date().toISOString(),
      details: {
        matchedTool: matched,
        identifiers,
        denylist: denylist.list(),
      },
    });
    throw new Error(message);
  }

  private async applyDocPatches(
    runContext: DocgenRunContext,
    patches: DocPatchRequest[],
    options?: { dryRun?: boolean },
  ): Promise<DocPatchApplyResult> {
    const engine = new DocPatchEngine();
    return engine.apply({
      runContext,
      patches,
      dryRun: options?.dryRun ?? runContext.flags.dryRun,
    });
  }

  private resolveMaxIterations(): number {
    const raw = process.env.MCODA_DOCS_MAX_ITERATIONS;
    if (!raw) return 2;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 2;
    return Math.max(1, parsed);
  }

  private isIterationEnabled(runContext: DocgenRunContext): boolean {
    if (runContext.flags.dryRun) return false;
    if (runContext.flags.iterate) return true;
    if (runContext.flags.fast) return false;
    return true;
  }

  private shouldBlockGate(gateId: string, runContext: DocgenRunContext): boolean {
    if (ALWAYS_BLOCKING_GATES.has(gateId)) return true;
    const resolveOpenQuestions =
      runContext.flags.resolveOpenQuestions ||
      process.env.MCODA_DOCS_RESOLVE_OPEN_QUESTIONS === "1";
    if (gateId === "gate-open-questions" && resolveOpenQuestions) {
      return true;
    }
    if (BUILD_READY_ONLY_GATES.has(gateId)) return runContext.flags.buildReady;
    return false;
  }

  private appendUniqueWarnings(runContext: DocgenRunContext, values: string[]): void {
    for (const value of values) {
      if (!value) continue;
      if (runContext.warnings.includes(value)) continue;
      runContext.warnings.push(value);
    }
  }

  private summarizeIssues(issues: ReviewIssue[]): string {
    const summary = issues
      .slice(0, 3)
      .map((issue) => `${issue.artifact}: ${issue.message}`)
      .join(" ");
    const suffix = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
    return `${summary}${suffix}`;
  }

  private appendGateWarnings(
    runContext: DocgenRunContext,
    gate: ReviewGateResult,
    blocking: boolean,
  ): void {
    if (gate.notes?.length) {
      this.appendUniqueWarnings(runContext, gate.notes);
    }
    if (blocking) return;
    if (gate.issues.length === 0) return;
    const summary = this.summarizeIssues(gate.issues);
    this.appendUniqueWarnings(runContext, [
      `${gate.gateName} issues (${gate.issues.length}). ${summary}`,
    ]);
  }

  private async runReviewGates(
    runContext: DocgenRunContext,
    phase: "review" | "recheck" = "review",
  ): Promise<{ gateResults: ReviewGateResult[]; blockingIssues: ReviewIssue[] }> {
    const gateResults: ReviewGateResult[] = [];
    const blockingIssues: ReviewIssue[] = [];
    const phaseLabel = phase === "recheck" ? "Re-check" : "Review";

    const runGate = async (
      gateId: string,
      gateName: string,
      runner: () => Promise<ReviewGateResult> | ReviewGateResult,
    ): Promise<ReviewGateResult> => {
      await this.recordDocgenStage(runContext, {
        stage: `${phase}:${gateId}`,
        message: `${phaseLabel}: ${gateName}`,
        phase,
        heartbeat: true,
        details: { gateId, gateName },
      });
      return await runner();
    };

    const addResult = (result: ReviewGateResult): void => {
      const blocking = this.shouldBlockGate(result.gateId, runContext);
      if (result.status === "fail" && blocking) {
        blockingIssues.push(...result.issues);
      }
      const normalized: ReviewGateResult =
        result.status === "fail" && !blocking ? { ...result, status: "warn" } : result;
      this.appendGateWarnings(runContext, normalized, blocking);
      gateResults.push(normalized);
    };

    const stateWarnings = (runContext.stateWarnings ?? []).filter(
      (warning) => typeof warning === "string" && warning.trim().length > 0,
    );
    const stateArtifact = runContext.commandName === "docs-pdr-generate" ? "pdr" : "sds";
    const stateIssues: ReviewIssue[] = stateWarnings.map((warning, index) => ({
      id: `gate-state-dir-cleanup-${index + 1}`,
      gateId: "gate-state-dir-cleanup",
      severity: "info",
      category: "compliance",
      artifact: stateArtifact,
      message: warning,
      remediation:
        "Keep docgen intermediate state under .mcoda or OS temp directories and relocate legacy state directories into .mcoda.",
      location: { kind: "heading", heading: "State Directory Cleanup", path: runContext.outputPath },
    }));
    addResult({
      gateId: "gate-state-dir-cleanup",
      gateName: "State Directory Cleanup",
      status: stateIssues.length > 0 ? "warn" : "pass",
      issues: stateIssues,
    });

    if (runContext.flags.noPlaceholders || runContext.flags.buildReady) {
      const allowlist = parseDelimitedList(process.env.MCODA_DOCS_PLACEHOLDER_ALLOWLIST);
      const denylist = parseDelimitedList(process.env.MCODA_DOCS_PLACEHOLDER_DENYLIST);
      addResult(
        await runGate("gate-placeholder-artifacts", "Placeholder Artifacts", () =>
          runPlaceholderArtifactGate({
            artifacts: runContext.artifacts,
            allowlist: allowlist.length > 0 ? allowlist : undefined,
            denylist: denylist.length > 0 ? denylist : undefined,
          }),
        ),
      );
    } else {
      const skippedGate: ReviewGateResult = {
        gateId: "gate-placeholder-artifacts",
        gateName: "Placeholder Artifacts",
        status: "skipped",
        issues: [],
        notes: ["Placeholder gate disabled (noPlaceholders/buildReady not set)."],
      };
      addResult(skippedGate);
    }

    addResult(
      await runGate("gate-api-path-consistency", "API Path Consistency", () =>
        runApiPathConsistencyGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-openapi-schema-sanity", "OpenAPI Schema Sanity", () =>
        runOpenApiSchemaSanityGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-openapi-coverage", "OpenAPI Coverage", () =>
        runOpenApiCoverageGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-sql-syntax", "SQL Syntax", () =>
        runSqlSyntaxGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-sql-required-tables", "SQL Required Tables", () =>
        runSqlRequiredTablesGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-admin-openapi-spec", "Admin OpenAPI Spec", () =>
        runAdminOpenApiSpecGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-terminology-normalization", "Terminology Normalization", () =>
        runTerminologyNormalizationGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-open-questions", "Open Questions", () =>
        runOpenQuestionsGate({ artifacts: runContext.artifacts }),
      ),
    );

    const resolveOpenQuestions =
      runContext.flags.resolveOpenQuestions ||
      process.env.MCODA_DOCS_RESOLVE_OPEN_QUESTIONS === "1";
    const noMaybesEnabled =
      runContext.flags.noMaybes ||
      process.env.MCODA_DOCS_NO_MAYBES === "1" ||
      resolveOpenQuestions;
    addResult(
      await runGate("gate-no-maybes", "No Maybes", () =>
        runNoMaybesGate({
          artifacts: runContext.artifacts,
          enabled: noMaybesEnabled,
        }),
      ),
    );

    addResult(
      await runGate("gate-rfp-consent", "RFP Consent", () =>
        runRfpConsentGate({ rfpPath: runContext.rfpPath }),
      ),
    );

    const definitionAllowlist = parseDelimitedList(
      process.env.MCODA_DOCS_RFP_DEFINITION_ALLOWLIST,
    );
    addResult(
      await runGate("gate-rfp-definition", "RFP Definition Coverage", () =>
        runRfpDefinitionGate({
          rfpPath: runContext.rfpPath,
          allowlist: definitionAllowlist.length > 0 ? definitionAllowlist : undefined,
        }),
      ),
    );

    addResult(
      await runGate("gate-pdr-interfaces", "PDR Interfaces", () =>
        runPdrInterfacesGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-pdr-ownership", "PDR Ownership", () =>
        runPdrOwnershipGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-pdr-tech-stack-rationale", "PDR Tech Stack Rationale", () =>
        runPdrTechStackRationaleGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-pdr-folder-tree", "PDR Folder Tree", () =>
        runPdrFolderTreeGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-pdr-no-unresolved-items", "PDR No Unresolved Items", () =>
        runPdrNoUnresolvedItemsGate({ artifacts: runContext.artifacts }),
      ),
    );

    const openQuestionsEnabled = resolveOpenQuestions;
    addResult(
      await runGate("gate-pdr-open-questions", "PDR Open Questions", () =>
        runPdrOpenQuestionsGate({
          artifacts: runContext.artifacts,
          enabled: openQuestionsEnabled,
        }),
      ),
    );

    addResult(
      await runGate("gate-sds-explicit-decisions", "SDS Explicit Decisions", () =>
        runSdsDecisionsGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-sds-tech-stack-rationale", "SDS Tech Stack Rationale", () =>
        runSdsTechStackRationaleGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-sds-folder-tree", "SDS Folder Tree", () =>
        runSdsFolderTreeGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-sds-no-unresolved-items", "SDS No Unresolved Items", () =>
        runSdsNoUnresolvedItemsGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-sds-policy-telemetry", "SDS Policy Telemetry", () =>
        runSdsPolicyTelemetryGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-sds-ops-observability-testing", "SDS Ops/Observability/Testing", () =>
        runSdsOpsGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-sds-external-adapters", "SDS External Adapters", () =>
        runSdsAdaptersGate({ artifacts: runContext.artifacts }),
      ),
    );
    addResult(
      await runGate("gate-deployment-blueprint", "Deployment Blueprint", () =>
        runDeploymentBlueprintGate({
          artifacts: runContext.artifacts,
          buildReady: runContext.flags.buildReady,
        }),
      ),
    );
    addResult(
      await runGate("gate-build-ready-completeness", "Build Ready Completeness", () =>
        runBuildReadyCompletenessGate({
          artifacts: runContext.artifacts,
          buildReady: runContext.flags.buildReady,
        }),
      ),
    );

    return { gateResults, blockingIssues };
  }

  private buildPatchPlanFromIssues(inputIssues: ReviewIssue[]): {
    patches: DocPatchRequest[];
    fixes: ReviewFix[];
  } {
    const patchesByPath = new Map<string, DocPatchRequest>();
    const fixes: ReviewFix[] = [];
    const seenRanges = new Set<string>();

    for (const issue of inputIssues) {
      if (issue.gateId !== "gate-placeholder-artifacts") continue;
      if (issue.location.kind !== "line_range") continue;
      const key = `${issue.location.path}:${issue.location.lineStart}-${issue.location.lineEnd}`;
      if (seenRanges.has(key)) continue;
      seenRanges.add(key);

      const patch =
        patchesByPath.get(issue.location.path) ??
        {
          path: issue.location.path,
          operations: [],
        };
      patch.operations.push({
        type: "remove_block",
        location: issue.location,
      });
      patchesByPath.set(issue.location.path, patch);

      fixes.push({
        issueId: issue.id,
        summary: `Removed placeholder content in ${path.basename(issue.location.path)}`,
        appliedAt: new Date().toISOString(),
        metadata: {
          gateId: issue.gateId,
          path: issue.location.path,
          lineStart: issue.location.lineStart,
          lineEnd: issue.location.lineEnd,
        },
      });
    }

    return { patches: Array.from(patchesByPath.values()), fixes };
  }

  private resolveQuestionDecision(question: string): string | undefined {
    const trimmed = question.trim().replace(/\?+$/, "").trim();
    if (!trimmed) return undefined;
    const patterns: Array<{ pattern: RegExp; verb: string }> = [
      { pattern: /should we use\s+(.+)$/i, verb: "Use" },
      { pattern: /^use\s+(.+)$/i, verb: "Use" },
      { pattern: /^choose\s+(.+)$/i, verb: "Choose" },
      { pattern: /^select\s+(.+)$/i, verb: "Select" },
      { pattern: /decide on\s+(.+)$/i, verb: "Use" },
    ];
    for (const entry of patterns) {
      const match = trimmed.match(entry.pattern);
      if (!match) continue;
      const choice = match[1]?.trim() ?? "";
      if (!choice) continue;
      if (/\bor\b|\/|either/i.test(choice)) continue;
      const suffix = choice.endsWith(".") ? "" : ".";
      return `${entry.verb} ${choice}${suffix}`;
    }
    return undefined;
  }

  private sanitizeIndecisiveLine(line: string, patternId: string): string | undefined {
    const patterns: Record<string, RegExp> = {
      maybe: /\bmaybe\b/i,
      optional: /\boptional\b/i,
      could: /\bcould\b/i,
      might: /\bmight\b/i,
      possibly: /\bpossibly\b/i,
      either: /\beither\b/i,
      tbd: /\btbd\b/i,
    };
    const pattern = patterns[patternId];
    if (!pattern) return undefined;
    const match = line.match(/^(\s*[-*+]\s+|\s*)(.*)$/);
    const prefix = match?.[1] ?? "";
    const body = match?.[2] ?? line;
    const cleaned = body
      .replace(pattern, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;:])/g, "$1")
      .trim();
    if (!cleaned || cleaned === body.trim()) return undefined;
    return `${prefix}${cleaned}`;
  }

  private formatResolvedDecisions(decisions: ReviewDecision[]): string {
    const lines: string[] = [];
    for (const decision of decisions) {
      const metadata = (decision.metadata ?? {}) as Record<string, unknown>;
      const question =
        typeof metadata.question === "string" && metadata.question.trim().length > 0
          ? metadata.question.trim()
          : undefined;
      const suffix = question ? ` (question: ${question})` : "";
      lines.push(`- ${decision.summary}${suffix}`);
    }
    return lines.join("\n");
  }

  private async resolveOpenQuestions(
    runContext: DocgenRunContext,
    gateResults: ReviewGateResult[],
  ): Promise<{ decisions: ReviewDecision[]; warnings: string[] }> {
    const enabled =
      runContext.flags.resolveOpenQuestions ||
      process.env.MCODA_DOCS_RESOLVE_OPEN_QUESTIONS === "1";
    if (!enabled) return { decisions: [], warnings: [] };
    const openQuestions = gateResults.find((gate) => gate.gateId === "gate-open-questions");
    if (!openQuestions || openQuestions.issues.length === 0) {
      return { decisions: [], warnings: [] };
    }

    const decisions: ReviewDecision[] = [];
    const warnings: string[] = [];
    const decisionTargets = new Map<string, ReviewDecision[]>();
    const lineReplacements = new Map<string, Map<number, string>>();
    const replacedLines = new Set<string>();

    for (const issue of openQuestions.issues) {
      if (issue.location.kind !== "line_range") continue;
      const metadata = (issue.metadata ?? {}) as Record<string, unknown>;
      const question =
        typeof metadata.question === "string" && metadata.question.trim().length > 0
          ? metadata.question.trim()
          : undefined;
      const normalized =
        typeof metadata.normalized === "string" && metadata.normalized.trim().length > 0
          ? metadata.normalized.trim()
          : undefined;
      const required = metadata.required === true;
      if (!question) continue;

      const decisionSummary = this.resolveQuestionDecision(question);
      if (!decisionSummary) {
        if (required) {
          warnings.push(`Open question unresolved: ${question}`);
        }
        continue;
      }

      const fallbackId = question
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const decisionIdBase = normalized ?? (fallbackId || issue.id);
      const decisionId = `decision-${decisionIdBase}`;
      const decision: ReviewDecision = {
        id: decisionId,
        summary: decisionSummary,
        rationale: `Resolved from open question: "${question}"`,
        decidedAt: new Date().toISOString(),
        relatedIssueIds: [issue.id],
        metadata: {
          question,
          normalized,
          target: metadata.target,
        },
      };
      decisions.push(decision);

      const target =
        typeof metadata.target === "string" && metadata.target.trim().length > 0
          ? metadata.target.trim()
          : issue.artifact;
      let targetPath: string | undefined;
      if (target === "pdr" || issue.artifact === "pdr") {
        targetPath = runContext.artifacts.pdr?.path;
      } else if (target === "sds" || issue.artifact === "sds") {
        targetPath = runContext.artifacts.sds?.path;
      } else {
        targetPath = runContext.artifacts.sds?.path ?? runContext.artifacts.pdr?.path;
      }
      if (!targetPath) {
        warnings.push(`Resolved decision could not be inserted (missing target doc): ${question}`);
      } else {
        const existing = decisionTargets.get(targetPath);
        if (existing) {
          existing.push(decision);
        } else {
          decisionTargets.set(targetPath, [decision]);
        }
      }

      const lineIndex = issue.location.lineStart - 1;
      const key = `${issue.location.path}:${lineIndex}`;
      replacedLines.add(key);
      if (!lineReplacements.has(issue.location.path)) {
        lineReplacements.set(issue.location.path, new Map());
      }
      lineReplacements.get(issue.location.path)?.set(lineIndex, `Resolved: ${decision.summary}`);
    }

    const noMaybesGate = gateResults.find((gate) => gate.gateId === "gate-no-maybes");
    if (noMaybesGate && noMaybesGate.issues.length > 0) {
      const contentCache = new Map<string, string>();
      const loadContent = async (filePath: string): Promise<string | undefined> => {
        if (contentCache.has(filePath)) return contentCache.get(filePath);
        try {
          const content = await fs.readFile(filePath, "utf8");
          contentCache.set(filePath, content);
          return content;
        } catch (error) {
          warnings.push(`Unable to read ${filePath} for indecisive cleanup: ${(error as Error).message ?? String(error)}`);
          return undefined;
        }
      };

      for (const issue of noMaybesGate.issues) {
        if (issue.location.kind !== "line_range") continue;
        const lineIndex = issue.location.lineStart - 1;
        const key = `${issue.location.path}:${lineIndex}`;
        if (replacedLines.has(key)) continue;
        const content = await loadContent(issue.location.path);
        if (!content) continue;
        const lines = content.split(/\r?\n/);
        if (lineIndex < 0 || lineIndex >= lines.length) continue;
        const line = lines[lineIndex] ?? "";
        const metadata = (issue.metadata ?? {}) as Record<string, unknown>;
        const patternId = typeof metadata.patternId === "string" ? metadata.patternId : "";
        const sanitized = this.sanitizeIndecisiveLine(line, patternId);
        if (!sanitized) continue;
        if (!lineReplacements.has(issue.location.path)) {
          lineReplacements.set(issue.location.path, new Map());
        }
        lineReplacements.get(issue.location.path)?.set(lineIndex, sanitized);
      }
    }

    if (lineReplacements.size === 0 && decisionTargets.size === 0) {
      return { decisions, warnings };
    }

    const patches: DocPatchRequest[] = [];
    for (const [filePath, replacements] of lineReplacements.entries()) {
      const operations: DocPatchRequest["operations"] = [];
      const sorted = Array.from(replacements.entries()).sort((a, b) => a[0] - b[0]);
      for (const [lineIndex, content] of sorted) {
        const lineNumber = lineIndex + 1;
        operations.push({
          type: "replace_section",
          location: {
            kind: "line_range",
            path: filePath,
            lineStart: lineNumber,
            lineEnd: lineNumber,
          },
          content,
        });
      }
      const decisionSet = decisionTargets.get(filePath);
      if (decisionSet && decisionSet.length > 0) {
        operations.push({
          type: "insert_section",
          heading: "Resolved Decisions",
          content: this.formatResolvedDecisions(decisionSet),
          position: "append",
          headingLevel: 2,
        });
      }
      if (operations.length > 0) {
        patches.push({ path: filePath, operations });
      }
    }

    for (const [filePath, decisionSet] of decisionTargets.entries()) {
      if (lineReplacements.has(filePath)) continue;
      if (!decisionSet.length) continue;
      patches.push({
        path: filePath,
        operations: [
          {
            type: "insert_section",
            heading: "Resolved Decisions",
            content: this.formatResolvedDecisions(decisionSet),
            position: "append",
            headingLevel: 2,
          },
        ],
      });
    }

    if (patches.length > 0) {
      const patchResult = await this.applyDocPatches(runContext, patches);
      if (patchResult.warnings.length > 0) {
        warnings.push(...patchResult.warnings);
      }
    }

    return { decisions, warnings };
  }

  private reviewReportDir(runContext: DocgenRunContext): string {
    return path.join(this.workspace.mcodaDir, "jobs", runContext.jobId, "review");
  }

  private reviewReportPaths(
    runContext: DocgenRunContext,
    label: string,
  ): {
    jsonPath: string;
    markdownPath: string;
    markdownRelative: string;
  } {
    const reportDir = this.reviewReportDir(runContext);
    const jobDir = path.join(this.workspace.mcodaDir, "jobs", runContext.jobId);
    const jsonPath = path.join(reportDir, `${label}.json`);
    const markdownPath = path.join(reportDir, `${label}.md`);
    const markdownRelative = path.relative(jobDir, markdownPath) || path.basename(markdownPath);
    return { jsonPath, markdownPath, markdownRelative };
  }

  private buildReviewReport(input: {
    runContext: DocgenRunContext;
    gateResults: ReviewGateResult[];
    remainingOpenItems: ReviewIssue[];
    fixesApplied: ReviewFix[];
    iterationStatus: "in_progress" | "completed" | "max_iterations";
    deltas?: ReviewReportDelta[];
    decisions?: ReviewDecision[];
    iterationReports?: string[];
  }): ReviewReport {
    const outcome = aggregateReviewOutcome({
      gateResults: input.gateResults,
      remainingOpenItems: input.remainingOpenItems,
      fixesApplied: input.fixesApplied,
      decisions: input.decisions ?? [],
      generatedAt: new Date().toISOString(),
    });
    const iterationReports =
      input.iterationReports && input.iterationReports.length > 0
        ? input.iterationReports
        : undefined;

    return {
      version: 1,
      generatedAt: outcome.generatedAt,
      iteration: {
        current: input.runContext.iteration.current,
        max: input.runContext.iteration.max,
        status: input.iterationStatus,
      },
      status: outcome.summary.status,
      summary: outcome.summary,
      gateResults: outcome.gateResults,
      issues: outcome.issues,
      remainingOpenItems: outcome.remainingOpenItems,
      fixesApplied: outcome.fixesApplied,
      decisions: outcome.decisions,
      deltas: input.deltas ?? [],
      metadata: {
        commandName: input.runContext.commandName,
        commandRunId: input.runContext.commandRunId,
        jobId: input.runContext.jobId,
        projectKey: input.runContext.projectKey,
        iterationReports,
      },
    };
  }

  private async persistReviewReport(
    runContext: DocgenRunContext,
    label: string,
    report: ReviewReport,
  ): Promise<{ markdownRelative: string }> {
    const paths = this.reviewReportPaths(runContext, label);
    await ensureDir(paths.jsonPath);
    await fs.writeFile(paths.jsonPath, serializeReviewReport(report), "utf8");
    await fs.writeFile(paths.markdownPath, renderReviewReport(report), "utf8");
    return { markdownRelative: paths.markdownRelative };
  }

  private async runIterationLoop(runContext: DocgenRunContext): Promise<{
    gateResults: ReviewGateResult[];
    fixesApplied: ReviewFix[];
    reviewReportPath?: string;
  }> {
    const iterationEnabled = this.isIterationEnabled(runContext);
    const maxIterations =
      runContext.iteration.max > 0
        ? runContext.iteration.max
        : iterationEnabled
          ? this.resolveMaxIterations()
          : 1;
    runContext.iteration.max = maxIterations;

    const fixesApplied: ReviewFix[] = [];
    const alignmentDeltas: ReviewReportDelta[] = [];
    const decisions: ReviewDecision[] = [];
    const iterationReports: string[] = [];
    let lastGateResults: ReviewGateResult[] = [];
    let lastBlockingIssues: ReviewIssue[] = [];
    const alignmentPatcher = new DocAlignmentPatcher();
    let finalReportRelative: string | undefined;

    const persistIterationReport = async (status: "in_progress" | "completed" | "max_iterations") => {
      const report = this.buildReviewReport({
        runContext,
        gateResults: lastGateResults,
        remainingOpenItems: lastBlockingIssues,
        fixesApplied,
        deltas: alignmentDeltas,
        decisions,
        iterationStatus: status,
      });
      const { markdownRelative } = await this.persistReviewReport(
        runContext,
        `review-iteration-${runContext.iteration.current}`,
        report,
      );
      iterationReports.push(markdownRelative);
    };

    const persistFinalReport = async (status: "completed" | "max_iterations") => {
      const report = this.buildReviewReport({
        runContext,
        gateResults: lastGateResults,
        remainingOpenItems: lastBlockingIssues,
        fixesApplied,
        deltas: alignmentDeltas,
        decisions,
        iterationStatus: status,
        iterationReports,
      });
      const { markdownRelative } = await this.persistReviewReport(
        runContext,
        "review-final",
        report,
      );
      finalReportRelative = markdownRelative;
    };

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      runContext.iteration.current = iteration;
      await this.jobService.recordIterationProgress(runContext.jobId, {
        current: iteration,
        max: maxIterations,
        phase: "review",
      });

      const review = await this.runReviewGates(runContext, "review");
      lastGateResults = review.gateResults;
      lastBlockingIssues = review.blockingIssues;

      if (review.blockingIssues.length === 0) {
        await persistIterationReport("completed");
        await persistFinalReport("completed");
        return { gateResults: review.gateResults, fixesApplied, reviewReportPath: finalReportRelative };
      }

      if (!iterationEnabled) {
        await persistIterationReport("max_iterations");
        await persistFinalReport("max_iterations");
        const summary = this.summarizeIssues(review.blockingIssues);
        throw new Error(`Doc generation review failed. ${summary}`);
      }

      const questionResolution = await this.resolveOpenQuestions(
        runContext,
        review.gateResults,
      );
      if (questionResolution.decisions.length > 0) {
        decisions.push(...questionResolution.decisions);
      }
      if (questionResolution.warnings.length > 0) {
        this.appendUniqueWarnings(runContext, questionResolution.warnings);
      }

      if (runContext.flags.crossAlign) {
        const alignmentResult = await alignmentPatcher.apply({
          runContext,
          gateResults: review.gateResults,
        });
        if (alignmentResult.warnings.length > 0) {
          this.appendUniqueWarnings(runContext, alignmentResult.warnings);
        }
        if (alignmentResult.deltas.length > 0) {
          alignmentDeltas.push(...alignmentResult.deltas);
        }
      }

      const patchPlan = this.buildPatchPlanFromIssues(review.blockingIssues);
      await this.jobService.recordIterationProgress(runContext.jobId, {
        current: iteration,
        max: maxIterations,
        phase: "patch",
        details: { patches: patchPlan.patches.length, fixes: patchPlan.fixes.length },
      });

      if (patchPlan.patches.length > 0) {
        fixesApplied.push(...patchPlan.fixes);
        const patchResult = await this.applyDocPatches(runContext, patchPlan.patches);
        if (patchResult.warnings.length > 0) {
          this.appendUniqueWarnings(runContext, patchResult.warnings);
        }

        await this.jobService.recordIterationProgress(runContext.jobId, {
          current: iteration,
          max: maxIterations,
          phase: "recheck",
        });

        const recheck = await this.runReviewGates(runContext, "recheck");
        lastGateResults = recheck.gateResults;
        lastBlockingIssues = recheck.blockingIssues;

        if (recheck.blockingIssues.length === 0) {
          await persistIterationReport("completed");
          await persistFinalReport("completed");
          return { gateResults: recheck.gateResults, fixesApplied, reviewReportPath: finalReportRelative };
        }
      }

      const iterationStatus =
        lastBlockingIssues.length === 0
          ? "completed"
          : iteration === maxIterations
            ? "max_iterations"
            : "in_progress";
      await persistIterationReport(iterationStatus);
    }

    const summary = this.summarizeIssues(lastBlockingIssues);
    await persistFinalReport("max_iterations");
    throw new Error(
      `Doc generation review failed after ${maxIterations} iteration(s). ${summary}`,
    );
  }

  private async enforcePlaceholderArtifacts(runContext: DocgenRunContext): Promise<void> {
    if (!runContext.flags.noPlaceholders) return;
    const allowlist = parseDelimitedList(process.env.MCODA_DOCS_PLACEHOLDER_ALLOWLIST);
    const denylist = parseDelimitedList(process.env.MCODA_DOCS_PLACEHOLDER_DENYLIST);
    const result = await runPlaceholderArtifactGate({
      artifacts: runContext.artifacts,
      allowlist: allowlist.length > 0 ? allowlist : undefined,
      denylist: denylist.length > 0 ? denylist : undefined,
    });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status !== "fail") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.artifact}: ${issue.message}`)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    throw new Error(`Placeholder artifacts detected (${result.issues.length}). ${summary}${suffix}`);
  }

  private async enforceApiPathConsistency(runContext: DocgenRunContext): Promise<void> {
    const result = await runApiPathConsistencyGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status !== "fail") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.artifact}: ${issue.message}`)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `API path consistency check failed (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceOpenApiSchemaSanity(runContext: DocgenRunContext): Promise<void> {
    if (!runContext.artifacts.openapi?.length) return;
    const issues: string[] = [];
    for (const record of runContext.artifacts.openapi) {
      try {
        const content = await fs.readFile(record.path, "utf8");
        const result = validateOpenApiSchemaContent(content);
        if (result.errors.length > 0) {
          issues.push(...result.errors.map((error) => `${record.path}: ${error}`));
        }
      } catch (error) {
        runContext.warnings.push(
          `Unable to read OpenAPI spec ${record.path}: ${(error as Error).message ?? String(error)}`,
        );
      }
    }
    if (issues.length === 0) return;
    const summary = issues.slice(0, 3).join(" ");
    const suffix = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
    const message = `OpenAPI schema sanity issues (${issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceOpenApiCoverage(runContext: DocgenRunContext): Promise<void> {
    const result = await runOpenApiCoverageGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status !== "fail") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.artifact}: ${issue.message}`)
      .join(" ");
    const suffix = result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `OpenAPI endpoint coverage check failed (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceSqlSyntax(runContext: DocgenRunContext): Promise<void> {
    const result = await runSqlSyntaxGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status !== "fail") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.artifact}: ${issue.message}`)
      .join(" ");
    const suffix = result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `SQL syntax validation failed (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceSqlRequiredTables(runContext: DocgenRunContext): Promise<void> {
    const result = await runSqlRequiredTablesGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status !== "fail") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.artifact}: ${issue.message}`)
      .join(" ");
    const suffix = result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `SQL required tables check failed (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async generateDeploymentBlueprint(
    runContext: DocgenRunContext,
    sdsContent: string,
    projectKey?: string,
  ): Promise<boolean> {
    if (runContext.flags.dryRun) {
      runContext.warnings.push("Dry run enabled; deployment blueprint generation skipped.");
      return false;
    }
    const scaffolder = new DocsScaffolder();
    const openapiRecords = runContext.artifacts.openapi ?? [];
    const primaryOpenApi =
      openapiRecords.find((record) => record.variant !== "admin") ?? openapiRecords[0];
    let openapiContent: string | undefined;
    if (primaryOpenApi) {
      try {
        openapiContent = await fs.readFile(primaryOpenApi.path, "utf8");
      } catch (error) {
        runContext.warnings.push(
          `Unable to read OpenAPI spec ${primaryOpenApi.path} for deployment blueprint: ${(error as Error).message ?? String(error)}`,
        );
      }
    }
    try {
      await scaffolder.generateDeploymentBlueprintFiles({
        sdsContent,
        openapiContent,
        outputDir: path.join(this.workspace.workspaceRoot, "deploy"),
        serviceName: projectKey ?? "app",
      });
      return true;
    } catch (error) {
      runContext.warnings.push(
        `Deployment blueprint generation failed: ${(error as Error).message ?? String(error)}`,
      );
      return false;
    }
  }

  private async enforceAdminOpenApiSpec(runContext: DocgenRunContext): Promise<void> {
    const docRecords = [runContext.artifacts.pdr, runContext.artifacts.sds].filter(
      (record): record is DocArtifactRecord => Boolean(record),
    );
    if (docRecords.length === 0) return;

    const mentions: Array<{ record: DocArtifactRecord; line: number; excerpt: string }> = [];
    for (const record of docRecords) {
      try {
        const content = await fs.readFile(record.path, "utf8");
        const found = findAdminSurfaceMentions(content);
        for (const mention of found) {
          mentions.push({
            record,
            line: mention.line,
            excerpt: mention.heading ? `${mention.heading}: ${mention.excerpt}` : mention.excerpt,
          });
        }
      } catch (error) {
        runContext.warnings.push(
          `Unable to scan ${record.path} for admin surface mentions: ${(error as Error).message ?? String(error)}`,
        );
      }
    }
    if (mentions.length === 0) return;

    const openapiRecords = runContext.artifacts.openapi ?? [];
    const hasAdminSpec = openapiRecords.some(
      (record) => record.variant === "admin" || /admin/i.test(path.basename(record.path)),
    );
    if (hasAdminSpec) return;

    const summary = mentions
      .slice(0, 2)
      .map((entry) => `${path.basename(entry.record.path)}:${entry.line} ${entry.excerpt}`)
      .join(" | ");
    const suffix = mentions.length > 2 ? ` (+${mentions.length - 2} more)` : "";
    const message = `Admin OpenAPI spec required (admin surfaces referenced): ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceTerminologyNormalization(runContext: DocgenRunContext): Promise<void> {
    const result = await runTerminologyNormalizationGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.artifact}: ${issue.message}`)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `Terminology normalization findings (${result.issues.length}). ${summary}${suffix}`;
    if (result.status === "fail" && runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceOpenQuestions(runContext: DocgenRunContext): Promise<void> {
    const result = await runOpenQuestionsGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.artifact}: ${issue.message}`)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `Open questions detected (${result.issues.length}). ${summary}${suffix}`;
    if (result.status === "fail" && runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceNoMaybes(runContext: DocgenRunContext): Promise<void> {
    const enabled =
      runContext.flags.noMaybes ||
      runContext.flags.resolveOpenQuestions ||
      process.env.MCODA_DOCS_NO_MAYBES === "1" ||
      process.env.MCODA_DOCS_RESOLVE_OPEN_QUESTIONS === "1";
    const result = await runNoMaybesGate({ artifacts: runContext.artifacts, enabled });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status !== "fail") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.artifact}: ${issue.message}`)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    throw new Error(`Indecisive language detected (${result.issues.length}). ${summary}${suffix}`);
  }

  private async enforceRfpConsent(runContext: DocgenRunContext): Promise<void> {
    const result = await runRfpConsentGate({ rfpPath: runContext.rfpPath });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.message}`)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `RFP consent contradictions detected (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceRfpDefinitionCoverage(runContext: DocgenRunContext): Promise<void> {
    const allowlist = parseDelimitedList(process.env.MCODA_DOCS_RFP_DEFINITION_ALLOWLIST);
    const result = await runRfpDefinitionGate({
      rfpPath: runContext.rfpPath,
      allowlist: allowlist.length > 0 ? allowlist : undefined,
    });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => issue.message)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `RFP definition coverage issues (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforcePdrInterfaces(runContext: DocgenRunContext): Promise<void> {
    const result = await runPdrInterfacesGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => issue.message)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `PDR interface/pipeline issues (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforcePdrOwnership(runContext: DocgenRunContext): Promise<void> {
    const result = await runPdrOwnershipGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => issue.message)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `PDR ownership/consent flow issues (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforcePdrOpenQuestionsQuality(runContext: DocgenRunContext): Promise<void> {
    const enabled = process.env.MCODA_DOCS_RESOLVE_OPEN_QUESTIONS === "1";
    const result = await runPdrOpenQuestionsGate({ artifacts: runContext.artifacts, enabled });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => issue.message)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `PDR open question quality issues (${result.issues.length}). ${summary}${suffix}`;
    throw new Error(message);
  }

  private async enforceSdsExplicitDecisions(runContext: DocgenRunContext): Promise<void> {
    const result = await runSdsDecisionsGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => issue.message)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `SDS explicit decision issues (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceSdsPolicyTelemetry(runContext: DocgenRunContext): Promise<void> {
    const result = await runSdsPolicyTelemetryGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => issue.message)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `SDS policy/telemetry/metering issues (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceSdsOpsObservabilityTesting(runContext: DocgenRunContext): Promise<void> {
    const result = await runSdsOpsGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => issue.message)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `SDS ops/observability/testing issues (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceSdsExternalAdapters(runContext: DocgenRunContext): Promise<void> {
    const result = await runSdsAdaptersGate({ artifacts: runContext.artifacts });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => issue.message)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `SDS external adapter issues (${result.issues.length}). ${summary}${suffix}`;
    if (runContext.flags.buildReady) {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceDeploymentBlueprint(runContext: DocgenRunContext): Promise<void> {
    const result = await runDeploymentBlueprintGate({
      artifacts: runContext.artifacts,
      buildReady: runContext.flags.buildReady,
    });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.message}`)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `Deployment blueprint validation issues (${result.issues.length}). ${summary}${suffix}`;
    if (result.status === "fail") {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async enforceBuildReadyCompleteness(runContext: DocgenRunContext): Promise<void> {
    const result = await runBuildReadyCompletenessGate({
      artifacts: runContext.artifacts,
      buildReady: runContext.flags.buildReady,
    });
    if (result.notes?.length) {
      runContext.warnings.push(...result.notes);
    }
    if (result.status === "pass" || result.status === "skipped") return;
    const summary = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.artifact}: ${issue.message}`)
      .join(" ");
    const suffix =
      result.issues.length > 3 ? ` (+${result.issues.length - 3} more)` : "";
    const message = `Build-ready completeness check failed (${result.issues.length}). ${summary}${suffix}`;
    if (result.status === "fail") {
      throw new Error(message);
    }
    runContext.warnings.push(message);
  }

  private async writePdrFile(outPath: string, content: string): Promise<void> {
    await ensureDir(outPath);
    await fs.writeFile(outPath, content, "utf8");
  }

  private async registerPdr(outPath: string, content: string, projectKey?: string): Promise<DocdexDocument> {
    const branch = this.workspace.config?.branch ?? (await readGitBranch(this.workspace.workspaceRoot));
    return this.docdex.registerDocument({
      docType: "PDR",
      path: outPath,
      content,
      metadata: {
        workspace: this.workspace.workspaceId,
        projectKey,
        branch,
        status: "draft",
      },
    });
  }

  private async writeSdsFile(outPath: string, content: string): Promise<void> {
    await ensureDir(outPath);
    await fs.writeFile(outPath, content, "utf8");
  }

  private async checkSdsDocdexProfile(warnings: string[]): Promise<void> {
    const base = this.workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL;
    if (base) return;
    const localStore = path.join(this.workspace.mcodaDir, "docdex", "documents.json");
    try {
      await fs.access(localStore);
      return;
    } catch {
      // No docdex URL or local store; continue with local docs if present.
      warnings.push(
        "Docdex is not configured for SDS retrieval; attempting local docs (no local docdex store found).",
      );
    }
  }

  private async registerSds(outPath: string, content: string, projectKey?: string): Promise<DocdexDocument> {
    const branch = this.workspace.config?.branch ?? (await readGitBranch(this.workspace.workspaceRoot));
    return this.docdex.registerDocument({
      docType: "SDS",
      path: outPath,
      content,
      metadata: {
        workspace: this.workspace.workspaceId,
        projectKey,
        branch,
        status: "draft",
      },
    });
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
        const collected: string[] = [];
        for await (const chunk of generator) {
          collected.push(chunk.output);
          await this.jobService.appendLog(jobId, chunk.output);
          if (onToken) onToken(chunk.output);
        }
        return { output: collected.join(""), adapter: agent.adapter };
      } catch {
        // Fall back to non-streaming invocation if streaming is not supported.
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

  async generatePdr(options: GeneratePdrOptions): Promise<GeneratePdrResult> {
    if (!options.rfpId && !options.rfpPath) {
      throw new Error("Either --rfp-id or --rfp-path must be provided.");
    }
    if (options.rfpPath) {
      const resolved = path.isAbsolute(options.rfpPath)
        ? options.rfpPath
        : path.join(this.workspace.workspaceRoot, options.rfpPath);
      try {
        await fs.access(resolved);
      } catch {
        throw new Error(`RFP path does not exist: ${resolved}`);
      }
    }
    const commandRun = await this.jobService.startCommandRun("docs-pdr-generate", options.projectKey);
    const job = await this.jobService.startJob("pdr_generate", commandRun.id, options.projectKey, {
      commandName: commandRun.commandName,
      payload: {
        projectKey: options.projectKey,
        rfpId: options.rfpId,
        rfpPath: options.rfpPath,
      },
    });
    const assembler = new DocContextAssembler(this.docdex, this.workspace);
    try {
      const context = await assembler.buildContext({
        rfpId: options.rfpId,
        rfpPath: options.rfpPath,
        projectKey: options.projectKey,
      });
      const checkpoint: JobCheckpoint = {
        stage: "context_built",
        timestamp: new Date().toISOString(),
        details: { rfp: context.rfp.path ?? context.rfp.id, docdexAvailable: context.docdexAvailable },
      };
      await this.jobService.writeCheckpoint(job.id, checkpoint);
      await this.jobService.recordTokenUsage({
        timestamp: new Date().toISOString(),
        workspaceId: this.workspace.workspaceId,
        commandName: "docs-pdr-generate",
        jobId: job.id,
        commandRunId: commandRun.id,
        action: "docdex_context",
        promptTokens: 0,
        completionTokens: 0,
        metadata: { docdexAvailable: context.docdexAvailable },
      });

      const stream = options.agentStream ?? true;
      const iterate = options.iterate === true;
      const fastMode =
        iterate ? false : options.fast === true || process.env.MCODA_DOCS_FAST === "1";
      const skipValidation = process.env.MCODA_SKIP_PDR_VALIDATION === "1";
      const buildReady = options.buildReady === true || process.env.MCODA_DOCS_BUILD_READY === "1";
      const resolveOpenQuestions =
        options.resolveOpenQuestions === true ||
        process.env.MCODA_DOCS_RESOLVE_OPEN_QUESTIONS === "1";
      const noMaybes =
        options.noMaybes === true ||
        process.env.MCODA_DOCS_NO_MAYBES === "1" ||
        resolveOpenQuestions;
      const noPlaceholders =
        options.noPlaceholders === true ||
        process.env.MCODA_DOCS_NO_PLACEHOLDERS === "1" ||
        buildReady;
      const crossAlign = options.crossAlign !== false;
      const iterationEnabled = !options.dryRun && !fastMode;
      const maxIterations = iterationEnabled ? this.resolveMaxIterations() : 1;

      const agent = await this.selectDocgenAgent({
        agentName: options.agentName,
        commandName: "docs-pdr-generate",
        commandAliases: ["docs-pdr-generate", "docs:pdr:generate", "pdr"],
        jobId: job.id,
        warnings: context.warnings,
        iterationEnabled,
      });
      const outputPath =
        options.outPath ?? this.defaultPdrOutputPath(options.projectKey, context.rfp.path);
      const runContext = this.createRunContext({
        commandName: "docs-pdr-generate",
        commandRunId: commandRun.id,
        jobId: job.id,
        projectKey: options.projectKey,
        rfpId: options.rfpId,
        rfpPath: context.rfp.path ?? options.rfpPath,
        outputPath,
        flags: {
          dryRun: options.dryRun === true,
          fast: fastMode,
          iterate,
          json: options.json === true,
          stream,
          buildReady,
          noPlaceholders,
          resolveOpenQuestions,
          noMaybes,
          crossAlign,
        },
        warnings: context.warnings,
      });
      runContext.iteration.max = maxIterations;
      const stateCleanupWarnings = await cleanupWorkspaceStateDirs({
        workspaceRoot: this.workspace.workspaceRoot,
        mcodaDir: this.workspace.mcodaDir,
      });
      const { statePath: iterativeOutputPath, warnings: statePathWarnings } = resolveDocgenStatePath({
        outputPath: runContext.outputPath,
        mcodaDir: this.workspace.mcodaDir,
        jobId: runContext.jobId,
        commandName: runContext.commandName,
      });
      const stateWarnings = [...stateCleanupWarnings, ...statePathWarnings];
      if (stateWarnings.length > 0) {
        runContext.stateWarnings = stateWarnings;
        this.appendUniqueWarnings(runContext, stateWarnings);
      }
      runContext.artifacts.pdr = { kind: "pdr", path: runContext.outputPath, meta: {} };
      await this.enforceToolDenylist({ runContext, agent });
      await this.recordDocgenStage(runContext, {
        stage: "generation",
        message: "Generating PDR draft",
        totalItems: maxIterations,
        processedItems: 0,
      });
      const prompts = await this.agentService.getPrompts(agent.id);
      const runbook =
        (await readPromptIfExists(this.workspace, path.join("prompts", "commands", "pdr-generate.md"))) ||
        DEFAULT_PDR_RUNBOOK_PROMPT;

      let draft = "";
      let agentUsed = false;
      let agentMetadata: Record<string, unknown> | undefined;
      let adapter = agent.adapter;
      let lastInvoke:
        | ((input: string) => Promise<{ output: string; adapter: string; metadata?: Record<string, unknown> }>)
        | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prompt = buildRunPrompt(context, options.projectKey, prompts, attempt === 0 ? runbook : `${runbook}\n\nRETRY: The previous attempt failed validation. Ensure all required sections are present and non-empty. Do not leave placeholders.`);
        const invoke = async (input: string) => {
          agentUsed = true;
          const { output: out, adapter: usedAdapter, metadata } = await this.invokeAgent(agent, input, stream, job.id, options.onToken);
          adapter = usedAdapter;
          agentMetadata = metadata;
          return { output: out, adapter: usedAdapter, metadata };
        };
        lastInvoke = invoke;
        const { output: agentOutput } = await invoke(prompt);
        const structured = ensureStructuredDraft(
          agentOutput,
          options.projectKey,
          context,
          context.rfp.path ?? context.rfp.id ?? "RFP",
        );
        const valid = skipValidation || (validateDraft(structured) && headingHasContent(structured, "Introduction"));
        await this.jobService.recordTokenUsage({
          timestamp: new Date().toISOString(),
          workspaceId: this.workspace.workspaceId,
          commandName: "docs-pdr-generate",
          jobId: job.id,
          commandRunId: commandRun.id,
          agentId: agent.id,
          modelName: agent.defaultModel,
          action: attempt === 0 ? "draft_pdr" : "draft_pdr_retry",
          promptTokens: estimateTokens(prompt),
          completionTokens: estimateTokens(agentOutput),
          metadata: {
            adapter,
            docdexAvailable: context.docdexAvailable,
            attempt: attempt + 1,
            phase: attempt === 0 ? "draft_pdr" : "draft_pdr_retry",
          },
        });
        if (valid) {
          draft = structured;
          break;
        }
        if (valid) break;
        const missing = missingPdrHeadings(draft);
        // eslint-disable-next-line no-console
        console.error(
          `[pdr validation] missing sections: ${missing.join(", ") || "none"}; introHasContent=${headingHasContent(draft, "Introduction")}; length=${draft.length}; attempt=${attempt + 1}`,
      );
        if (attempt === 1) {
          throw new Error("PDR draft validation failed after retry (missing required sections or empty output).");
        }
      }
      if (!draft) {
        throw new Error("PDR draft generation failed; no valid draft produced.");
      }

      if (fastMode) {
        context.warnings.push("Fast mode enabled; skipping PDR enrichment and tidy passes.");
      } else if (lastInvoke) {
        draft = await enrichPdrDraft(draft, agent, context, options.projectKey, lastInvoke);
        draft = ensureStructuredDraft(draft, options.projectKey, context, context.rfp.path ?? context.rfp.id ?? "RFP");
      }
      if (!fastMode && lastInvoke) {
        try {
          const tidiedRaw = await tidyPdrDraft(draft, agent, lastInvoke);
          const tidied = ensureStructuredDraft(
            tidiedRaw,
            options.projectKey,
            context,
            context.rfp.path ?? context.rfp.id ?? "RFP",
          );
          const tidiedValid = validateDraft(tidied) && headingHasContent(tidied, "Introduction");
          const keepTidied = tidiedValid && tidied.length >= draft.length * 0.6;
          if (keepTidied) {
            draft = tidied;
          }
        } catch (error) {
          context.warnings.push(`Tidy pass skipped: ${(error as Error).message ?? "unknown error"}`);
        }
      }
      if (!options.dryRun) {
        const firstDraftPath = path.join(
          this.workspace.mcodaDir,
          "docs",
          "pdr",
          `${path.basename(runContext.outputPath, path.extname(runContext.outputPath))}-first-draft.md`,
        );
        await ensureDir(firstDraftPath);
        await fs.writeFile(firstDraftPath, draft, "utf8");
        if (fastMode) {
          context.warnings.push("Fast mode enabled; skipping iterative PDR refinement.");
        } else {
          try {
            const iterativeDraft = await buildIterativePdr(
              options.projectKey,
              context,
              draft,
              iterativeOutputPath,
              lastInvoke ?? (async (input: string) => this.invokeAgent(agent, input, stream, job.id, options.onToken)),
            );
            draft = iterativeDraft;
          } catch (error) {
            context.warnings.push(`Iterative PDR refinement failed; keeping first draft. ${String(error)}`);
          }
        }
      }
      draft = ensureStructuredDraft(
        draft,
        options.projectKey,
        context,
        context.rfp.path ?? context.rfp.id ?? "RFP",
      );
      await this.jobService.writeCheckpoint(job.id, {
        stage: "draft_completed",
        timestamp: new Date().toISOString(),
        details: { length: draft.length },
      });

      let docdexId: string | undefined;
      let segments: string[] | undefined;
      let mirrorStatus = "skipped";
      let reviewReportPath: string | undefined;
      if (options.dryRun) {
        context.warnings.push("Dry run enabled; PDR was not written to disk or registered in docdex.");
      }
      if (!options.dryRun) {
        await this.writePdrFile(runContext.outputPath, draft);
        if (context.docdexAvailable) {
          try {
            const registered = await this.registerPdr(runContext.outputPath, draft, options.projectKey);
            docdexId = registered.id;
            segments = (registered.segments ?? []).map((s) => s.id);
            await fs.writeFile(
              `${runContext.outputPath}.meta.json`,
              JSON.stringify({ docdexId, segments, projectKey: options.projectKey }, null, 2),
              "utf8",
            );
          } catch (error) {
            context.warnings.push(`Docdex registration skipped: ${(error as Error).message}`);
          }
        }
        const publicDocsDir = path.join(this.workspace.workspaceRoot, "docs", "pdr");
        const shouldMirror = this.workspace.config?.mirrorDocs !== false;
        if (shouldMirror) {
          try {
            await ensureDir(path.join(publicDocsDir, "placeholder"));
            const mirrorPath = path.join(publicDocsDir, path.basename(runContext.outputPath));
            await ensureDir(mirrorPath);
            await fs.writeFile(mirrorPath, draft, "utf8");
            mirrorStatus = "mirrored";
          } catch {
            // optional mirror skipped
            mirrorStatus = "failed";
          }
        }
        try {
          await this.recordDocgenStage(runContext, {
            stage: "inventory",
            message: "Building doc inventory",
          });
          runContext.artifacts = await buildDocInventory({
            workspace: this.workspace,
            preferred: { pdrPath: runContext.outputPath },
          });
        } catch (error) {
          runContext.warnings.push(`Doc inventory build failed: ${(error as Error).message ?? String(error)}`);
        }
        const iterationResult = await this.runIterationLoop(runContext);
        reviewReportPath = iterationResult.reviewReportPath;
      }

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: {
          outputPath: runContext.outputPath,
          docdexId,
          segments,
          mirrorStatus,
          ...(reviewReportPath ? { reviewReportPath } : {}),
        },
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");
      if (options.rateAgents && agentUsed) {
        try {
          const ratingService = await this.ensureRatingService();
          await ratingService.rate({
            workspace: this.workspace,
            agentId: agent.id,
            commandName: "docs-pdr-generate",
            jobId: job.id,
            commandRunId: commandRun.id,
          });
        } catch (error) {
          context.warnings.push(`Agent rating failed: ${(error as Error).message ?? String(error)}`);
        }
      }
      return {
        jobId: job.id,
        commandRunId: commandRun.id,
        outputPath: runContext.outputPath,
        draft,
        docdexId,
        warnings: runContext.warnings,
      };
    } catch (error) {
      await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: (error as Error).message });
      await this.jobService.finishCommandRun(commandRun.id, "failed", (error as Error).message);
      throw error;
    }
  }

  private async tryResumeSds(
    resumeJobId: string,
    warnings: string[],
  ): Promise<
    | {
        job: any;
        completed: boolean;
        outputPath?: string;
        draft?: string;
        docdexId?: string;
        commandRunId?: string;
      }
    | undefined
  > {
    const manifestPath = path.join(this.workspace.mcodaDir, "jobs", resumeJobId, "manifest.json");
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw);
      if (manifest.type && manifest.type !== "sds_generate") {
        throw new Error(
          `Job ${resumeJobId} is type ${manifest.type}, not sds_generate. Use a matching job id or rerun without --resume.`,
        );
      }
      if (manifest.status === "running") {
        throw new Error(`Job ${resumeJobId} is still running; use "mcoda job watch --id ${resumeJobId}" to monitor.`);
      }

      const checkpoints = await this.jobService.readCheckpoints(resumeJobId);
      const lastCkpt = checkpoints[checkpoints.length - 1];
      const draftPath =
        (lastCkpt?.details?.draftPath as string | undefined) ??
        path.join(this.workspace.mcodaDir, "jobs", resumeJobId, "draft.md");
      let draft: string | undefined;
      try {
        draft = await fs.readFile(draftPath, "utf8");
      } catch {
        // missing draft is allowed; will re-run agent
      }

      if (manifest.status === "succeeded") {
        const outputPath = manifest.metadata?.outputPath ?? manifest.metadata?.output_path;
        warnings.push(`Resume requested; returning completed SDS from job ${resumeJobId}.`);
        return {
          job: manifest,
          completed: true,
          outputPath,
          draft,
          docdexId: manifest.metadata?.docdexId ?? manifest.metadata?.docdex_id,
          commandRunId: manifest.commandRunId ?? manifest.command_run_id,
        };
      }

      const resumeFromDraft = draft && lastCkpt?.stage === "draft_completed";
      if (resumeFromDraft) {
        warnings.push(`Resuming SDS generation from saved draft for job ${resumeJobId}.`);
      } else {
        warnings.push(`Resume requested for ${resumeJobId}; restarting agent draft generation.`);
      }

      return {
        job: manifest,
        completed: false,
        outputPath: manifest.metadata?.outputPath ?? manifest.metadata?.output_path,
        draft,
        docdexId: manifest.metadata?.docdexId ?? manifest.metadata?.docdex_id,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        warnings.push(`No resume data found for job ${resumeJobId}; starting a new SDS job.`);
        return undefined;
      }
      if (error instanceof Error) throw error;
      throw new Error(String(error));
    }
  }

  async generateSds(options: GenerateSdsOptions): Promise<GenerateSdsResult> {
    const warnings: string[] = [];
    await this.checkSdsDocdexProfile(warnings);
    const assembler = new DocContextAssembler(this.docdex, this.workspace);
    const commandRun = await this.jobService.startCommandRun("docs-sds-generate", options.projectKey);
    let job: any;
    let resumeDraft: string | undefined;
    let resumeDocdexId: string | undefined;
    if (options.resumeJobId) {
      const resumed = await this.tryResumeSds(options.resumeJobId, warnings);
      if (resumed) {
        job = resumed.job;
        await this.jobService.updateJobStatus(job.id, "running", { resumedBy: commandRun.id });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "resume_started",
          timestamp: new Date().toISOString(),
          details: { resumedBy: commandRun.id },
        });
        if (resumed.completed) {
          await this.jobService.finishCommandRun(commandRun.id, "succeeded");
          return {
            jobId: job.id,
            commandRunId: commandRun.id,
            outputPath: resumed.outputPath,
            draft: resumed.draft ?? "",
            docdexId: resumed.docdexId,
            warnings,
          };
        }
        resumeDraft = resumed.draft;
        resumeDocdexId = resumed.docdexId;
      }
    }
    if (!job) {
      job = await this.jobService.startJob("sds_generate", commandRun.id, options.projectKey, {
        commandName: commandRun.commandName,
        payload: {
          projectKey: options.projectKey,
          templateName: options.templateName,
          resumeJobId: options.resumeJobId,
        },
      });
    }
    try {
      const context = await assembler.buildSdsContext({ projectKey: options.projectKey });
      warnings.push(...context.warnings);
      await this.jobService.writeCheckpoint(job.id, {
        stage: "context_built",
        timestamp: new Date().toISOString(),
        details: {
          docdexAvailable: context.docdexAvailable,
          rfp: context.rfp?.path ?? context.rfp?.id,
          pdrCount: context.pdrs.length,
          existingSds: context.existingSds.length,
        },
      });
      await this.jobService.recordTokenUsage({
        timestamp: new Date().toISOString(),
        workspaceId: this.workspace.workspaceId,
        commandName: "docs-sds-generate",
        jobId: job.id,
        commandRunId: commandRun.id,
        action: "docdex_context",
        promptTokens: 0,
        completionTokens: 0,
        metadata: { docdexAvailable: context.docdexAvailable },
      });

      const outputPath = (options.outPath ??
        (job.metadata?.outputPath as string | undefined) ??
        this.defaultSdsOutputPath(options.projectKey)) as string;
      const draftPath = path.join(this.workspace.mcodaDir, "jobs", job.id, "draft.md");
      const allowExisting = Boolean(options.resumeJobId);
      if (!options.force && !allowExisting) {
        try {
          await fs.access(outputPath);
          throw new Error(
            `Output already exists: ${outputPath}. Re-run with --force to overwrite or specify --out for a different path.`,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }

      const stream = options.agentStream ?? true;
      const iterate = options.iterate === true;
      const fastMode =
        iterate ? false : options.fast === true || process.env.MCODA_DOCS_FAST === "1";
      const skipValidation = process.env.MCODA_SKIP_SDS_VALIDATION === "1";
      const buildReady = options.buildReady === true || process.env.MCODA_DOCS_BUILD_READY === "1";
      const resolveOpenQuestions =
        options.resolveOpenQuestions === true ||
        process.env.MCODA_DOCS_RESOLVE_OPEN_QUESTIONS === "1";
      const noMaybes =
        options.noMaybes === true ||
        process.env.MCODA_DOCS_NO_MAYBES === "1" ||
        resolveOpenQuestions;
      const noPlaceholders =
        options.noPlaceholders === true ||
        process.env.MCODA_DOCS_NO_PLACEHOLDERS === "1" ||
        buildReady;
      const crossAlign = options.crossAlign !== false;
      const iterationEnabled = !options.dryRun && !fastMode;
      const maxIterations = iterationEnabled ? this.resolveMaxIterations() : 1;

      const agent = await this.selectDocgenAgent({
        agentName: options.agentName,
        commandName: "docs-sds-generate",
        commandAliases: ["docs-sds-generate", "docs:sds:generate", "sds"],
        jobId: job.id,
        warnings,
        iterationEnabled,
      });
      const runContext = this.createRunContext({
        commandName: "docs-sds-generate",
        commandRunId: commandRun.id,
        jobId: job.id,
        projectKey: options.projectKey,
        rfpPath: context.rfp?.path,
        templateName: options.templateName,
        outputPath,
        flags: {
          dryRun: options.dryRun === true,
          fast: fastMode,
          iterate,
          json: options.json === true,
          stream,
          buildReady,
          noPlaceholders,
          resolveOpenQuestions,
          noMaybes,
          crossAlign,
        },
        warnings,
      });
      runContext.iteration.max = maxIterations;
      const stateCleanupWarnings = await cleanupWorkspaceStateDirs({
        workspaceRoot: this.workspace.workspaceRoot,
        mcodaDir: this.workspace.mcodaDir,
      });
      const { statePath: iterativeOutputPath, warnings: statePathWarnings } = resolveDocgenStatePath({
        outputPath: runContext.outputPath,
        mcodaDir: this.workspace.mcodaDir,
        jobId: runContext.jobId,
        commandName: runContext.commandName,
      });
      const stateWarnings = [...stateCleanupWarnings, ...statePathWarnings];
      if (stateWarnings.length > 0) {
        runContext.stateWarnings = stateWarnings;
        this.appendUniqueWarnings(runContext, stateWarnings);
      }
      runContext.artifacts.sds = { kind: "sds", path: runContext.outputPath, meta: {} };
      await this.enforceToolDenylist({ runContext, agent });
      await this.recordDocgenStage(runContext, {
        stage: "generation",
        message: "Generating SDS draft",
        totalItems: maxIterations,
        processedItems: 0,
      });
      const prompts = await this.agentService.getPrompts(agent.id);
      const template = await this.loadSdsTemplate(options.templateName);
      const sdsSections = getSdsSections(template.content);
      const runbook =
        (await readPromptIfExists(this.workspace, path.join("prompts", "commands", "sds-generate.md"))) ||
        (await readPromptIfExists(this.workspace, path.join("prompts", "sds", "generate.md"))) ||
        DEFAULT_SDS_RUNBOOK_PROMPT;

      let draft = resumeDraft ?? "";
      let agentUsed = false;
      let agentMetadata: Record<string, unknown> | undefined;
      let adapter = agent.adapter;
      const invoke = async (input: string) => {
        agentUsed = true;
        const { output: out, adapter: usedAdapter, metadata } = await this.invokeAgent(
          agent,
          input,
          stream,
          job.id,
          options.onToken,
        );
        adapter = usedAdapter;
        if (metadata) agentMetadata = metadata;
        return { output: out, adapter: usedAdapter, metadata };
      };
      if (!resumeDraft) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const prompt = buildSdsRunPrompt(
            context,
            options.projectKey,
            prompts,
            attempt === 0
              ? runbook
              : `${runbook}\n\nRETRY: The previous attempt failed validation. Ensure all required sections are present and non-empty.`,
            template.content,
          );
          const { output: agentOutput, adapter: usedAdapter } = await invoke(prompt);
          draft = ensureSdsStructuredDraft(agentOutput, options.projectKey, context, template.content);
          const valid = skipValidation || (validateSdsDraft(draft) && headingHasContent(draft, "Architecture"));
          await this.jobService.recordTokenUsage({
            timestamp: new Date().toISOString(),
            workspaceId: this.workspace.workspaceId,
            commandName: "docs-sds-generate",
            jobId: job.id,
            commandRunId: commandRun.id,
            agentId: agent.id,
            modelName: agent.defaultModel,
            action: attempt === 0 ? "draft_sds" : "draft_sds_retry",
            promptTokens: estimateTokens(prompt),
            completionTokens: estimateTokens(agentOutput),
            metadata: {
              adapter,
              provider: adapter,
              docdexAvailable: context.docdexAvailable,
              template: template.name,
              attempt: attempt + 1,
              phase: attempt === 0 ? "draft_sds" : "draft_sds_retry",
            },
          });
          if (valid) break;
          if (attempt === 1) {
            throw new Error("SDS draft validation failed after retry (missing required sections or empty output).");
          }
        }
      } else {
        const valid = skipValidation || (validateSdsDraft(draft) && headingHasContent(draft, "Architecture"));
        if (!valid) {
          warnings.push("Saved draft failed validation on resume; regenerating.");
          draft = "";
        } else {
          await this.jobService.recordTokenUsage({
            timestamp: new Date().toISOString(),
            workspaceId: this.workspace.workspaceId,
            commandName: "docs-sds-generate",
            jobId: job.id,
            commandRunId: commandRun.id,
            action: "draft_sds_resume",
            promptTokens: 0,
            completionTokens: estimateTokens(draft),
            metadata: {
              adapter,
              provider: adapter,
              docdexAvailable: context.docdexAvailable,
              template: template.name,
              resumeFromJob: options.resumeJobId,
            },
          });
        }
      }
      if (!draft) {
        // regenerated draft in case resume draft was invalid
        const prompt = buildSdsRunPrompt(context, options.projectKey, prompts, runbook, template.content);
        const { output: agentOutput, adapter: usedAdapter } = await invoke(prompt);
        draft = ensureSdsStructuredDraft(agentOutput, options.projectKey, context, template.content);
        await this.jobService.recordTokenUsage({
          timestamp: new Date().toISOString(),
          workspaceId: this.workspace.workspaceId,
          commandName: "docs-sds-generate",
          jobId: job.id,
          commandRunId: commandRun.id,
          agentId: agent.id,
          modelName: agent.defaultModel,
          action: "draft_sds_resume_regenerate",
          promptTokens: estimateTokens(prompt),
          completionTokens: estimateTokens(agentOutput),
          metadata: {
            adapter,
            provider: adapter,
            docdexAvailable: context.docdexAvailable,
            template: template.name,
            phase: "draft_sds_resume_regenerate",
            attempt: 1,
          },
        });
      }
      if (fastMode) {
        warnings.push("Fast mode enabled; skipping SDS enrichment and tidy passes.");
      } else {
        // Enrich each section sequentially after a valid base draft exists.
        draft = await enrichSdsDraft(draft, sdsSections, agent, context, options.projectKey, invoke);
        draft = ensureSdsStructuredDraft(draft, options.projectKey, context, template.content);
        if (!skipValidation && !(validateSdsDraft(draft) && headingHasContent(draft, "Architecture"))) {
          warnings.push("Enriched SDS draft failed validation; using structured fallback.");
          draft = ensureSdsStructuredDraft(draft, options.projectKey, context, template.content);
        }
        try {
          const tidiedRaw = await tidySdsDraft(draft, sdsSections, agent, invoke);
          const tidied = ensureSdsStructuredDraft(tidiedRaw, options.projectKey, context, template.content);
          if (skipValidation || (validateSdsDraft(tidied) && headingHasContent(tidied, "Architecture"))) {
            draft = tidied;
          }
        } catch (error) {
          warnings.push(`SDS tidy pass skipped: ${(error as Error).message ?? "unknown error"}`);
        }
      }
      await fs.mkdir(path.dirname(draftPath), { recursive: true });
      await fs.writeFile(draftPath, draft, "utf8");
      const firstDraftPath = path.join(
        this.workspace.mcodaDir,
        "docs",
        "sds",
        `${path.basename(runContext.outputPath, path.extname(runContext.outputPath))}-first-draft.md`,
      );
      await ensureDir(firstDraftPath);
      await fs.writeFile(firstDraftPath, draft, "utf8");
      if (fastMode) {
        warnings.push("Fast mode enabled; skipping iterative SDS refinement.");
      } else {
        try {
          const iterativeDraft = await buildIterativeSds(
            options.projectKey,
            context,
            draft,
            sdsSections,
            iterativeOutputPath,
            invoke,
          );
          draft = iterativeDraft;
        } catch (error) {
          warnings.push(`Iterative SDS refinement failed; keeping first draft. ${String(error)}`);
        }
      }
      draft = ensureSdsStructuredDraft(draft, options.projectKey, context, template.content);
      await this.jobService.writeCheckpoint(job.id, {
        stage: "draft_completed",
        timestamp: new Date().toISOString(),
        details: { length: draft.length, template: template.name, draftPath },
      });

      let docdexId: string | undefined;
      let segments: string[] | undefined;
      let mirrorStatus = "skipped";
      let reviewReportPath: string | undefined;
      if (options.dryRun) {
        warnings.push("Dry run enabled; SDS was not written to disk or registered in docdex.");
      }
      if (!options.dryRun) {
        await this.writeSdsFile(runContext.outputPath, draft);
        if (context.docdexAvailable) {
          try {
            const registered = await this.registerSds(runContext.outputPath, draft, options.projectKey);
            docdexId = registered.id;
            segments = (registered.segments ?? []).map((s) => s.id);
            await fs.writeFile(
              `${runContext.outputPath}.meta.json`,
              JSON.stringify({ docdexId, segments, projectKey: options.projectKey }, null, 2),
              "utf8",
            );
          } catch (error) {
            warnings.push(`Docdex registration skipped: ${(error as Error).message}`);
          }
        }
        const publicDocsDir = path.join(this.workspace.workspaceRoot, "docs", "sds");
        const shouldMirror = this.workspace.config?.mirrorDocs !== false;
        if (shouldMirror) {
          try {
            await ensureDir(path.join(publicDocsDir, "placeholder"));
            const mirrorPath = path.join(publicDocsDir, path.basename(runContext.outputPath));
            await ensureDir(mirrorPath);
            await fs.writeFile(mirrorPath, draft, "utf8");
            mirrorStatus = "mirrored";
          } catch {
            mirrorStatus = "failed";
          }
        }
        try {
          await this.recordDocgenStage(runContext, {
            stage: "inventory",
            message: "Building doc inventory",
          });
          runContext.artifacts = await buildDocInventory({
            workspace: this.workspace,
            preferred: { sdsPath: runContext.outputPath },
          });
        } catch (error) {
          runContext.warnings.push(`Doc inventory build failed: ${(error as Error).message ?? String(error)}`);
        }
        await this.recordDocgenStage(runContext, {
          stage: "blueprint",
          message: "Generating deployment blueprint",
        });
        const blueprintGenerated = await this.generateDeploymentBlueprint(
          runContext,
          draft,
          options.projectKey,
        );
        if (blueprintGenerated) {
          try {
            await this.recordDocgenStage(runContext, {
              stage: "inventory",
              message: "Rebuilding doc inventory",
            });
            runContext.artifacts = await buildDocInventory({
              workspace: this.workspace,
              preferred: { sdsPath: runContext.outputPath },
            });
          } catch (error) {
            runContext.warnings.push(
              `Doc inventory rebuild after blueprint failed: ${(error as Error).message ?? String(error)}`,
            );
          }
        }
        const iterationResult = await this.runIterationLoop(runContext);
        reviewReportPath = iterationResult.reviewReportPath;
      }

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: {
          outputPath: runContext.outputPath,
          docdexId,
          segments,
          template: template.name,
          mirrorStatus,
          agentMetadata,
          ...(reviewReportPath ? { reviewReportPath } : {}),
        },
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");
      if (options.rateAgents && agentUsed) {
        try {
          const ratingService = await this.ensureRatingService();
          await ratingService.rate({
            workspace: this.workspace,
            agentId: agent.id,
            commandName: "docs-sds-generate",
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
        outputPath: runContext.outputPath,
        draft,
        docdexId,
        warnings: runContext.warnings,
      };
    } catch (error) {
      await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: (error as Error).message });
      await this.jobService.finishCommandRun(commandRun.id, "failed", (error as Error).message);
      throw error;
    }
  }
}
