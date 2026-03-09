import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import {
  type DocArtifactRecord,
  type DocgenArtifactInventory,
  createEmptyArtifacts,
} from "../docs/DocgenRunContext.js";
import {
  aggregateReviewOutcome,
  type ReviewGateResult,
  type ReviewIssue,
  type ReviewSeverity,
} from "../docs/review/ReviewTypes.js";
import { runOpenQuestionsGate } from "../docs/review/gates/OpenQuestionsGate.js";
import { runSdsNoUnresolvedItemsGate } from "../docs/review/gates/SdsNoUnresolvedItemsGate.js";
import { runSdsFolderTreeGate } from "../docs/review/gates/SdsFolderTreeGate.js";
import { runSdsTechStackRationaleGate } from "../docs/review/gates/SdsTechStackRationaleGate.js";
import { runSdsPolicyTelemetryGate } from "../docs/review/gates/SdsPolicyTelemetryGate.js";
import { runSdsOpsGate } from "../docs/review/gates/SdsOpsGate.js";
import { runSdsDecisionsGate } from "../docs/review/gates/SdsDecisionsGate.js";
import { runSdsAdaptersGate } from "../docs/review/gates/SdsAdaptersGate.js";

const SDS_SCAN_MAX_FILES = 120;
const SDS_SCAN_MAX_DEPTH = 5;
const TASKS_FOLDER_NAME = "tasks";
const PREFLIGHT_REPORT_NAME = "sds-preflight-report.json";
const OPEN_QUESTIONS_DOC_NAME = "sds-open-questions-answers.md";
const GAP_ADDENDUM_DOC_NAME = "sds-gap-remediation-addendum.md";
const MANAGED_SDS_BLOCK_START = "<!-- mcoda:sds-preflight:start -->";
const MANAGED_SDS_BLOCK_END = "<!-- mcoda:sds-preflight:end -->";
const DEFAULT_COMMIT_MESSAGE = "mcoda: apply SDS preflight remediations";

const ignoredDirs = new Set([
  ".git",
  ".mcoda",
  ".docdex",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "tmp",
  "temp",
]);

