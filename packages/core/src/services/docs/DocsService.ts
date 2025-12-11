import path from "node:path";
import { promises as fs } from "node:fs";
import { AgentService } from "@mcoda/agents";
import { GlobalRepository } from "@mcoda/db";
import { Agent, AgentPromptManifest } from "@mcoda/shared";
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
import { JobService, JobCheckpoint } from "../jobs/JobService.js";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { RoutingService } from "../agents/RoutingService.js";

export interface GeneratePdrOptions {
  workspace: WorkspaceResolution;
  projectKey?: string;
  rfpId?: string;
  rfpPath?: string;
  outPath?: string;
  agentName?: string;
  agentStream?: boolean;
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
  ["Requirements", "Requirements & Constraints"],
  ["Architecture", "Architecture Overview"],
  ["Interfaces", "Interfaces / APIs"],
  ["Non-Functional", "Non-Functional Requirements"],
  ["Risks", "Risks & Mitigations"],
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
  const required = [
    "Introduction",
    "Scope",
    "Architecture",
    "Components",
    "Data Model",
    "Interfaces",
    "Non-Functional",
    "Security",
    "Failure",
    "Risks",
    "Open Questions",
  ];
  return required.every((section) => new RegExp(`^#{1,6}\\s+[^\\n]*${section}\\b`, "im").test(draft));
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

class DocContextAssembler {
  constructor(private docdex: DocdexClient, private workspace: WorkspaceResolution) {}

  private summarize(doc: DocdexDocument): string {
    const lines = (doc.content ?? "").split(/\r?\n/).filter(Boolean);
    const head = lines.slice(0, 5).join(" ");
    return head || doc.title || doc.path || "Document";
  }