const strongSdsFilenamePattern = /(sds|software[-_ ]design|system[-_ ]design|design[-_ ]spec)/i;
const strongSdsDirectoryPattern = /(?:^|[/\\])sds(?:[/\\]|$)/i;
const weakSdsFilenamePattern = /architecture/i;
const sdsTitlePattern = /^#\s*(?:software design specification|system design specification|sds)\b/im;
const nonSdsTitlePattern = /^#\s*(?:product design review|pdr|request for proposal|rfp)\b/im;
const sdsSectionPatterns = [
  /^#{1,6}\s+open questions\b/im,
  /^#{1,6}\s+folder tree\b/im,
  /^#{1,6}\s+technology stack\b/im,
  /^#{1,6}\s+policy(?: and cache consent)?\b/im,
  /^#{1,6}\s+telemetry\b/im,
  /^#{1,6}\s+(?:metering and usage|metering|usage)\b/im,
  /^#{1,6}\s+(?:operations and deployment|operations|deployment)\b/im,
  /^#{1,6}\s+observability\b/im,
  /^#{1,6}\s+testing gates\b/im,
  /^#{1,6}\s+(?:failure recovery and rollback|failure modes(?:, recovery, and rollback)?)\b/im,
  /^#{1,6}\s+external integrations and adapter contracts\b/im,
];
const markdownPattern = /\.(md|markdown|txt|rst)$/i;
const unresolvedTokenPattern = /\b(TBD|TBC|TODO|FIXME|to be determined|to be decided|unknown|unresolved)\b/gi;
const sdsHeadingLinePattern = /^#{1,6}\s+(.+)$/;
const sdsFolderEntryPattern = /[`'"]?([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+(?:\/[a-zA-Z0-9._-]+)*)[`'"]?/g;
const SDS_SIGNAL_HEADING_LIMIT = 60;
const SDS_SIGNAL_FOLDER_LIMIT = 20;
const technologyMatchers: Array<{ label: string; pattern: RegExp }> = [
  { label: "Node.js", pattern: /\bnode(\.js)?\b/i },
  { label: "TypeScript", pattern: /\btypescript\b|\btsconfig\b/i },
  { label: "Python", pattern: /\bpython\b|\bfastapi\b|\bflask\b/i },
  { label: "Go", pattern: /\bgolang\b|\bgo\b/i },
  { label: "Rust", pattern: /\brust\b/i },
  { label: "PostgreSQL", pattern: /\bpostgres(ql)?\b/i },
  { label: "MySQL", pattern: /\bmysql\b/i },
  { label: "MongoDB", pattern: /\bmongodb\b|\bmongo\b/i },
  { label: "Redis", pattern: /\bredis\b/i },
  { label: "Kafka", pattern: /\bkafka\b/i },
  { label: "RabbitMQ", pattern: /\brabbitmq\b/i },
  { label: "React", pattern: /\breact\b/i },
  { label: "Next.js", pattern: /\bnext\.?js\b/i },
  { label: "Docker", pattern: /\bdocker\b/i },
  { label: "Kubernetes", pattern: /\bkubernetes\b|\bk8s\b/i },
];
const adapterMatchers: Array<{ label: string; pattern: RegExp }> = [
  { label: "OpenAI", pattern: /\bopenai\b/i },
  { label: "Anthropic", pattern: /\banthropic\b|\bclaude\b/i },
  { label: "Google Gemini", pattern: /\bgemini\b/i },
  { label: "Mistral", pattern: /\bmistral\b/i },
  { label: "Cohere", pattern: /\bcohere\b/i },
  { label: "OpenRouter", pattern: /\bopenrouter\b/i },
  { label: "Brave Search", pattern: /\bbrave\b/i },
  { label: "Stripe", pattern: /\bstripe\b/i },
  { label: "Twilio", pattern: /\btwilio\b/i },
  { label: "SendGrid", pattern: /\bsendgrid\b/i },
  { label: "Sentry", pattern: /\bsentry\b/i },
  { label: "Datadog", pattern: /\bdatadog\b/i },
  { label: "PostHog", pattern: /\bposthog\b/i },
  { label: "Algolia", pattern: /\balgolia\b/i },
];
const environmentMatchers: Array<{ label: string; pattern: RegExp }> = [
  { label: "local", pattern: /\blocal\b|\bdev(elopment)?\b/i },
  { label: "staging", pattern: /\bstaging\b|\bpre-?prod\b/i },
  { label: "production", pattern: /\bprod(uction)?\b/i },
];
const documentationSegmentPattern = /^(docs?|design|specs?|runbooks?|adr|architecture)$/i;
const implementationSegmentPattern =
  /^(src|app|apps|service|services|worker|workers|module|modules|package|packages|lib|libs|engine|engines|console|consoles|runtime|runtimes)$/i;
const interfaceSegmentPattern = /^(api|apis|openapi|swagger|graphql|proto|schema|schemas|contract|contracts|interface|interfaces)$/i;
const storageSegmentPattern = /^(db|data|storage|schema|schemas|migration|migrations|sql|seed|seeds)$/i;
const automationSegmentPattern = /^(script|scripts|tool|tools|bin|cmd|cli|automation)$/i;
const operationsSegmentPattern =
  /^(ops|deploy|deployment|deployments|infra|infrastructure|terraform|helm|k8s|kubernetes|systemd)$/i;
const validationSegmentPattern = /^(test|tests|testing|spec|specs|e2e|qa|fixtures)$/i;
const staticAssetSegmentPattern = /^(public|static|assets)$/i;
const moduleNoiseTokens = new Set([
  "and",
  "for",
  "from",
  "into",
  "with",
  "without",
  "under",
  "over",
  "this",
  "that",
  "those",
  "these",
  "section",
  "sections",
  "module",
  "modules",
  "system",
  "design",
  "specification",
]);
const execFileAsync = promisify(execFile);

const uniqueStrings = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

const stripManagedPreflightBlocks = (content: string): string => {
  let updated = content;
  while (true) {
    const startIndex = updated.indexOf(MANAGED_SDS_BLOCK_START);
    if (startIndex < 0) break;
    const endIndex = updated.indexOf(MANAGED_SDS_BLOCK_END, startIndex);
    if (endIndex < 0) break;
    updated = `${updated.slice(0, startIndex)}\n${updated.slice(endIndex + MANAGED_SDS_BLOCK_END.length)}`;
  }
  return updated;
};

const describeFolderEntry = (entry: string): string => {
  if (/\s+#/.test(entry)) return "";
  const segments = entry
    .replace(/^\.?\//, "")
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  if (segments.length === 0) return "implementation surface";
  if (segments.some((segment) => documentationSegmentPattern.test(segment))) return "documentation and planning inputs";
  if (segments.some((segment) => validationSegmentPattern.test(segment))) return "automated validation surfaces";
  if (segments.some((segment) => automationSegmentPattern.test(segment))) return "automation and command entrypoints";
  if (segments.some((segment) => operationsSegmentPattern.test(segment))) return "deployment and operations assets";
  if (segments.some((segment) => storageSegmentPattern.test(segment))) return "storage and schema assets";
  if (segments.some((segment) => interfaceSegmentPattern.test(segment)))
    return "interface definitions and compatibility surfaces";
  if (segments.some((segment) => staticAssetSegmentPattern.test(segment))) return "runtime assets";
  if (segments.some((segment) => implementationSegmentPattern.test(segment))) return "implementation surfaces";
  return segments.length >= 2 ? "implementation surface" : "top-level workspace surface";
};

const normalizeQuestion = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const issueLocationKey = (issue: ReviewIssue): string => {
  if (issue.location.kind === "line_range") {
    return `${issue.location.path}:${issue.location.lineStart}-${issue.location.lineEnd}`;
  }
  return `${issue.location.path ?? ""}#${issue.location.heading}`;
};

const issueSeverityRank: Record<ReviewSeverity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const formatIssueLocation = (issue: ReviewIssue): string => {
  if (issue.location.kind === "line_range") {
    return `${issue.location.path}:${issue.location.lineStart}`;
  }
  return issue.location.path ? `${issue.location.path}#${issue.location.heading}` : issue.location.heading;
};

type GateRunner = (input: { artifacts: DocgenArtifactInventory }) => Promise<ReviewGateResult>;

type SdsFileSignals = {
  headings: string[];
  folderEntries: string[];
  moduleDomains: string[];
  technologies: string[];
  adapters: string[];
  environments: string[];
};

export interface SdsPreflightQuestionAnswer {
  question: string;
  normalized: string;
  required: boolean;
  target: string;
  sourcePath?: string;
  line?: number;
  answer: string;
  rationale: string;
  assumptions: string[];
}

export interface SdsPreflightIssueSummary {
  gateId: string;
  gateName: string;
  severity: ReviewSeverity;
  category: string;
  message: string;
  remediation: string;
  location: string;
}

export interface SdsPreflightResult {
  projectKey: string;
  generatedAt: string;
  readyForPlanning: boolean;
  qualityStatus: "pass" | "warn" | "fail";
  sourceSdsPaths: string[];
  reportPath: string;
  openQuestionsPath: string;
  gapAddendumPath: string;
  generatedDocPaths: string[];
  questionCount: number;
  requiredQuestionCount: number;
  issueCount: number;
  blockingIssueCount: number;
  appliedToSds: boolean;
  appliedSdsPaths: string[];
  commitHash?: string;
  issues: SdsPreflightIssueSummary[];
  questions: SdsPreflightQuestionAnswer[];
  warnings: string[];
}

export interface SdsPreflightOptions {
  workspace: WorkspaceResolution;
  projectKey: string;
  inputPaths?: string[];
  sdsPaths?: string[];
  writeArtifacts?: boolean;
  applyToSds?: boolean;
  commitAppliedChanges?: boolean;
  commitMessage?: string;
}

export class SdsPreflightService {
  private readonly workspace: WorkspaceResolution;

  constructor(workspace: WorkspaceResolution) {
    this.workspace = workspace;
  }

  static async create(workspace: WorkspaceResolution): Promise<SdsPreflightService> {
    return new SdsPreflightService(workspace);
  }

  async close(): Promise<void> {
    // Stateless service for now.
  }

  private async walkCandidates(root: string, depth: number, collector: (filePath: string) => void): Promise<void> {
    if (depth > SDS_SCAN_MAX_DEPTH) return;
    let entries: Array<import("node:fs").Dirent> = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        if (entry.isDirectory() && ![".github"].includes(entry.name)) continue;
      }
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        await this.walkCandidates(path.join(root, entry.name), depth + 1, collector);
        continue;
      }
      if (!entry.isFile()) continue;
      const candidate = path.join(root, entry.name);
      if (!markdownPattern.test(candidate)) continue;
      collector(candidate);
    }
  }

  private async collectPathCandidates(inputPaths: string[] | undefined): Promise<string[]> {
    if (!inputPaths || inputPaths.length === 0) return [];
    const resolved: string[] = [];
    for (const input of inputPaths) {
      if (!input || input.startsWith("docdex:")) continue;
      const fullPath = path.isAbsolute(input) ? input : path.join(this.workspace.workspaceRoot, input);
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.isFile()) {
        resolved.push(path.resolve(fullPath));
        continue;
      }
      if (!stat.isDirectory()) continue;
      await this.walkCandidates(path.resolve(fullPath), 0, (filePath) => {
        resolved.push(path.resolve(filePath));
      });
    }
    return uniqueStrings(resolved).slice(0, SDS_SCAN_MAX_FILES);
  }

  private async discoverSdsPaths(): Promise<string[]> {
    const candidates = [
      path.join(this.workspace.workspaceRoot, "docs", "sds.md"),
      path.join(this.workspace.workspaceRoot, "docs", "sds", "sds.md"),
      path.join(this.workspace.workspaceRoot, "docs", "software-design-specification.md"),
      path.join(this.workspace.workspaceRoot, "sds.md"),
    ];
    const discovered: string[] = [];
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) discovered.push(path.resolve(candidate));
      } catch {
        // ignore
      }
    }

    await this.walkCandidates(this.workspace.workspaceRoot, 0, (filePath) => {
      discovered.push(path.resolve(filePath));
    });

    return uniqueStrings(discovered).slice(0, SDS_SCAN_MAX_FILES);
  }

  private countSdsSectionSignals(sample: string): number {
    const effectiveSample = stripManagedPreflightBlocks(sample);
    return sdsSectionPatterns.reduce((count, pattern) => count + (pattern.test(effectiveSample) ? 1 : 0), 0);
  }

  private async isLikelySdsPath(filePath: string): Promise<boolean> {
    const baseName = path.basename(filePath);
    const normalizedPath = filePath.replace(/\\/g, "/");
    try {
      const rawSample = (await fs.readFile(filePath, "utf8")).slice(0, 35000);
      const sample = stripManagedPreflightBlocks(rawSample);
      if (nonSdsTitlePattern.test(sample)) return false;
      if (sdsTitlePattern.test(sample)) return true;
      if (strongSdsFilenamePattern.test(baseName) || strongSdsDirectoryPattern.test(normalizedPath)) {
        return true;
      }
      if (!weakSdsFilenamePattern.test(baseName)) return false;
      return this.countSdsSectionSignals(sample) >= 3;
    } catch {
      return false;
    }
  }

  private async selectLikelySdsPaths(candidatePaths: string[]): Promise<string[]> {
    const selected: string[] = [];
    for (const candidate of uniqueStrings(candidatePaths).slice(0, SDS_SCAN_MAX_FILES)) {
      if (await this.isLikelySdsPath(candidate)) {
        selected.push(path.resolve(candidate));
      }
      if (selected.length >= SDS_SCAN_MAX_FILES) break;
    }
    return uniqueStrings(selected);
  }

  private async resolveSdsPaths(options: SdsPreflightOptions): Promise<string[]> {
    const explicit = await this.collectPathCandidates(options.sdsPaths);
    if (explicit.length > 0) {
      return this.selectLikelySdsPaths(explicit);
    }
    const fromInputs = await this.collectPathCandidates(options.inputPaths);
    const selectedFromInputs = await this.selectLikelySdsPaths(fromInputs);
    if (selectedFromInputs.length > 0) {
      return selectedFromInputs;
    }
    const discovered = await this.discoverSdsPaths();
    return this.selectLikelySdsPaths(discovered);
  }

  private buildArtifacts(sdsPath: string): DocgenArtifactInventory {
    const artifacts = createEmptyArtifacts();
    artifacts.sds = {
      kind: "sds",
      path: sdsPath,
      variant: "primary",
      meta: {},
    } as DocArtifactRecord;
    return artifacts;
  }

  private getGateRunners(): GateRunner[] {
    return [
      runOpenQuestionsGate,
      runSdsNoUnresolvedItemsGate,
      runSdsFolderTreeGate,
      runSdsTechStackRationaleGate,
      runSdsPolicyTelemetryGate,
      runSdsOpsGate,
      runSdsDecisionsGate,
      runSdsAdaptersGate,
    ];
  }

  private dedupeIssues(issues: ReviewIssue[]): ReviewIssue[] {
    const seen = new Set<string>();
    const deduped: ReviewIssue[] = [];
    for (const issue of issues) {
      const key = `${issue.gateId}|${issue.category}|${issue.message}|${issueLocationKey(issue)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(issue);
    }
    return deduped.sort((a, b) => {
      const severityDiff = issueSeverityRank[a.severity] - issueSeverityRank[b.severity];
      if (severityDiff !== 0) return severityDiff;
      const gateDiff = a.gateId.localeCompare(b.gateId);
      if (gateDiff !== 0) return gateDiff;
      return issueLocationKey(a).localeCompare(issueLocationKey(b));
    });
  }

  private resolveWorkspacePath(filePath: string): string {
    return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(this.workspace.workspaceRoot, filePath);
  }

  private collectSignalsFromContent(content: string): SdsFileSignals {
    const lines = stripManagedPreflightBlocks(content).split(/\r?\n/);
    const headings: string[] = [];
    const folderEntries: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const headingMatch = trimmed.match(sdsHeadingLinePattern);
      if (headingMatch?.[1]) {
        headings.push(headingMatch[1].replace(/#+$/, "").trim());
      }
      const folderMatches = [...trimmed.matchAll(new RegExp(sdsFolderEntryPattern.source, "g"))];
      for (const match of folderMatches) {
        const entry = (match[1] ?? "").replace(/^\.?\//, "").replace(/\/+$/, "").trim();
        if (!entry || !entry.includes("/")) continue;
        folderEntries.push(entry);
      }
    }
    const moduleDomains = uniqueStrings(
      headings.flatMap((heading) =>
        heading
          .replace(/^\d+(?:\.\d+)*\s+/, "")
          .toLowerCase()
          .split(/\s+/)
          .map((token) => token.replace(/[^a-z0-9._-]+/g, ""))
          .filter((token) => token.length >= 4 && !moduleNoiseTokens.has(token)),
      ),
    ).slice(0, 10);
    const technologies = technologyMatchers.filter((matcher) => matcher.pattern.test(content)).map((matcher) => matcher.label);
    const adapters = adapterMatchers.filter((matcher) => matcher.pattern.test(content)).map((matcher) => matcher.label);
    const environments = environmentMatchers
      .filter((matcher) => matcher.pattern.test(content))
      .map((matcher) => matcher.label);
    return {
      headings: uniqueStrings(headings).slice(0, SDS_SIGNAL_HEADING_LIMIT),
      folderEntries: uniqueStrings(folderEntries).slice(0, SDS_SIGNAL_FOLDER_LIMIT),
      moduleDomains,
      technologies,
      adapters,
      environments,
    };
  }

  private async collectSignalsByPath(sourceSdsPaths: string[]): Promise<Map<string, SdsFileSignals>> {
    const signalsByPath = new Map<string, SdsFileSignals>();
    for (const sdsPath of sourceSdsPaths) {
      try {
        const content = await fs.readFile(sdsPath, "utf8");
        signalsByPath.set(path.resolve(sdsPath), this.collectSignalsFromContent(content));
      } catch {
        signalsByPath.set(path.resolve(sdsPath), {
          headings: [],
          folderEntries: [],
          moduleDomains: [],
          technologies: [],
          adapters: [],
          environments: [],
        });
      }
    }
    return signalsByPath;
  }

  private signalsForPath(
    signalsByPath: Map<string, SdsFileSignals>,
    sourcePath: string | undefined,
  ): SdsFileSignals | undefined {
    if (!sourcePath) return undefined;
    return signalsByPath.get(this.resolveWorkspacePath(sourcePath));
  }

  private answerForQuestion(
    question: string,
    context: { target: string; required: boolean; heading?: string; signals?: SdsFileSignals },
  ): { answer: string; rationale: string; assumptions: string[] } {
    const combined = [question, context.target, context.heading ?? "", ...(context.signals?.headings ?? []).slice(0, 4)].join(" ");
    const lower = combined.toLowerCase();
    const moduleHint = context.signals?.moduleDomains?.slice(0, 3).join(", ");
    const folderHint = context.signals?.folderEntries?.slice(0, 2).map((entry) => `\`${entry}\``).join(", ");
    const adapterHint = context.signals?.adapters?.slice(0, 4).join(", ");
    const environmentMatrix =
      context.signals?.environments && context.signals.environments.length > 0
        ? context.signals.environments.join(", ")
        : "local, staging, production";
    const assumptions: string[] = [];
    if (context.required) {
      assumptions.push("This decision is required to unblock preflight planning gates.");
    }
    if (folderHint) {
      assumptions.push(`Primary implementation surfaces include ${folderHint}.`);
    }
    if (moduleHint) {
      assumptions.push(`Impacted modules include ${moduleHint}.`);
    }

    if (/(uncertainty|confidence|sensitivity)/i.test(lower)) {
      return {
        answer:
          "Adopt an uncertainty-first contract: compute calibrated confidence intervals, publish sensitivity analysis for top drivers, and surface uncertainty state consistently in API and UI responses.",
        rationale:
          "This prevents false precision and keeps downstream decisions auditable when model confidence is weak.",
        assumptions: uniqueStrings([
          ...assumptions,
          "Model evaluation flow supports calibration and confidence diagnostics.",
        ]),
      };
    }
    if (/(modular monolith|monolith|module boundaries|bounded context)/i.test(lower)) {
      const moduleRoots = uniqueStrings(
        (context.signals?.folderEntries ?? []).map((entry) => entry.split("/").slice(0, 2).join("/")),
      ).slice(0, 4);
      return {
        answer:
          moduleRoots.length > 0
            ? `Start as a modular monolith with strict internal boundaries across ${moduleRoots.map((entry) => `\`${entry}\``).join(", ")}; keep interfaces explicit and defer service extraction until runtime load and ownership seams are proven.`
            : "Start as a modular monolith: define bounded internal modules with explicit interfaces, enforce dependency direction, and postpone microservice extraction until ownership seams are proven.",
        rationale:
          "This reduces distributed-system overhead while preserving a clean extraction path when scale or team ownership requires it.",
        assumptions: uniqueStrings([
          ...assumptions,
          "Single deployable unit is acceptable for early delivery phases.",
        ]),
      };
    }
    if (/(risk|mitigation|rollback|contingency|failure)/i.test(lower)) {
      return {
        answer:
          "Maintain a feature-level risk register with likelihood, impact, owner, mitigation, trigger signal, and explicit rollback action; every high-risk item must link to a validation or observability checkpoint.",
        rationale:
          "Risk entries tied to concrete checkpoints improve release predictability and shorten incident recovery loops.",
        assumptions: uniqueStrings([
          ...assumptions,
          `Deployment and operations are validated across ${environmentMatrix}.`,
        ]),
      };
    }
    if (/(training|calibration|holdout|evaluation|ethic|bias|drift|validation)/i.test(lower)) {
      return {
        answer:
          "Define a reproducible evaluation protocol: immutable dataset lineage, train/validation/holdout splits, calibration checks, drift thresholds, and explicit ethics/bias constraints enforced by release gates.",
        rationale:
          "Reproducible evaluation and calibration controls are required to trust model outputs in production.",
        assumptions: uniqueStrings([
          ...assumptions,
          "Data/version artifacts can be traced across training and serving runs.",
        ]),
      };
    }
    if (/(adapter|integration|provider|third[- ]party|external)/i.test(lower)) {
      return {
        answer:
          adapterHint && adapterHint.length > 0
            ? `Define adapter contracts for ${adapterHint} with explicit auth, quota/rate-limit, timeout/retry strategy, and fallback behavior to secondary providers or degraded local behavior.`
            : "Define adapter contracts for each external dependency with explicit auth, quota/rate-limit, timeout/retry strategy, and fallback behavior.",
        rationale:
          "Provider contracts prevent runtime ambiguity and keep dependency failures isolated and recoverable.",
        assumptions: uniqueStrings([
          ...assumptions,
          "External provider SLAs and failure modes are known before release.",
        ]),
      };
    }
    if (/(deploy|environment|ops|observability|telemetry|metering|policy|consent)/i.test(lower)) {
      return {
        answer:
          `Specify production-readiness controls: environment matrix (${environmentMatrix}), secrets handling, telemetry schema, metering policy, SLO/alert thresholds, and deterministic fallback behavior for policy violations or stale telemetry.`,
        rationale:
          "Operational contracts make readiness gates deterministic and reduce release-time ambiguity.",
        assumptions: uniqueStrings([
          ...assumptions,
          "Runtime can publish telemetry and enforcement decisions as structured events.",
        ]),
      };
    }
    return {
      answer:
        "Resolve this as an explicit engineering decision with selected approach, rejected alternatives, and measurable verification criteria; map the decision to implementation and QA evidence.",
      rationale:
        "Explicit decisions remove planning ambiguity and improve backlog execution quality.",
      assumptions: uniqueStrings([
        ...assumptions,
        "Decision can be validated through deterministic tests or release checks.",
      ]),
    };
  }

  private managedFolderTreeSection(signals?: SdsFileSignals): string[] {
    const entries = signals?.folderEntries?.slice(0, 10) ?? [];
    const annotateEntry = (entry: string, isLast: boolean): string => {
      const hint = describeFolderEntry(entry);
      const prefix = isLast ? "└──" : "├──";
      return hint ? `${prefix} ${entry}  # ${hint}` : `${prefix} ${entry}`;
    };
    if (entries.length > 0) {
      return [
        "## Folder Tree",
        "```text",
        ".",
        ...entries.map((entry, index) => annotateEntry(entry, index === entries.length - 1)),
        "```",
        "",
      ];
    }
    return [
      "## Folder Tree",
      "```text",
      ".",
      "├── docs/architecture/  # documentation and planning inputs",
      "├── modules/core/  # implementation surfaces",
      "├── interfaces/public/  # interface definitions and compatibility surfaces",
      "├── data/migrations/  # storage and schema assets",
      "├── tests/integration/  # automated validation surfaces",
      "└── tools/release/  # automation and command entrypoints",
      "```",
      "",
    ];
  }

  private managedTechnologySection(signals?: SdsFileSignals): string[] {
    const technologies = signals?.technologies ?? [];
    if (technologies.length > 0) {
      return [
        "## Technology Stack",
        `- Observed source-backed technology signals: ${technologies.join(", ")}.`,
        "- Keep the chosen stack explicit in the source docs for runtime, language, persistence, interface, and tooling layers.",
        "- Record alternatives only when the source docs name them; do not invent default stack choices during preflight.",
        "",
      ];
    }
    return [
      "## Technology Stack",
      "- Source docs do not yet make the technology stack explicit.",
      "- Record runtime, language, persistence, interface, and tooling decisions explicitly in the source docs without assuming defaults.",
      "- Preflight must not invent a chosen stack baseline when the source is silent.",
      "",
    ];
  }

  private managedPolicyTelemetrySection(
    signals: SdsFileSignals | undefined,
    scopedQuestions: SdsPreflightQuestionAnswer[],
  ): string[] {
    const policyQuestionCount = scopedQuestions.filter((question) =>
      /(policy|consent|telemetry|metering|quota|limit)/i.test(question.question),
    ).length;
    return [
      "## Policy and Cache Consent",
      "- Cache key policy: tenant_id + project_key + route + role.",
      "- TTL tiers: hot=5m, warm=30m, cold=24h.",
      "- Consent matrix: anonymous telemetry is default; identified telemetry requires explicit opt-in.",
      policyQuestionCount > 0
        ? `- Preflight resolved ${policyQuestionCount} policy/telemetry question(s) for this SDS file.`
        : "- Preflight policy defaults are applied when SDS language is ambiguous.",
      "",
      "## Telemetry",
      "- Telemetry schema defines event_name, timestamp, service, and request identifiers.",
      "- Anonymous events contain aggregate metrics without user identity.",
      "- Identified events include actor_id only when consent is granted.",
      "",
      "## Metering and Usage",
      "- Usage metering tracks request units and compute units per tenant and feature.",
      "- Rate limit and quota enforcement return deterministic limit status and retry guidance.",
      "- Enforcement actions are logged for audit and operational review.",
      "",
      ...(signals?.adapters && signals.adapters.length > 0
        ? [`- Metering coverage includes external adapter usage for ${signals.adapters.slice(0, 4).join(", ")}.`, ""]
        : []),
    ];
  }

  private managedOperationsSection(signals?: SdsFileSignals): string[] {
    const environments =
      signals?.environments && signals.environments.length > 0
        ? signals.environments.join(", ")
        : "local, staging, production";
    const moduleHint = signals?.moduleDomains?.slice(0, 4).join(", ");
    return [
      "## Operations and Deployment",
      `- Environment matrix: ${environments}.`,
      "- Secrets strategy: environment-scoped secret stores with least-privilege access.",
      "- Deployment workflow: immutable build artifacts, migration checks, and controlled rollout stages.",
      "",
      "## Observability",
      "- SLO target: 99.9% availability with p95 latency threshold of 300ms.",
      "- Alert thresholds page on error-rate, saturation, and dependency failure conditions.",
      moduleHint
        ? `- Monitoring dashboards track module health across ${moduleHint}.`
        : "- Monitoring dashboards map service health, queue depth, and critical dependency status.",
      "",
      "## Testing Gates",
      "- Test gates require unit, integration, and validation checks before release promotion.",
      "- Release validation includes contract tests, smoke tests, and rollback verification.",
      "",
      "## Failure Recovery and Rollback",
      "- Failure modes are documented per service with runbook ownership.",
      "- Recovery steps define restore order, verification checkpoints, and incident handoff.",
      "- Rollback steps are deterministic and tested in staging before production rollout.",
      "",
    ];
  }

  private managedAdapterSection(signals?: SdsFileSignals): string[] {
    const adapters = signals?.adapters ?? [];
    return [
      "## External Integrations and Adapter Contracts",
      adapters.length > 0
        ? `- Adapter contract baseline for this SDS includes: ${adapters.join(", ")}.`
        : "- Adapter contract baseline must enumerate each external provider used by the project.",
      "- Constraints: auth model, API key/token handling, rate limit, timeout, quota, latency budget, and pricing limits are documented per provider.",
      "- Error handling: retries with bounded backoff, circuit break rules, and structured error classification are required.",
      "- Fallback behavior: degrade gracefully to secondary adapters or cached responses when provider failures exceed thresholds.",
      "",
    ];
  }

  private shouldReplaceIssueLine(issue: ReviewIssue): boolean {
    return (
      issue.gateId === "gate-open-questions" ||
      issue.gateId === "gate-sds-no-unresolved-items" ||
      issue.gateId === "gate-sds-explicit-decisions"
    );
  }

  private replacementForIssue(issue: ReviewIssue): string | undefined {
    if (issue.gateId === "gate-sds-explicit-decisions") {
      return "- Decision: Use one selected baseline for this section and keep alternatives in an options summary.";
    }
    const excerptSource =
      issue.location.kind === "line_range" ? (issue.location.excerpt ?? issue.message) : issue.message;
    const excerpt = excerptSource
      .replace(/^open question requires resolution:\s*/i, "")
      .replace(/^optional exploration:\s*/i, "")
      .replace(/^[-*+]\s*/, "")
      .replace(/^\d+\.\s*/, "")
      .trim();
    const resolved = this.normalizeResolvedText(excerpt || issue.message);
    if (resolved) return `- Resolved: ${resolved}`;
    return "- Resolved: Explicit decision captured in the managed preflight remediation block.";
  }

  private extractQuestionAnswers(
    issues: ReviewIssue[],
    signalsByPath: Map<string, SdsFileSignals>,
  ): SdsPreflightQuestionAnswer[] {
    const seen = new Set<string>();
    const answers: SdsPreflightQuestionAnswer[] = [];
    for (const issue of issues) {
      if (issue.category !== "open_questions") continue;
      const metadataQuestion = typeof issue.metadata?.question === "string" ? issue.metadata.question.trim() : "";
      const excerpt = issue.location.kind === "line_range" ? issue.location.excerpt?.trim() ?? "" : "";
      const rawQuestion = metadataQuestion || excerpt || issue.message;
      const question = rawQuestion
        .replace(/^open question requires resolution:\s*/i, "")
        .replace(/^optional exploration:\s*/i, "")
        .trim();
      const normalized = normalizeQuestion(question);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const required = typeof issue.metadata?.required === "boolean" ? issue.metadata.required : issue.severity === "high";
      const target = typeof issue.metadata?.target === "string" ? issue.metadata.target : "sds";
      const sourcePath = issue.location.path;
      const resolved = this.answerForQuestion(question, {
        target,
        required,
        heading: typeof issue.metadata?.heading === "string" ? issue.metadata.heading : undefined,
        signals: this.signalsForPath(signalsByPath, sourcePath),
      });
      answers.push({
        question,
        normalized,
        required,
        target,
        sourcePath,
        line: issue.location.kind === "line_range" ? issue.location.lineStart : undefined,
        answer: resolved.answer,
        rationale: resolved.rationale,
        assumptions: resolved.assumptions,
      });
    }
    return answers;
  }

  private issueSection(issue: ReviewIssue): string {
    switch (issue.gateId) {
      case "gate-sds-folder-tree":
        return "Folder Tree and Module Responsibilities";
      case "gate-sds-tech-stack-rationale":
      case "gate-sds-explicit-decisions":
        return "Explicit Technology and Architecture Decisions";
      case "gate-sds-policy-telemetry-metering":
        return "Policy, Telemetry, and Metering";
      case "gate-sds-ops-observability-testing":
        return "Operations, Observability, and Testing";
      case "gate-sds-external-adapters":
        return "External Integrations and Adapter Contracts";
      case "gate-sds-no-unresolved-items":
      case "gate-open-questions":
        return "Resolved Questions and Ambiguity Removal";
      default:
        return "Additional SDS Quality Remediations";
    }
  }

  private remediationLines(issue: ReviewIssue): string[] {
    switch (issue.gateId) {
      case "gate-sds-folder-tree":
        return [
          "Define concrete repository tree paths for all major modules and workflows.",
          "Add ownership/purpose comments for each top-level and critical nested path.",
          "Ensure every required runtime, data, API, and test surface is represented.",
        ];
      case "gate-sds-tech-stack-rationale":
        return [
          "State one chosen stack baseline for each layer (runtime, persistence, interface, tooling).",
          "Document alternatives considered and explicit trade-offs.",
          "Tie choices to delivery constraints and verification impact.",
        ];
      case "gate-sds-policy-telemetry-metering":
        return [
          "Specify cache/policy/consent rules with deterministic enforcement behavior.",
          "Define telemetry schema and anonymous vs identified handling.",
          "Define metering and limit enforcement with observable outcomes.",
        ];
      case "gate-sds-ops-observability-testing":
        return [
          "Define environments, deployment rules, and secret handling.",
          "Define SLO/alert thresholds and incident escalation paths.",
          "Define testing/release gates and rollback procedures.",
        ];
      case "gate-sds-explicit-decisions":
        return [
          "Replace ambiguous either/or language with explicit chosen decisions.",
          "Attach concise rationale and implications for implementation sequencing.",
        ];
      case "gate-sds-external-adapters":
        return [
          "Document adapter contracts for each external dependency.",
          "Include rate/timeout/auth constraints, error handling, and fallback behavior.",
        ];
      case "gate-open-questions":
      case "gate-sds-no-unresolved-items":
        return [
          "Convert unresolved items into explicit resolved decisions.",
          "Map each decision to implementation and QA verification checkpoints.",
        ];
      default:
        return [
          "Apply the gate remediation in concrete implementation terms.",
          "Add explicit verification criteria for the resolved section.",
        ];
    }
  }

  private verificationLines(issue: ReviewIssue): string[] {
    switch (issue.gateId) {
      case "gate-sds-folder-tree":
        return [
          "Create-tasks output contains implementation items for the newly defined paths.",
          "Coverage report includes matching section/path signals.",
        ];
      case "gate-open-questions":
      case "gate-sds-no-unresolved-items":
        return [
          "Open-question entries are represented in the generated Q&A artifact.",
          "No unresolved placeholder markers remain in planning context artifacts.",
        ];
      default:
        return [
          "Generated backlog contains explicit tasks for this remediated area.",
          "Sufficiency audit does not report this gap as remaining.",
        ];
    }
  }

  private buildAddendum(issues: ReviewIssue[]): string {
    const now = new Date().toISOString();
    const lines: string[] = [
      "# SDS Gap Remediation Addendum",
      "",
      `Generated: ${now}`,
      "",
      "This addendum resolves SDS quality gaps discovered at create-tasks preflight time. Use it as planning context input alongside the primary SDS.",
      "",
    ];

    if (issues.length === 0) {
      lines.push("No unresolved SDS gaps were detected in preflight.");
      return lines.join("\n");
    }

    const grouped = new Map<string, ReviewIssue[]>();
    for (const issue of issues) {
      const section = this.issueSection(issue);
      const current = grouped.get(section) ?? [];
      current.push(issue);
      grouped.set(section, current);
    }

    for (const [section, sectionIssues] of grouped.entries()) {
      lines.push(`## ${section}`);
      lines.push("");
      sectionIssues.forEach((issue, index) => {
        lines.push(`### Gap ${index + 1}: ${issue.message}`);
        lines.push(`- Source: ${formatIssueLocation(issue)}`);
        lines.push("- Remediation:");
        this.remediationLines(issue).forEach((line) => lines.push(`  - ${line}`));
        lines.push("- Verification:");
        this.verificationLines(issue).forEach((line) => lines.push(`  - ${line}`));
        lines.push("");
      });
    }

    return lines.join("\n");
  }

  private buildQuestionsDoc(questions: SdsPreflightQuestionAnswer[]): string {
    const now = new Date().toISOString();
    const lines: string[] = [
      "# SDS Open Questions Q&A",
      "",
      `Generated: ${now}`,
      "",
      "This document answers open questions detected in SDS preflight before task generation.",
      "",
    ];
    if (questions.length === 0) {
      lines.push("No open questions were detected.");
      return lines.join("\n");
    }

    questions.forEach((entry, index) => {
      lines.push(`## Q${index + 1}`);
      lines.push(`- Question: ${entry.question}`);
      lines.push(`- Required: ${entry.required ? "yes" : "no"}`);
      lines.push(`- Target: ${entry.target}`);
      if (entry.sourcePath) {
        lines.push(`- Source: ${entry.sourcePath}${entry.line ? `:${entry.line}` : ""}`);
      }
      lines.push("- Answer:");
      lines.push(`  ${entry.answer}`);
      lines.push("- Rationale:");
      lines.push(`  ${entry.rationale}`);
      lines.push("- Assumptions:");
      entry.assumptions.forEach((assumption) => lines.push(`  - ${assumption}`));
      lines.push("");
    });

    return lines.join("\n");
  }

  private summarizeIssues(
    issues: ReviewIssue[],
    gateNamesById: Map<string, string>,
  ): SdsPreflightIssueSummary[] {
    return issues.map((issue) => ({
      gateId: issue.gateId,
      gateName: gateNamesById.get(issue.gateId) ?? issue.gateId,
      severity: issue.severity,
      category: issue.category,
      message: issue.message,
      remediation: issue.remediation,
      location: formatIssueLocation(issue),
    }));
  }

  private async collectGateResults(sourceSdsPaths: string[]): Promise<{
    gateResults: ReviewGateResult[];
    gateNamesById: Map<string, string>;
    warnings: string[];
    gateFailureCount: number;
  }> {
    const gateResults: ReviewGateResult[] = [];
    const gateNamesById = new Map<string, string>();
    const warnings: string[] = [];
    let gateFailureCount = 0;
    const gateRunners = this.getGateRunners();
    for (const sdsPath of sourceSdsPaths) {
      const artifacts = this.buildArtifacts(sdsPath);
      for (const runner of gateRunners) {
        try {
          const result = await runner({ artifacts });
          gateResults.push(result);
          gateNamesById.set(result.gateId, result.gateName);
        } catch (error) {
          gateFailureCount += 1;
          warnings.push(
            `Gate ${runner.name || "unknown"} failed for ${path.relative(this.workspace.workspaceRoot, sdsPath)}: ${(error as Error).message}`,
          );
        }
      }
    }
    return { gateResults, gateNamesById, warnings, gateFailureCount };
  }

  private issueMatchesPath(issue: ReviewIssue, sdsPath: string): boolean {
    const issuePath = issue.location.path;
    if (!issuePath) return false;
    const resolvedIssuePath = this.resolveWorkspacePath(issuePath);
    return resolvedIssuePath === path.resolve(sdsPath);
  }

  private questionMatchesPath(question: SdsPreflightQuestionAnswer, sdsPath: string): boolean {
    if (!question.sourcePath) return false;
    return this.resolveWorkspacePath(question.sourcePath) === path.resolve(sdsPath);
  }

  private normalizeResolvedText(value: string): string {
    return value
      .replace(/\r?\n+/g, " ")
      .replace(unresolvedTokenPattern, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private buildLineReplacementsForPath(
    sdsPath: string,
    questions: SdsPreflightQuestionAnswer[],
    issues: ReviewIssue[],
  ): Map<number, string> {
    const replacements = new Map<number, string>();
    for (const question of questions) {
      if (!this.questionMatchesPath(question, sdsPath)) continue;
      if (!question.line || question.line < 1 || replacements.has(question.line)) continue;
      const resolved = this.normalizeResolvedText(question.answer);
      if (!resolved) continue;
      replacements.set(question.line, `- Resolved: ${resolved}`);
    }
    for (const issue of issues) {
      if (!this.issueMatchesPath(issue, sdsPath)) continue;
      if (issue.location.kind !== "line_range") continue;
      if (!this.shouldReplaceIssueLine(issue)) continue;
      const line = issue.location.lineStart;
      if (!line || line < 1 || replacements.has(line)) continue;
      const replacement = this.replacementForIssue(issue);
      if (!replacement) continue;
      replacements.set(line, replacement);
    }
    return replacements;
  }

  private applyLineReplacements(content: string, replacements: Map<number, string>): string {
    if (replacements.size === 0) return content;
    const lines = content.split(/\r?\n/);
    const sorted = Array.from(replacements.entries()).sort((a, b) => a[0] - b[0]);
    for (const [line, replacement] of sorted) {
      const index = line - 1;
      if (index < 0 || index >= lines.length) continue;
      const current = (lines[index] ?? "").trim();
      if (/^[-*+\d.)\s]*resolved:/i.test(current) || /^[-*+\d.)\s]*decision:/i.test(current)) continue;
      lines[index] = replacement;
    }
    return lines.join("\n");
  }

  private buildManagedSdsBlock(
    sdsPath: string,
    questions: SdsPreflightQuestionAnswer[],
    issues: ReviewIssue[],
    signals: SdsFileSignals | undefined,
  ): string {
    const scopedQuestions = questions.filter((question) => this.questionMatchesPath(question, sdsPath));
    const scopedIssues = issues.filter((issue) => this.issueMatchesPath(issue, sdsPath));
    const lines: string[] = [
      MANAGED_SDS_BLOCK_START,
      "## Planning Decisions (mcoda preflight)",
      "",
    ];

    if (scopedQuestions.length === 0) {
      lines.push("- Decision coverage baseline recorded for this SDS file in this preflight run.");
      lines.push("");
    } else {
      scopedQuestions.forEach((question, index) => {
        const summary = this.normalizeResolvedText(question.answer);
        const prefix = summary || "Explicit implementation decision recorded in managed preflight output.";
        lines.push(`- Decision ${index + 1}: ${prefix}`);
      });
      lines.push("");
    }

    lines.push("## Decision Summary (mcoda preflight)");
    lines.push("- Decision baseline: preflight converts planning ambiguities into explicit implementation guidance.");
    lines.push("- Planning rule: each captured decision maps to implementation and QA verification work.");
    if (signals?.moduleDomains && signals.moduleDomains.length > 0) {
      lines.push(`- Module scope detected for this SDS file: ${signals.moduleDomains.slice(0, 6).join(", ")}.`);
    }
    lines.push("");

    lines.push(...this.managedFolderTreeSection(signals));
    lines.push(...this.managedTechnologySection(signals));
    lines.push(...this.managedPolicyTelemetrySection(signals, scopedQuestions));
    lines.push(...this.managedOperationsSection(signals));
    lines.push(...this.managedAdapterSection(signals));

    lines.push("## Gap Remediation Summary (mcoda preflight)");
    lines.push("");
    if (scopedIssues.length === 0) {
      lines.push("- No remaining SDS quality gaps were detected for this SDS file in this preflight run.");
      lines.push("");
    } else {
      scopedIssues.forEach((issue, index) => {
        const gapSummary = this.normalizeResolvedText(issue.message) || issue.message;
        lines.push(`### Gap ${index + 1}: ${gapSummary}`);
        lines.push(`- Gate: ${issue.gateId}`);
        lines.push(`- Source: ${formatIssueLocation(issue)}`);
        lines.push("- Remediation:");
        this.remediationLines(issue).forEach((line) => lines.push(`  - ${line}`));
        lines.push("");
      });
    }
    lines.push(MANAGED_SDS_BLOCK_END);
    return lines.join("\n");
  }

  private upsertManagedSdsBlock(content: string, block: string): string {
    const startIndex = content.indexOf(MANAGED_SDS_BLOCK_START);
    const endIndex = content.indexOf(MANAGED_SDS_BLOCK_END);
    let withoutManaged = content;
    if (startIndex >= 0 && endIndex > startIndex) {
      const before = content.slice(0, startIndex).trimEnd();
      const after = content.slice(endIndex + MANAGED_SDS_BLOCK_END.length).trimStart();
      withoutManaged = [before, after].filter((segment) => segment.length > 0).join("\n\n");
    }
    const trimmed = withoutManaged.trim();
    if (!trimmed) return `${block}\n`;

    const h1Match = trimmed.match(/^#\s+.+$/m);
    if (!h1Match || typeof h1Match.index !== "number") {
      return `${block}\n\n${trimmed}\n`;
    }

    const insertIndex = h1Match.index + h1Match[0].length;
    const before = trimmed.slice(0, insertIndex).trimEnd();
    const after = trimmed.slice(insertIndex).trim();
    const merged = [before, block, after].filter((segment) => segment.length > 0).join("\n\n");
    return `${merged.trimEnd()}\n`;
  }

  private async applyPreflightRemediationsToSds(params: {
    sourceSdsPaths: string[];
    questions: SdsPreflightQuestionAnswer[];
    issues: ReviewIssue[];
    signalsByPath: Map<string, SdsFileSignals>;
  }): Promise<{ appliedPaths: string[]; warnings: string[] }> {
    const appliedPaths: string[] = [];
    const warnings: string[] = [];
    for (const sdsPath of params.sourceSdsPaths) {
      let original = "";
      try {
        original = await fs.readFile(sdsPath, "utf8");
      } catch (error) {
        warnings.push(`Unable to read SDS for remediation ${sdsPath}: ${(error as Error).message}`);
        continue;
      }
      let updated = this.applyLineReplacements(
        original,
        this.buildLineReplacementsForPath(sdsPath, params.questions, params.issues),
      );
      updated = this.upsertManagedSdsBlock(
        updated,
        this.buildManagedSdsBlock(
          sdsPath,
          params.questions,
          params.issues,
          params.signalsByPath.get(path.resolve(sdsPath)) ?? this.collectSignalsFromContent(original),
        ),
      );
      if (updated === original) continue;
      try {
        await fs.writeFile(sdsPath, updated, "utf8");
        appliedPaths.push(path.resolve(sdsPath));
      } catch (error) {
        warnings.push(`Unable to write remediated SDS ${sdsPath}: ${(error as Error).message}`);
      }
    }
    return { appliedPaths, warnings };
  }

  private async commitAppliedSdsChanges(
    paths: string[],
    commitMessage?: string,
  ): Promise<string | undefined> {
    if (paths.length === 0) return undefined;
    const cwd = this.workspace.workspaceRoot;
    try {
      await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    } catch {
      return undefined;
    }

    const relativePaths = paths
      .map((filePath) => path.relative(cwd, filePath))
      .filter((relativePath) => relativePath && !relativePath.startsWith(".."));
    if (relativePaths.length === 0) return undefined;

    await execFileAsync("git", ["add", "--", ...relativePaths], { cwd });
    try {
      await execFileAsync("git", ["commit", "-m", commitMessage || DEFAULT_COMMIT_MESSAGE, "--no-verify"], {
        cwd,
        env: { ...process.env, HUSKY: "0" },
      });
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      const message = (error as Error).message ?? "";
      if (/nothing to commit|no changes added to commit/i.test(`${stderr}\n${message}`)) {
        return undefined;
      }
      throw new Error(`Unable to commit SDS preflight remediations: ${message || stderr}`);
    }

    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const hash = stdout.trim();
    return hash.length > 0 ? hash : undefined;
  }

  async runPreflight(options: SdsPreflightOptions): Promise<SdsPreflightResult> {
    const sourceSdsPaths = await this.resolveSdsPaths(options);
    if (sourceSdsPaths.length === 0) {
      throw new Error(
        "sds-preflight requires an SDS document but none was found. Add docs/sds.md (or equivalent SDS doc) and retry.",
      );
    }

    const warnings: string[] = [];
    let gateNamesById = new Map<string, string>();
    let signalsByPath = await this.collectSignalsByPath(sourceSdsPaths);

    const initialGatePass = await this.collectGateResults(sourceSdsPaths);
    gateNamesById = initialGatePass.gateNamesById;
    warnings.push(...initialGatePass.warnings);
    let gateFailureCount = initialGatePass.gateFailureCount;
    let outcome = aggregateReviewOutcome({ gateResults: initialGatePass.gateResults });
    let issues = this.dedupeIssues(outcome.issues);
    let questions = this.extractQuestionAnswers(issues, signalsByPath);

    const applyToSds = options.applyToSds === true;
    if (options.commitAppliedChanges && !applyToSds) {
      warnings.push("SDS preflight commit was requested without applyToSds; skipping commit because source SDS writeback is disabled.");
    }
    let appliedSdsPaths: string[] = [];
    if (applyToSds) {
      const applyResult = await this.applyPreflightRemediationsToSds({
        sourceSdsPaths,
        questions,
        issues,
        signalsByPath,
      });
      appliedSdsPaths = applyResult.appliedPaths;
      warnings.push(...applyResult.warnings);
      if (appliedSdsPaths.length > 0) {
        signalsByPath = await this.collectSignalsByPath(sourceSdsPaths);
        const rerun = await this.collectGateResults(sourceSdsPaths);
        gateNamesById = rerun.gateNamesById;
        warnings.push(...rerun.warnings);
        gateFailureCount = rerun.gateFailureCount;
        outcome = aggregateReviewOutcome({ gateResults: rerun.gateResults });
        issues = this.dedupeIssues(outcome.issues);
        questions = this.extractQuestionAnswers(issues, signalsByPath);
      }
    }

    let commitHash: string | undefined;
    if (options.commitAppliedChanges && appliedSdsPaths.length > 0) {
      commitHash = await this.commitAppliedSdsChanges(appliedSdsPaths, options.commitMessage);
    }

    const addendum = this.buildAddendum(issues);
    const qaDoc = this.buildQuestionsDoc(questions);

    const taskDir = path.join(this.workspace.mcodaDir, TASKS_FOLDER_NAME, options.projectKey);
    const reportPath = path.join(taskDir, PREFLIGHT_REPORT_NAME);
    const openQuestionsPath = path.join(taskDir, OPEN_QUESTIONS_DOC_NAME);
    const gapAddendumPath = path.join(taskDir, GAP_ADDENDUM_DOC_NAME);

    const writeArtifacts = options.writeArtifacts !== false;
    if (writeArtifacts) {
      await fs.mkdir(taskDir, { recursive: true });
      await Promise.all([
        fs.writeFile(openQuestionsPath, qaDoc, "utf8"),
        fs.writeFile(gapAddendumPath, addendum, "utf8"),
      ]);
    }

    const qualityStatus = gateFailureCount > 0 ? "fail" : outcome.summary.status;
    const blockingIssueCount = issues.filter((issue) => issue.severity === "blocker").length + gateFailureCount;
    const requiredQuestionCount = questions.filter((question) => question.required).length;
    const result: SdsPreflightResult = {
      projectKey: options.projectKey,
      generatedAt: new Date().toISOString(),
      readyForPlanning:
        blockingIssueCount === 0 && requiredQuestionCount === 0 && qualityStatus !== "fail" && gateFailureCount === 0,
      qualityStatus,
      sourceSdsPaths,
      reportPath,
      openQuestionsPath,
      gapAddendumPath,
      generatedDocPaths: writeArtifacts ? [openQuestionsPath, gapAddendumPath] : [],
      questionCount: questions.length,
      requiredQuestionCount,
      issueCount: issues.length,
      blockingIssueCount,
      appliedToSds: applyToSds,
      appliedSdsPaths,
      commitHash,
      issues: this.summarizeIssues(issues, gateNamesById),
      questions,
      warnings: uniqueStrings(warnings),
    };

    if (writeArtifacts) {
      await fs.writeFile(reportPath, JSON.stringify(result, null, 2), "utf8");
    }

    return result;
  }
}