  private async findLatestLocalDoc(docType: string): Promise<DocdexDocument | undefined> {
    const candidates: { path: string; mtime: number }[] = [];
    const dirs = [
      path.join(this.workspace.mcodaDir, "docs", docType.toLowerCase()),
      path.join(this.workspace.workspaceRoot, "docs", docType.toLowerCase()),
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
        "No PDR or RFP content could be resolved. Ensure docdex is reachable with an sds_default profile or add local docs under .mcoda/docs/pdr and docs/rfp.",
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
      related = await this.docdex.search({ projectKey: input.projectKey, docType: "PDR", profile: "rfp_default" });
      const sds = await this.docdex.search({ projectKey: input.projectKey, docType: "SDS", profile: "rfp_default" });
      openapi = await this.docdex.search({ projectKey: input.projectKey, docType: "OPENAPI", profile: "rfp_default" });
      related = [...related, ...sds];
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
      "Introduction, Scope, Requirements & Constraints, Architecture Overview, Interfaces / APIs, Non-Functional Requirements, Risks & Mitigations, Open Questions, Acceptance Criteria",
      "Do not use bold headings; use `##` headings only. Do not repeat sections.",
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
  const required = [
    { title: "Introduction", fallback: `This PDR summarizes project ${projectKey ?? "N/A"} based on ${rfpSource}.` },
    {
      title: "Scope",
      fallback:
        "In-scope: todo CRUD (title required; optional description, due date, priority), status toggle, filters/sort/search, bulk complete/delete, keyboard shortcuts, responsive UI, offline/localStorage. Out-of-scope: multi-user/auth/sync/backends, notifications/reminders, team features, heavy UI kits.",
    },
    {
      title: "Requirements & Constraints",
      fallback:
        context.bullets.map((b) => `- ${b}`).join("\n") ||
        "- Data model, UX flows, keyboard shortcuts, and offline localStorage persistence per RFP.",
    },
    { title: "Architecture Overview", fallback: "Describe the system architecture, components, and interactions." },
    { title: "Interfaces / APIs", fallback: "List key interfaces and constraints. Do not invent endpoints." },
    { title: "Non-Functional Requirements", fallback: "- Performance, reliability, compliance, and operational needs." },
    { title: "Risks & Mitigations", fallback: "- Enumerate risks from the RFP and proposed mitigations." },
    { title: "Open Questions", fallback: "- Outstanding questions to clarify with stakeholders." },
    { title: "Acceptance Criteria", fallback: "- Add/edit/delete todos persists offline; filters/sorts/search <100ms for 500 items; shortcuts (`n`, Ctrl/Cmd+Enter) work; bulk actions confirm/undo; responsive and accessible (WCAG AA basics)." },
  ];

  const parts: string[] = [];
  parts.push(`# Product Design Review${projectKey ? `: ${projectKey}` : ""}`);
  for (const section of required) {
    const best = getBestSectionBody(normalized, section.title);
    const cleaned = cleanBody(best ?? "");
    const body = cleaned && cleaned.length > 0 ? cleaned : cleanBody(section.fallback);
    parts.push(`## ${section.title}`);
    parts.push(body);
  }
  parts.push("## Source RFP");
  parts.push(rfpSource);
  return parts.join("\n\n");
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
    "- Keep exactly one instance of each H2 section: Introduction, Scope, Requirements & Constraints, Architecture Overview, Interfaces / APIs, Non-Functional Requirements, Risks & Mitigations, Open Questions, Acceptance Criteria, Source RFP.",
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
    title: "Architecture Overview",
    guidance: [
      "List concrete modules/components: UI shells (list/detail), state/store, persistence adapter (localStorage), keyboard/shortcut handler, bulk selection manager, search/filter/sort utilities.",
      "Describe data flow (load -> store -> UI render; user actions -> store mutate -> persist).",
      "Call out offline-first behavior and how persistence errors are handled.",
    ],
  },
  {
    title: "Requirements & Constraints",
    guidance: [
      "Spell out data model fields (id, title, description?, status enum, dueDate format/timezone, priority enum order, createdAt/updatedAt, selection flag).",
      "Define localStorage key naming, schema versioning, and migration approach.",
      "Include accessibility expectations (keyboard focus, ARIA basics) and bundle size/perf targets.",
    ],
  },
  {
    title: "Interfaces / APIs",
    guidance: [
      "Define internal contracts: store API (add/update/delete/toggle/filter/search), persistence adapter API (load/save/validate), shortcut map (keys -> actions), bulk action contract, optional export/import shape.",
      "Clarify validation rules (required title, length limits, due date handling).",
    ],
  },
  {
    title: "Non-Functional Requirements",
    guidance: [
      "Quantify perf (<100ms for 500 items), bundle size goal, offline expectations, and accessibility targets (focus order, contrast).",
      "Reliability: handling storage quota/corruption, error surfacing.",
    ],
  },
  {
    title: "Risks & Mitigations",
    guidance: [
      "Cover localStorage limits/corruption, keyboard conflicts, bulk delete accidents, schema drift, and mobile usability.",
      "Provide specific mitigations (validation, confirmations/undo, migrations, debounced search, accessible shortcuts).",
    ],
  },
  {
    title: "Open Questions",
    guidance: [
      "Resolve defaults: sort/tie-breakers, priority order, initial filters, due date format/timezone.",
      "Ask about export/import needs, accessibility targets, theming/branding, undo/confirm patterns.",
    ],
  },
];

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

  const defaultSections = [
    "Introduction",
    "Goals & Scope",
    "Architecture Overview",
    "Components & Responsibilities",
    "Data Model & Persistence",
    "Interfaces & Contracts",
    "Non-Functional Requirements",
    "Security & Compliance",
    "Failure Modes & Resilience",
    "Risks & Mitigations",
    "Assumptions",
    "Open Questions",
    "Acceptance Criteria",
  ];

  const sections = templateHeadings.length ? templateHeadings : defaultSections;
  const cues = extractBullets(context.pdrs[0]?.content ?? context.rfp?.content ?? "", 10);
  const assumptionFallback =
    context.warnings.length > 0
      ? context.warnings.map((w) => `- Assumption/Gap: ${w}`).join("\n")
      : "- Document assumptions and dependencies.";

  const fallbackFor = (section: string): string => {
    const key = section.toLowerCase();
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
    if (key.includes("assumption")) return assumptionFallback;
    if (key.includes("question")) return "- Outstanding questions and clarifications required.";
    if (key.includes("acceptance")) return "- Criteria for sign-off and verification.";
    if (key.includes("introduction"))
      return `SDS for ${projectKey ?? "project"} derived from available PDR/RFP context.`;
    return "- TBD";
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
  return structured;
};

const getSdsSections = (template: string): string[] => {
  const templateHeadings = template
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim());

  const defaultSections = [
    "Introduction",
    "Goals & Scope",
    "Architecture Overview",
    "Components & Responsibilities",
    "Data Model & Persistence",
    "Interfaces & Contracts",
    "Non-Functional Requirements",
    "Security & Compliance",
    "Failure Modes & Resilience",
    "Risks & Mitigations",
    "Assumptions",
    "Open Questions",
    "Acceptance Criteria",
  ];

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
  const regex = new RegExp(`(^#{1,6}\\s+${title}\\b)([\\s\\S]*?)(?=^#{1,6}\\s+|$)`, "im");
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

  constructor(
    private workspace: WorkspaceResolution,
    deps: {
      docdex?: DocdexClient;
      jobService?: JobService;
      agentService: AgentService;
      repo: GlobalRepository;
      routingService: RoutingService;
      noTelemetry?: boolean;
    },
  ) {
    this.docdex = deps?.docdex ?? new DocdexClient({ workspaceRoot: workspace.workspaceRoot });
    this.jobService = deps?.jobService ?? new JobService(workspace, undefined, { noTelemetry: deps?.noTelemetry });
    this.repo = deps.repo;
    this.agentService = deps.agentService;
    this.routingService = deps.routingService;
  }

  static async create(workspace: WorkspaceResolution, options: { noTelemetry?: boolean } = {}): Promise<DocsService> {
    const repo = await GlobalRepository.create();
    const agentService = new AgentService(repo);
    const routingService = await RoutingService.create();
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
    });
    const jobService = new JobService(workspace, undefined, { noTelemetry: options.noTelemetry });
    return new DocsService(workspace, { repo, agentService, routingService, docdex, jobService, noTelemetry: options.noTelemetry });
  }

  async close(): Promise<void> {
    if ((this.agentService as any).close) {
      await this.agentService.close();
    }
    if ((this.repo as any).close) {
      await this.repo.close();
    }
    if ((this.jobService as any).close) {
      await this.jobService.close();
    }
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

  private async resolveAgent(
    agentName: string | undefined,
    commandAliases: string[] = ["docs-pdr-generate", "docs:pdr:generate", "pdr"],
  ): Promise<Agent> {
    const commandName = commandAliases[commandAliases.length - 1] ?? "pdr";
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName,
      overrideAgentSlug: agentName,
    });
    return resolved.agent;
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

  private async assertSdsDocdexProfile(): Promise<void> {
    const base = this.workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL;
    if (base) return;
    const localStore = path.join(this.workspace.workspaceRoot, ".mcoda", "docdex", "documents.json");
    try {
      await fs.access(localStore);
    } catch {
      throw new Error(
        "Docdex is not configured for SDS retrieval (missing docdexUrl and no local store). Configure docdexUrl or index docs with an sds_default profile.",
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
        action: "docdex_context",
        promptTokens: 0,
        completionTokens: 0,
        metadata: { docdexAvailable: context.docdexAvailable },
      });

      const agent = await this.resolveAgent(options.agentName);
      const prompts = await this.agentService.getPrompts(agent.id);
      const runbook =
        (await readPromptIfExists(this.workspace, path.join("prompts", "commands", "pdr-generate.md"))) ||
        DEFAULT_PDR_RUNBOOK_PROMPT;

      let draft = "";
      let agentMetadata: Record<string, unknown> | undefined;
      let adapter = agent.adapter;
      const stream = options.agentStream ?? true;
      const skipValidation = process.env.MCODA_SKIP_PDR_VALIDATION === "1";
      let lastInvoke:
        | ((input: string) => Promise<{ output: string; adapter: string; metadata?: Record<string, unknown> }>)
        | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prompt = buildRunPrompt(context, options.projectKey, prompts, attempt === 0 ? runbook : `${runbook}\n\nRETRY: The previous attempt failed validation. Ensure all required sections are present and non-empty. Do not leave placeholders.`);
        const invoke = async (input: string) => {
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
          agentId: agent.id,
          modelName: agent.defaultModel,
          action: attempt === 0 ? "draft_pdr" : "draft_pdr_retry",
          promptTokens: estimateTokens(prompt),
          completionTokens: estimateTokens(agentOutput),
          metadata: { adapter, docdexAvailable: context.docdexAvailable, attempt },
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

      if (lastInvoke) {
        draft = await enrichPdrDraft(draft, agent, context, options.projectKey, lastInvoke);
        draft = ensureStructuredDraft(draft, options.projectKey, context, context.rfp.path ?? context.rfp.id ?? "RFP");
      }
      if (lastInvoke) {
        try {
          const tidiedRaw = await tidyPdrDraft(draft, agent, lastInvoke);
          const tidied = ensureStructuredDraft(tidiedRaw, options.projectKey, context, context.rfp.path ?? context.rfp.id ?? "RFP");
          const tidiedValid = validateDraft(tidied) && headingHasContent(tidied, "Introduction");
          const keepTidied = tidiedValid && tidied.length >= draft.length * 0.6;
          if (keepTidied) {
            draft = tidied;
          }
        } catch (error) {
          context.warnings.push(`Tidy pass skipped: ${(error as Error).message ?? "unknown error"}`);
        }
      }
      const outputPath = options.outPath ?? this.defaultPdrOutputPath(options.projectKey, context.rfp.path);
      const firstDraftPath = path.join(
        this.workspace.mcodaDir,
        "docs",
        "pdr",
        `${path.basename(outputPath, path.extname(outputPath))}-first-draft.md`,
      );
      await ensureDir(firstDraftPath);
      await fs.writeFile(firstDraftPath, draft, "utf8");
      try {
        const iterativeDraft = await buildIterativePdr(
          options.projectKey,
          context,
          draft,
          outputPath,
          lastInvoke ?? (async (input: string) => this.invokeAgent(agent, input, stream, job.id, options.onToken)),
        );
        draft = iterativeDraft;
      } catch (error) {
        context.warnings.push(`Iterative PDR refinement failed; keeping first draft. ${String(error)}`);
      }
      await this.jobService.writeCheckpoint(job.id, {
        stage: "draft_completed",
        timestamp: new Date().toISOString(),
        details: { length: draft.length },
      });

      let docdexId: string | undefined;
      let segments: string[] | undefined;
      let mirrorStatus = "skipped";
      if (options.dryRun) {
        context.warnings.push("Dry run enabled; PDR was not written to disk or registered in docdex.");
      }
      if (!options.dryRun) {
        await this.writePdrFile(outputPath, draft);
        if (context.docdexAvailable) {
          const registered = await this.registerPdr(outputPath, draft, options.projectKey);
          docdexId = registered.id;
          segments = (registered.segments ?? []).map((s) => s.id);
          await fs.writeFile(
            `${outputPath}.meta.json`,
            JSON.stringify({ docdexId, segments, projectKey: options.projectKey }, null, 2),
            "utf8",
          );
        }
        const publicDocsDir = path.join(this.workspace.workspaceRoot, "docs", "pdr");
        const shouldMirror = this.workspace.config?.mirrorDocs !== false;
        if (shouldMirror) {
          try {
            await ensureDir(path.join(publicDocsDir, "placeholder"));
            const mirrorPath = path.join(publicDocsDir, path.basename(outputPath));
            await ensureDir(mirrorPath);
            await fs.writeFile(mirrorPath, draft, "utf8");
            mirrorStatus = "mirrored";
          } catch {
            // optional mirror skipped
            mirrorStatus = "failed";
          }
        }
      }

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: { outputPath, docdexId, segments, mirrorStatus },
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");
      return {
        jobId: job.id,
        commandRunId: commandRun.id,
        outputPath,
        draft,
        docdexId,
        warnings: context.warnings,
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
    await this.assertSdsDocdexProfile();
    const assembler = new DocContextAssembler(this.docdex, this.workspace);
    const warnings: string[] = [];
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

      const agent = await this.resolveAgent(options.agentName, ["docs-sds-generate", "docs:sds:generate", "sds"]);
      const prompts = await this.agentService.getPrompts(agent.id);
      const template = await this.loadSdsTemplate(options.templateName);
      const sdsSections = getSdsSections(template.content);
      const runbook =
        (await readPromptIfExists(this.workspace, path.join("prompts", "commands", "sds-generate.md"))) ||
        (await readPromptIfExists(this.workspace, path.join("prompts", "sds", "generate.md"))) ||
        DEFAULT_SDS_RUNBOOK_PROMPT;

      let draft = resumeDraft ?? "";
      let agentMetadata: Record<string, unknown> | undefined;
      let adapter = agent.adapter;
      const stream = options.agentStream ?? true;
      const skipValidation = process.env.MCODA_SKIP_SDS_VALIDATION === "1";
      const invoke = async (input: string) => {
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
              attempt,
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
          agentId: agent.id,
          modelName: agent.defaultModel,
          action: "draft_sds_resume_regenerate",
          promptTokens: estimateTokens(prompt),
          completionTokens: estimateTokens(agentOutput),
          metadata: { adapter, provider: adapter, docdexAvailable: context.docdexAvailable, template: template.name },
        });
      }
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
      await fs.mkdir(path.dirname(draftPath), { recursive: true });
      await fs.writeFile(draftPath, draft, "utf8");
      const firstDraftPath = path.join(
        this.workspace.mcodaDir,
        "docs",
        "sds",
        `${path.basename(outputPath, path.extname(outputPath))}-first-draft.md`,
      );
      await ensureDir(firstDraftPath);
      await fs.writeFile(firstDraftPath, draft, "utf8");
      try {
        const iterativeDraft = await buildIterativeSds(
          options.projectKey,
          context,
          draft,
          sdsSections,
          outputPath,
          invoke,
        );
        draft = iterativeDraft;
      } catch (error) {
        warnings.push(`Iterative SDS refinement failed; keeping first draft. ${String(error)}`);
      }
      await this.jobService.writeCheckpoint(job.id, {
        stage: "draft_completed",
        timestamp: new Date().toISOString(),
        details: { length: draft.length, template: template.name, draftPath },
      });

      let docdexId: string | undefined;
      let segments: string[] | undefined;
      let mirrorStatus = "skipped";
      if (options.dryRun) {
        warnings.push("Dry run enabled; SDS was not written to disk or registered in docdex.");
      }
      if (!options.dryRun) {
        await this.writeSdsFile(outputPath, draft);
        if (context.docdexAvailable) {
          const registered = await this.registerSds(outputPath, draft, options.projectKey);
          docdexId = registered.id;
          segments = (registered.segments ?? []).map((s) => s.id);
          await fs.writeFile(
            `${outputPath}.meta.json`,
            JSON.stringify({ docdexId, segments, projectKey: options.projectKey }, null, 2),
            "utf8",
          );
        }
        const publicDocsDir = path.join(this.workspace.workspaceRoot, "docs", "sds");
        const shouldMirror = this.workspace.config?.mirrorDocs !== false;
        if (shouldMirror) {
          try {
            await ensureDir(path.join(publicDocsDir, "placeholder"));
            const mirrorPath = path.join(publicDocsDir, path.basename(outputPath));
            await ensureDir(mirrorPath);
            await fs.writeFile(mirrorPath, draft, "utf8");
            mirrorStatus = "mirrored";
          } catch {
            mirrorStatus = "failed";
          }
        }
      }

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: {
          outputPath,
          docdexId,
          segments,
          template: template.name,
          mirrorStatus,
          agentMetadata,
        },
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");
      return {
        jobId: job.id,
        commandRunId: commandRun.id,
        outputPath,
        draft,
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
