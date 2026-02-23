import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentService, cliHealthy, resolveCodaliProviderFromAdapter } from "@mcoda/agents";
import { DocdexClient, VcsClient } from "@mcoda/integrations";
import { resolveChromiumBinary } from "@mcoda/integrations/qa/ChromiumQaAdapter.js";
import { GlobalRepository, WorkspaceRepository, type TaskCommentRow } from "@mcoda/db";
import { PathHelper, READY_TO_CODE_REVIEW, WORK_ALLOWED_STATUSES, filterTaskStatuses } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService, type JobState } from "../jobs/JobService.js";
import { TaskSelectionService, TaskSelectionFilters, TaskSelectionPlan } from "./TaskSelectionService.js";
import { TaskStateService } from "./TaskStateService.js";
import { QaTestCommandBuilder } from "./QaTestCommandBuilder.js";
import { RoutingService } from "../agents/RoutingService.js";
import { GATEWAY_HANDOFF_ENV_PATH } from "../agents/GatewayHandoff.js";
import { AgentRatingService } from "../agents/AgentRatingService.js";
import {
  ensureProjectGuidance,
  isDocContextExcluded,
  loadProjectGuidance,
  normalizeDocType,
} from "../shared/ProjectGuidance.js";
import { AUTH_ERROR_REASON, isAuthErrorMessage } from "../shared/AuthErrors.js";
import { buildDocdexUsageGuidance } from "../shared/DocdexGuidance.js";
import { createTaskCommentSlug, formatTaskCommentBody } from "../tasks/TaskCommentFormatter.js";

const exec = promisify(execCb);
const DEFAULT_BASE_BRANCH = "mcoda-dev";
const DEFAULT_TASK_BRANCH_PREFIX = "mcoda/task/";
const TASK_LOCK_TTL_SECONDS = 60 * 60;
const MAX_TEST_FIX_ATTEMPTS = 3;
const DEFAULT_TEST_OUTPUT_CHARS = 1200;
const WORK_ON_TASKS_PATCH_MODE_ENV = "MCODA_WORK_ON_TASKS_PATCH_MODE";
const WORK_ON_TASKS_ENFORCE_COMMENT_BACKLOG_ENV = "MCODA_WOT_ENFORCE_COMMENT_BACKLOG";
const WORK_ON_TASKS_SCOPE_MODE_ENV = "MCODA_WOT_SCOPE_MODE";
const WORK_ON_TASKS_COMMENT_BACKLOG_MAX_FAILS_ENV = "MCODA_WOT_COMMENT_BACKLOG_MAX_FAILS";
const REPO_PROMPTS_DIR = fileURLToPath(new URL("../../../../../prompts/", import.meta.url));
const resolveRepoPromptPath = (filename: string): string => path.join(REPO_PROMPTS_DIR, filename);
const DEFAULT_CODE_WRITER_PROMPT = [
  "You are the code-writing agent.",
  "You are not the QA agent. Do not run qa-tasks, generate QA plans, or write QA reports.",
  buildDocdexUsageGuidance({ contextLabel: "task notes", includeHeading: false, includeFallback: true }),
  "Use docdex snippets to ground decisions (data model, offline/online expectations, constraints, acceptance criteria).",
  "When a comment backlog is provided (code-review/qa-tasks), resolve those items first and do not mark a slug resolved unless you made real repo changes that address it.",
  "Do not ignore the main task description or acceptance criteria; address them after resolving comment backlog items.",
  "Re-use existing store/slices/adapters and tests; avoid inventing new backends or ad-hoc actions. Keep behavior backward-compatible and scoped to the documented contracts.",
  "Do not hardcode ports. Read PORT/HOST (or MCODA_QA_PORT/MCODA_QA_HOST) from env, and document base URLs with http://localhost:<PORT> placeholders when needed.",
  "Do not create docs/qa/* reports unless the task explicitly requests one. Work-on-tasks should not generate QA reports.",
  "If you encounter merge conflicts or conflict markers, stop and report; do not attempt to merge them.",
  "Work directly in the repo: edit files and run commands as needed. If you cannot edit files directly, output a minimal patch/diff or patch_json response per the output requirements.",
].join("\n");
const DEFAULT_JOB_PROMPT = "You are an mcoda agent that follows workspace runbooks and responds with actionable, concise output.";
const DEFAULT_CHARACTER_PROMPT =
  "Write clearly, avoid hallucinations, cite assumptions, and prioritize risk mitigation for the user.";
const GATEWAY_PROMPT_MARKERS = [
  "you are the gateway agent",
  "return json only",
  "output json only",
  "docdexnotes",
  "fileslikelytouched",
  "filestocreate",
  "do not include fields outside the schema",
];
const QA_PROMPT_MARKERS = [
  "qa agent prompt",
  "qa task",
  "qa-tasks",
  "qa report",
  "tested_scope",
  "coverage_summary",
  "start of qa task",
  "qa plan output schema",
];
const QA_ADAPTERS = new Set(["qa-cli"]);

const sanitizeNonGatewayPrompt = (value?: string): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (GATEWAY_PROMPT_MARKERS.some((marker) => lower.includes(marker))) return undefined;
  return trimmed;
};

const looksLikeQaPrompt = (value?: string): boolean => {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return QA_PROMPT_MARKERS.some((marker) => normalized.includes(marker));
};

const readPromptFile = async (promptPath: string, fallback: string): Promise<string> => {
  try {
    const content = await fs.promises.readFile(promptPath, "utf8");
    const trimmed = content.trim();
    if (trimmed) return trimmed;
  } catch {
    // fall through to fallback
  }
  return fallback;
};

export interface WorkOnTasksRequest extends TaskSelectionFilters {
  workspace: WorkspaceResolution;
  noCommit?: boolean;
  dryRun?: boolean;
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  baseBranch?: string;
  autoMerge?: boolean;
  autoPush?: boolean;
  workRunner?: string;
  useCodali?: boolean;
  agentAdapterOverride?: string;
  onAgentChunk?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  maxAgentSeconds?: number;
  allowFileOverwrite?: boolean;
  missingTestsPolicy?: MissingTestsPolicy;
  allowMissingTests?: boolean;
}

export interface TaskExecutionResult {
  taskKey: string;
  status: "succeeded" | "failed" | "skipped";
  notes?: string;
  branch?: string;
}

export interface WorkOnTasksResult {
  jobId: string;
  commandRunId: string;
  selection: TaskSelectionPlan;
  results: TaskExecutionResult[];
  warnings: string[];
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil((text ?? "").length / 4));
const isPatchModeEnabled = (): boolean => {
  const raw = process.env[WORK_ON_TASKS_PATCH_MODE_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
};
const isCommentBacklogEnforced = (): boolean => {
  const raw = process.env[WORK_ON_TASKS_ENFORCE_COMMENT_BACKLOG_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
};
const resolveScopeMode = (): "strict" | "dir" => {
  const raw = process.env[WORK_ON_TASKS_SCOPE_MODE_ENV];
  if (!raw) return "dir";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "strict") return "strict";
  if (normalized === "dir" || normalized === "directory") return "dir";
  return "dir";
};
const resolveCommentBacklogMaxFails = (): number => {
  const raw = process.env[WORK_ON_TASKS_COMMENT_BACKLOG_MAX_FAILS_ENV];
  if (!raw) return 2;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2;
  return parsed;
};
type CodaliEnvOverrideOptions = {
  preferredFiles?: string[];
  readOnlyPaths?: string[];
  planHint?: string;
  skipSearch?: boolean;
};

const mergeUnique = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const buildCodaliEnvOverrides = (
  options: CodaliEnvOverrideOptions | string[] = [],
): Record<string, string> => {
  const resolvedOptions = Array.isArray(options) ? { preferredFiles: options } : options;
  const overrides: Record<string, string> = {};
  const setIfMissing = (key: string, value: string) => {
    if (process.env[key] === undefined) {
      overrides[key] = value;
    }
  };
  setIfMissing("CODALI_SMART", "1");
  setIfMissing("CODALI_BUILDER_MODE", "patch_json");
  setIfMissing("CODALI_BUILDER_PATCH_FORMAT", "file_writes");
  setIfMissing("CODALI_FORMAT_BUILDER", "json");
  const preferredFiles = mergeUnique(resolvedOptions.preferredFiles ?? []);
  if (preferredFiles.length > 0) {
    setIfMissing("CODALI_CONTEXT_PREFERRED_FILES", preferredFiles.join(","));
  }
  const readOnlyPaths = mergeUnique(resolvedOptions.readOnlyPaths ?? []);
  if (readOnlyPaths.length > 0) {
    setIfMissing("CODALI_SECURITY_READONLY_PATHS", readOnlyPaths.join(","));
  }
  if (resolvedOptions.planHint && resolvedOptions.planHint.trim().length > 0) {
    setIfMissing("CODALI_PLAN_HINT", resolvedOptions.planHint.trim());
  }
  if (resolvedOptions.skipSearch) {
    setIfMissing("CODALI_CONTEXT_SKIP_SEARCH", "1");
  }
  return overrides;
};

const normalizeSlugList = (input?: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return input
    .map((slug) => (typeof slug === "string" ? slug.trim() : ""))
    .filter((slug) => slug.length > 0);
};
const normalizeDirList = (input?: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => (typeof entry === "string" ? entry.trim().replace(/\\/g, "/") : ""))
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^\.\/+/, "").replace(/\/+$/, ""));
};
const deriveParentDirs = (paths: string[]): string[] => {
  const dirs = new Set<string>();
  for (const entry of paths) {
    const normalized = entry.replace(/\\/g, "/").replace(/^\.\/+/, "");
    const dir = path.posix.dirname(normalized);
    if (dir && dir !== "." && dir !== "/") {
      dirs.add(dir);
    }
  }
  return Array.from(dirs);
};

type GatewayHandoffSummary = {
  planSteps: string[];
  filesLikelyTouched: string[];
  filesToCreate: string[];
  dirsToCreate: string[];
  risks: string[];
};

const normalizeGatewayItem = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "(none)") return "";
  let cleaned = trimmed.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
  if (!cleaned || cleaned === "(none)") return "";
  cleaned = cleaned.replace(/^`|`$/g, "").replace(/^file:\s*/i, "");
  cleaned = cleaned.replace(/^\.\/+/, "");
  return cleaned.trim();
};

const resolveGatewaySection = (header: string): keyof GatewayHandoffSummary | null => {
  const normalized = header.trim().toLowerCase();
  if (normalized.startsWith("plan")) return "planSteps";
  if (normalized.startsWith("files likely touched")) return "filesLikelyTouched";
  if (normalized.startsWith("files to create")) return "filesToCreate";
  if (normalized.startsWith("dirs to create")) return "dirsToCreate";
  if (normalized.startsWith("risks")) return "risks";
  return null;
};

const parseGatewayHandoff = (content: string): GatewayHandoffSummary => {
  const summary: GatewayHandoffSummary = {
    planSteps: [],
    filesLikelyTouched: [],
    filesToCreate: [],
    dirsToCreate: [],
    risks: [],
  };
  let section: keyof GatewayHandoffSummary | null = null;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      section = resolveGatewaySection(trimmed.slice(3));
      continue;
    }
    if (!section) continue;
    if (!trimmed || trimmed === "(none)") continue;
    const item = normalizeGatewayItem(trimmed);
    if (!item) continue;
    summary[section].push(item);
  }
  summary.planSteps = mergeUnique(summary.planSteps);
  summary.filesLikelyTouched = mergeUnique(summary.filesLikelyTouched);
  summary.filesToCreate = mergeUnique(summary.filesToCreate);
  summary.dirsToCreate = mergeUnique(summary.dirsToCreate);
  summary.risks = mergeUnique(summary.risks);
  return summary;
};

const readGatewayHandoffFile = async (handoffPath: string): Promise<GatewayHandoffSummary> => {
  const content = await fs.promises.readFile(handoffPath, "utf8");
  return parseGatewayHandoff(content);
};

const buildGatewayPreferredFiles = (handoff: GatewayHandoffSummary | null): string[] => {
  if (!handoff) return [];
  return mergeUnique([...handoff.filesLikelyTouched, ...handoff.filesToCreate]);
};

const buildGatewayPlanHint = (handoff: GatewayHandoffSummary | null): string | undefined => {
  if (!handoff) return undefined;
  const steps = mergeUnique(handoff.planSteps);
  const targetFiles = mergeUnique([...handoff.filesLikelyTouched, ...handoff.filesToCreate]);
  const risks = mergeUnique(handoff.risks);
  if (!steps.length && !targetFiles.length && !risks.length) return undefined;
  const riskAssessment = risks.length ? risks.join("; ") : "gateway: not provided";
  return JSON.stringify({
    steps,
    target_files: targetFiles,
    risk_assessment: riskAssessment,
    verification: [],
  });
};

const NON_BLOCKING_COMMENT_SEVERITIES = new Set(["info", "low", "minor", "nit", "nitpick"]);
const NON_BLOCKING_COMMENT_CATEGORIES = new Set(["suggestion", "nitpick"]);

const isNonBlockingComment = (comment: TaskCommentRow): boolean => {
  const category = (comment.category ?? "").trim().toLowerCase();
  if (NON_BLOCKING_COMMENT_CATEGORIES.has(category)) return true;
  const meta = (comment.metadata ?? {}) as Record<string, unknown>;
  const severityRaw = meta.severity ?? meta.level ?? meta.priority;
  const severity = typeof severityRaw === "string" ? severityRaw.trim().toLowerCase() : "";
  if (severity && NON_BLOCKING_COMMENT_SEVERITIES.has(severity)) return true;
  return false;
};

const formatSlugList = (slugs: string[], limit = 12): string => {
  if (!slugs.length) return "(none)";
  const slice = slugs.slice(0, limit);
  const suffix = slugs.length > limit ? ` (+${slugs.length - limit} more)` : "";
  return `${slice.join(", ")}${suffix}`;
};

const looksLikeUnifiedDiff = (value: string): boolean => {
  if (/^diff --git /m.test(value) || /\*\*\* Begin Patch/.test(value)) return true;
  const hasFileHeaders = /^---\s+\S+/m.test(value) && /^\+\+\+\s+\S+/m.test(value);
  const hasHunk = /^@@/m.test(value);
  return hasFileHeaders && hasHunk;
};

const extractPatches = (output: string): string[] => {
  const patches = new Set<string>();
  const fenceRegex = /```(\w+)?\s*\r?\n([\s\S]*?)\r?\n```/g;

  for (const match of output.matchAll(fenceRegex)) {
    const lang = (match[1] ?? "").toLowerCase();
    const content = (match[2] ?? "").trim();
    if (!content) continue;
    if (looksLikeUnifiedDiff(content)) {
      patches.add(content);
    }
  }

  const unfenced = output.replace(fenceRegex, "");
  for (const match of unfenced.matchAll(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g)) {
    const content = match[0].trim();
    if (content) patches.add(content);
  }
  for (const match of unfenced.matchAll(/^diff --git [\s\S]*?(?=^diff --git |\s*$)/gm)) {
    const content = match[0].trim();
    if (content) patches.add(content);
  }

  return Array.from(patches).filter(Boolean);
};

const stripAgentOutputBlocks = (output: string): string => {
  let stripped = output;
  stripped = stripped.replace(/```(?:patch|diff)[\s\S]*?```/gi, "");
  stripped = stripped.replace(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/g, "");
  stripped = stripped.replace(/^diff --git [\s\S]*?(?=^diff --git |\s*$)/gm, "");
  stripped = stripped.replace(
    /(?:^|\r?\n)\s*(?:[-*]\s*)?FILE:\s*[^\r\n]+\r?\n```[^\r\n]*\r?\n[\s\S]*?\r?\n```/g,
    "",
  );
  return stripped;
};

const isJsonOnlyOutput = (output: string): boolean => {
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
};

const hasUnfencedFileHeader = (output: string): boolean => {
  if (isJsonOnlyOutput(output)) return false;
  const stripped = stripAgentOutputBlocks(output);
  return /(?:^|\r?\n)\s*(?:[-*]\s*)?FILE:\s*\S+/i.test(stripped);
};

const hasExtraneousOutput = (output: string, jsonDetected: boolean): boolean => {
  if (jsonDetected && isJsonOnlyOutput(output)) return false;
  const stripped = stripAgentOutputBlocks(output);
  return stripped.trim().length > 0;
};

const sanitizeAgentOutput = (output: string): string => {
  if (!output.includes("[agent-io]")) return output;
  const lines = output.split(/\r?\n/);
  const cleaned: string[] = [];
  for (const line of lines) {
    if (!line.includes("[agent-io]")) {
      cleaned.push(line);
      continue;
    }
    if (/^\s*\[agent-io\]\s*(?:begin|input|meta)/i.test(line)) {
      continue;
    }
    const stripped = line.replace(/^\s*\[agent-io\]\s*(?:output\s*)?/i, "");
    if (stripped.trim()) cleaned.push(stripped);
  }
  return cleaned.join("\n");
};

const resolveCodaliFailureReason = (message: string): string | null => {
  if (!message) return null;
  const lower = message.toLowerCase();
  if (lower.includes("codali_unavailable")) return "codali_unavailable";
  if (lower.includes("codali_provider_unsupported")) return "codali_provider_unsupported";
  if (message.includes("CODALI_UNSUPPORTED_ADAPTER")) return "codali_provider_unsupported";
  return null;
};

const DIFF_METADATA_SUFFIX =
  /\s+\((?:new file|deleted|renamed|rename|copy|binary|mode|old mode|new mode|similarity index|index)[^)]*\)\s*$/i;
const DIFF_METADATA_TRAIL =
  /\s+(?:new file|deleted|renamed|rename|copy|binary|mode|old mode|new mode|similarity index|index)\b.*$/i;
const TRAILING_PAREN_SUFFIX = /\s+\([^/\\)]+\)\s*$/;

const stripDiffMetadataSuffix = (value: string): { value: string; stripped: boolean } => {
  const trimmed = value.trim();
  if (!trimmed) return { value: "", stripped: false };
  if (DIFF_METADATA_SUFFIX.test(trimmed)) {
    return { value: trimmed.replace(DIFF_METADATA_SUFFIX, "").trim(), stripped: true };
  }
  if (DIFF_METADATA_TRAIL.test(trimmed)) {
    return { value: trimmed.replace(DIFF_METADATA_TRAIL, "").trim(), stripped: true };
  }
  return { value: trimmed, stripped: false };
};

const hasIllegalPathSuffix = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (DIFF_METADATA_SUFFIX.test(trimmed)) return true;
  if (DIFF_METADATA_TRAIL.test(trimmed) && /\s/.test(trimmed)) return true;
  if (TRAILING_PAREN_SUFFIX.test(trimmed)) return true;
  return false;
};

const normalizeFileBlockPath = (value: string): { path: string; invalid: boolean } => {
  const trimmed = value.trim();
  if (!trimmed) return { path: "", invalid: false };
  let cleaned = trimmed.replace(/^[`'"]+|[`'"]+$/g, "");
  cleaned = cleaned.replace(/^file:\s*/i, "");
  cleaned = cleaned.replace(/^[ab][\\/]/, "");
  cleaned = cleaned.replace(/^\.\/+/, "");
  const invalid = hasIllegalPathSuffix(cleaned);
  const { value: withoutMeta } = stripDiffMetadataSuffix(cleaned);
  return { path: withoutMeta.replace(/^[`'"]+|[`'"]+$/g, ""), invalid };
};

const extractFileBlocks = (
  output: string,
): { fileBlocks: Array<{ path: string; content: string }>; invalidPaths: string[] } => {
  const files: Array<{ path: string; content: string }> = [];
  const invalidPaths: string[] = [];
  const regex = /(?:^|\r?\n)\s*(?:[-*]\s*)?FILE:\s*([^\r\n]+)\r?\n```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/g;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const rawPath = match[1] ?? "";
    const normalized = normalizeFileBlockPath(rawPath);
    if (normalized.invalid) {
      const candidate = rawPath.trim();
      if (candidate) invalidPaths.push(candidate);
    }
    const filePath = normalized.path;
    if (!filePath) continue;
    const content = match[2] ?? "";
    const key = `${filePath}::${content.length}`;
    if (!seen.has(key)) {
      files.push({ path: filePath, content });
      seen.add(key);
    }
  }
  return { fileBlocks: files, invalidPaths };
};

const looksLikeJsonOutput = (output: string): boolean => {
  const trimmed = output.trim();
  if (!trimmed) return false;
  if (/```json/i.test(output)) return true;
  return trimmed.startsWith("{") || trimmed.startsWith("[");
};

const parseJsonPayload = (output: string): unknown | null => {
  const candidates: string[] = [];
  const fenced = output.match(/```json([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const trimmed = output.trim();
  if (trimmed) candidates.push(trimmed);
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const firstBrace = output.indexOf("{");
    const firstBracket = output.indexOf("[");
    const start =
      firstBrace >= 0 && firstBracket >= 0 ? Math.min(firstBrace, firstBracket) : Math.max(firstBrace, firstBracket);
    const endBrace = output.lastIndexOf("}");
    const endBracket = output.lastIndexOf("]");
    const end = endBrace >= 0 && endBracket >= 0 ? Math.max(endBrace, endBracket) : Math.max(endBrace, endBracket);
    if (start >= 0 && end > start) {
      candidates.push(output.slice(start, end + 1));
    }
  }
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized) continue;
    if (!normalized.startsWith("{") && !normalized.startsWith("[")) continue;
    try {
      return JSON.parse(normalized);
    } catch {
      /* try next candidate */
    }
  }
  return null;
};

const extractPatchesFromJson = (payload: unknown): string[] => {
  const patches = new Set<string>();
  const seen = new Set<unknown>();
  const addPatchText = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const extracted = extractPatches(trimmed);
    if (extracted.length) {
      extracted.forEach((patch) => patches.add(patch));
      return;
    }
    if (looksLikeUnifiedDiff(trimmed)) {
      patches.add(trimmed);
    }
  };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") {
      if (typeof value === "string") addPatchText(value);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    const directKeys = ["patch", "diff", "unified_diff", "unifiedDiff", "patchText", "patches", "diffs"];
    for (const key of directKeys) {
      if (record[key] === undefined) continue;
      visit(record[key]);
    }
    Object.values(record).forEach(visit);
  };
  visit(payload);
  return Array.from(patches);
};

const extractFileBlocksFromJson = (
  payload: unknown,
): {
  fileBlocks: Array<{ path: string; content: string }>;
  invalidPaths: string[];
  allowOverwrite: boolean;
} => {
  const files = new Map<string, string>();
  const invalidPaths: string[] = [];
  let allowOverwrite = false;
  const addFile = (filePath: string, content: string) => {
    const normalized = normalizeFileBlockPath(filePath);
    if (normalized.invalid) {
      const candidate = filePath.trim();
      if (candidate) invalidPaths.push(candidate);
    }
    const normalizedPath = normalized.path.trim();
    if (!normalizedPath) return;
    files.set(normalizedPath, content);
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { fileBlocks: [], invalidPaths, allowOverwrite };
  }
  const record = payload as Record<string, unknown>;
  const fileContainers = ["files", "fileBlocks", "file_blocks", "newFiles", "writeFiles", "file_writes", "fileWrites"];
  const detectOverwrite = (value: unknown, containerKey?: string) => {
    if (containerKey && ["file_writes", "filewrites", "writefiles"].includes(containerKey.toLowerCase())) {
      allowOverwrite = true;
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const entryRecord = entry as Record<string, unknown>;
        const explicit =
          entryRecord.overwrite === true ||
          String(entryRecord.mode ?? "").toLowerCase() === "overwrite" ||
          String(entryRecord.action ?? "").toLowerCase() === "overwrite";
        if (explicit) {
          allowOverwrite = true;
          return;
        }
      }
      return;
    }
    const recordValue = value as Record<string, unknown>;
    const explicit =
      recordValue.overwrite === true ||
      String(recordValue.mode ?? "").toLowerCase() === "overwrite" ||
      String(recordValue.action ?? "").toLowerCase() === "overwrite";
    if (explicit) {
      allowOverwrite = true;
    }
  };
  const addFromContainer = (container: unknown) => {
    if (!container || typeof container !== "object") return;
    if (Array.isArray(container)) {
      for (const entry of container) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const entryRecord = entry as Record<string, unknown>;
        if (typeof entryRecord.path === "string" && typeof entryRecord.content === "string") {
          addFile(entryRecord.path, entryRecord.content);
        } else if (typeof entryRecord.file === "string" && typeof entryRecord.contents === "string") {
          addFile(entryRecord.file, entryRecord.contents);
        }
      }
      return;
    }
    const containerRecord = container as Record<string, unknown>;
    if (typeof containerRecord.path === "string" && typeof containerRecord.content === "string") {
      addFile(containerRecord.path, containerRecord.content);
      return;
    }
    if (typeof containerRecord.file === "string" && typeof containerRecord.contents === "string") {
      addFile(containerRecord.file, containerRecord.contents);
      return;
    }
    const entries = Object.entries(containerRecord);
    if (entries.length && entries.every(([, val]) => typeof val === "string")) {
      entries.forEach(([filePath, content]) => addFile(filePath, content as string));
    }
  };
  for (const key of fileContainers) {
    const container = record[key];
    if (container !== undefined) {
      detectOverwrite(container, key);
      addFromContainer(container);
    }
  }
  return {
    fileBlocks: Array.from(files.entries()).map(([filePath, content]) => ({ path: filePath, content })),
    invalidPaths,
    allowOverwrite,
  };
};

const extractCommentResolutionFromJson = (
  payload: unknown,
): { resolvedSlugs?: string[]; unresolvedSlugs?: string[]; commentBacklogStatus?: string } | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const resolved = normalizeSlugList(record.resolvedSlugs ?? record.resolved_slugs);
  const unresolved = normalizeSlugList(record.unresolvedSlugs ?? record.unresolved_slugs);
  const rawStatus =
    (typeof record.commentBacklogStatus === "string" ? record.commentBacklogStatus : undefined) ??
    (typeof record.comment_backlog_status === "string" ? record.comment_backlog_status : undefined);
  const status = rawStatus?.trim();
  if (!resolved.length && !unresolved.length && !status) return null;
  return {
    resolvedSlugs: resolved.length ? resolved : undefined,
    unresolvedSlugs: unresolved.length ? unresolved : undefined,
    commentBacklogStatus: status || undefined,
  };
};

type StructuredPatchAction =
  | { action: "replace"; file: string; search_block: string; replace_block: string }
  | { action: "create"; file: string; content: string }
  | { action: "delete"; file: string };

const normalizeActionValue = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const extractPatchActionsFromJson = (
  payload: unknown,
): { actions: StructuredPatchAction[]; invalid: string[] } => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { actions: [], invalid: [] };
  }
  const record = payload as Record<string, unknown>;
  const containers = [
    record.patches,
    record.patch_actions,
    record.patchActions,
    record.actions,
    record.changes,
  ].filter((entry) => entry !== undefined);
  const actions: StructuredPatchAction[] = [];
  const invalid: string[] = [];
  const handleEntry = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const item = entry as Record<string, unknown>;
    const action = normalizeActionValue(item.action ?? item.type ?? item.kind);
    const fileRaw = typeof item.file === "string" ? item.file : typeof item.path === "string" ? item.path : "";
    const file = fileRaw.trim();
    if (!action || !file) {
      invalid.push(`missing action or file for ${fileRaw || "entry"}`);
      return;
    }
    if (action === "replace") {
      const search =
        typeof item.search_block === "string"
          ? item.search_block
          : typeof item.search === "string"
            ? item.search
            : typeof item.find === "string"
              ? item.find
              : "";
      const replace =
        typeof item.replace_block === "string"
          ? item.replace_block
          : typeof item.replace === "string"
            ? item.replace
            : typeof item.with === "string"
              ? item.with
              : "";
      if (!search || !replace) {
        invalid.push(`replace action missing search/replace for ${file}`);
        return;
      }
      actions.push({ action: "replace", file, search_block: search, replace_block: replace });
      return;
    }
    if (action === "create") {
      const content =
        typeof item.content === "string"
          ? item.content
          : typeof item.contents === "string"
            ? item.contents
            : typeof item.body === "string"
              ? item.body
              : "";
      if (!content) {
        invalid.push(`create action missing content for ${file}`);
        return;
      }
      actions.push({ action: "create", file, content });
      return;
    }
    if (action === "delete") {
      actions.push({ action: "delete", file });
      return;
    }
    invalid.push(`unsupported action '${action}' for ${file}`);
  };
  for (const container of containers) {
    if (Array.isArray(container)) {
      container.forEach(handleEntry);
    } else {
      handleEntry(container);
    }
  }
  return { actions, invalid };
};

const placeholderTokenRegex = /\?\?\?|rest of existing code/i;
const placeholderEllipsisRegex = /^[\s+-]*\.{3}\s*$/m;

const containsPlaceholderContent = (content: string): boolean =>
  placeholderTokenRegex.test(content) || placeholderEllipsisRegex.test(content);

const escapeRegex = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildWhitespaceRegex = (search: string): RegExp => {
  let pattern = "";
  for (const char of search) {
    if (/\s/.test(char)) {
      pattern += "\\s*";
    } else {
      pattern += `${escapeRegex(char)}\\s*`;
    }
  }
  return new RegExp(pattern, "g");
};

const replaceOnce = (content: string, search: string, replace: string): string => {
  const occurrences = content.split(search).length - 1;
  if (occurrences === 1) {
    return content.replace(search, replace);
  }
  if (occurrences > 1) {
    throw new Error("Ambiguous search block. Provide more context.");
  }
  const regex = buildWhitespaceRegex(search);
  const matches = [...content.matchAll(regex)];
  if (matches.length === 0) {
    throw new Error("Search block not found in file.");
  }
  if (matches.length > 1) {
    throw new Error("Ambiguous search block. Provide more context.");
  }
  return content.replace(regex, replace);
};

const extractAgentChanges = (
  output: string,
): {
  patches: string[];
  fileBlocks: Array<{ path: string; content: string }>;
  structuredActions: StructuredPatchAction[];
  jsonDetected: boolean;
  commentResolution?: { resolvedSlugs?: string[]; unresolvedSlugs?: string[]; commentBacklogStatus?: string };
  unfencedFileHeader: boolean;
  placeholderFileBlocks: boolean;
  invalidFileBlockPaths: string[];
  invalidPatchActions: string[];
  allowFileOverwrite: boolean;
} => {
  let patches = extractPatches(output);
  const fileBlockResult = extractFileBlocks(output);
  let fileBlocks = fileBlockResult.fileBlocks;
  let invalidFileBlockPaths = fileBlockResult.invalidPaths;
  const unfencedFileHeader = hasUnfencedFileHeader(output);
  let placeholderFileBlocks = fileBlocks.some((block) => containsPlaceholderContent(block.content));
  let jsonDetected = false;
  let structuredActions: StructuredPatchAction[] = [];
  let invalidPatchActions: string[] = [];
  let allowFileOverwrite = false;
  let commentResolution: { resolvedSlugs?: string[]; unresolvedSlugs?: string[]; commentBacklogStatus?: string } | undefined;
  if (patches.length) {
    patches = patches.filter((patch) => !containsPlaceholderContent(patch));
  }
  if (patches.length === 0 && fileBlocks.length === 0) {
    const payload = parseJsonPayload(output);
    if (payload) {
      jsonDetected = true;
      patches = extractPatchesFromJson(payload);
      const jsonFiles = extractFileBlocksFromJson(payload);
      fileBlocks = jsonFiles.fileBlocks;
      invalidFileBlockPaths = [...invalidFileBlockPaths, ...jsonFiles.invalidPaths];
      allowFileOverwrite = jsonFiles.allowOverwrite;
      placeholderFileBlocks = fileBlocks.some((block) => containsPlaceholderContent(block.content));
      commentResolution = extractCommentResolutionFromJson(payload) ?? undefined;
      const actionResult = extractPatchActionsFromJson(payload);
      structuredActions = actionResult.actions;
      invalidPatchActions = actionResult.invalid;
      if (patches.length) {
        patches = patches.filter((patch) => !containsPlaceholderContent(patch));
      }
    } else if (looksLikeJsonOutput(output)) {
      jsonDetected = true;
    }
  }
  return {
    patches,
    fileBlocks,
    structuredActions,
    jsonDetected,
    commentResolution,
    unfencedFileHeader,
    placeholderFileBlocks,
    invalidFileBlockPaths,
    invalidPatchActions,
    allowFileOverwrite,
  };
};

const splitFileBlocksByExistence = (
  fileBlocks: Array<{ path: string; content: string }>,
  cwd: string,
): { existing: string[]; remaining: Array<{ path: string; content: string }> } => {
  const existing: string[] = [];
  const remaining: Array<{ path: string; content: string }> = [];
  for (const block of fileBlocks) {
    const resolved = path.resolve(cwd, block.path);
    if (fs.existsSync(resolved)) {
      existing.push(block.path);
    } else {
      remaining.push(block);
    }
  }
  return { existing, remaining };
};

type TaskPhase = "selection" | "context" | "prompt" | "agent" | "apply" | "tests" | "vcs" | "finalize";

type TestRequirements = {
  unit: string[];
  component: string[];
  integration: string[];
  api: string[];
};

type TestRunResult = { command: string; stdout: string; stderr: string; code: number };
export type MissingTestsPolicy = "block_job" | "skip_task" | "fail_task";
const DEFAULT_MISSING_TESTS_POLICY: MissingTestsPolicy = "block_job";

const normalizeMissingTestsPolicy = (value: unknown): MissingTestsPolicy | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "block_job" || normalized === "skip_task" || normalized === "fail_task") {
    return normalized;
  }
  return undefined;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeTestCommands = (value: unknown): string[] => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return normalizeStringArray(value);
};

const normalizeTestRequirements = (value: unknown): TestRequirements => {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    unit: normalizeStringArray(raw.unit),
    component: normalizeStringArray(raw.component),
    integration: normalizeStringArray(raw.integration),
    api: normalizeStringArray(raw.api),
  };
};

const hasTestRequirements = (requirements: TestRequirements): boolean =>
  requirements.unit.length > 0 ||
  requirements.component.length > 0 ||
  requirements.integration.length > 0 ||
  requirements.api.length > 0;

const formatTestRequirementsNote = (requirements: TestRequirements): string => {
  const parts: string[] = [];
  if (requirements.unit.length) parts.push(`Unit: ${requirements.unit.join("; ")}`);
  if (requirements.component.length) parts.push(`Component: ${requirements.component.join("; ")}`);
  if (requirements.integration.length) parts.push(`Integration: ${requirements.integration.join("; ")}`);
  if (requirements.api.length) parts.push(`API: ${requirements.api.join("; ")}`);
  return parts.length ? `Required tests: ${parts.join(" | ")}` : "";
};

const formatQaReadinessNote = (value: unknown): string => {
  if (!value || typeof value !== "object") return "";
  const qa = value as Record<string, unknown>;
  const profiles = normalizeStringArray(qa.profiles_expected);
  const requires = normalizeStringArray(qa.requires);
  const blockers = normalizeStringArray(qa.blockers);
  const dataSetup = normalizeStringArray(qa.data_setup);
  const notes = typeof qa.notes === "string" ? qa.notes.trim() : "";
  const entrypoints = Array.isArray(qa.entrypoints)
    ? qa.entrypoints
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          const raw = entry as Record<string, unknown>;
          const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
          const baseUrl = typeof raw.base_url === "string" ? raw.base_url.trim() : "";
          const command = typeof raw.command === "string" ? raw.command.trim() : "";
          const detail = baseUrl || command;
          if (!kind && !detail) return "";
          return detail ? `${kind || "entry"}=${detail}` : kind;
        })
        .filter(Boolean)
    : [];
  const parts: string[] = [];
  if (profiles.length) parts.push(`Profiles: ${profiles.join(", ")}`);
  if (entrypoints.length) parts.push(`Entrypoints: ${entrypoints.join("; ")}`);
  if (requires.length) parts.push(`Requires: ${requires.join("; ")}`);
  if (dataSetup.length) parts.push(`Data setup: ${dataSetup.join("; ")}`);
  if (blockers.length) parts.push(`Blockers: ${blockers.join("; ")}`);
  if (notes) parts.push(`Notes: ${notes}`);
  return parts.length ? `QA readiness: ${parts.join(" | ")}` : "";
};

const truncateText = (value: string, maxChars = DEFAULT_TEST_OUTPUT_CHARS): string => {
  if (!value) return "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
};

const formatTestFailureSummary = (results: TestRunResult[]): string => {
  return results
    .map((result) => {
      const stdout = truncateText(result.stdout ?? "");
      const stderr = truncateText(result.stderr ?? "");
      const lines = [
        `Command: ${result.command}`,
        `Exit code: ${result.code}`,
        stdout ? `Stdout: ${stdout}` : undefined,
        stderr ? `Stderr: ${stderr}` : undefined,
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
};

const readPackageScripts = (packageRoot: string): Record<string, string> | null => {
  try {
    const raw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (parsed && typeof parsed.scripts === "object") {
      return parsed.scripts ?? null;
    }
  } catch {
    /* ignore unreadable package.json */
  }
  return null;
};

const hasPackageScript = (packageRoot: string, scriptName: string): boolean => {
  const scripts = readPackageScripts(packageRoot);
  const script = scripts?.[scriptName];
  return typeof script === "string" && script.trim().length > 0;
};

const hasTestScript = (packageRoot: string): boolean => {
  return hasPackageScript(packageRoot, "test");
};

const extractCommandCwd = (command: string): string | undefined => {
  const match = command.match(/(?:--prefix|-C|--cwd)\s*=?\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const resolveTestCommandRoot = (command: string, workspaceRoot: string): string | undefined => {
  const candidate = extractCommandCwd(command);
  if (!candidate) return workspaceRoot;
  return path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate);
};

const isPackageManagerTestCommand = (command: string): boolean => {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!/^(npm|yarn|pnpm)\b/i.test(normalized)) return false;
  return /\btest\b/i.test(normalized);
};

const extractPackageScriptName = (command: string): string | undefined => {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return undefined;
  if (!/^(npm|yarn|pnpm)$/i.test(tokens[0])) return undefined;
  let idx = 1;
  while (idx < tokens.length) {
    const token = tokens[idx];
    if (token.startsWith("-")) {
      if (token === "--prefix" || token === "--cwd" || token === "-C") {
        idx += 2;
        continue;
      }
      if (token.startsWith("--prefix=") || token.startsWith("--cwd=")) {
        idx += 1;
        continue;
      }
      idx += 1;
      continue;
    }
    if (token === "run") {
      idx += 1;
      break;
    }
    if (token === "test") return "test";
    return token;
  }
  if (idx >= tokens.length) return undefined;
  const script = tokens[idx];
  if (!script || script.startsWith("-")) return undefined;
  return script;
};

const detectDefaultTestCommand = (workspaceRoot: string): string | undefined => {
  if (!hasTestScript(workspaceRoot)) return undefined;
  const hasPnpm =
    fs.existsSync(path.join(workspaceRoot, "pnpm-lock.yaml")) ||
    fs.existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"));
  const hasYarn = fs.existsSync(path.join(workspaceRoot, "yarn.lock"));
  const hasNpmLock =
    fs.existsSync(path.join(workspaceRoot, "package-lock.json")) ||
    fs.existsSync(path.join(workspaceRoot, "npm-shrinkwrap.json"));
  const hasPackageJson = fs.existsSync(path.join(workspaceRoot, "package.json"));
  if (hasPnpm) return "pnpm test";
  if (hasYarn) return "yarn test";
  if (hasNpmLock || hasPackageJson) return "npm test";
  return undefined;
};

const quoteShellPath = (value: string): string => (value.includes(" ") ? `"${value}"` : value);

const findNearestPackageRoot = (workspaceRoot: string, filePath: string): string | undefined => {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
  let current = resolved;
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      current = path.dirname(resolved);
    }
  } else {
    current = path.dirname(resolved);
  }
  const root = path.resolve(workspaceRoot);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
};

const resolveScopedPackageRoot = (workspaceRoot: string, files: string[]): string | undefined => {
  if (!files.length) return undefined;
  const candidates = files
    .map((file) => findNearestPackageRoot(workspaceRoot, file))
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  if (!candidates.length) return undefined;
  const unique = Array.from(new Set(candidates));
  unique.sort((a, b) => b.length - a.length);
  return unique[0];
};

const detectPackageManager = (workspaceRoot: string, packageRoot: string): "pnpm" | "yarn" | "npm" | undefined => {
  const hasPnpm =
    fs.existsSync(path.join(workspaceRoot, "pnpm-lock.yaml")) ||
    fs.existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml")) ||
    fs.existsSync(path.join(packageRoot, "pnpm-lock.yaml"));
  if (hasPnpm) return "pnpm";
  const hasYarn =
    fs.existsSync(path.join(workspaceRoot, "yarn.lock")) || fs.existsSync(path.join(packageRoot, "yarn.lock"));
  if (hasYarn) return "yarn";
  const hasNpmLock =
    fs.existsSync(path.join(workspaceRoot, "package-lock.json")) ||
    fs.existsSync(path.join(workspaceRoot, "npm-shrinkwrap.json")) ||
    fs.existsSync(path.join(packageRoot, "package-lock.json")) ||
    fs.existsSync(path.join(packageRoot, "npm-shrinkwrap.json"));
  const hasPackageJson = fs.existsSync(path.join(packageRoot, "package.json"));
  if (hasNpmLock || hasPackageJson) return "npm";
  return undefined;
};

const buildScopedTestCommand = (workspaceRoot: string, packageRoot: string): string | undefined => {
  if (!hasTestScript(packageRoot)) return undefined;
  const manager = detectPackageManager(workspaceRoot, packageRoot);
  if (!manager) return undefined;
  const relative = path.relative(workspaceRoot, packageRoot).split(path.sep).join("/");
  const target = relative && relative !== "" ? relative : ".";
  const quoted = quoteShellPath(target);
  if (manager === "pnpm") return target === "." ? "pnpm test" : `pnpm -C ${quoted} test`;
  if (manager === "yarn") return target === "." ? "yarn test" : `yarn --cwd ${quoted} test`;
  if (manager === "npm") return target === "." ? "npm test" : `npm --prefix ${quoted} test`;
  return undefined;
};

const detectScopedTestCommand = (workspaceRoot: string, files: string[]): string | undefined => {
  const scopedRoot = resolveScopedPackageRoot(workspaceRoot, files);
  if (scopedRoot) {
    const scopedCommand = buildScopedTestCommand(workspaceRoot, scopedRoot);
    if (scopedCommand) return scopedCommand;
  }
  return detectDefaultTestCommand(workspaceRoot);
};

const resolveNodeCommand = (): string => {
  const override = process.env.NODE_BIN?.trim();
  const resolved = override || (process.platform === "win32" ? "node.exe" : "node");
  return resolved.includes(" ") ? `"${resolved}"` : resolved;
};

const resolvePowerShellCommand = (): string => (process.platform === "win32" ? "powershell" : "pwsh");

const detectRunAllTestsScript = (workspaceRoot: string): string | undefined => {
  const candidates = ["tests/all.js", "tests/all.sh", "tests/all.ps1", "tests/all"];
  for (const candidate of candidates) {
    const scriptPath = path.join(workspaceRoot, ...candidate.split("/"));
    if (fs.existsSync(scriptPath)) {
      return candidate;
    }
  }
  return undefined;
};

const buildRunAllTestsCommand = (relativePath: string): string => {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized.endsWith(".js")) return `${resolveNodeCommand()} ${normalized}`;
  if (normalized.endsWith(".ps1")) return `${resolvePowerShellCommand()} -File ${quoteShellPath(normalized)}`;
  if (normalized.endsWith(".sh")) return `bash ${quoteShellPath(normalized)}`;
  if (normalized.startsWith(".")) return normalized;
  return `./${normalized}`;
};

const isNodeWorkspace = (workspaceRoot: string, seedCommands: string[] = []): boolean => {
  const hasNodeFiles =
    fs.existsSync(path.join(workspaceRoot, "package.json")) ||
    fs.existsSync(path.join(workspaceRoot, "pnpm-lock.yaml")) ||
    fs.existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml")) ||
    fs.existsSync(path.join(workspaceRoot, "yarn.lock")) ||
    fs.existsSync(path.join(workspaceRoot, "package-lock.json")) ||
    fs.existsSync(path.join(workspaceRoot, "npm-shrinkwrap.json"));
  if (hasNodeFiles) return true;
  return seedCommands.some((command) => /\b(node|npm|pnpm|yarn)\b/i.test(command));
};

const detectRunAllTestsCommand = (workspaceRoot: string): string | undefined => {
  const script = detectRunAllTestsScript(workspaceRoot);
  if (!script) return undefined;
  return buildRunAllTestsCommand(script);
};

const pickSeedTestCategory = (requirements: TestRequirements): keyof TestRequirements => {
  const order: (keyof TestRequirements)[] = ["unit", "component", "integration", "api"];
  const active = order.filter((key) => requirements[key].length > 0);
  if (active.length === 1) return active[0];
  return "unit";
};

const buildRunAllTestsScript = (seedCategory: keyof TestRequirements, seedCommands: string[]): string => {
  const suites: Record<keyof TestRequirements, string[]> = {
    unit: [],
    component: [],
    integration: [],
    api: [],
  };
  if (seedCommands.length) {
    suites[seedCategory] = seedCommands;
  }
  return [
    "#!/usr/bin/env node",
    'const { spawnSync } = require("node:child_process");',
    "",
    "// Register test commands per discipline.",
    `const testSuites = ${JSON.stringify(suites, null, 2)};`,
    "",
    'const entries = Object.entries(testSuites).flatMap(([label, commands]) =>',
    "  commands.map((command) => ({ label, command }))",
    ");",
    "if (!entries.length) {",
    '  console.error("No test commands registered in tests/all.js. Add unit/component/integration/api commands.");',
    "  process.exit(1);",
    "}",
    "",
    'console.log("MCODA_RUN_ALL_TESTS_START");',
    "let failed = false;",
    "for (const entry of entries) {",
    "  const result = spawnSync(entry.command, { shell: true, stdio: \"inherit\" });",
    "  const status = typeof result.status === \"number\" ? result.status : 1;",
    "  if (status !== 0) failed = true;",
    "}",
    'console.log(`MCODA_RUN_ALL_TESTS_COMPLETE status=${failed ? "failed" : "passed"}`);',
    'console.log("MCODA_RUN_ALL_TESTS_END");',
    "process.exit(failed ? 1 : 0);",
    "",
  ].join("\n");
};

const ensureRunAllTestsScript = async (
  workspaceRoot: string,
  requirements: TestRequirements,
  seedCommands: string[],
): Promise<boolean> => {
  if (!isNodeWorkspace(workspaceRoot, seedCommands)) return false;
  const scriptPath = path.join(workspaceRoot, "tests", "all.js");
  if (fs.existsSync(scriptPath)) return false;
  await PathHelper.ensureDir(path.dirname(scriptPath));
  const seedCategory = pickSeedTestCategory(requirements);
  const contents = buildRunAllTestsScript(seedCategory, seedCommands);
  await fs.promises.writeFile(scriptPath, contents, "utf8");
  return true;
};

const sanitizeTestCommands = (
  commands: string[],
  workspaceRoot: string,
): { commands: string[]; skipped: string[] } => {
  if (!commands.length) return { commands, skipped: [] };
  const skipped: string[] = [];
  const sanitized = commands.filter((command) => {
    const trimmed = command.trim();
    if (!trimmed) return false;
    const normalized = trimmed.replace(/\s+/g, " ");
    if (!isPackageManagerTestCommand(normalized)) return true;
    const packageRoot = resolveTestCommandRoot(normalized, workspaceRoot);
    if (!packageRoot) {
      skipped.push(`${command} (missing package root)`);
      return false;
    }
    if (!fs.existsSync(path.join(packageRoot, "package.json"))) {
      skipped.push(`${command} (package.json missing)`);
      return false;
    }
    const scriptName = extractPackageScriptName(normalized);
    if (scriptName && !hasPackageScript(packageRoot, scriptName)) {
      skipped.push(`${command} (${scriptName} script missing)`);
      return false;
    }
    return true;
  });
  return { commands: sanitized, skipped };
};

const dedupeCommands = (commands: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const touchedFilesFromPatch = (patch: string): string[] => {
  const files = new Set<string>();
  const regex = /^\+\+\+\s+b\/([^\s]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(patch)) !== null) {
    files.add(match[1]);
  }
  return Array.from(files);
};

const normalizePatchPath = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let stripped = trimmed.replace(/^file:\s*/i, "");
  if (stripped === "/dev/null") return null;
  stripped = stripped.replace(/^[ab][\\/]/, "");
  stripped = stripped.replace(/^["'`]+|["'`]+$/g, "");
  if (!stripped || stripped === "/dev/null") return null;
  const normalized = stripDiffMetadataSuffix(stripped).value;
  return normalized || null;
};

const extractPatchFilePaths = (patch: string): string[] => {
  const files = new Set<string>();
  const diffHeader = /^diff --git\s+([^\s]+)\s+([^\s]+)/gm;
  const fileHeader = /^(?:\+\+\+|---)\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = diffHeader.exec(patch)) !== null) {
    const left = normalizePatchPath(match[1] ?? "");
    const right = normalizePatchPath(match[2] ?? "");
    if (left) files.add(left);
    if (right) files.add(right);
  }
  while ((match = fileHeader.exec(patch)) !== null) {
    const normalized = normalizePatchPath(match[1] ?? "");
    if (normalized) files.add(normalized);
  }
  return Array.from(files);
};

const findOutOfScopePatchPaths = (patches: string[], workspaceRoot: string): string[] => {
  const invalid = new Set<string>();
  for (const patch of patches) {
    for (const file of extractPatchFilePaths(patch)) {
      if (!PathHelper.isPathInside(workspaceRoot, file)) {
        invalid.add(file);
      }
    }
  }
  return Array.from(invalid);
};

const findOutOfScopeActionPaths = (
  actions: StructuredPatchAction[],
  workspaceRoot: string,
): string[] => {
  const invalid = new Set<string>();
  for (const action of actions) {
    const file = action.file?.trim();
    if (!file) continue;
    if (!PathHelper.isPathInside(workspaceRoot, file)) {
      invalid.add(file);
    }
  }
  return Array.from(invalid);
};

const normalizePaths = (workspaceRoot: string, files: string[]): string[] =>
  files.map((f) => PathHelper.resolveRelativePath(workspaceRoot, f));
const resolveLockTtlSeconds = (maxAgentSeconds?: number): number => {
  if (!maxAgentSeconds || maxAgentSeconds <= 0) return TASK_LOCK_TTL_SECONDS;
  return Math.max(1, Math.min(TASK_LOCK_TTL_SECONDS, maxAgentSeconds + 60));
};
const WORK_DIR = (jobId: string, mcodaDir: string) => path.join(mcodaDir, "jobs", jobId, "work");

const maybeConvertApplyPatch = (patch: string): string => {
  if (!patch.trimStart().startsWith("*** Begin Patch")) return patch;
  const lines = patch.split(/\r?\n/);
  let i = 0;
  const out: string[] = [];
  const next = () => lines[++i];
  const current = () => lines[i];
  const advanceUntilNextFile = () => {
    while (i < lines.length && !current().startsWith("*** ")) i += 1;
  };

  while (i < lines.length) {
    const line = current();
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
      i += 1;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const file = line.replace("*** Add File: ", "").trim();
      const content: string[] = [];
      i += 1;
      while (i < lines.length && !current().startsWith("*** ")) {
        const l = current();
        if (l.startsWith("+")) {
          content.push(l.slice(1));
        } else if (!l.startsWith("\\ No newline at end of file")) {
          // Some apply_patch emitters omit the leading "+", so treat raw lines as content.
          content.push(l);
        }
        i += 1;
      }
      const count = content.length;
      out.push(`diff --git a/${file} b/${file}`);
      out.push("new file mode 100644");
      out.push("--- /dev/null");
      out.push(`+++ b/${file}`);
      if (count > 0) {
        out.push(`@@ -0,0 +1,${count} @@`);
        content.forEach((l) => out.push(`+${l}`));
      } else {
        out.push("@@ -0,0 +0,0 @@");
      }
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const file = line.replace("*** Delete File: ", "").trim();
      out.push(`diff --git a/${file} b/${file}`);
      out.push("deleted file mode 100644");
      out.push(`--- a/${file}`);
      out.push("+++ /dev/null");
      out.push("@@ -1 +0,0 @@");
      i += 1;
      advanceUntilNextFile();
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const file = line.replace("*** Update File: ", "").trim();
      i += 1;
      // Skip optional move line
      if (i < lines.length && current().startsWith("*** Move to: ")) i += 1;
      out.push(`diff --git a/${file} b/${file}`);
      out.push(`--- a/${file}`);
      out.push(`+++ b/${file}`);
      while (i < lines.length && !current().startsWith("*** ")) {
        const l = current();
        if (l.startsWith("@@") || l.startsWith("+++") || l.startsWith("---") || l.startsWith("+") || l.startsWith("-") || l.startsWith(" ")) {
          out.push(l);
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join("\n");
};

const ensureDiffHeader = (patch: string): string => {
  const lines = patch.split(/\r?\n/);
  const hasHeader = /^diff --git /m.test(patch);
  const minusIdx = lines.findIndex((l) => l.startsWith("--- "));
  const plusIdx = lines.findIndex((l) => l.startsWith("+++ "));
  if (minusIdx === -1 || plusIdx === -1) return patch;
  const minusPathRaw = lines[minusIdx].replace(/^---\s+/, "").trim();
  const plusPathRaw = lines[plusIdx].replace(/^\+\+\+\s+/, "").trim();
  const lhs =
    minusPathRaw === "/dev/null"
      ? plusPathRaw.replace(/^b\//, "")
      : minusPathRaw.replace(/^a\//, "");
  const rhs = plusPathRaw.replace(/^b\//, "");
  const header = `diff --git a/${lhs} b/${rhs}`;
  const result: string[] = [...lines];
  if (!hasHeader) {
    result.unshift(header);
  }
  const headerIdx = result.findIndex((l) => l.startsWith("diff --git "));
  const hasNewFileMode = result.some((l) => l.startsWith("new file mode"));
  const isAdd = minusPathRaw === "/dev/null";
  if (isAdd && !hasNewFileMode) {
    result.splice(headerIdx + 1, 0, "new file mode 100644");
  }
  return result.join("\n");
};

const normalizeDiffPaths = (patch: string, workspaceRoot: string): string => {
  const rootEntries = new Set<string>();
  try {
    fs.readdirSync(workspaceRoot, { withFileTypes: true }).forEach((entry) => {
      rootEntries.add(entry.name);
    });
  } catch {
    /* ignore */
  }

  const normalizePath = (raw: string): string => {
    let value = raw.trim();
    value = value.replace(/^file:\s*/i, "");
    value = value.replace(/^["'`]+|["'`]+$/g, "");
    value = value.replace(/^[ab][\\/]/, "");
    value = stripDiffMetadataSuffix(value).value;
    if (value === "/dev/null") return value;
    const original = value;
    const absolute = path.isAbsolute(original);
    if (absolute) {
      const relative = path.relative(workspaceRoot, original);
      const normalizedRelative = relative.replace(/\\/g, "/");
      if (!normalizedRelative.startsWith("..") && normalizedRelative !== "") {
        return normalizedRelative;
      }
      const segments = original.replace(/\\/g, "/").split("/").filter(Boolean);
      for (let i = 0; i < segments.length; i += 1) {
        if (rootEntries.has(segments[i])) {
          return segments.slice(i).join("/");
        }
      }
    }
    return original.replace(/\\/g, "/");
  };

  return patch
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        const parts = line.split(" ");
        if (parts.length >= 4) {
          const left = normalizePath(parts[2]);
          const right = normalizePath(parts[3]);
          return `diff --git a/${left} b/${right}`;
        }
        return line;
      }
      if (line.startsWith("--- ")) {
        const rest = line.slice(4).trim();
        if (rest === "/dev/null") return line;
        const normalized = normalizePath(rest);
        return `--- a/${normalized}`;
      }
      if (line.startsWith("+++ ")) {
        const rest = line.slice(4).trim();
        if (rest === "/dev/null") return line;
        const normalized = normalizePath(rest);
        return `+++ b/${normalized}`;
      }
      return line;
    })
    .join("\n");
};

const DOC_GUARD_DIRS = ["docs/sds", "docs/rfp", "openapi"];
const DOC_GUARD_FILES = ["openapi.yaml", "openapi.yml", "openapi.json"];

const formatDocGuardList = (): string => {
  const dirs = DOC_GUARD_DIRS.map((dir) => `${dir}/**`);
  return [...dirs, ...DOC_GUARD_FILES].join(", ");
};

const isGuardedDocPath = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (DOC_GUARD_FILES.includes(normalized)) return true;
  return DOC_GUARD_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
};

const countLines = (content: string): number => {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
};

const docDeletionThreshold = (totalLines: number): number => Math.max(50, Math.ceil(totalLines * 0.5));

const collectDocPatchDeletions = (patch: string, workspaceRoot: string): Record<string, number> => {
  const normalized = normalizeDiffPaths(ensureDiffHeader(maybeConvertApplyPatch(patch)), workspaceRoot);
  const lines = normalized.split(/\r?\n/);
  const deletions: Record<string, number> = {};
  let currentFile: string | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(" ");
      const rawPath = parts[3] ?? "";
      const pathValue = rawPath.startsWith("b/") ? rawPath.slice(2) : rawPath;
      currentFile = pathValue || null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") continue;
      currentFile = raw.startsWith("b/") ? raw.slice(2) : raw;
      continue;
    }
    if (!currentFile || !isGuardedDocPath(currentFile)) continue;
    if (line.startsWith("---")) continue;
    if (line.startsWith("-")) {
      deletions[currentFile] = (deletions[currentFile] ?? 0) + 1;
    }
  }
  return deletions;
};

const detectLargeDocEdits = async (
  patches: string[],
  fileBlocks: Array<{ path: string; content: string }>,
  workspaceRoot: string,
): Promise<
  Array<{
    path: string;
    removedLines: number;
    beforeLines: number;
    afterLines?: number;
    threshold: number;
    mode: "patch" | "file";
  }>
> => {
  const violations: Array<{
    path: string;
    removedLines: number;
    beforeLines: number;
    afterLines?: number;
    threshold: number;
    mode: "patch" | "file";
  }> = [];

  for (const patch of patches) {
    const deletions = collectDocPatchDeletions(patch, workspaceRoot);
    for (const [filePath, removedLines] of Object.entries(deletions)) {
      if (!isGuardedDocPath(filePath)) continue;
      const resolved = path.join(workspaceRoot, filePath);
      let beforeLines = 0;
      try {
        const content = await fs.promises.readFile(resolved, "utf8");
        beforeLines = countLines(content);
      } catch {
        beforeLines = 0;
      }
      if (!beforeLines) continue;
      const threshold = docDeletionThreshold(beforeLines);
      if (removedLines >= threshold) {
        violations.push({ path: filePath, removedLines, beforeLines, threshold, mode: "patch" });
      }
    }
  }

  for (const block of fileBlocks) {
    const rawPath = block.path?.trim();
    if (!rawPath) continue;
    const resolved = path.resolve(workspaceRoot, rawPath);
    const relative = path.relative(workspaceRoot, resolved).replace(/\\/g, "/");
    if (!isGuardedDocPath(relative)) continue;
    let beforeLines = 0;
    try {
      const content = await fs.promises.readFile(resolved, "utf8");
      beforeLines = countLines(content);
    } catch {
      beforeLines = 0;
    }
    if (!beforeLines) continue;
    const afterLines = countLines(block.content ?? "");
    const removedLines = Math.max(0, beforeLines - afterLines);
    const threshold = docDeletionThreshold(beforeLines);
    if (removedLines >= threshold) {
      violations.push({ path: relative, removedLines, beforeLines, afterLines, threshold, mode: "file" });
    }
  }

  return violations;
};

const convertMissingFilePatchToAdd = (patch: string, workspaceRoot: string): string => {
  if (!/@@\s+-0,0\s+\+\d+/m.test(patch)) return patch;
  const files = touchedFilesFromPatch(patch);
  if (!files.length) return patch;
  let updated = patch;
  let changed = false;
  for (const file of files) {
    const resolved = path.join(workspaceRoot, file);
    if (fs.existsSync(resolved)) continue;
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const minus = new RegExp(`^---\\s+(?:a/)?${escaped}$`, "m");
    if (minus.test(updated)) {
      updated = updated.replace(minus, "--- /dev/null");
      changed = true;
    }
    const plus = new RegExp(`^\\+\\+\\+\\s+(?:b/)?${escaped}$`, "m");
    if (plus.test(updated)) {
      updated = updated.replace(plus, `+++ b/${file}`);
      changed = true;
    }
  }
  return changed ? ensureDiffHeader(updated) : updated;
};

const stripInvalidIndexLines = (patch: string): string =>
  patch
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith("index ")) return true;
      const value = line.replace(/^index\s+/, "").trim();
      return /^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/.test(value);
    })
    .join("\n");

const isPlaceholderPatch = (patch: string): boolean => containsPlaceholderContent(patch);

const normalizeHunkHeaders = (patch: string): string => {
  const lines = patch.split(/\r?\n/);
  const out: string[] = [];
  let currentAddFile = false;

  const countLines = (start: number): { minus: number; plus: number } => {
    let minus = 0;
    let plus = 0;
    for (let j = start; j < lines.length; j += 1) {
      const l = lines[j];
      if (l.startsWith("@@") || l.startsWith("diff --git ") || l.startsWith("*** End Patch")) break;
      if (l.startsWith("+++ ") || l.startsWith("--- ")) continue;
      if (l.startsWith(" ")) {
        minus += 1;
        plus += 1;
      } else if (l.startsWith("-")) {
        minus += 1;
      } else if (l.startsWith("+")) {
        plus += 1;
      } else if (!l.trim()) {
        minus += 1;
        plus += 1;
      } else {
        break;
      }
    }
    return { minus, plus };
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      currentAddFile = false;
      out.push(line);
      continue;
    }
    if (line.startsWith("--- ")) {
      currentAddFile = line.includes("/dev/null");
      out.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      out.push(line);
      continue;
    }

    const isHunk = line.startsWith("@@");
    const hasRanges = /^@@\s+-\d+/.test(line);
    if (isHunk && !hasRanges) {
      const { minus, plus } = countLines(i + 1);
      const minusCount = currentAddFile ? 0 : minus;
      const plusCount = currentAddFile ? Math.max(plus, 0) : plus;
      out.push(`@@ -0,${minusCount} +1,${plusCount} @@`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
};

const fixMissingPrefixesInHunks = (patch: string): string => {
  const lines = patch.split(/\r?\n/);
  const out: string[] = [];
  let inHunk = false;
  let addFile = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      addFile = false;
      out.push(line);
      continue;
    }
    if (line.startsWith("--- ")) {
      addFile = line.includes("/dev/null");
      out.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      out.push(line);
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      out.push(line);
      continue;
    }
    if (inHunk) {
      if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("*** End Patch")) {
        inHunk = false;
        out.push(line);
        continue;
      }
      if (!line.length) {
        out.push(addFile ? "+" : " ");
        continue;
      }
      if (!/^[+\-\s]/.test(line)) {
        out.push(`+${line}`);
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
};

const parseAddedFileContents = (patch: string): Record<string, string> => {
  const lines = patch.split(/\r?\n/);
  const additions: Record<string, string[]> = {};
  let currentFile: string | null = null;
  let isAdd = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      isAdd = false;
    }
    if (line.startsWith("--- ")) {
      const minusPath = line.replace(/^---\s+/, "").trim();
      isAdd = minusPath === "/dev/null";
    }
    if (line.startsWith("+++ ") && isAdd) {
      const plusPath = line.replace(/^\+\+\+\s+/, "").trim().replace(/^b\//, "");
      currentFile = plusPath;
      additions[currentFile] = [];
    }
    if (currentFile && isAdd) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        additions[currentFile].push(line.slice(1));
      }
    }
  }
  return Object.fromEntries(Object.entries(additions).map(([file, content]) => [file, content.join("\n")]));
};

const parseAddOnlyPatchContents = (patch: string): Record<string, string> => {
  const lines = patch.split(/\r?\n/);
  const additions: Record<string, string[]> = {};
  let currentFile: string | null = null;
  let inHunk = false;
  let sawContextOrRemoval = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const pathLine = line.replace(/^\+\+\+\s+/, "").trim();
      if (pathLine && pathLine !== "/dev/null") {
        currentFile = pathLine.replace(/^b\//, "");
      }
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("*** End Patch")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (currentFile) {
        if (!additions[currentFile]) additions[currentFile] = [];
        additions[currentFile].push(line.slice(1));
      }
      continue;
    }
    if (!line.length) {
      if (currentFile) {
        if (!additions[currentFile]) additions[currentFile] = [];
        additions[currentFile].push("");
      }
      continue;
    }
    if (line.startsWith("-") || line.startsWith(" ")) {
      sawContextOrRemoval = true;
    }
  }

  if (sawContextOrRemoval) return {};
  return Object.fromEntries(Object.entries(additions).map(([file, content]) => [file, content.join("\n")]));
};

const updateAddPatchForExistingFile = (patch: string, existingFiles: Set<string>, cwd: string): { patch: string; skipped: string[] } => {
  const additions = parseAddedFileContents(patch);
  const skipped: string[] = [];
  let updated = patch;
  if (existingFiles.size > 0) {
    const existingRelative = new Set(
      Array.from(existingFiles).map((absolute) => path.relative(cwd, absolute).replace(/\\/g, "/")),
    );
    let currentFile: string | null = null;
    const out: string[] = [];
    for (const line of updated.split(/\r?\n/)) {
      if (line.startsWith("diff --git ")) {
        const parts = line.split(" ");
        const raw = parts[3] ?? parts[2] ?? "";
        currentFile = raw.replace(/^b\//, "").replace(/^a\//, "");
        out.push(line);
        continue;
      }
      const currentExists = currentFile ? existingRelative.has(currentFile) : false;
      if (currentExists && line.startsWith("new file mode")) {
        continue;
      }
      if (currentExists && line.startsWith("--- /dev/null")) {
        out.push(`--- a/${currentFile}`);
        continue;
      }
      out.push(line);
    }
    updated = out.join("\n");
  }
  for (const file of Object.keys(additions)) {
    const absolute = path.join(cwd, file);
    if (!existingFiles.has(absolute)) continue;
    try {
      const content = fs.readFileSync(absolute, "utf8");
      if (content.trim() === additions[file].trim()) {
        skipped.push(file);
        continue;
      }
    } catch {
      // ignore read errors; fall back to converting patch
    }
    // Convert add patch to update by removing new file mode and dev/null markers.
    const lines = updated.split(/\r?\n/);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith("diff --git ")) {
        out.push(line);
        continue;
      }
      if (line.startsWith("new file mode") && lines[i + 1]?.includes(file)) {
        continue;
      }
      if (line.startsWith("--- /dev/null") && lines[i + 1]?.includes(file)) {
        out.push(`--- a/${file}`);
        continue;
      }
      out.push(line);
    }
    updated = out.join("\n");
  }
  return { patch: updated, skipped };
};

const splitPatchIntoDiffs = (patch: string): string[] => {
  const parts = patch.split(/^diff --git /m).filter(Boolean);
  if (parts.length <= 1) return [patch];
  return parts.map((part) => `diff --git ${part}`.trim());
};

export class WorkOnTasksService {
  private selectionService: TaskSelectionService;
  private stateService: TaskStateService;
  private taskLogSeq = new Map<string, number>();
  private vcs: VcsClient;
  private routingService: RoutingService;
  private ratingService?: AgentRatingService;
  private async readPromptFiles(paths: string[]): Promise<string[]> {
    const contents: string[] = [];
    const seen = new Set<string>();
    for (const promptPath of paths) {
      try {
        const content = await fs.promises.readFile(promptPath, "utf8");
        const trimmed = content.trim();
        if (trimmed && !seen.has(trimmed)) {
          contents.push(trimmed);
          seen.add(trimmed);
        }
      } catch {
        /* optional prompt */
      }
    }
    return contents;
  }

  constructor(
    private workspace: WorkspaceResolution,
    private deps: {
      agentService: AgentService;
      docdex: DocdexClient;
      jobService: JobService;
      workspaceRepo: WorkspaceRepository;
      selectionService?: TaskSelectionService;
      stateService?: TaskStateService;
      repo: GlobalRepository;
      vcsClient?: VcsClient;
      routingService: RoutingService;
      ratingService?: AgentRatingService;
    },
  ) {
    this.selectionService = deps.selectionService ?? new TaskSelectionService(workspace, deps.workspaceRepo);
    this.stateService = deps.stateService ?? new TaskStateService(deps.workspaceRepo);
    this.vcs = deps.vcsClient ?? new VcsClient();
    this.routingService = deps.routingService;
    this.ratingService = deps.ratingService;
  }

  private async loadPrompts(agentId: string): Promise<{
    jobPrompt?: string;
    characterPrompt?: string;
    commandPrompt?: string;
  }> {
    const agentPrompts =
      "getPrompts" in this.deps.agentService ? await (this.deps.agentService as any).getPrompts(agentId) : undefined;
    const mcodaPromptPath = path.join(this.workspace.mcodaDir, "prompts", "code-writer.md");
    const workspacePromptPath = path.join(this.workspace.workspaceRoot, "prompts", "code-writer.md");
    const repoPromptPath = resolveRepoPromptPath("code-writer.md");
    try {
      await fs.promises.mkdir(path.dirname(mcodaPromptPath), { recursive: true });
      await fs.promises.access(mcodaPromptPath);
      console.info(`[work-on-tasks] using existing code-writer prompt at ${mcodaPromptPath}`);
    } catch {
      try {
        await fs.promises.access(workspacePromptPath);
        await fs.promises.copyFile(workspacePromptPath, mcodaPromptPath);
        console.info(`[work-on-tasks] copied code-writer prompt to ${mcodaPromptPath}`);
      } catch {
        try {
          await fs.promises.access(repoPromptPath);
          await fs.promises.copyFile(repoPromptPath, mcodaPromptPath);
          console.info(`[work-on-tasks] copied repo code-writer prompt to ${mcodaPromptPath}`);
        } catch {
          console.info(
            `[work-on-tasks] no code-writer prompt found at ${workspacePromptPath} or repo prompts; writing default prompt to ${mcodaPromptPath}`,
          );
          await fs.promises.writeFile(mcodaPromptPath, DEFAULT_CODE_WRITER_PROMPT, "utf8");
        }
      }
    }
    let filePrompt = await readPromptFile(mcodaPromptPath, DEFAULT_CODE_WRITER_PROMPT);
    if (looksLikeQaPrompt(filePrompt)) {
      console.info("[work-on-tasks] detected QA prompt in code-writer prompt; restoring default code-writer prompt.");
      filePrompt = DEFAULT_CODE_WRITER_PROMPT;
      try {
        await fs.promises.writeFile(mcodaPromptPath, DEFAULT_CODE_WRITER_PROMPT, "utf8");
      } catch {
        // ignore prompt write failures
      }
    }
    let commandPrompt = agentPrompts?.commandPrompts?.["work-on-tasks"]?.trim() || filePrompt;
    if (looksLikeQaPrompt(commandPrompt)) {
      console.info("[work-on-tasks] ignoring QA-flavored command prompt override; using code-writer prompt.");
      commandPrompt = filePrompt;
    }
    return {
      jobPrompt: sanitizeNonGatewayPrompt(agentPrompts?.jobPrompt) ?? DEFAULT_JOB_PROMPT,
      characterPrompt: sanitizeNonGatewayPrompt(agentPrompts?.characterPrompt) ?? DEFAULT_CHARACTER_PROMPT,
      commandPrompt: commandPrompt || undefined,
    };
  }

  private async ensureMcoda(): Promise<void> {
    await PathHelper.ensureDir(this.workspace.mcodaDir);
  }

  private async writeWorkCheckpoint(jobId: string, data: Record<string, unknown>): Promise<void> {
    const dir = WORK_DIR(jobId, this.workspace.mcodaDir);
    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, "state.json");
    await fs.promises.writeFile(target, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  }

  private async persistPatchArtifact(jobId: string, taskKey: string, payload: Record<string, unknown>): Promise<string> {
    const dir = path.join(WORK_DIR(jobId, this.workspace.mcodaDir), "patches");
    await fs.promises.mkdir(dir, { recursive: true });
    const safeKey = taskKey.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(dir, `${safeKey}-${stamp}.json`);
    await fs.promises.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
    return path.relative(this.workspace.mcodaDir, target);
  }

  private async checkpoint(jobId: string, stage: string, details?: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.deps.jobService.writeCheckpoint(jobId, {
      stage,
      timestamp,
      details,
    });
    await this.writeWorkCheckpoint(jobId, { stage, details, timestamp });
  }

  static async create(workspace: WorkspaceResolution): Promise<WorkOnTasksService> {
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
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    const jobService = new JobService(workspace, workspaceRepo);
    const selectionService = new TaskSelectionService(workspace, workspaceRepo);
    const stateService = new TaskStateService(workspaceRepo);
    const vcsClient = new VcsClient();
    return new WorkOnTasksService(workspace, {
      agentService,
      docdex,
      jobService,
      workspaceRepo,
      selectionService,
      stateService,
      repo,
      vcsClient,
      routingService,
    });
  }

  async close(): Promise<void> {
    const maybeClose = async (target: unknown) => {
      try {
        if ((target as any)?.close) await (target as any).close();
      } catch {
        /* ignore */
      }
    };
    await maybeClose(this.deps.selectionService);
    await maybeClose(this.deps.stateService);
    await maybeClose(this.deps.agentService);
    await maybeClose(this.deps.jobService);
    await maybeClose(this.deps.repo);
    await maybeClose(this.deps.workspaceRepo);
    await maybeClose(this.deps.routingService);
    await maybeClose(this.deps.docdex);
  }

  setDocdexAvailability(available: boolean, reason?: string): void {
    if (available) return;
    const docdex = this.deps.docdex as any;
    if (docdex && typeof docdex.disable === "function") {
      docdex.disable(reason);
    }
  }

  private async resolveAgent(agentName?: string) {
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: "work-on-tasks",
      overrideAgentSlug: agentName,
    });
    this.ensureWorkAgent(resolved.agent);
    return resolved.agent;
  }

  private ensureWorkAgent(agent: { id: string; slug?: string | null; adapter?: string | null }): void {
    const adapter = (agent.adapter ?? "").toLowerCase();
    if (QA_ADAPTERS.has(adapter)) {
      const label = agent.slug ?? agent.id;
      throw new Error(`Work-on-tasks cannot use QA adapter ${adapter} (agent ${label}). Select a code-writing agent.`);
    }
  }

  private ensureRatingService(): AgentRatingService {
    if (!this.ratingService) {
      this.ratingService = new AgentRatingService(this.workspace, {
        workspaceRepo: this.deps.workspaceRepo,
        globalRepo: this.deps.repo,
        agentService: this.deps.agentService,
        routingService: this.routingService,
      });
    }
    return this.ratingService;
  }

  private resolveTaskComplexity(task: TaskSelectionPlan["ordered"][number]["task"]): number | undefined {
    const metadata = (task.metadata as Record<string, unknown> | null | undefined) ?? {};
    const metaComplexity =
      typeof metadata.complexity === "number" && Number.isFinite(metadata.complexity) ? metadata.complexity : undefined;
    const storyPoints =
      typeof task.storyPoints === "number" && Number.isFinite(task.storyPoints) ? task.storyPoints : undefined;
    const candidate = metaComplexity ?? storyPoints;
    if (!Number.isFinite(candidate ?? NaN)) return undefined;
    return Math.min(10, Math.max(1, Math.round(candidate as number)));
  }

  private nextLogSeq(taskRunId: string): number {
    const next = (this.taskLogSeq.get(taskRunId) ?? 0) + 1;
    this.taskLogSeq.set(taskRunId, next);
    return next;
  }

  private async logTask(taskRunId: string, message: string, source?: string, details?: Record<string, unknown>): Promise<void> {
    await this.deps.workspaceRepo.insertTaskLog({
      taskRunId,
      sequence: this.nextLogSeq(taskRunId),
      timestamp: new Date().toISOString(),
      source: source ?? "work-on-tasks",
      message,
      details: details ?? undefined,
    });
  }

  private async recordTokenUsage(params: {
    agentId: string;
    model?: string;
    jobId: string;
    commandRunId: string;
    taskRunId: string;
    taskId: string;
    projectId?: string;
    tokensPrompt: number;
    tokensCompletion: number;
    phase?: string;
    attempt?: number;
    durationSeconds?: number;
  }) {
    const total = params.tokensPrompt + params.tokensCompletion;
    await this.deps.jobService.recordTokenUsage({
      workspaceId: this.workspace.workspaceId,
      agentId: params.agentId,
      modelName: params.model,
      jobId: params.jobId,
      commandRunId: params.commandRunId,
      taskRunId: params.taskRunId,
      taskId: params.taskId,
      projectId: params.projectId,
      tokensPrompt: params.tokensPrompt,
      tokensCompletion: params.tokensCompletion,
      tokensTotal: total,
      durationSeconds: params.durationSeconds ?? null,
      timestamp: new Date().toISOString(),
      metadata: {
        commandName: "work-on-tasks",
        phase: params.phase ?? "agent",
        action: params.phase ?? "agent",
        attempt: params.attempt ?? 1,
      },
    });
  }

  private async updateTaskPhase(
    jobId: string,
    taskRunId: string,
    taskKey: string,
    phase: TaskPhase,
    status: "start" | "end" | "error",
    details?: Record<string, unknown>,
  ) {
    const payload = { taskKey, phase, status, ...(details ?? {}) };
    await this.deps.workspaceRepo.updateTaskRun(taskRunId, { runContext: { phase, status } });
    await this.logTask(taskRunId, `${phase}:${status}`, phase, payload);
    await this.checkpoint(jobId, `task:${taskKey}:${phase}:${status}`, payload);
  }

  private async gatherDocContext(
    projectKey?: string,
    docLinks: string[] = [],
  ): Promise<{ summary: string; warnings: string[]; docdexUnavailable: boolean }> {
    const warnings: string[] = [];
    const parts: string[] = [];
    let openApiIncluded = false;
    let docdexUnavailable = false;
    const shouldIncludeDocType = (docType: string): boolean => {
      if (docType.toUpperCase() !== "OPENAPI") return true;
      if (openApiIncluded) return false;
      openApiIncluded = true;
      return true;
    };
    if (typeof (this.deps.docdex as any)?.ensureRepoScope === "function") {
      try {
        await (this.deps.docdex as any).ensureRepoScope();
      } catch (error) {
        warnings.push(`docdex scope missing: ${(error as Error).message}`);
        docdexUnavailable = true;
        return { summary: "", warnings, docdexUnavailable };
      }
    }
    try {
      const docs = await this.deps.docdex.search({ projectKey, profile: "workspace-code" });
      const filteredDocs = docs.filter(
        (doc) => !isDocContextExcluded(doc.path ?? doc.title ?? doc.id, false),
      );
      const resolveDocType = (doc: { docType?: string; path?: string; title?: string; content?: string; segments?: Array<{ content?: string }> }) => {
        const content = doc.segments?.[0]?.content ?? doc.content ?? "";
        const normalized = normalizeDocType({
          docType: doc.docType,
          path: doc.path,
          title: doc.title,
          content,
        });
        if (normalized.downgraded) {
          warnings.push(
            `Docdex docType downgraded from SDS to DOC for ${doc.path ?? doc.title ?? doc.docType ?? "unknown"}: ${normalized.reason ?? "not_sds"}`,
          );
        }
        return normalized.docType;
      };
      for (const doc of filteredDocs.slice(0, 5)) {
        const docType = resolveDocType(doc);
        if (!shouldIncludeDocType(docType)) continue;
        parts.push(`- [${docType}] ${doc.title ?? doc.path ?? doc.id}`);
      }
    } catch (error) {
      warnings.push(`docdex search failed: ${(error as Error).message}`);
      docdexUnavailable = true;
    }
    const normalizeDocLink = (value: string): { type: "id" | "path"; ref: string } => {
      const trimmed = value.trim();
      const stripped = trimmed.replace(/^docdex:/i, "").replace(/^doc:/i, "");
      const candidate = stripped || trimmed;
      const looksLikePath =
        candidate.includes("/") ||
        candidate.includes("\\") ||
        /\.(md|markdown|txt|rst|yaml|yml|json)$/i.test(candidate);
      return { type: looksLikePath ? "path" : "id", ref: candidate };
    };
    for (const link of docLinks) {
      try {
        const { type, ref } = normalizeDocLink(link);
        if (type === "path" && isDocContextExcluded(ref, false)) {
          parts.push(`- [linked:filtered] ${link} — excluded from non-QA context`);
          continue;
        }
        let doc = undefined;
        if (type === "path" && "findDocumentByPath" in this.deps.docdex) {
          doc = await (this.deps.docdex as DocdexClient).findDocumentByPath(ref);
        }
        if (!doc) {
          doc = await this.deps.docdex.fetchDocumentById(ref);
        }
        if (!doc) {
          warnings.push(`docdex fetch returned no document for ${link}`);
          parts.push(`- [linked:missing] ${link} — no docdex entry found`);
          continue;
        }
        const docType = (() => {
          const content = doc.segments?.[0]?.content ?? doc.content ?? "";
          const normalized = normalizeDocType({
            docType: doc.docType,
            path: doc.path,
            title: doc.title,
            content,
          });
          if (normalized.downgraded) {
            warnings.push(
              `Docdex docType downgraded from SDS to DOC for ${doc.path ?? doc.title ?? doc.id}: ${normalized.reason ?? "not_sds"}`,
            );
          }
          return normalized.docType;
        })();
        if (!shouldIncludeDocType(docType)) continue;
        const excerpt = doc.segments?.[0]?.content?.slice(0, 240);
        parts.push(`- [linked:${docType}] ${doc.title ?? doc.id}${excerpt ? ` — ${excerpt}` : ""}`);
      } catch (error) {
        const message = (error as Error).message;
        warnings.push(`docdex fetch failed for ${link}: ${message}`);
        parts.push(`- [linked:missing] ${link} — ${message}`);
      }
    }
    const summary = parts.join("\n");
    return { summary, warnings, docdexUnavailable };
  }

  private parseCommentBody(body: string): { message: string; suggestedFix?: string } {
    const trimmed = (body ?? "").trim();
    if (!trimmed) return { message: "(no details provided)" };
    const lines = trimmed.split(/\r?\n/);
    const normalize = (value: string) => value.trim().toLowerCase();
    const messageIndex = lines.findIndex((line) => normalize(line) === "message:");
    const suggestedIndex = lines.findIndex((line) => {
      const normalized = normalize(line);
      return normalized === "suggested_fix:" || normalized === "suggested fix:";
    });
    if (messageIndex >= 0) {
      const messageLines = lines.slice(messageIndex + 1, suggestedIndex >= 0 ? suggestedIndex : undefined);
      const message = messageLines.join("\n").trim();
      const suggestedLines = suggestedIndex >= 0 ? lines.slice(suggestedIndex + 1) : [];
      const suggestedFix = suggestedLines.join("\n").trim();
      return { message: message || trimmed, suggestedFix: suggestedFix || undefined };
    }
    if (suggestedIndex >= 0) {
      const message = lines.slice(0, suggestedIndex).join("\n").trim() || trimmed;
      const inlineFix = lines[suggestedIndex]?.split(/suggested fix:/i)[1]?.trim();
      const suggestedTail = lines.slice(suggestedIndex + 1).join("\n").trim();
      const suggestedFix = inlineFix || suggestedTail || undefined;
      return { message, suggestedFix };
    }
    return { message: trimmed };
  }

  private buildCommentBacklog(comments: TaskCommentRow[]): string {
    if (!comments.length) return "";
    const seen = new Set<string>();
    const lines: string[] = [];
    const toSingleLine = (value: string) => value.replace(/\s+/g, " ").trim();
    for (const comment of comments) {
      const details = this.parseCommentBody(comment.body);
      const slug =
        comment.slug?.trim() ||
        createTaskCommentSlug({
          source: comment.sourceCommand ?? "comment",
          message: details.message || comment.body,
          file: comment.file,
          line: comment.line,
          category: comment.category ?? null,
        });
      const key =
        slug ??
        `${comment.sourceCommand}:${comment.file ?? ""}:${comment.line ?? ""}:${details.message || comment.body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const location = comment.file
        ? `${comment.file}${typeof comment.line === "number" ? `:${comment.line}` : ""}`
        : "(location not specified)";
      const message = toSingleLine(details.message || comment.body || "(no details provided)");
      lines.push(`- [${slug ?? "untracked"}] ${location} ${message}`);
      const suggestedFix =
        (comment.metadata?.suggestedFix as string | undefined) ?? details.suggestedFix ?? undefined;
      if (suggestedFix) {
        lines.push(`  Suggested fix: ${toSingleLine(suggestedFix)}`);
      }
    }
    return lines.join("\n");
  }

  private buildWorkLog(comments: TaskCommentRow[]): string {
    if (!comments.length) return "";
    const toSingleLine = (value: string) => value.replace(/\s+/g, " ").trim();
    const lines: string[] = [];
    for (const comment of comments) {
      const details = this.parseCommentBody(comment.body);
      const summary = toSingleLine(details.message || comment.body || "(no details provided)");
      const stamp = comment.createdAt ? new Date(comment.createdAt).toISOString() : "unknown time";
      const category = comment.category ?? comment.sourceCommand ?? "work-on-tasks";
      const slug = comment.slug?.trim();
      const label = slug ? `${category}:${slug}` : category;
      lines.push(`- [${label}] ${stamp}: ${summary}`);
    }
    return lines.join("\n");
  }

  private async loadCommentContext(taskId: string): Promise<{ comments: TaskCommentRow[]; unresolved: TaskCommentRow[] }> {
    const comments = await this.deps.workspaceRepo.listTaskComments(taskId, {
      sourceCommands: ["code-review", "qa-tasks"],
      limit: 50,
    });
    const unresolved = comments.filter((comment) => !comment.resolvedAt && !isNonBlockingComment(comment));
    return { comments, unresolved };
  }

  private async loadWorkLog(taskId: string): Promise<TaskCommentRow[]> {
    return this.deps.workspaceRepo.listTaskComments(taskId, {
      sourceCommands: ["work-on-tasks"],
      limit: 5,
    });
  }

  private async countCommentBacklogFailures(taskId: string): Promise<number> {
    const comments = await this.deps.workspaceRepo.listTaskComments(taskId, {
      sourceCommands: ["work-on-tasks"],
      limit: 50,
    });
    return comments.filter((comment) => {
      if (comment.category !== "comment_backlog") return false;
      const reason = (comment.metadata as any)?.reason;
      return reason === "comment_backlog_unaddressed" || reason === "comment_backlog_missing";
    }).length;
  }

  private async applyCommentResolutions(params: {
    taskId: string;
    taskRunId: string;
    jobId: string;
    agentId: string;
    resolvedSlugs?: string[] | null;
    unresolvedSlugs?: string[] | null;
    existingComments: TaskCommentRow[];
    dryRun: boolean;
  }): Promise<{ resolved: string[]; reopened: string[]; open: string[] }> {
    const existingBySlug = new Map<string, TaskCommentRow>();
    const openBySlug = new Set<string>();
    const resolvedBySlug = new Set<string>();
    for (const comment of params.existingComments) {
      if (!comment.slug) continue;
      if (!existingBySlug.has(comment.slug)) {
        existingBySlug.set(comment.slug, comment);
      }
      if (comment.resolvedAt) {
        resolvedBySlug.add(comment.slug);
      } else {
        openBySlug.add(comment.slug);
      }
    }

    const allowedSlugs = new Set(existingBySlug.keys());
    const resolvedSlugs = normalizeSlugList(params.resolvedSlugs ?? undefined).filter((slug) => allowedSlugs.has(slug));
    const resolvedSet = new Set(resolvedSlugs);
    const unresolvedSet = new Set(
      normalizeSlugList(params.unresolvedSlugs ?? undefined).filter((slug) => allowedSlugs.has(slug)),
    );
    for (const slug of resolvedSet) {
      unresolvedSet.delete(slug);
    }

    const toResolve = resolvedSlugs.filter((slug) => openBySlug.has(slug));
    const toReopen = Array.from(unresolvedSet).filter((slug) => resolvedBySlug.has(slug));

    if (!params.dryRun) {
      for (const slug of toResolve) {
        await this.deps.workspaceRepo.resolveTaskComment({
          taskId: params.taskId,
          slug,
          resolvedAt: new Date().toISOString(),
          resolvedBy: params.agentId,
        });
      }
      for (const slug of toReopen) {
        await this.deps.workspaceRepo.reopenTaskComment({ taskId: params.taskId, slug });
      }
    }

    const openSet = new Set(openBySlug);
    for (const slug of unresolvedSet) {
      openSet.add(slug);
    }
    for (const slug of resolvedSet) {
      openSet.delete(slug);
    }

    if ((resolvedSlugs.length || toReopen.length || unresolvedSet.size) && !params.dryRun) {
      const resolutionMessage = [
        `Resolved slugs: ${formatSlugList(toResolve)}`,
        `Reopened slugs: ${formatSlugList(toReopen)}`,
        `Open slugs: ${formatSlugList(Array.from(openSet))}`,
      ].join("\n");
      const resolutionSlug = createTaskCommentSlug({
        source: "work-on-tasks",
        message: resolutionMessage,
        category: "comment_resolution",
      });
      const resolutionBody = formatTaskCommentBody({
        slug: resolutionSlug,
        source: "work-on-tasks",
        message: resolutionMessage,
        status: "resolved",
        category: "comment_resolution",
      });
      const createdAt = new Date().toISOString();
      await this.deps.workspaceRepo.createTaskComment({
        taskId: params.taskId,
        taskRunId: params.taskRunId,
        jobId: params.jobId,
        sourceCommand: "work-on-tasks",
        authorType: "agent",
        authorAgentId: params.agentId,
        category: "comment_resolution",
        slug: resolutionSlug,
        status: "resolved",
        body: resolutionBody,
        createdAt,
        resolvedAt: createdAt,
        resolvedBy: params.agentId,
        metadata: {
          resolvedSlugs: toResolve,
          reopenedSlugs: toReopen,
          openSlugs: Array.from(openSet),
        },
      });
    }

    return { resolved: toResolve, reopened: toReopen, open: Array.from(openSet) };
  }

  private buildPrompt(
    task: TaskSelectionPlan["ordered"][number],
    docSummary: string,
    fileScope: string[],
    commentBacklog: string,
    workLog: string,
    enforceCommentBacklog: boolean,
  ): string {
    const deps = task.dependencies.keys.length ? `Depends on: ${task.dependencies.keys.join(", ")}` : "No open dependencies.";
    const acceptance = (task.task.acceptanceCriteria ?? []).join("; ");
    const docdexHint =
      docSummary ||
      "Use docdex: search workspace docs with project key and fetch linked documents when present (doc_links metadata).";
    const backlog = commentBacklog
      ? `Comment backlog${enforceCommentBacklog ? " (highest priority)" : ""}:\n${commentBacklog}`
      : "";
    const workLogSection = workLog ? `Work log (recent):\n${workLog}` : "";
    return [
      `Task ${task.task.key}: ${task.task.title}`,
      `Description: ${task.task.description ?? "(none)"}`,
      `Epic: ${task.task.epicKey} (${task.task.epicTitle ?? "n/a"}), Story: ${task.task.storyKey} (${task.task.storyTitle ?? "n/a"})`,
      `Acceptance: ${acceptance || "Refer to SDS/OpenAPI for expected behavior."}`,
      deps,
      commentBacklog
        ? enforceCommentBacklog
          ? "Priority: resolve the comment backlog before any other work."
          : "Comment backlog provided; address relevant items and report status."
        : "",
      backlog,
      workLogSection,
      `Allowed files: ${fileScope.length ? fileScope.join(", ") : "(not constrained)"}`,
      `Doc context:\n${docdexHint}`,
      "Verify target paths against the current workspace (use docdex/file hints); do not assume hashed or generated asset names exist. If a path is missing, create the file with full content (and parent dirs) or state clearly what is missing so the change can be applied.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async checkoutBaseBranch(baseBranch: string, options?: { allowDirty?: boolean }): Promise<void> {
    await this.vcs.ensureRepo(this.workspace.workspaceRoot);
    await this.vcs.ensureBaseBranch(this.workspace.workspaceRoot, baseBranch);
    const dirtyPaths = await this.vcs.dirtyPaths(this.workspace.workspaceRoot);
    const nonMcodaDirty = dirtyPaths.filter((p: string) => !p.startsWith(".mcoda"));
    if (nonMcodaDirty.length && !options?.allowDirty) {
      throw new Error(`Working tree dirty: ${nonMcodaDirty.join(", ")}`);
    }
    try {
      await this.vcs.checkoutBranch(this.workspace.workspaceRoot, baseBranch);
    } catch (error) {
      const errorText = this.formatGitError(error);
      if (options?.allowDirty && this.isDirtyCheckoutError(errorText)) {
        // Leave current branch intact; caller will reconcile dirty changes later.
        return;
      }
      throw error;
    }
  }

  private buildCommitEnv(agentId?: string): NodeJS.ProcessEnv {
    const shortAgentId = agentId ? agentId.slice(0, 8) : "";
    const committerName = agentId ? `mcoda-code-writer (${shortAgentId})` : "mcoda-code-writer";
    return {
      ...process.env,
      GIT_AUTHOR_NAME: committerName,
      GIT_AUTHOR_EMAIL: "code-writer@mcoda.local",
      GIT_COMMITTER_NAME: committerName,
      GIT_COMMITTER_EMAIL: "code-writer@mcoda.local",
    };
  }

  private async commitPendingChanges(
    branchInfo: { branch: string; base: string } | null,
    taskKey: string,
    taskTitle: string,
    reason: string,
    taskId: string,
    taskRunId: string,
    options?: { updateTask?: boolean; agentId?: string },
  ): Promise<string | null> {
    const dirty = await this.vcs.dirtyPaths(this.workspace.workspaceRoot);
    const nonMcoda = dirty.filter((p: string) => !p.startsWith(".mcoda"));
    if (!nonMcoda.length) return null;
    const normalize = (value: string): string =>
      value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    const blocked = nonMcoda.filter((p) => {
      const normalized = normalize(p);
      return normalized === "docs/qa" || normalized.startsWith("docs/qa/");
    });
    if (blocked.length) {
      await this.vcs.restorePaths(this.workspace.workspaceRoot, blocked);
      await this.logTask(
        taskRunId,
        `Removed blocked QA report paths from work-on-tasks output: ${blocked.join(", ")}`,
        "policy",
      );
    }
    const allowed = nonMcoda.filter((p) => !blocked.includes(p));
    if (!allowed.length) return null;
    await this.vcs.stage(this.workspace.workspaceRoot, allowed);
    const status = await this.vcs.status(this.workspace.workspaceRoot);
    if (!status.trim().length) return null;
    const message = `[${taskKey}] ${taskTitle} (${reason})`;
    const commitEnv = this.buildCommitEnv(options?.agentId);
    await this.vcs.commit(this.workspace.workspaceRoot, message, { env: commitEnv });
    const head = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
    if (options?.updateTask !== false) {
      await this.deps.workspaceRepo.updateTask(taskId, {
        vcsLastCommitSha: head,
        vcsBranch: branchInfo?.branch ?? null,
        vcsBaseBranch: branchInfo?.base ?? null,
      });
    }
    await this.logTask(taskRunId, `Auto-committed pending changes (${reason})`, "vcs", {
      branch: branchInfo?.branch,
      base: branchInfo?.base,
      head,
    });
    return head;
  }

  private async ensureBranches(
    taskKey: string,
    taskTitle: string,
    taskId: string,
    baseBranch: string,
    taskRunId: string,
    agentId?: string,
  ): Promise<{ branch: string; base: string; mergeConflicts?: string[]; remoteSyncNote?: string }> {
    const branch = `${DEFAULT_TASK_BRANCH_PREFIX}${taskKey}`;
    const cwd = this.workspace.workspaceRoot;
    let pendingCherryPickSha: string | null = null;
    await this.vcs.ensureRepo(cwd);
    const dirtyPaths = await this.vcs.dirtyPaths(cwd);
    const nonMcodaDirty = dirtyPaths.filter((p: string) => !p.startsWith(".mcoda"));
    if (nonMcodaDirty.length) {
      const currentBranch = await this.vcs.currentBranch(cwd);
      const taskBranchExists = await this.vcs.branchExists(cwd, branch);
      if (currentBranch === branch) {
        await this.commitPendingChanges(
          { branch, base: baseBranch },
          taskKey,
          taskTitle,
          "pre_existing_changes",
          taskId,
          taskRunId,
          { agentId },
        );
      } else if (!taskBranchExists) {
        pendingCherryPickSha = await this.commitPendingChanges(
          { branch: currentBranch ?? branch, base: baseBranch },
          taskKey,
          taskTitle,
          "pre_existing_changes",
          taskId,
          taskRunId,
          { updateTask: false, agentId },
        );
      } else {
        try {
          await this.vcs.checkoutBranch(cwd, branch);
          await this.commitPendingChanges(
            { branch, base: baseBranch },
            taskKey,
            taskTitle,
            "pre_existing_changes",
            taskId,
            taskRunId,
            { agentId },
          );
        } catch (error) {
          const errorText = this.formatGitError(error);
          await this.logTask(
            taskRunId,
            `Warning: failed to checkout ${branch} with a dirty workspace; committing on ${
              currentBranch ?? "HEAD"
            } and cherry-picking onto ${branch}.`,
            "vcs",
            { error: errorText, dirtyPaths: nonMcodaDirty },
          );
          pendingCherryPickSha = await this.commitPendingChanges(
            { branch: currentBranch ?? branch, base: baseBranch },
            taskKey,
            taskTitle,
            "pre_existing_changes",
            taskId,
            taskRunId,
            { updateTask: false, agentId },
          );
        }
      }
    }

    await this.checkoutBaseBranch(baseBranch, { allowDirty: true });
    const hasRemote = await this.vcs.hasRemote(cwd);
    if (hasRemote) {
      try {
        await this.vcs.pull(cwd, "origin", baseBranch, true);
      } catch (error) {
        await this.logTask(taskRunId, `Warning: failed to pull ${baseBranch} from origin; continuing with local base.`, "vcs", {
          error: (error as Error).message,
        });
      }
    }
    const branchExists = await this.vcs.branchExists(cwd, branch);
    let remoteSyncNote = "";
    if (branchExists) {
      await this.vcs.checkoutBranch(cwd, branch);
      await this.commitPendingChanges(
        { branch, base: baseBranch },
        taskKey,
        taskTitle,
        "pre_existing_changes",
        taskId,
        taskRunId,
        { agentId },
      );
      if (hasRemote) {
        try {
          await this.vcs.pull(cwd, "origin", branch, true);
        } catch (error) {
          const errorText = this.formatGitError(error);
          await this.logTask(taskRunId, `Warning: failed to pull ${branch} from origin; continuing with local branch.`, "vcs", {
            error: errorText,
          });
          if (this.isNonFastForwardPull(errorText)) {
            remoteSyncNote = `Remote task branch ${branch} is ahead/diverged. Sync it with origin (pull/rebase or merge). If conflicts arise, stop and report; do not attempt to merge them.`;
          }
        }
      }
      if (pendingCherryPickSha) {
        try {
          await this.vcs.cherryPick(cwd, pendingCherryPickSha);
          await this.logTask(taskRunId, `Cherry-picked pre-existing changes (${pendingCherryPickSha}).`, "vcs");
        } catch (error) {
          const conflicts = await this.vcs.conflictPaths(cwd);
          if (conflicts.length) {
            await this.logTask(taskRunId, `Conflicts while cherry-picking pre-existing changes.`, "vcs", {
              conflicts,
              error: this.formatGitError(error),
            });
            try {
              await this.vcs.abortCherryPick(cwd);
            } catch {
              // ignore abort failures
            }
            return { branch, base: baseBranch, mergeConflicts: conflicts, remoteSyncNote };
          }
          throw error;
        }
      }
      try {
        await this.vcs.merge(cwd, baseBranch, branch, true);
      } catch (error) {
        const conflicts = await this.vcs.conflictPaths(cwd);
        if (conflicts.length) {
          await this.logTask(
            taskRunId,
            `Merge conflicts detected while merging ${baseBranch} into ${branch}; auto-resolving by taking ${baseBranch}.`,
            "vcs",
            { conflicts },
          );
          try {
            await this.vcs.resolveMergeConflicts(cwd, "theirs", conflicts);
            await this.logTask(
              taskRunId,
              `Resolved merge conflicts by taking ${baseBranch} for ${conflicts.length} file(s).`,
              "vcs",
            );
          } catch (resolveError) {
            await this.logTask(taskRunId, "Auto-resolve failed; aborting merge.", "vcs", {
              error: this.formatGitError(resolveError),
            });
            await this.vcs.abortMerge(cwd);
            return { branch, base: baseBranch, mergeConflicts: conflicts, remoteSyncNote };
          }
        } else {
          throw new Error(`Failed to merge ${baseBranch} into ${branch}: ${(error as Error).message}`);
        }
      }
    } else {
      await this.vcs.createOrCheckoutBranch(cwd, branch, baseBranch);
      if (pendingCherryPickSha) {
        try {
          await this.vcs.cherryPick(cwd, pendingCherryPickSha);
          await this.logTask(taskRunId, `Cherry-picked pre-existing changes (${pendingCherryPickSha}).`, "vcs");
        } catch (error) {
          const conflicts = await this.vcs.conflictPaths(cwd);
          if (conflicts.length) {
            await this.logTask(taskRunId, `Conflicts while cherry-picking pre-existing changes.`, "vcs", {
              conflicts,
              error: this.formatGitError(error),
            });
            try {
              await this.vcs.abortCherryPick(cwd);
            } catch {
              // ignore abort failures
            }
            return { branch, base: baseBranch, mergeConflicts: conflicts, remoteSyncNote };
          }
          throw error;
        }
      }
      await this.commitPendingChanges(
        { branch, base: baseBranch },
        taskKey,
        taskTitle,
        "pre_existing_changes",
        taskId,
        taskRunId,
        { agentId },
      );
    }
    return { branch, base: baseBranch, remoteSyncNote: remoteSyncNote || undefined };
  }

  private formatGitError(error: unknown): string {
    if (!error) return "";
    const stderr = typeof (error as any).stderr === "string" ? (error as any).stderr : "";
    const stdout = typeof (error as any).stdout === "string" ? (error as any).stdout : "";
    const message = error instanceof Error ? error.message : String(error);
    return [message, stderr, stdout].filter(Boolean).join(" ");
  }

  private isNonFastForwardPush(errorText: string): boolean {
    return /non-fast-forward|fetch first|rejected/i.test(errorText);
  }

  private isNonFastForwardPull(errorText: string): boolean {
    return /not possible to fast-forward|divergent|non-fast-forward|rejected/i.test(errorText);
  }

  private isRemotePermissionError(errorText: string): boolean {
    return /protected branch|gh006|permission denied|not authorized|not allowed to push|access denied|403|forbidden/i.test(errorText);
  }

  private isCommitHookFailure(errorText: string): boolean {
    return /hook|pre-commit|commit-msg|husky/i.test(errorText);
  }

  private isGpgSignFailure(errorText: string): boolean {
    return /gpg|signing key|signing failed|gpg failed|no secret key/i.test(errorText);
  }

  private isDirtyCheckoutError(errorText: string): boolean {
    return /would be overwritten by checkout|local changes|commit your changes or stash them/i.test(errorText);
  }
  private async pushWithRecovery(taskRunId: string, branch: string): Promise<{ pushed: boolean; skipped: boolean; reason?: string }> {
    const cwd = this.workspace.workspaceRoot;
    try {
      await this.vcs.push(cwd, "origin", branch);
      return { pushed: true, skipped: false };
    } catch (error) {
      const errorText = this.formatGitError(error);
      if (this.isRemotePermissionError(errorText)) {
        await this.logTask(
          taskRunId,
          `Remote rejected push for ${branch} due to permissions or branch protection; continuing with local commits.`,
          "vcs",
          {
            error: errorText,
            guidance: "Use a token with write access or push to an unprotected branch and open a PR.",
          },
        );
        return { pushed: false, skipped: true, reason: "permission" };
      }
      if (!this.isNonFastForwardPush(errorText)) {
        throw error;
      }
      await this.logTask(
        taskRunId,
        `Non-fast-forward push rejected for ${branch}; attempting to pull and retry.`,
        "vcs",
        { error: errorText },
      );
      const currentBranch = await this.vcs.currentBranch(cwd);
      if (currentBranch && currentBranch !== branch) {
        await this.vcs.ensureClean(cwd);
        await this.vcs.checkoutBranch(cwd, branch);
      }
      try {
        await this.vcs.pull(cwd, "origin", branch, false);
        await this.vcs.push(cwd, "origin", branch);
      } catch (retryError) {
        const retryText = this.formatGitError(retryError);
        if (this.isRemotePermissionError(retryText)) {
          await this.logTask(
            taskRunId,
            `Remote rejected push for ${branch} after sync due to permissions or branch protection; continuing with local commits.`,
            "vcs",
            {
              error: retryText,
              guidance: "Use a token with write access or push to an unprotected branch and open a PR.",
            },
          );
          return { pushed: false, skipped: true, reason: "permission" };
        }
        throw new Error(`Non-fast-forward push rejected for ${branch}; retry after pull failed: ${retryText}`);
      } finally {
        if (currentBranch && currentBranch !== branch) {
          await this.vcs.checkoutBranch(cwd, currentBranch);
        }
      }
      await this.logTask(taskRunId, `Push recovered after syncing ${branch} from origin.`, "vcs");
      return { pushed: true, skipped: false };
    }
  }

  private validateScope(allowed: string[], touched: string[]): { ok: boolean; message?: string } {
    if (!allowed.length) return { ok: true };
    const normalizedAllowed = allowed.map((f) => f.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, ""));
    const mode = resolveScopeMode();
    const expandedAllowed =
      mode === "dir"
        ? Array.from(new Set([...normalizedAllowed, ...deriveParentDirs(normalizedAllowed)]))
        : normalizedAllowed;
    const outOfScope = touched.filter(
      (f) => !expandedAllowed.some((allowedPath) => f === allowedPath || f.startsWith(`${allowedPath}/`)),
    );
    if (outOfScope.length) {
      return { ok: false, message: `Patch touches files outside allowed scope: ${outOfScope.join(", ")}` };
    }
    return { ok: true };
  }

  private async buildStructuredFileBlocks(
    actions: StructuredPatchAction[],
    workspaceRoot: string,
  ): Promise<{ fileBlocks: Array<{ path: string; content: string }>; errors: string[] }> {
    const fileBlocks: Array<{ path: string; content: string }> = [];
    const errors: string[] = [];
    for (const action of actions) {
      const rawPath = action.file?.trim();
      if (!rawPath) {
        errors.push("Structured patch action missing file path.");
        continue;
      }
      if (!PathHelper.isPathInside(workspaceRoot, rawPath)) {
        errors.push(`Structured patch action path outside workspace: ${rawPath}`);
        continue;
      }
      const resolved = path.resolve(workspaceRoot, rawPath);
      if (action.action === "create") {
        fileBlocks.push({ path: rawPath, content: action.content });
        continue;
      }
      if (action.action === "delete") {
        if (!fs.existsSync(resolved)) {
          errors.push(`Structured delete target missing: ${rawPath}`);
          continue;
        }
        fileBlocks.push({ path: rawPath, content: "" });
        continue;
      }
      if (action.action === "replace") {
        try {
          const current = await fs.promises.readFile(resolved, "utf8");
          const updated = replaceOnce(current, action.search_block, action.replace_block);
          fileBlocks.push({ path: rawPath, content: updated });
        } catch (error) {
          errors.push(
            `Structured replace failed for ${rawPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    return { fileBlocks, errors };
  }

  private async applyStructuredActions(
    actions: StructuredPatchAction[],
    workspaceRoot: string,
    dryRun: boolean,
    allowOverwrite: boolean,
  ): Promise<{ touched: string[]; error?: string; warnings?: string[] }> {
    const touched = new Set<string>();
    const warnings: string[] = [];
    for (const action of actions) {
      const rawPath = action.file?.trim();
      if (!rawPath) {
        return { touched: Array.from(touched), error: "Structured patch action missing file path." };
      }
      if (!PathHelper.isPathInside(workspaceRoot, rawPath)) {
        return { touched: Array.from(touched), error: `Structured patch path outside workspace: ${rawPath}` };
      }
      const resolved = path.resolve(workspaceRoot, rawPath);
      if (action.action === "create") {
        if (fs.existsSync(resolved) && !allowOverwrite) {
          return { touched: Array.from(touched), error: `File already exists: ${rawPath}` };
        }
        if (!dryRun) {
          await PathHelper.ensureDir(path.dirname(resolved));
          await fs.promises.writeFile(resolved, action.content, "utf8");
        }
        touched.add(rawPath);
        continue;
      }
      if (action.action === "delete") {
        if (!fs.existsSync(resolved)) {
          return { touched: Array.from(touched), error: `File not found for deletion: ${rawPath}` };
        }
        if (!dryRun) {
          await fs.promises.rm(resolved, { force: true });
        }
        touched.add(rawPath);
        continue;
      }
      if (action.action === "replace") {
        if (!fs.existsSync(resolved)) {
          return { touched: Array.from(touched), error: `File not found for replace: ${rawPath}` };
        }
        try {
          const current = await fs.promises.readFile(resolved, "utf8");
          const updated = replaceOnce(current, action.search_block, action.replace_block);
          if (!dryRun) {
            await fs.promises.writeFile(resolved, updated, "utf8");
          }
          touched.add(rawPath);
        } catch (error) {
          return {
            touched: Array.from(touched),
            error: `Structured replace failed for ${rawPath}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
    }
    return { touched: Array.from(touched), warnings };
  }

  private async applyPatches(
    patches: string[],
    cwd: string,
    dryRun: boolean,
    context: { jobId: string; taskKey: string; attempt: number },
  ): Promise<{
    touched: string[];
    error?: string;
    warnings?: string[];
    hardFailure?: boolean;
    rejectDetails?: { files: string[]; message: string; removedRejects: string[]; cleanupErrors: string[] };
  }> {
    const touched = new Set<string>();
    const warnings: string[] = [];
    let applied = 0;
    const { jobId, taskKey, attempt } = context;
    const recordPatchIssue = async (details: Record<string, unknown>, message?: string): Promise<void> => {
      try {
        const artifactPath = await this.persistPatchArtifact(jobId, taskKey, {
          schema_version: 1,
          task_key: taskKey,
          attempt,
          created_at: new Date().toISOString(),
          ...details,
        });
        const warnMessage = message ? `${message} (artifact: ${artifactPath})` : `Patch artifact saved to ${artifactPath}.`;
        warnings.push(warnMessage);
      } catch (persistError) {
        warnings.push(
          `Failed to persist patch artifact for ${taskKey}: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
        );
      }
    };

    const removeRejectFiles = async (rejectPaths: string[]): Promise<{ removed: string[]; errors: string[] }> => {
      const removed: string[] = [];
      const errors: string[] = [];
      for (const rejectPath of rejectPaths) {
        try {
          await fs.promises.rm(rejectPath, { force: true });
          removed.push(rejectPath);
        } catch (error) {
          errors.push(`${rejectPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { removed, errors };
    };

    for (const [patchIndex, patch] of patches.entries()) {
      const normalized = maybeConvertApplyPatch(patch);
      const withHeader = ensureDiffHeader(normalized);
      const withPaths = normalizeDiffPaths(withHeader, cwd);
      const withAdds = convertMissingFilePatchToAdd(withPaths, cwd);
      const withHunks = normalizeHunkHeaders(withAdds);
      const withPrefixes = fixMissingPrefixesInHunks(withHunks);
      const sanitized = stripInvalidIndexLines(withPrefixes);
      if (isPlaceholderPatch(sanitized)) {
        const message = "Skipped placeholder patch that contained ??? or 'rest of existing code'.";
        warnings.push(message);
        await recordPatchIssue(
          {
            reason: "placeholder_patch",
            patch_index: patchIndex,
            raw_patch: patch,
            normalized_patch: sanitized,
          },
          message,
        );
        continue;
      }
      const files = touchedFilesFromPatch(sanitized);
      if (!files.length) {
        const message = "Skipped patch with no recognizable file paths.";
        warnings.push(message);
        await recordPatchIssue(
          {
            reason: "missing_file_paths",
            patch_index: patchIndex,
            raw_patch: patch,
            normalized_patch: sanitized,
          },
          message,
        );
        continue;
      }
      const segments = splitPatchIntoDiffs(sanitized);
      for (const [segmentIndex, segment] of segments.entries()) {
        const segmentFiles = touchedFilesFromPatch(segment);
        const existingFiles = new Set(segmentFiles.map((f) => path.join(cwd, f)).filter((f) => fs.existsSync(f)));
        let patchToApply = segment;
        if (existingFiles.size > 0) {
          const { patch: converted, skipped } = updateAddPatchForExistingFile(segment, existingFiles, cwd);
          patchToApply = converted;
          if (skipped.length) {
            const message = `Skipped add patch for existing files: ${skipped.join(", ")}`;
            warnings.push(message);
            await recordPatchIssue(
              {
                reason: "existing_files",
                patch_index: patchIndex,
                segment_index: segmentIndex,
                raw_patch: patch,
                normalized_patch: sanitized,
                segment_patch: patchToApply,
                segment_files: segmentFiles,
              },
              message,
            );
            continue;
          }
        }
        if (dryRun) {
          segmentFiles.forEach((f) => touched.add(f));
          applied += 1;
          continue;
        }
        // Ensure target directories exist for new/updated files.
        for (const file of segmentFiles) {
          const dir = path.dirname(path.join(cwd, file));
          try {
            await fs.promises.mkdir(dir, { recursive: true });
          } catch {
            /* ignore mkdir errors; git apply will surface issues */
          }
        }
        try {
          await this.vcs.applyPatch(cwd, patchToApply);
          segmentFiles.forEach((f) => touched.add(f));
          applied += 1;
        } catch (error) {
          // Fallback: if the segment only adds new files and git apply fails, write the files directly.
          const additions = parseAddedFileContents(patchToApply);
          const fallbackAdditions = Object.keys(additions).length ? additions : parseAddOnlyPatchContents(patchToApply);
          const addTargets = Object.keys(fallbackAdditions);
          if (addTargets.length && segmentFiles.length === addTargets.length) {
            try {
              for (const file of addTargets) {
                const dest = path.join(cwd, file);
                await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                await fs.promises.writeFile(dest, fallbackAdditions[file], "utf8");
                touched.add(file);
              }
              applied += 1;
              warnings.push(`Applied add-only segment by writing files directly: ${addTargets.join(", ")}`);
              continue;
            } catch (writeError) {
              const message = `Patch segment failed and fallback write failed (${segmentFiles.join(", ") || "unknown files"}): ${(writeError as Error).message}`;
              warnings.push(message);
              await recordPatchIssue(
                {
                  reason: "add_write_failed",
                  patch_index: patchIndex,
                  segment_index: segmentIndex,
                  raw_patch: patch,
                  normalized_patch: sanitized,
                  segment_patch: patchToApply,
                  segment_files: segmentFiles,
                  error: message,
                },
                message,
              );
              continue;
            }
          }
          const rejectResult = await this.vcs.applyPatchWithReject(cwd, patchToApply);
          const rejectPaths = segmentFiles
            .map((file) => path.join(cwd, `${file}.rej`))
            .filter((rejectPath) => fs.existsSync(rejectPath));
          const cleanup = await removeRejectFiles(rejectPaths);
          const messageParts = [
            `Patch rejected for ${segmentFiles.join(", ") || "unknown files"}.`,
            cleanup.removed.length ? `Removed ${cleanup.removed.length} reject file(s).` : "No reject files found.",
            cleanup.errors.length ? `Reject cleanup errors: ${cleanup.errors.join("; ")}` : "",
            rejectResult?.error ? `Git error: ${rejectResult.error}` : "",
          ].filter(Boolean);
          const rejectMessage = messageParts.join(" ");
          warnings.push(rejectMessage);
          await recordPatchIssue(
            {
              reason: "reject_failed",
              patch_index: patchIndex,
              segment_index: segmentIndex,
              raw_patch: patch,
              normalized_patch: sanitized,
              segment_patch: patchToApply,
              segment_files: segmentFiles,
              reject_files: rejectPaths,
              reject_cleanup_errors: cleanup.errors,
              error: rejectMessage,
            },
            rejectMessage,
          );
          return {
            touched: Array.from(touched),
            warnings,
            error: rejectMessage,
            hardFailure: true,
            rejectDetails: {
              files: segmentFiles,
              message: rejectMessage,
              removedRejects: cleanup.removed,
              cleanupErrors: cleanup.errors,
            },
          };
          const message = `Patch segment failed (${segmentFiles.join(", ") || "unknown files"}): ${
            (error as Error).message
          }`;
          warnings.push(message);
          await recordPatchIssue(
            {
              reason: "apply_failed",
              patch_index: patchIndex,
              segment_index: segmentIndex,
              raw_patch: patch,
              normalized_patch: sanitized,
              segment_patch: patchToApply,
              segment_files: segmentFiles,
              error: message,
            },
            message,
          );
        }
      }
    }
    if (!applied && warnings.length) {
      return { touched: Array.from(touched), warnings, error: "No patches applied; all segments failed or were skipped." };
    }
    return { touched: Array.from(touched), warnings };
  }

  private async applyFileBlocks(
    files: Array<{ path: string; content: string }>,
    cwd: string,
    dryRun: boolean,
    allowNoop = false,
    allowOverwrite = false,
  ): Promise<{ touched: string[]; error?: string; warnings?: string[]; appliedCount: number }> {
    const touched = new Set<string>();
    const warnings: string[] = [];
    let applied = 0;
    for (const file of files) {
      const relative = file.path.trim();
      if (!relative) {
        warnings.push("Skipped file block with empty path.");
        continue;
      }
      const resolved = path.resolve(cwd, relative);
      const relativePath = path.relative(cwd, resolved).replace(/\\/g, "/");
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        warnings.push(`Skipped file block outside workspace: ${relative}`);
        continue;
      }
      if (fs.existsSync(resolved)) {
        if (!allowOverwrite) {
          warnings.push(`Skipped file block for existing file: ${relativePath}`);
          continue;
        }
        if (!file.content || !file.content.trim()) {
          warnings.push(`Skipped overwrite for ${relativePath}: empty FILE block content.`);
          continue;
        }
        warnings.push(`Overwriting existing file from FILE block: ${relativePath}`);
        if (dryRun) {
          touched.add(relativePath);
          applied += 1;
          continue;
        }
        try {
          await fs.promises.writeFile(resolved, file.content, "utf8");
          touched.add(relativePath);
          applied += 1;
        } catch (error) {
          warnings.push(`Failed to overwrite file block ${relativePath}: ${(error as Error).message}`);
        }
        continue;
      }
      if (dryRun) {
        touched.add(relativePath);
        applied += 1;
        continue;
      }
      try {
        await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
        await fs.promises.writeFile(resolved, file.content ?? "", "utf8");
        touched.add(relativePath);
        applied += 1;
      } catch (error) {
        warnings.push(`Failed to write file block ${relativePath}: ${(error as Error).message}`);
      }
    }
    if (!applied && !allowNoop) {
      return {
        touched: Array.from(touched),
        warnings,
        error: "No file blocks were applied.",
        appliedCount: applied,
      };
    }
    return { touched: Array.from(touched), warnings, appliedCount: applied };
  }

  private usesCliBrowserTools(commands: string[]): boolean {
    const pattern = /(cypress|puppeteer|selenium|capybara|dusk)/i;
    return commands.some((command) => pattern.test(command));
  }

  private ensureCypressChromium(command: string): string {
    if (!/cypress/i.test(command)) return command;
    if (/--browser(\s+|=)/i.test(command)) return command;
    if (/\bcypress\s+(run|open)\b/i.test(command)) {
      return `${command} --browser chromium`;
    }
    return command;
  }

  private async applyChromiumForTests(
    commands: string[],
  ): Promise<{ ok: boolean; commands: string[]; env: NodeJS.ProcessEnv; message?: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!this.usesCliBrowserTools(commands)) {
      return { ok: true, commands, env };
    }
    const chromiumPath = await resolveChromiumBinary();
    if (!chromiumPath) {
      return {
        ok: false,
        commands,
        env,
        message:
          "Chromium binary not found for CLI browser tests. Install Docdex Chromium (docdex setup or MCODA_QA_CHROMIUM_PATH).",
      };
    }
    env.CHROME_PATH = chromiumPath;
    env.CHROME_BIN = chromiumPath;
    env.PUPPETEER_EXECUTABLE_PATH = chromiumPath;
    env.PUPPETEER_PRODUCT = "chrome";
    env.CYPRESS_BROWSER = "chromium";
    const updated = commands.map((command) => this.ensureCypressChromium(command));
    return { ok: true, commands: updated, env };
  }

  private async findMissingTestHarnessTasks(
    orderedTasks: TaskSelectionPlan["ordered"],
  ): Promise<
    Array<{
      taskKey: string;
      testRequirements: TestRequirements;
      attemptedCommands: string[];
    }>
  > {
    const issues: Array<{
      taskKey: string;
      testRequirements: TestRequirements;
      attemptedCommands: string[];
    }> = [];
    const commandBuilder = new QaTestCommandBuilder(this.workspace.workspaceRoot);
    const runAllTestsCommandHint = detectRunAllTestsCommand(this.workspace.workspaceRoot);

    for (const selected of orderedTasks) {
      const metadata = (selected.task.metadata as Record<string, unknown> | undefined) ?? {};
      const testRequirements = normalizeTestRequirements(metadata.test_requirements ?? metadata.testRequirements);
      if (!hasTestRequirements(testRequirements)) continue;

      let testCommands = normalizeTestCommands(metadata.tests ?? metadata.testCommands);
      const attemptedCommands: string[] = [];
      const sanitizedMetadata = sanitizeTestCommands(testCommands, this.workspace.workspaceRoot);
      testCommands = sanitizedMetadata.commands;
      attemptedCommands.push(...testCommands);

      if (!testCommands.length) {
        try {
          const commandPlan = await commandBuilder.build({ task: selected.task });
          const built = sanitizeTestCommands(commandPlan.commands, this.workspace.workspaceRoot);
          testCommands = built.commands;
          attemptedCommands.push(...built.commands);
        } catch {
          // Ignore command builder errors for preflight and rely on fallback checks.
        }
      }

      if (!testCommands.length) {
        let allowedFiles = Array.isArray(metadata.files) ? normalizePaths(this.workspace.workspaceRoot, metadata.files) : [];
        const allowedDirs = normalizeDirList(metadata.allowed_dirs ?? metadata.allowedDirs);
        if (allowedDirs.length) {
          const normalizedDirs = normalizePaths(this.workspace.workspaceRoot, allowedDirs);
          allowedFiles = Array.from(new Set([...allowedFiles, ...normalizedDirs]));
        }
        const fallbackCommand = detectScopedTestCommand(this.workspace.workspaceRoot, allowedFiles);
        if (fallbackCommand) {
          const fallback = sanitizeTestCommands([fallbackCommand], this.workspace.workspaceRoot);
          testCommands = fallback.commands;
          attemptedCommands.push(...fallback.commands);
        }
      }

      const hasRunnableTests = testCommands.length > 0 || Boolean(runAllTestsCommandHint);
      if (hasRunnableTests) continue;
      issues.push({
        taskKey: selected.task.key,
        testRequirements,
        attemptedCommands: dedupeCommands(attemptedCommands),
      });
    }

    return issues;
  }

  private async runTests(
    commands: string[],
    cwd: string,
    abortSignal?: AbortSignal,
  ): Promise<{ ok: boolean; results: { command: string; stdout: string; stderr: string; code: number }[] }> {
    const results: { command: string; stdout: string; stderr: string; code: number }[] = [];
    const chromiumPrep = await this.applyChromiumForTests(commands);
    if (!chromiumPrep.ok) {
      return {
        ok: false,
        results: [
          {
            command: commands[0] ?? "chromium-preflight",
            stdout: "",
            stderr: chromiumPrep.message ?? "Chromium preflight failed.",
            code: 1,
          },
        ],
      };
    }
    for (const command of chromiumPrep.commands) {
      try {
        if (abortSignal?.aborted) {
          throw new Error("work_on_tasks_aborted");
        }
        const { stdout, stderr } = await exec(command, {
          cwd,
          signal: abortSignal,
          env: chromiumPrep.env,
        });
        results.push({ command, stdout, stderr, code: 0 });
      } catch (error: any) {
        results.push({
          command,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? String(error),
          code: typeof error.code === "number" ? error.code : 1,
        });
        return { ok: false, results };
      }
    }
    return { ok: true, results };
  }

  async workOnTasks(request: WorkOnTasksRequest): Promise<WorkOnTasksResult> {
    await this.ensureMcoda();
    const commandName = "work-on-tasks";
    const requestedAgentStream = request.agentStream ?? process.env.MCODA_STREAM_IO === "1";
    const normalizedWorkRunner = request.workRunner?.trim().toLowerCase();
    const requestedAdapterOverride = request.agentAdapterOverride?.trim();
    const normalizedAdapterOverride = requestedAdapterOverride?.toLowerCase();
    const codaliRequired =
      Boolean(request.useCodali) ||
      normalizedWorkRunner === "codali" ||
      normalizedWorkRunner === "codali-cli" ||
      normalizedAdapterOverride === "codali" ||
      normalizedAdapterOverride === "codali-cli";
    const resolvedWorkRunner = normalizedWorkRunner ?? (codaliRequired ? "codali" : undefined);
    const agentAdapterOverride = codaliRequired ? "codali-cli" : requestedAdapterOverride;
    const agentStream = requestedAgentStream;
    const patchModeEnabled = !codaliRequired && isPatchModeEnabled();
    const directEditsEnabled = !patchModeEnabled;
    const enforceCommentBacklog = isCommentBacklogEnforced();
    const commentBacklogMaxFails = resolveCommentBacklogMaxFails();
    const requestedMissingTestsPolicy = normalizeMissingTestsPolicy(request.missingTestsPolicy);
    const missingTestsPolicy: MissingTestsPolicy =
      requestedMissingTestsPolicy ?? (request.allowMissingTests ? "skip_task" : DEFAULT_MISSING_TESTS_POLICY);
    const baseCodaliEnvOverrides = codaliRequired ? buildCodaliEnvOverrides() : {};
    const configuredBaseBranch = this.workspace.config?.branch;
    const requestedBaseBranch = request.baseBranch;
    const resolvedBaseBranch = (requestedBaseBranch ?? configuredBaseBranch ?? DEFAULT_BASE_BRANCH).trim();
    const normalizedBaseBranch = resolvedBaseBranch === "dev" ? DEFAULT_BASE_BRANCH : resolvedBaseBranch;
    const baseBranch = DEFAULT_BASE_BRANCH;
    const configuredAutoMerge = this.workspace.config?.autoMerge;
    const configuredAutoPush = this.workspace.config?.autoPush;
    const autoMerge = request.autoMerge ?? configuredAutoMerge ?? true;
    const autoPush = request.autoPush ?? configuredAutoPush ?? true;
    const baseBranchWarnings: string[] = [];
    const statusWarnings: string[] = [];
    const runnerWarnings: string[] = [];
    if (request.missingTestsPolicy && !requestedMissingTestsPolicy) {
      runnerWarnings.push(
        `Unknown missing-tests policy "${String(request.missingTestsPolicy)}"; using "${missingTestsPolicy}".`,
      );
    }
    const ignoreStatusFilter = Boolean(request.taskKeys?.length) || request.ignoreStatusFilter === true;
    const { filtered: statusFilter, rejected } = ignoreStatusFilter
      ? { filtered: request.statusFilter ?? [], rejected: [] as string[] }
      : filterTaskStatuses(request.statusFilter, WORK_ALLOWED_STATUSES, WORK_ALLOWED_STATUSES);
    const includeTypes = request.includeTypes?.length ? request.includeTypes : undefined;
    let excludeTypes = request.excludeTypes;
    if (!excludeTypes && !includeTypes?.length && (!request.taskKeys || request.taskKeys.length === 0)) {
      excludeTypes = ["qa_followup"];
    }
    if (!ignoreStatusFilter && rejected.length > 0) {
      statusWarnings.push(
        `work-on-tasks ignores unsupported statuses: ${rejected.join(", ")}. Allowed: ${WORK_ALLOWED_STATUSES.join(
          ", ",
        )}.`,
      );
    }
    if (ignoreStatusFilter) {
      statusWarnings.push("work-on-tasks ignores status filters when explicit --task keys are provided.");
    }
    if (codaliRequired && requestedAgentStream) {
      runnerWarnings.push("work-on-tasks disables streaming when codali is required.");
    }
    if (codaliRequired && isPatchModeEnabled()) {
      runnerWarnings.push("work-on-tasks patch mode is ignored when codali is required.");
    }
    if (normalizedBaseBranch && normalizedBaseBranch !== DEFAULT_BASE_BRANCH) {
      baseBranchWarnings.push(
        `Base branch ${normalizedBaseBranch} ignored; work-on-tasks always uses ${DEFAULT_BASE_BRANCH}.`,
      );
    }
    const commandRun = await this.deps.jobService.startCommandRun(commandName, request.projectKey, {
      taskIds: request.taskKeys,
    });
    const job = await this.deps.jobService.startJob("work", commandRun.id, request.projectKey, {
      commandName,
      payload: {
        projectKey: request.projectKey,
        epicKey: request.epicKey,
        storyKey: request.storyKey,
        tasks: request.taskKeys,
        statusFilter: ignoreStatusFilter ? undefined : statusFilter,
        ignoreStatusFilter,
        includeTypes,
        excludeTypes,
        ignoreDependencies: true,
        limit: request.limit,
        parallel: request.parallel,
        noCommit: request.noCommit ?? false,
        dryRun: request.dryRun ?? false,
        agent: request.agentName,
        agentStream,
        missingTestsPolicy,
        allowMissingTests: request.allowMissingTests ?? false,
      },
    });

    const workspaceRoot = request.workspace.workspaceRoot;
    const repoRoot = workspaceRoot;
    const docdexBaseUrl =
      process.env.CODALI_DOCDEX_BASE_URL ??
      process.env.DOCDEX_HTTP_BASE_URL ??
      this.workspace.config?.docdexUrl ??
      process.env.MCODA_DOCDEX_URL ??
      process.env.DOCDEX_URL;
    const docdexRepoId =
      process.env.CODALI_DOCDEX_REPO_ID ??
      this.workspace.config?.docdexRepoId ??
      process.env.MCODA_DOCDEX_REPO_ID ??
      process.env.DOCDEX_REPO_ID;
    const docdexRepoRoot = process.env.CODALI_DOCDEX_REPO_ROOT ?? workspaceRoot;
    const baseInvocationMetadata: Record<string, unknown> = {
      command: commandName,
      workspaceRoot,
      repoRoot,
      docdexBaseUrl,
      docdexRepoId,
      docdexRepoRoot,
      projectKey: request.projectKey,
      jobId: job.id,
      commandRunId: commandRun.id,
    };

    let selection: TaskSelectionPlan;
    let storyPointsProcessed = 0;
    const abortSignal = request.abortSignal;
    const resolveAbortReason = () => {
      const reason = abortSignal?.reason;
      if (typeof reason === "string" && reason.trim().length > 0) return reason;
      if (reason instanceof Error && reason.message) return reason.message;
      return "work_on_tasks_aborted";
    };
    const abortIfSignaled = () => {
      if (abortSignal?.aborted) {
        throw new Error(resolveAbortReason());
      }
    };
    const withAbort = async <T>(promise: Promise<T>): Promise<T> => {
      if (!abortSignal) return promise;
      if (abortSignal.aborted) {
        throw new Error(resolveAbortReason());
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error(resolveAbortReason()));
        abortSignal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => {
          abortSignal.removeEventListener("abort", onAbort);
        });
      });
    };
    const isAbortError = (message: string): boolean => {
      if (!message) return false;
      if (message === "agent_timeout") return true;
      if (/abort/i.test(message)) return true;
      return message === resolveAbortReason();
    };
    try {
      await this.checkoutBaseBranch(baseBranch, { allowDirty: true });
      selection = await this.selectionService.selectTasks({
        projectKey: request.projectKey,
        epicKey: request.epicKey,
        storyKey: request.storyKey,
        taskKeys: request.taskKeys,
        statusFilter,
        ignoreStatusFilter,
        includeTypes,
        excludeTypes,
        ignoreDependencies: true,
        limit: request.limit,
        parallel: request.parallel,
      });

      await this.checkpoint(job.id, "selection", {
        ordered: selection.ordered.map((t) => t.task.key),
      });

      await this.deps.jobService.updateJobStatus(job.id, "running", {
        payload: {
          ...(job.payload ?? {}),
          selection: selection.ordered.map((t) => t.task.key),
        },
        totalItems: selection.ordered.length,
        processedItems: 0,
      });

      type WorkOnTasksTaskSummary = {
        taskKey: string;
        adapter: string;
        adapterOverride?: string;
        provider: string;
        model: string;
        sourceAdapter?: string;
        codali?: {
          logPath?: string;
          touchedFiles?: string[];
          runId?: string;
        };
      };
      const results: TaskExecutionResult[] = [];
      const taskSummaries = new Map<string, WorkOnTasksTaskSummary>();
      const warnings: string[] = [...baseBranchWarnings, ...statusWarnings, ...runnerWarnings, ...selection.warnings];
      try {
        const guidance = await ensureProjectGuidance(this.workspace.workspaceRoot, {
          mcodaDir: this.workspace.mcodaDir,
        });
        if (guidance.status !== "existing") {
          warnings.push(`project_guidance_${guidance.status}: ${guidance.path}`);
        }
      } catch (error) {
        warnings.push(
          `project_guidance_bootstrap_failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (missingTestsPolicy === "block_job") {
        const missingHarnessTasks = await this.findMissingTestHarnessTasks(selection.ordered);
        if (missingHarnessTasks.length > 0) {
          const taskKeys = missingHarnessTasks.map((issue) => issue.taskKey);
          await this.checkpoint(job.id, "tests_preflight_blocked", {
            reason: "missing_test_harness",
            policy: missingTestsPolicy,
            taskKeys,
            issues: missingHarnessTasks.map((issue) => ({
              taskKey: issue.taskKey,
              testRequirements: issue.testRequirements,
              attemptedCommands: issue.attemptedCommands,
            })),
          });
          throw new Error(
            `missing_test_harness: selected tasks require tests but no runnable test harness was found (${taskKeys.join(
              ", ",
            )}). Configure metadata.tests/testCommands or add tests/all.js.`,
          );
        }
      }
      const gatewayHandoffPath = codaliRequired ? process.env[GATEWAY_HANDOFF_ENV_PATH] : undefined;
      let gatewayHandoff: GatewayHandoffSummary | null = null;
      if (gatewayHandoffPath) {
        try {
          gatewayHandoff = await readGatewayHandoffFile(gatewayHandoffPath);
        } catch (error) {
          warnings.push(
            `gateway_handoff_unavailable: ${gatewayHandoffPath} (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      const gatewayPreferredFiles = buildGatewayPreferredFiles(gatewayHandoff);
      const gatewayPlanHint = buildGatewayPlanHint(gatewayHandoff);
      const skipDocContext = codaliRequired && Boolean(gatewayHandoff);
      const agent = await this.resolveAgent(request.agentName);
      let codaliProviderInfo: { provider: string; sourceAdapter?: string; requiresApiKey: boolean } | null = null;
      if (codaliRequired) {
        const config = agent.config as Record<string, unknown> | undefined;
        const explicitProvider =
          (typeof config?.provider === "string" ? config.provider : undefined) ??
          (typeof config?.llmProvider === "string" ? config.llmProvider : undefined);
        try {
          codaliProviderInfo = resolveCodaliProviderFromAdapter({
            sourceAdapter: agent.adapter ?? undefined,
            explicitProvider,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`codali_provider_unsupported: ${message}`);
        }
        const health = cliHealthy();
        if (!health.ok) {
          const detail = (health.details?.error as string | undefined) ?? "codali CLI unavailable";
          throw new Error(
            `codali_unavailable: codali CLI unavailable (${detail}). Set CODALI_BIN or install codali.`,
          );
        }
      }
      const prompts = await this.loadPrompts(agent.id);
      const formatSessionId = (iso: string): string => {
        const date = new Date(iso);
        const pad = (value: number) => String(value).padStart(2, "0");
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(
          date.getMinutes(),
        )}${pad(date.getSeconds())}`;
      };
      const formatDuration = (ms: number): string => {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const seconds = totalSeconds % 60;
        const minutesTotal = Math.floor(totalSeconds / 60);
        const minutes = minutesTotal % 60;
        const hours = Math.floor(minutesTotal / 60);
        if (hours > 0) return `${hours}H ${minutes}M ${seconds}S`;
        return `${minutes}M ${seconds}S`;
      };
      const formatCount = (value: number): string => value.toLocaleString("en-US");
      const emitLine = (line: string): void => {
        if (request.onAgentChunk) {
          request.onAgentChunk(`${line}\n`);
          return;
        }
        console.info(line);
      };
      const emitBlank = (): void => emitLine("");
      const resolveProvider = (adapter?: string): string => {
        if (!adapter) return "n/a";
        const trimmed = adapter.trim();
        if (!trimmed) return "n/a";
        if (trimmed.includes("-")) return trimmed.split("-")[0];
        return trimmed;
      };
      const resolveReasoning = (config?: Record<string, unknown>): string => {
        if (!config) return "n/a";
        const raw = (config as Record<string, unknown>).reasoning ?? (config as Record<string, unknown>).thinking;
        if (typeof raw === "string") return raw;
        if (typeof raw === "boolean") return raw ? "enabled" : "disabled";
        return "n/a";
      };
      const emitTaskStart = (details: {
        taskKey: string;
        alias: string;
        summary: string;
        model: string;
        provider: string;
        step: string;
        reasoning: string;
        workdir: string;
        sessionId: string;
        startedAt: string;
      }): void => {
        emitLine("╭──────────────────────────────────────────────────────────╮");
        emitLine("│                  START OF WORK TASK                      │");
        emitLine("╰──────────────────────────────────────────────────────────╯");
        emitLine(`  [🪪] Start Task ID:  ${details.taskKey}`);
        emitLine(`  [👹] Alias:          ${details.alias}`);
        emitLine(`  [ℹ️] Summary:        ${details.summary}`);
        emitLine(`  [🤖] Model:          ${details.model}`);
        emitLine(`  [🕹️] Provider:       ${details.provider}`);
        emitLine(`  [🧩] Step:           ${details.step}`);
        emitLine(`  [🧠] Reasoning:      ${details.reasoning}`);
        emitLine(`  [📁] Workdir:        ${details.workdir}`);
        emitLine(`  [🔑] Session:        ${details.sessionId}`);
        emitLine(`  [🕒] Started:        ${details.startedAt}`);
        emitBlank();
        emitLine("    ░░░░░ START OF WORK TASK ░░░░░");
        emitBlank();
        emitLine(`    [STEP ${details.step}]  [MODEL ${details.model}]`);
        emitBlank();
        emitBlank();
      };
      const emitTaskEnd = async (details: {
        taskKey: string;
        status: TaskExecutionResult["status"];
        terminal: string;
        storyPoints?: number | null;
        elapsedMs: number;
        tokensPrompt: number;
        tokensCompletion: number;
        promptEstimate: number;
        taskBranch?: string | null;
        baseBranch?: string | null;
        touchedFiles: number;
        mergeStatus: "merged" | "skipped" | "failed";
        mergeNote?: string | null;
        failureReason?: string | null;
        headSha?: string | null;
        startedAt: string;
        endedAt: string;
      }): Promise<void> => {
        const tokensTotal = details.tokensPrompt + details.tokensCompletion;
        const promptEstimate = Math.max(1, details.promptEstimate);
        const usagePercent = (tokensTotal / promptEstimate) * 100;
        const completion = details.status === "succeeded" ? 100 : 0;
        const completionBar = "💰".repeat(15);
        const statusLabel =
          details.status === "succeeded"
            ? READY_TO_CODE_REVIEW.toUpperCase()
            : details.status === "skipped"
              ? "SKIPPED"
              : "FAILED";
        const hasRemote = await this.vcs.hasRemote(this.workspace.workspaceRoot);
        const tracking = details.taskBranch ? (hasRemote ? `origin/${details.taskBranch}` : "n/a") : "n/a";
        const headSha = details.headSha ?? "n/a";
        const baseLabel = details.baseBranch ?? baseBranch;
        emitLine("╭──────────────────────────────────────────────────────────╮");
        emitLine("│                   END OF WORK TASK                       │");
        emitLine("╰──────────────────────────────────────────────────────────╯");
        emitLine(
          `  👏🏼 TASK ${details.taskKey} | 📜 STATUS ${statusLabel} | 🏠 TERMINAL ${details.terminal} | ⚡ SP ${
            details.storyPoints ?? 0
          } | ⌛ TIME ${formatDuration(details.elapsedMs)}`,
        );
        emitLine(`  [🕒] Started:        ${details.startedAt}`);
        emitLine(`  [🕒] Ended:          ${details.endedAt}`);
        emitBlank();
        emitLine(`  [${completionBar}] ${completion.toFixed(1)}% Complete`);
        emitLine(`  Tokens used:  ${formatCount(tokensTotal)}`);
        emitLine(`  ${usagePercent.toFixed(1)}% used vs prompt est (x${(tokensTotal / promptEstimate).toFixed(2)})`);
        emitLine(`  Est. tokens:   ${formatCount(promptEstimate)}`);
        emitBlank();
        emitLine("🌿 Git summary");
        emitLine("────────────────────────────────────────────────────────────");
        emitLine(`  [🎋] Task branch: ${details.taskBranch ?? "n/a"}`);
        emitLine(`  [🗿] Tracking:    ${tracking}`);
        const mergeDetail = details.mergeNote ? ` (${details.mergeNote})` : "";
        emitLine(`  [🚀] Merge→${baseLabel}:   ${details.mergeStatus}${mergeDetail}`);
        emitLine(`  [🐲] HEAD:        ${headSha}`);
        emitLine(`  [♨️] Files:       ${details.touchedFiles}`);
        emitLine(`  [🔑] Base:        ${baseLabel}`);
        emitLine("  [🧾] Git log:    n/a");
        emitBlank();
        if (details.failureReason) {
          emitLine(`  [⚠️] Failure:     ${details.failureReason}`);
          emitBlank();
        }
        emitLine("🗂 Artifacts");
        emitLine("────────────────────────────────────────────────────────────");
        emitLine("  • History:    n/a");
        emitLine("  • Git log:    n/a");
        emitBlank();
        emitLine("    ░░░░░ END OF WORK TASK ░░░░░");
        emitBlank();
      };

      let abortRemainingReason: string | null = null;
      taskLoop: for (const [index, task] of selection.ordered.entries()) {
        if (abortRemainingReason) break taskLoop;
        abortIfSignaled();
        const startedAt = new Date().toISOString();
        const taskRun = await this.deps.workspaceRepo.createTaskRun({
          taskId: task.task.id,
          command: "work-on-tasks",
          jobId: job.id,
          commandRunId: commandRun.id,
          agentId: agent.id,
          status: "running",
          startedAt,
          storyPointsAtRun: task.task.storyPoints ?? null,
          gitBranch: task.task.vcsBranch ?? null,
          gitBaseBranch: task.task.vcsBaseBranch ?? null,
          gitCommitSha: task.task.vcsLastCommitSha ?? null,
        });

        const statusContext = {
          commandName: "work-on-tasks",
          jobId: job.id,
          taskRunId: taskRun.id,
          agentId: agent.id,
          metadata: { lane: "work" },
        };

        const sessionId = formatSessionId(startedAt);
        const initialStatus = (task.task.status ?? "").toLowerCase().trim();
        const taskAlias = `Working on task ${task.task.key}`;
        const taskSummary = task.task.title || task.task.description || "(none)";
        const adapterLabel = agent.adapter ?? "n/a";
        const modelLabel = agent.defaultModel ?? "(default)";
        const providerLabel =
          codaliRequired && codaliProviderInfo ? codaliProviderInfo.provider : resolveProvider(adapterLabel);
        const reasoningLabel = resolveReasoning(agent.config as Record<string, unknown> | undefined);
        const stepLabel = directEditsEnabled ? "direct" : "patch";
        await this.logTask(taskRun.id, "Adapter context", "agent", {
          adapter: adapterLabel,
          adapterOverride: agentAdapterOverride,
          provider: providerLabel,
          model: modelLabel,
          sourceAdapter: codaliProviderInfo?.sourceAdapter ?? adapterLabel,
        });
        taskSummaries.set(task.task.key, {
          taskKey: task.task.key,
          adapter: adapterLabel,
          adapterOverride: agentAdapterOverride,
          provider: providerLabel,
          model: modelLabel,
          sourceAdapter: codaliProviderInfo?.sourceAdapter ?? adapterLabel,
        });
        const taskStartMs = Date.now();
        let taskStatus: TaskExecutionResult["status"] | null = null;
        let tokensPromptTotal = 0;
        let tokensCompletionTotal = 0;
        let promptEstimateBase = 0;
        let promptEstimateTotal = 0;
        let mergeStatus: "merged" | "skipped" | "failed" = "skipped";
        let mergeNote: string | null = null;
        let failureReason: string | null = null;
        let patchApplied = false;
        let runAllScriptCreated = false;
        let allowedFiles: string[] = [];
        let touched: string[] = [];
        let hasChanges = false;
        let codaliRunMeta: { logPath?: string; touchedFiles?: string[]; runId?: string } | null = null;
        let dirtyBeforeAgent: string[] = [];
        let unresolvedComments: TaskCommentRow[] = [];
        let commentBacklogFailures = 0;
        let commentBacklogEnforced = enforceCommentBacklog;
        let commentContext: { comments: TaskCommentRow[]; unresolved: TaskCommentRow[] } | null = null;
        let workLog: TaskCommentRow[] = [];
        let commentResolution:
          | { resolvedSlugs?: string[]; unresolvedSlugs?: string[]; commentBacklogStatus?: string }
          | null = null;
        let commentResolutionApplied = false;
        let commentProgressLogged = false;
        let taskBranchName: string | null = task.task.vcsBranch ?? null;
        let baseBranchName: string | null = task.task.vcsBaseBranch ?? baseBranch;
        let branchInfo: { branch: string; base: string; mergeConflicts?: string[]; remoteSyncNote?: string } | null = {
          branch: task.task.vcsBranch ?? "",
          base: task.task.vcsBaseBranch ?? baseBranch,
        };
        let headSha: string | null = task.task.vcsLastCommitSha ?? null;
        let taskEndEmitted = false;
        let vcsFinalized = false;
        let runVcsPhase:
          | ((options: { allowResultUpdate: boolean; reason: string }) => Promise<{ halt: boolean }>)
          | null = null;
        const setFailureReason = (reason: string | undefined | null): void => {
          if (!failureReason && reason) failureReason = reason;
        };
        const setMergeNote = (note: string | undefined | null): void => {
          if (!mergeNote && note) mergeNote = note;
        };
        const addCommentProgress = async (params: {
          openSlugs: string[];
          resolvedSlugs: string[];
          unresolvedSlugs: string[];
          status: string;
          touchedFiles: string[];
          hasChanges: boolean;
        }): Promise<void> => {
          if (commentProgressLogged) return;
          commentProgressLogged = true;
          const messageLines = [
            "[work-on-tasks]",
            "Comment backlog follow-up (priority applied).",
            `Open slugs: ${formatSlugList(params.openSlugs)}`,
            `Resolved slugs (reported): ${formatSlugList(params.resolvedSlugs)}`,
            `Unresolved slugs (reported): ${formatSlugList(params.unresolvedSlugs)}`,
            `Comment backlog status: ${params.status || "missing"}`,
            `Repo changes: ${params.hasChanges ? "yes" : "no"}`,
            `Touched files: ${
              params.touchedFiles.length ? params.touchedFiles.join(", ") : "(none)"
            }`,
          ];
          const body = messageLines.join("\n");
          const slug = createTaskCommentSlug({
            source: "work-on-tasks",
            message: "comment_progress",
            category: "comment_progress",
          });
          await this.deps.workspaceRepo.createTaskComment({
            taskId: task.task.id,
            taskRunId: taskRun.id,
            jobId: job.id,
            sourceCommand: "work-on-tasks",
            authorType: "agent",
            authorAgentId: agent.id,
            category: "comment_progress",
            slug,
            status: "open",
            body,
            createdAt: new Date().toISOString(),
            metadata: {
              openSlugs: params.openSlugs,
              resolvedSlugs: params.resolvedSlugs,
              unresolvedSlugs: params.unresolvedSlugs,
              commentBacklogStatus: params.status || "missing",
              hasChanges: params.hasChanges,
              touchedFiles: params.touchedFiles,
            },
          });
        };
        const applyCommentResolutionIfNeeded = async (): Promise<{
          resolved: string[];
          reopened: string[];
          open: string[];
        } | null> => {
          if (commentResolutionApplied) return null;
          if (!commentResolution?.resolvedSlugs?.length && !commentResolution?.unresolvedSlugs?.length) {
            return null;
          }
          const context = commentContext ?? (await this.loadCommentContext(task.task.id));
          commentContext = context;
          const applied = await this.applyCommentResolutions({
            taskId: task.task.id,
            taskRunId: taskRun.id,
            jobId: job.id,
            agentId: agent.id,
            resolvedSlugs: commentResolution.resolvedSlugs ?? null,
            unresolvedSlugs: commentResolution.unresolvedSlugs ?? null,
            existingComments: context.comments,
            dryRun: Boolean(request.dryRun),
          });
          commentResolutionApplied = true;
          await this.logTask(
            taskRun.id,
            `Applied comment resolution: resolved=${applied.resolved.length}, reopened=${applied.reopened.length}, open=${applied.open.length}`,
            "comment_resolution",
          );
          return applied;
        };

        emitTaskStart({
          taskKey: task.task.key,
          alias: taskAlias,
          summary: taskSummary,
          model: modelLabel,
          provider: providerLabel,
          step: stepLabel,
          reasoning: reasoningLabel,
          workdir: this.workspace.workspaceRoot,
          sessionId,
          startedAt,
        });

        const emitTaskEndOnce = async () => {
          if (taskEndEmitted) return;
          taskEndEmitted = true;
          const status = taskStatus ?? "failed";
          const terminal =
            status === "succeeded"
              ? touched.length
                ? "READY_TO_CODE_REVIEW_WITH_CHANGES"
                : "READY_TO_CODE_REVIEW_NO_CHANGES"
              : status === "skipped"
                ? "SKIPPED"
                : "FAILED";
          let resolvedHead = headSha;
          if (!resolvedHead) {
            try {
              resolvedHead = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
            } catch {
              resolvedHead = null;
            }
          }
          await emitTaskEnd({
            taskKey: task.task.key,
            status,
            terminal,
            storyPoints: task.task.storyPoints ?? 0,
            elapsedMs: Date.now() - taskStartMs,
            tokensPrompt: tokensPromptTotal,
            tokensCompletion: tokensCompletionTotal,
            promptEstimate: promptEstimateTotal || promptEstimateBase,
            taskBranch: taskBranchName || null,
            baseBranch: baseBranchName || baseBranch,
            touchedFiles: touched.length,
            mergeStatus,
            mergeNote,
            failureReason: status === "succeeded" ? null : failureReason,
            headSha: resolvedHead,
            startedAt,
            endedAt: new Date().toISOString(),
          });
        };

        try {
        const phaseTimers: Partial<Record<TaskPhase, number>> = {};
        const startPhase = async (phase: TaskPhase, details?: Record<string, unknown>) => {
          phaseTimers[phase] = Date.now();
          await this.updateTaskPhase(job.id, taskRun.id, task.task.key, phase, "start", details);
        };
        const endPhase = async (phase: TaskPhase, details?: Record<string, unknown>) => {
          const started = phaseTimers[phase];
          const durationSeconds = started ? Math.round(((Date.now() - started) / 1000) * 1000) / 1000 : undefined;
          await this.updateTaskPhase(job.id, taskRun.id, task.task.key, phase, "end", {
            ...(details ?? {}),
            durationSeconds,
          });
        };

        try {
          abortIfSignaled();
          await startPhase("selection", {
            dependencies: task.dependencies.keys,
          });
          await this.logTask(taskRun.id, `Selected task ${task.task.key}`, "selection", {
            dependencies: task.dependencies.keys,
          });

          await endPhase("selection");
        } catch (error) {
          const message = `Selection phase failed: ${(error as Error).message}`;
          try {
            await this.logTask(taskRun.id, message, "selection");
          } catch {
            /* ignore log failures */
          }
          await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
            status: "failed",
            finishedAt: new Date().toISOString(),
          });
          setFailureReason(message);
          results.push({ taskKey: task.task.key, status: "failed", notes: message });
          taskStatus = "failed";
          await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
          await emitTaskEndOnce();
          continue taskLoop;
        }
        const lockTtlSeconds = resolveLockTtlSeconds(request.maxAgentSeconds);
        let lockAcquired = false;
        if (!request.dryRun) {
          const lockResult = await this.deps.workspaceRepo.tryAcquireTaskLock(task.task.id, taskRun.id, job.id, lockTtlSeconds);
          if (!lockResult.acquired) {
            await this.logTask(taskRun.id, "Task already locked by another run; skipping.", "vcs", {
              lock: lockResult.lock ?? null,
            });
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
              status: "cancelled",
              finishedAt: new Date().toISOString(),
            });
            results.push({ taskKey: task.task.key, status: "skipped", notes: "task_locked" });
            taskStatus = "skipped";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            await emitTaskEndOnce();
            continue taskLoop;
          }
          lockAcquired = true;
        }

        try {
          abortIfSignaled();
          const metadata = (task.task.metadata as any) ?? {};
          allowedFiles = Array.isArray(metadata.files) ? normalizePaths(this.workspace.workspaceRoot, metadata.files) : [];
          const allowedDirs = normalizeDirList(metadata.allowed_dirs ?? metadata.allowedDirs);
          if (allowedDirs.length) {
            const normalizedDirs = normalizePaths(this.workspace.workspaceRoot, allowedDirs);
            allowedFiles = Array.from(new Set([...allowedFiles, ...normalizedDirs]));
          }
          const testRequirements = normalizeTestRequirements(metadata.test_requirements ?? metadata.testRequirements);
          const testRequirementsNote = formatTestRequirementsNote(testRequirements);
          const qaReadinessNote = formatQaReadinessNote(metadata.qa);
          const testsRequired = hasTestRequirements(testRequirements);
          let testCommands = normalizeTestCommands(metadata.tests ?? metadata.testCommands);
          const allowDocEdits =
            metadata.allow_doc_edits === true ||
            metadata.allowDocEdits === true ||
            metadata.allow_doc_edits === "true" ||
            metadata.allowDocEdits === "true";
          const allowLargeDocEdits =
            allowDocEdits ||
            metadata.allow_large_doc_edits === true ||
            metadata.allowLargeDocEdits === true ||
            metadata.allow_large_doc_edits === "true" ||
            metadata.allowLargeDocEdits === "true";
          const sanitized = sanitizeTestCommands(testCommands, this.workspace.workspaceRoot);
          testCommands = sanitized.commands;
          if (sanitized.skipped.length) {
            await this.logTask(
              taskRun.id,
              `Skipped test commands: ${sanitized.skipped.join("; ")}`,
              "tests",
            );
          }
          if (!testCommands.length && testsRequired) {
            const commandBuilder = new QaTestCommandBuilder(this.workspace.workspaceRoot);
            const commandPlan = await commandBuilder.build({ task: task.task });
            if (commandPlan.commands.length) {
              const built = sanitizeTestCommands(commandPlan.commands, this.workspace.workspaceRoot);
              testCommands = built.commands;
              if (built.skipped.length) {
                await this.logTask(
                  taskRun.id,
                  `Skipped test commands: ${built.skipped.join("; ")}`,
                  "tests",
                );
              }
            }
          }
          if (!testCommands.length && testsRequired) {
            const fallbackCommand = detectScopedTestCommand(this.workspace.workspaceRoot, allowedFiles);
            if (fallbackCommand) testCommands = [fallbackCommand];
          }
          let runAllTestsCommandHint = testsRequired ? detectRunAllTestsCommand(this.workspace.workspaceRoot) : undefined;
          let runAllTestsScriptPath = testsRequired ? detectRunAllTestsScript(this.workspace.workspaceRoot) : undefined;
          if (!runAllTestsCommandHint && !request.dryRun && testsRequired && testCommands.length > 0) {
            try {
              runAllScriptCreated = await ensureRunAllTestsScript(
                this.workspace.workspaceRoot,
                testRequirements,
                testCommands,
              );
              if (runAllScriptCreated) {
                runAllTestsCommandHint = detectRunAllTestsCommand(this.workspace.workspaceRoot);
                runAllTestsScriptPath = detectRunAllTestsScript(this.workspace.workspaceRoot);
                await this.logTask(
                  taskRun.id,
                  `Created run-all tests script (${runAllTestsScriptPath ?? "tests/all.js"}).`,
                  "tests",
                );
              }
            } catch (error) {
              await this.logTask(
                taskRun.id,
                `Failed to create run-all tests script: ${error instanceof Error ? error.message : String(error)}`,
                "tests",
              );
            }
          }
          if (testsRequired && runAllScriptCreated && runAllTestsScriptPath) {
            const normalizedScript = runAllTestsScriptPath.replace(/\\/g, "/");
            if (allowedFiles.length && !allowedFiles.includes(normalizedScript)) {
              allowedFiles = [...allowedFiles, normalizedScript];
            }
          }
          if (!testCommands.length && testsRequired && runAllTestsCommandHint) {
            testCommands = [runAllTestsCommandHint];
          }
          const runAllTestsNote =
            testsRequired && !request.dryRun
              ? runAllTestsCommandHint
                ? `Run-all tests command: ${runAllTestsCommandHint}`
                : "Run-all tests script missing (tests/all.js | tests/all.sh | tests/all.ps1). Create it or configure test commands."
              : "";
          const hasRunnableTests = testCommands.length > 0 || Boolean(runAllTestsCommandHint);
          if (testsRequired && !hasRunnableTests) {
            if (missingTestsPolicy === "skip_task") {
              await this.logTask(
                taskRun.id,
                "Tests required but no runnable test commands were found; skipping task due to missing-tests policy.",
                "tests",
                { testRequirements, missingTestsPolicy },
              );
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                status: "cancelled",
                finishedAt: new Date().toISOString(),
              });
              results.push({ taskKey: task.task.key, status: "skipped", notes: "missing_test_harness" });
              taskStatus = "skipped";
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              await emitTaskEndOnce();
              continue taskLoop;
            }
            if (missingTestsPolicy === "block_job") {
              await this.logTask(
                taskRun.id,
                "Tests required but no runnable test commands were found; stopping job due to missing-tests policy.",
                "tests",
                { testRequirements, missingTestsPolicy },
              );
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                status: "cancelled",
                finishedAt: new Date().toISOString(),
              });
              taskStatus = "skipped";
              await emitTaskEndOnce();
              throw new Error(
                `missing_test_harness: ${task.task.key} requires tests but no runnable test commands were found`,
              );
            }
            await this.logTask(
              taskRun.id,
              "Tests required but no runnable test commands were found; failing task.",
              "tests",
              { testRequirements, missingTestsPolicy },
            );
            await this.stateService.markFailed(task.task, "tests_not_configured", statusContext);
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
              status: "failed",
              finishedAt: new Date().toISOString(),
            });
            setFailureReason("tests_not_configured");
            results.push({ taskKey: task.task.key, status: "failed", notes: "tests_not_configured" });
            taskStatus = "failed";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            await emitTaskEndOnce();
            continue taskLoop;
          }
          const shouldRunTests = !request.dryRun && (testsRequired ? hasRunnableTests : testCommands.length > 0);
          let mergeConflicts: string[] = [];
          let remoteSyncNote = "";
          let testAttemptCount = 0;
          let lastLockRefresh = Date.now();
          const getLockRefreshIntervalMs = () => {
            const ttlMs = lockTtlSeconds * 1000;
            return Math.max(250, Math.min(ttlMs - 250, Math.floor(ttlMs / 3)));
          };
          const refreshLock = async (label: string, force = false): Promise<boolean> => {
            if (!lockAcquired) return true;
            const now = Date.now();
            if (!force && now - lastLockRefresh < getLockRefreshIntervalMs()) return true;
            try {
              const refreshed = await this.deps.workspaceRepo.refreshTaskLock(task.task.id, taskRun.id, lockTtlSeconds);
              if (!refreshed) {
                await this.logTask(taskRun.id, `Task lock lost during ${label}; another run may have taken it.`, "vcs", {
                  reason: "lock_stolen",
                });
              }
              if (refreshed) {
                lastLockRefresh = now;
              }
              return refreshed;
            } catch (error) {
              await this.logTask(taskRun.id, `Failed to refresh task lock (${label}); treating as lock loss.`, "vcs", {
                error: (error as Error).message,
                reason: "refresh_failed",
              });
              return false;
            }
            return true;
          };

          runVcsPhase = async ({ allowResultUpdate, reason }) => {
            if (vcsFinalized) return { halt: false };
            vcsFinalized = true;
            const hasResult = results.some((result) => result.taskKey === task.task.key);
            const recordFailureResult = async (notes: string) => {
              if (!allowResultUpdate || hasResult) return;
              results.push({ taskKey: task.task.key, status: "failed", notes });
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            };
            let haltAfterPush = false;
            if (request.dryRun) {
              mergeStatus = "skipped";
              setMergeNote("dry_run");
              await this.logTask(taskRun.id, "Dry-run: skipped commit/merge.", "vcs");
              return { halt: false };
            }
            if (request.noCommit) {
              mergeStatus = "skipped";
              setMergeNote("no_commit");
              await this.logTask(taskRun.id, "no-commit set: skipped commit/merge.", "vcs");
              return { halt: false };
            }
            if (!branchInfo?.branch || !branchInfo?.base) {
              mergeStatus = "skipped";
              setMergeNote("no_task_branch");
              await this.logTask(taskRun.id, "No task branch available; skipped commit/merge.", "vcs");
              return { halt: false };
            }
            if (!(await refreshLock("vcs_start", true))) {
              await this.logTask(taskRun.id, "Aborting task: lock lost before VCS phase.", "vcs");
              await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "vcs", "error", { error: "task_lock_lost" });
              await this.stateService.markFailed(task.task, "task_lock_lost", statusContext);
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                status: "failed",
                finishedAt: new Date().toISOString(),
              });
              setFailureReason("task_lock_lost");
              taskStatus = "failed";
              await recordFailureResult("task_lock_lost");
              return { halt: true };
            }
            await startPhase("vcs", { branch: branchInfo.branch, base: branchInfo.base, reason });
            try {
              const restrictAutoMergeWithoutScope = Boolean(this.workspace.config?.restrictAutoMergeWithoutScope);
              if (!autoMerge || (restrictAutoMergeWithoutScope && allowedFiles.length === 0)) {
                const mergeReason = !autoMerge ? "auto_merge_disabled" : "no_file_scope";
                setMergeNote(`${mergeReason}_forced`);
                await this.logTask(
                  taskRun.id,
                  `Auto-merge setting ignored (${mergeReason}); merge is required for task branches.`,
                  "vcs",
                  { reason: mergeReason },
                );
              }

              const dirty = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter((p) => !p.startsWith(".mcoda"));
              const toStage = dirty.length ? dirty : touched.length ? touched : ["."];
              await this.vcs.stage(this.workspace.workspaceRoot, toStage);
              const status = await this.vcs.status(this.workspace.workspaceRoot);
              const hasChanges = status.trim().length > 0;
              if (hasChanges) {
                const commitMessage = `[${task.task.key}] ${task.task.title}`;
                const commitEnv = this.buildCommitEnv(agent.id);
                let committed = false;
                try {
                  await this.vcs.commit(this.workspace.workspaceRoot, commitMessage, { env: commitEnv });
                  committed = true;
                } catch (error) {
                  const errorText = this.formatGitError(error);
                  const hookFailure = this.isCommitHookFailure(errorText);
                  const gpgFailure = this.isGpgSignFailure(errorText);
                  if (hookFailure || gpgFailure) {
                    const guidance = [
                      hookFailure
                        ? "Commit hook failed; run hooks manually or configure bypass (e.g., HUSKY=0) if policy allows."
                        : "",
                      gpgFailure
                        ? "GPG signing failed; configure signing key or disable commit.gpgsign for this repo."
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    await this.logTask(taskRun.id, `Commit failed; retrying with bypass flags. ${guidance}`, "vcs", {
                      error: errorText,
                    });
                    try {
                      await this.vcs.commit(this.workspace.workspaceRoot, commitMessage, {
                        noVerify: hookFailure,
                        noGpgSign: gpgFailure,
                        env: commitEnv,
                      });
                      committed = true;
                      await this.logTask(taskRun.id, "Commit succeeded after bypassing hook/signing checks.", "vcs");
                    } catch (retryError) {
                      const retryText = this.formatGitError(retryError);
                      throw new Error(`Commit failed after retry: ${retryText}`);
                    }
                  } else {
                    throw error;
                  }
                }
                if (committed) {
                  const head = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
                  await this.deps.workspaceRepo.updateTask(task.task.id, { vcsLastCommitSha: head });
                  await this.logTask(taskRun.id, `Committed changes (${head})`, "vcs");
                  headSha = head;
                }
              } else {
                await this.logTask(taskRun.id, "No changes to commit.", "vcs");
              }

              try {
                await this.vcs.merge(this.workspace.workspaceRoot, branchInfo.branch, branchInfo.base);
                mergeStatus = "merged";
                try {
                  headSha = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
                } catch {
                  // Best-effort head capture.
                }
                await this.logTask(taskRun.id, `Merged ${branchInfo.branch} into ${branchInfo.base}`, "vcs");
                if (!(await refreshLock("vcs_merge"))) {
                  await this.logTask(taskRun.id, "Aborting task: lock lost after merge.", "vcs");
                  await this.stateService.markFailed(task.task, "task_lock_lost", statusContext);
                  await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                    status: "failed",
                    finishedAt: new Date().toISOString(),
                  });
                  setFailureReason("task_lock_lost");
                  taskStatus = "failed";
                  await recordFailureResult("task_lock_lost");
                  return { halt: true };
                }
              } catch (error) {
                mergeStatus = "failed";
                const conflicts = await this.vcs.conflictPaths(this.workspace.workspaceRoot);
                if (conflicts.length) {
                  await this.logTask(
                    taskRun.id,
                    `Merge conflicts while merging ${branchInfo.branch} into ${branchInfo.base}; auto-resolving by taking ${branchInfo.branch}.`,
                    "vcs",
                    {
                      conflicts,
                    },
                  );
                  try {
                    await this.vcs.resolveMergeConflicts(this.workspace.workspaceRoot, "theirs", conflicts);
                    mergeStatus = "merged";
                    try {
                      headSha = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
                    } catch {
                      // Best-effort head capture after conflict resolution.
                    }
                    await this.logTask(
                      taskRun.id,
                      `Resolved merge conflicts by taking ${branchInfo.branch} for ${conflicts.length} file(s).`,
                      "vcs",
                    );
                  } catch (resolveError) {
                    await this.logTask(taskRun.id, "Auto-resolve failed; aborting merge.", "vcs", {
                      error: this.formatGitError(resolveError),
                    });
                    await this.vcs.abortMerge(this.workspace.workspaceRoot);
                    await this.stateService.markFailed(task.task, "merge_conflict", statusContext);
                    await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                      status: "failed",
                      finishedAt: new Date().toISOString(),
                    });
                    setFailureReason("merge_conflict");
                    taskStatus = "failed";
                    await recordFailureResult("merge_conflict");
                    haltAfterPush = true;
                  }
                } else {
                  throw error;
                }
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (/task lock lost/i.test(message)) {
                return { halt: true };
              }
              await this.logTask(taskRun.id, `VCS commit/push failed: ${message}`, "vcs");
              await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "vcs", "error", { error: message });
              await this.stateService.markFailed(task.task, "vcs_failed", statusContext);
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
              setFailureReason("vcs_failed");
              mergeStatus = "failed";
              taskStatus = "failed";
              await recordFailureResult("vcs_failed");
              haltAfterPush = true;
            } finally {
              await endPhase("vcs", { branch: branchInfo.branch, base: branchInfo.base });
            }
            const hasRemote = await this.vcs.hasRemote(this.workspace.workspaceRoot);
            if (hasRemote) {
              if (!autoPush) {
                await this.logTask(
                  taskRun.id,
                  `Auto-push setting ignored; pushing ${branchInfo.branch} and ${branchInfo.base} to origin.`,
                  "vcs",
                  { reason: "auto_push_disabled" },
                );
              }
              const branchPush = await this.pushWithRecovery(taskRun.id, branchInfo.branch);
              if (branchPush.pushed) {
                await this.logTask(taskRun.id, "Pushed branch to remote origin", "vcs");
              } else if (branchPush.skipped) {
                await this.logTask(taskRun.id, "Skipped pushing branch to remote origin due to permissions/protection.", "vcs");
              }
              if (!(await refreshLock("vcs_push_branch"))) {
                await this.logTask(taskRun.id, "Aborting task: lock lost after pushing branch.", "vcs");
                await this.stateService.markFailed(task.task, "task_lock_lost", statusContext);
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                  status: "failed",
                  finishedAt: new Date().toISOString(),
                });
                setFailureReason("task_lock_lost");
                taskStatus = "failed";
                await recordFailureResult("task_lock_lost");
                return { halt: true };
              }
              const basePush = await this.pushWithRecovery(taskRun.id, branchInfo.base);
              if (basePush.pushed) {
                await this.logTask(taskRun.id, `Pushed base branch ${branchInfo.base} to remote origin`, "vcs");
              } else if (basePush.skipped) {
                await this.logTask(
                  taskRun.id,
                  `Skipped pushing base branch ${branchInfo.base} due to permissions/protection.`,
                  "vcs",
                );
              }
              if (!(await refreshLock("vcs_push_base"))) {
                await this.logTask(taskRun.id, "Aborting task: lock lost after pushing base branch.", "vcs");
                await this.stateService.markFailed(task.task, "task_lock_lost", statusContext);
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                  status: "failed",
                  finishedAt: new Date().toISOString(),
                });
                setFailureReason("task_lock_lost");
                taskStatus = "failed";
                await recordFailureResult("task_lock_lost");
                return { halt: true };
              }
            } else {
              await this.logTask(taskRun.id, "No remote configured; skipping push to origin.", "vcs");
            }
            return { halt: haltAfterPush };
          };

          if (!request.dryRun) {
            try {
              branchInfo = await this.ensureBranches(
                task.task.key,
                task.task.title ?? "(untitled)",
                task.task.id,
                baseBranch,
                taskRun.id,
                agent.id,
              );
              taskBranchName = branchInfo.branch || taskBranchName;
              baseBranchName = branchInfo.base || baseBranchName;
              mergeConflicts = branchInfo.mergeConflicts ?? [];
              remoteSyncNote = branchInfo.remoteSyncNote ?? "";
              await this.deps.workspaceRepo.updateTask(task.task.id, {
                vcsBranch: branchInfo.branch,
                vcsBaseBranch: branchInfo.base,
              });
              await this.logTask(taskRun.id, `Using branch ${branchInfo.branch} (base ${branchInfo.base})`, "vcs");
              if (mergeConflicts.length) {
                await this.logTask(taskRun.id, `Failing task due to merge conflicts: ${mergeConflicts.join(", ")}`, "vcs");
                await this.stateService.markFailed(task.task, "merge_conflict", statusContext);
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                  status: "failed",
                  finishedAt: new Date().toISOString(),
                });
                setFailureReason("merge_conflict");
                results.push({ taskKey: task.task.key, status: "failed", notes: "merge_conflict" });
                taskStatus = "failed";
                await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                await emitTaskEndOnce();
                continue taskLoop;
              }
            } catch (error) {
              const message = `Failed to prepare branches: ${(error as Error).message}`;
              await this.logTask(taskRun.id, message, "vcs");
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
              setFailureReason(message);
              results.push({ taskKey: task.task.key, status: "failed", notes: message });
              taskStatus = "failed";
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              continue taskLoop;
            }
          }

          await startPhase("context", {
            allowedFiles,
            tests: testCommands,
            testRequirements,
            skipDocdex: skipDocContext,
          });
          const docLinks = Array.isArray((metadata as any).doc_links) ? (metadata as any).doc_links : [];
          let docSummary = "";
          let docWarnings: string[] = [];
          let docdexUnavailable = false;
          if (skipDocContext) {
            docWarnings = ["Gateway handoff present; skipping docdex context gathering."];
          } else {
            const docContext = await this.gatherDocContext(request.projectKey, docLinks);
            docSummary = docContext.summary;
            docWarnings = docContext.warnings;
            docdexUnavailable = docContext.docdexUnavailable;
          }
          if (docWarnings.length) {
            warnings.push(...docWarnings);
            await this.logTask(taskRun.id, docWarnings.join("; "), "docdex");
          }
          if (docdexUnavailable) {
            const message = "Docdex unavailable; missing required context for this task.";
            await this.logTask(taskRun.id, message, "docdex", { warnings: docWarnings });
            await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "context", "error", {
              error: "missing_docdex",
            });
            await this.stateService.markFailed(task.task, "missing_docdex", statusContext);
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
              status: "failed",
              finishedAt: new Date().toISOString(),
            });
            setFailureReason("missing_docdex");
            results.push({ taskKey: task.task.key, status: "failed", notes: "missing_docdex" });
            taskStatus = "failed";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            await emitTaskEndOnce();
            continue taskLoop;
          }
          await endPhase("context", { docWarnings, docSummary: Boolean(docSummary) });

          const projectGuidance = await loadProjectGuidance(this.workspace.workspaceRoot, this.workspace.mcodaDir);
          if (projectGuidance) {
            await this.logTask(taskRun.id, `Loaded project guidance from ${projectGuidance.source}`, "project_guidance");
          }

          await startPhase("prompt", { docSummary: Boolean(docSummary), agent: agent.id });
          commentContext = await this.loadCommentContext(task.task.id);
          unresolvedComments = commentContext.unresolved;
          commentBacklogFailures = await this.countCommentBacklogFailures(task.task.id);
          commentBacklogEnforced =
            enforceCommentBacklog && commentBacklogFailures < commentBacklogMaxFails;
          const commentBacklog = this.buildCommentBacklog(unresolvedComments);
          workLog = await this.loadWorkLog(task.task.id);
          const workLogSummary = this.buildWorkLog(workLog);
          const promptBase = this.buildPrompt(
            task,
            docSummary,
            allowedFiles,
            commentBacklog,
            workLogSummary,
            commentBacklogEnforced,
          );
          const testCommandNote = testCommands.length ? `Test commands: ${testCommands.join(" && ")}` : "";
          const testExpectationNote = shouldRunTests
            ? testsRequired
              ? "Tests must pass before the task can be finalized. Run task-specific tests first, then run-all tests."
              : "Tests must pass before the task can be finalized."
            : "";
          const commentBacklogNote = commentBacklog
            ? commentBacklogEnforced
              ? "Comment backlog is highest priority. Resolve those items first and focus on them before other task work. If you cannot resolve a comment, explain why and leave the slug unresolved. Do not mark slugs resolved unless you made repo changes that address them. If you return JSON, include resolvedSlugs/unresolvedSlugs and set commentBacklogStatus (e.g., in_progress/resolved/blocked)."
              : "Comment backlog is provided. Address relevant items and report status. Avoid marking slugs resolved unless your changes address them. If you return JSON, include resolvedSlugs/unresolvedSlugs/commentBacklogStatus when possible."
            : "";
          if (commentBacklog && enforceCommentBacklog && !commentBacklogEnforced) {
            await this.logTask(
              taskRun.id,
              `Comment backlog enforcement disabled after ${commentBacklogFailures} failure(s) (max ${commentBacklogMaxFails}).`,
              "execution",
            );
          }
          const outputRequirementNote = [
            "Output requirements:",
            "- Prefer direct repo edits when tools are available. If direct edits are not possible, output a minimal patch/diff or patch_json response with no extra prose.",
            "- Do not commit changes; leave the working tree for mcoda to stage and commit.",
            "- Summarize what you changed and any test results.",
            allowDocEdits
              ? ""
              : `- Protected paths are read-only unless allow_doc_edits=true: ${formatDocGuardList()}. Do not edit these to shortcut the task; fix code instead and call out spec mismatches.`,
            commentBacklog
              ? commentBacklogEnforced
                ? "- If comment backlog is present, include a JSON object with resolvedSlugs/unresolvedSlugs/commentBacklogStatus."
                : "- If comment backlog is present, include resolvedSlugs/unresolvedSlugs/commentBacklogStatus when possible."
              : "",
            commentBacklogEnforced
              ? "- Do not mark comment slugs resolved without corresponding repo changes."
              : "- Avoid marking comment slugs resolved unless repo changes address them.",
            "- Do not create docs/qa/* reports unless explicitly required by the task.",
          ]
            .filter(Boolean)
            .join("\n");
          const promptExtras = [
            testRequirementsNote,
            testCommandNote,
            runAllTestsNote,
            testExpectationNote,
            qaReadinessNote,
            commentBacklogNote,
            outputRequirementNote,
          ]
            .filter(Boolean)
            .join("\n");
          const promptWithTests = promptExtras ? `${promptBase}\n${promptExtras}` : promptBase;
          const guidanceBlock = projectGuidance?.content ? `Project Guidance (read first):\n${projectGuidance.content}` : "";
          const notes = remoteSyncNote;
          const prompt = [notes, promptWithTests].filter(Boolean).join("\n\n");
          const commandPrompt = prompts.commandPrompt ?? "";
          const systemPrompt = [guidanceBlock, prompts.jobPrompt, prompts.characterPrompt, commandPrompt].filter(Boolean).join("\n\n");
          await this.logTask(taskRun.id, `System prompt:\n${systemPrompt || "(none)"}`, "prompt");
          await this.logTask(taskRun.id, `Task prompt:\n${prompt}`, "prompt");
          promptEstimateBase = estimateTokens(systemPrompt + prompt);
          await endPhase("prompt", { hasSystemPrompt: Boolean(systemPrompt) });

          if (request.dryRun) {
            await this.logTask(taskRun.id, "Dry-run enabled; skipping execution.", "execution");
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
              status: "cancelled",
              finishedAt: new Date().toISOString(),
            });
            results.push({ taskKey: task.task.key, status: "skipped", notes: "dry_run" });
            taskStatus = "skipped";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            continue taskLoop;
          }

          try {
            await this.stateService.transitionToInProgress(task.task, statusContext);
          } catch (error) {
            await this.logTask(taskRun.id, `Failed to move task to in_progress: ${(error as Error).message}`, "state");
          }

          const streamChunk = (text?: string) => {
            if (!text) return;
            if (request.onAgentChunk) {
              request.onAgentChunk(text);
              return;
            }
            if (agentStream) {
              process.stdout.write(text);
            }
          };
        const taskInvocationMetadata: Record<string, unknown> = {
          ...baseInvocationMetadata,
          taskId: task.task.id,
          taskKey: task.task.key,
          agentId: agent.id,
          agentSlug: agent.slug ?? agent.id,
          sourceAdapter: codaliProviderInfo?.sourceAdapter ?? adapterLabel,
        };
        if (codaliRequired) {
          const codaliPreferredFiles = mergeUnique([...gatewayPreferredFiles, ...allowedFiles]);
          const readOnlyPaths = allowDocEdits ? [] : [...DOC_GUARD_DIRS, ...DOC_GUARD_FILES];
          const taskCodaliEnvOverrides = {
            ...baseCodaliEnvOverrides,
            ...buildCodaliEnvOverrides({
              preferredFiles: codaliPreferredFiles,
              readOnlyPaths: readOnlyPaths.length ? readOnlyPaths : undefined,
              planHint: gatewayPlanHint,
              skipSearch: gatewayPreferredFiles.length > 0,
            }),
          };
          if (Object.keys(taskCodaliEnvOverrides).length > 0) {
            taskInvocationMetadata.codaliEnv = taskCodaliEnvOverrides;
          }
          if (gatewayPlanHint) {
            const planHintInjected = Boolean(taskCodaliEnvOverrides.CODALI_PLAN_HINT);
            const message = planHintInjected
              ? "Injected CODALI_PLAN_HINT from gateway handoff."
              : "Skipped CODALI_PLAN_HINT injection; env already set.";
            await this.logTask(taskRun.id, message, "codali", {
              handoffPath: gatewayHandoffPath ?? null,
              injected: planHintInjected,
            });
          }
        }

          const patchOnlyAgentSlug = (() => {
            const config = agent.config as Record<string, unknown> | undefined;
            const direct = typeof config?.patchOnlyAgent === "string" ? config.patchOnlyAgent : undefined;
            const legacy = typeof config?.patch_only_agent === "string" ? config.patch_only_agent : undefined;
            const candidate = (direct ?? legacy)?.trim();
            return candidate || undefined;
          })();
          let patchOnlyAgent: { id: string; defaultModel?: string } | null = null;
          const resolvePatchOnlyAgent = async (): Promise<{ id: string; defaultModel?: string } | null> => {
            if (!patchOnlyAgentSlug) return null;
            if (patchOnlyAgent) return patchOnlyAgent;
            try {
              const resolved = await this.routingService.resolveAgentForCommand({
                workspace: this.workspace,
                commandName: "work-on-tasks",
                overrideAgentSlug: patchOnlyAgentSlug,
                projectKey: selection.project?.key,
              });
              patchOnlyAgent = resolved.agent;
              return patchOnlyAgent;
            } catch (error) {
              await this.logTask(
                taskRun.id,
                `Patch-only agent override (${patchOnlyAgentSlug}) failed: ${error instanceof Error ? error.message : String(error)}`,
                "agent",
              );
              return null;
            }
          };

          const invokeAgentOnce = async (
            input: string,
            phaseLabel: string,
            agentOverride?: { id: string; defaultModel?: string },
          ) => {
            abortIfSignaled();
            const previousCwd = process.cwd();
            const targetCwd = this.workspace.workspaceRoot;
            const shouldChdir = previousCwd !== targetCwd;
            const activeAgent = agentOverride ?? agent;
            let output = "";
            let invocationMetadata: Record<string, unknown> | undefined;
            let invocationAdapter: string | undefined;
            let invocationModel: string | undefined;
            const started = Date.now();
            try {
              if (shouldChdir) {
                process.chdir(targetCwd);
              }
              if (agentStream && this.deps.agentService.invokeStream) {
                const stream = await withAbort(
                  this.deps.agentService.invokeStream(activeAgent.id, {
                    input,
                    adapterType: agentAdapterOverride,
                    metadata: taskInvocationMetadata,
                  }),
                );
                let pollLockLost = false;
                let aborted = false;
                const onAbort = () => {
                  aborted = true;
                };
                abortSignal?.addEventListener("abort", onAbort, { once: true });
                const refreshTimer = setInterval(() => {
                  void refreshLock("agent_stream_poll").then((ok) => {
                    if (!ok) pollLockLost = true;
                  });
                }, getLockRefreshIntervalMs());
                try {
                  for await (const chunk of stream) {
                    if (aborted) {
                      throw new Error(resolveAbortReason());
                    }
                    if (!invocationMetadata && chunk.metadata) {
                      invocationMetadata = chunk.metadata as Record<string, unknown>;
                    }
                    if (!invocationAdapter && typeof chunk.adapter === "string") {
                      invocationAdapter = chunk.adapter;
                    }
                    if (!invocationModel && typeof chunk.model === "string") {
                      invocationModel = chunk.model;
                    }
                    output += chunk.output ?? "";
                    streamChunk(chunk.output);
                    await this.logTask(taskRun.id, chunk.output ?? "", phaseLabel);
                    if (!(await refreshLock("agent_stream"))) {
                      await this.logTask(taskRun.id, "Aborting task: lock lost during agent streaming.", "vcs");
                      throw new Error("Task lock lost during agent stream.");
                    }
                  }
                } finally {
                  clearInterval(refreshTimer);
                  abortSignal?.removeEventListener("abort", onAbort);
                }
                if (pollLockLost) {
                  await this.logTask(taskRun.id, "Aborting task: lock lost during agent stream.", "vcs");
                  throw new Error("Task lock lost during agent stream.");
                }
                if (aborted) {
                  throw new Error(resolveAbortReason());
                }
              } else {
                let pollLockLost = false;
                let rejectLockLost: ((error: Error) => void) | null = null;
                const lockLostPromise = new Promise<never>((_, reject) => {
                  rejectLockLost = reject;
                });
                const refreshTimer = setInterval(() => {
                  void refreshLock("agent_poll").then((ok) => {
                    if (ok || pollLockLost) return;
                    pollLockLost = true;
                    if (rejectLockLost) rejectLockLost(new Error("Task lock lost during agent invoke."));
                  });
                }, getLockRefreshIntervalMs());
                const invokePromise = withAbort(
                  this.deps.agentService.invoke(activeAgent.id, {
                    input,
                    adapterType: agentAdapterOverride,
                    metadata: taskInvocationMetadata,
                  }),
                ).catch((error) => {
                  if (pollLockLost) return null as any;
                  throw error;
                });
                try {
                  const result = await Promise.race([invokePromise, lockLostPromise]);
                  if (result) {
                    output = result.output ?? "";
                    invocationMetadata = (result.metadata as Record<string, unknown> | undefined) ?? invocationMetadata;
                    invocationAdapter = result.adapter ?? invocationAdapter;
                    invocationModel = result.model ?? invocationModel;
                  }
                } finally {
                  clearInterval(refreshTimer);
                }
                if (pollLockLost) {
                  await this.logTask(taskRun.id, "Aborting task: lock lost during agent invoke.", "vcs");
                  throw new Error("Task lock lost during agent invoke.");
                }
                streamChunk(output);
                await this.logTask(taskRun.id, output, phaseLabel);
              }
            } finally {
              if (shouldChdir) {
                try {
                  process.chdir(previousCwd);
                } catch (error) {
                  await this.logTask(
                    taskRun.id,
                    `Failed to restore working directory: ${error instanceof Error ? error.message : String(error)}`,
                    "agent",
                  );
                }
              }
            }
            return {
              output,
              durationSeconds: (Date.now() - started) / 1000,
              agentUsed: activeAgent,
              metadata: invocationMetadata,
              adapter: invocationAdapter,
              model: invocationModel,
            };
          };

          const recordUsage = async (
            phase: "agent" | "agent_retry",
            output: string,
            durationSeconds: number,
            promptText: string,
            agentUsed?: { id: string; defaultModel?: string },
            attempt?: number,
          ) => {
            const promptTokens = estimateTokens(promptText);
            const completionTokens = estimateTokens(output);
            tokensPromptTotal += promptTokens;
            tokensCompletionTotal += completionTokens;
            promptEstimateTotal += promptTokens;
            const resolvedAgent = agentUsed ?? agent;
            await this.recordTokenUsage({
              agentId: resolvedAgent.id,
              model: resolvedAgent.defaultModel,
              jobId: job.id,
              commandRunId: commandRun.id,
              taskRunId: taskRun.id,
              taskId: task.task.id,
              projectId: selection.project?.id,
              tokensPrompt: promptTokens,
              tokensCompletion: completionTokens,
              phase,
              attempt,
              durationSeconds,
            });
          };

          const maxAttempts = shouldRunTests ? MAX_TEST_FIX_ATTEMPTS : 1;
          let testsPassed = !shouldRunTests;
          let lastTestFailureSummary = "";
          let lastTestResults: TestRunResult[] = [];
          let lastTestErrorType: "tests_failed" | "tests_not_configured" | null = null;
          if (directEditsEnabled) {
            try {
              dirtyBeforeAgent = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter(
                (p) => !p.startsWith(".mcoda"),
              );
            } catch {
              dirtyBeforeAgent = [];
            }
          }

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            abortIfSignaled();
            const attemptNotes: string[] = [];
            if (attempt > 1) {
              attemptNotes.push(`Retry attempt ${attempt} of ${maxAttempts}.`);
            }
            if (lastTestFailureSummary) {
              attemptNotes.push("Previous test run failed. Fix the issues and update the code/tests.");
              attemptNotes.push(`Test failure summary:\n${lastTestFailureSummary}`);
            }
            const attemptPrompt = attemptNotes.length ? `${prompt}\n\n${attemptNotes.join("\n")}` : prompt;
            const agentInput = `${systemPrompt}\n\n${attemptPrompt}`;
            let agentOutput = "";
            let agentDuration = 0;
            let agentInvocation: {
              output: string;
              durationSeconds: number;
              agentUsed: { id: string; defaultModel?: string };
              metadata?: Record<string, unknown>;
              adapter?: string;
              model?: string;
            } | null = null;
            let triedRetry = false;
            let triedPatchFallback = false;
            let fileFallbackMode = false;
            let fallbackOutputInvalid = false;

            try {
              await startPhase("agent", { agent: agent.id, stream: agentStream, attempt, maxAttempts });
              agentInvocation = await invokeAgentOnce(agentInput, "agent");
              const rawAgentOutput = agentInvocation.output ?? "";
              agentOutput = sanitizeAgentOutput(rawAgentOutput);
              agentDuration = agentInvocation.durationSeconds;
              await endPhase("agent", { agentDurationSeconds: agentDuration, attempt });
              if (!(await refreshLock("agent"))) {
                await this.logTask(taskRun.id, "Aborting task: lock lost after agent completion.", "vcs");
                throw new Error("Task lock lost after agent completion.");
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (/task lock lost/i.test(message)) {
                throw error;
              }
              await this.logTask(taskRun.id, `Agent invocation failed: ${message}`, "agent");
              await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "agent", "error", { error: message, attempt });
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                status: "failed",
                finishedAt: new Date().toISOString(),
              });
              const codaliReason = resolveCodaliFailureReason(message);
              const failureNote = codaliReason ?? message;
              setFailureReason(failureNote);
              results.push({ taskKey: task.task.key, status: "failed", notes: failureNote });
              if (isAuthErrorMessage(message)) {
                abortRemainingReason = message;
                setFailureReason(AUTH_ERROR_REASON);
                warnings.push(`Auth/rate limit error detected; stopping after ${task.task.key}. ${message}`);
              }
              taskStatus = "failed";
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              continue taskLoop;
            }

            if (!agentInvocation) {
              throw new Error("Agent invocation did not return a response.");
            }
            await recordUsage("agent", agentInvocation.output ?? "", agentDuration, agentInput, agentInvocation.agentUsed, attempt);

            const invocationMeta = (agentInvocation.metadata ?? {}) as Record<string, unknown>;
            const rawTouched = Array.isArray(invocationMeta.touchedFiles) ? invocationMeta.touchedFiles : [];
            const touchedFiles = rawTouched.filter(
              (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
            );
            const logPath = typeof invocationMeta.logPath === "string" ? invocationMeta.logPath : undefined;
            const runId = typeof invocationMeta.runId === "string" ? invocationMeta.runId : undefined;
            if (logPath || touchedFiles.length || runId) {
              const codali = { logPath, touchedFiles: touchedFiles.length ? touchedFiles : undefined, runId };
              codaliRunMeta = codali;
              const summary = taskSummaries.get(task.task.key);
              if (summary) {
                summary.codali = codali;
              } else {
                taskSummaries.set(task.task.key, {
                  taskKey: task.task.key,
                  adapter: adapterLabel,
                  adapterOverride: agentAdapterOverride,
                  provider: providerLabel,
                  model: modelLabel,
                  sourceAdapter: codaliProviderInfo?.sourceAdapter ?? adapterLabel,
                  codali,
                });
              }
              await this.logTask(taskRun.id, "Codali artifacts captured.", "codali", {
                logPath,
                touchedFiles: touchedFiles.length ? touchedFiles : undefined,
                runId,
              });
            }

            let {
              patches,
              fileBlocks,
              structuredActions,
              jsonDetected,
              commentResolution: agentCommentResolution,
              unfencedFileHeader,
              placeholderFileBlocks,
              invalidFileBlockPaths,
              invalidPatchActions,
              allowFileOverwrite,
            } = extractAgentChanges(agentOutput);
            commentResolution = agentCommentResolution ?? null;
            const patchOutputDetected =
              patches.length > 0 ||
              fileBlocks.length > 0 ||
              structuredActions.length > 0 ||
              unfencedFileHeader ||
              placeholderFileBlocks ||
              invalidFileBlockPaths.length > 0 ||
              invalidPatchActions.length > 0;
            if (patchModeEnabled) {
              if (fileBlocks.length && patches.length) {
                if (!allowFileOverwrite) {
                  const { existing, remaining } = splitFileBlocksByExistence(fileBlocks, this.workspace.workspaceRoot);
                  if (existing.length) {
                    await this.logTask(taskRun.id, `Skipped FILE blocks for existing files: ${existing.join(", ")}`, "agent");
                  }
                  fileBlocks = remaining;
                }
              }
              if (structuredActions.length && patches.length) {
                await this.logTask(
                  taskRun.id,
                  "Structured patch actions detected; ignoring unified diff patches in favor of structured edits.",
                  "agent",
                );
                patches = [];
              }
              if (structuredActions.length && fileBlocks.length) {
                await this.logTask(
                  taskRun.id,
                  "Structured patch actions detected; ignoring FILE blocks in favor of structured edits.",
                  "agent",
                );
                fileBlocks = [];
              }
              if (structuredActions.length && invalidPatchActions.length) {
                await this.logTask(
                  taskRun.id,
                  `Some structured patch actions were invalid: ${invalidPatchActions.join("; ")}`,
                  "agent",
                );
              }
              if (placeholderFileBlocks) {
                await this.logTask(
                  taskRun.id,
                  "Agent output contained placeholder content in FILE blocks; rejecting output and retrying.",
                  "agent",
                );
                patches = [];
                fileBlocks = [];
                structuredActions = [];
                invalidPatchActions = [];
                jsonDetected = false;
              }
              if (unfencedFileHeader) {
                await this.logTask(
                  taskRun.id,
                  "Agent output contained FILE headers without fenced blocks; rejecting output and retrying with strict formatting.",
                  "agent",
                );
                patches = [];
                fileBlocks = [];
                jsonDetected = false;
              }
              if (invalidFileBlockPaths.length) {
                await this.logTask(
                  taskRun.id,
                  `Agent output contained FILE paths with diff metadata (${invalidFileBlockPaths.join(", ")}); rejecting output.`,
                  "agent",
                );
                patches = [];
                fileBlocks = [];
                structuredActions = [];
                invalidPatchActions = [];
                jsonDetected = false;
              }
              if ((patches.length > 0 || fileBlocks.length > 0) && hasExtraneousOutput(agentOutput, jsonDetected)) {
                await this.logTask(
                  taskRun.id,
                  "Agent output contained non-code text; rejecting patch/FILE blocks and retrying with strict output.",
                  "agent",
                );
                patches = [];
                fileBlocks = [];
                structuredActions = [];
                invalidPatchActions = [];
                jsonDetected = false;
              }
              if (patches.length === 0 && fileBlocks.length === 0 && structuredActions.length === 0 && !triedRetry) {
                triedRetry = true;
                const retryReason = jsonDetected
                  ? "Agent output was JSON-only and did not include patch or file blocks; retrying with explicit output instructions."
                  : "Agent output did not include a patch or file blocks; retrying with explicit output instructions.";
                await this.logTask(taskRun.id, retryReason, "agent");
                try {
                  const retryInput = `${systemPrompt}\n\n${attemptPrompt}\n\nOutput ONLY code changes. If editing existing files, respond with a unified diff inside \`\`\`patch\`\`\` fences. If creating new files, respond ONLY with FILE blocks in this format:\nFILE: path/to/file.ext\n\`\`\`\n<full file contents>\n\`\`\`\nDo not include analysis, narration, or extra text. Do not output JSON unless the runtime forces it; if forced, return a top-level JSON object with either a \`patch\` string (unified diff) or a \`files\` array of {path, content}.`;
                  const retryAgent = patchOnlyAgentSlug ? ((await resolvePatchOnlyAgent()) ?? agent) : agent;
                  if (retryAgent.id !== agent.id) {
                    await this.logTask(
                      taskRun.id,
                      `Retrying with patch-only agent override: ${patchOnlyAgentSlug}`,
                      "agent",
                    );
                  }
                  const retry = await invokeAgentOnce(retryInput, "agent", retryAgent);
                  agentOutput = sanitizeAgentOutput(retry.output ?? "");
                  agentDuration += retry.durationSeconds;
                  await recordUsage("agent_retry", retry.output ?? "", retry.durationSeconds, retryInput, retry.agentUsed, attempt);
                  ({
                    patches,
                    fileBlocks,
                    structuredActions,
                    jsonDetected,
                    commentResolution: agentCommentResolution,
                    unfencedFileHeader,
                    placeholderFileBlocks,
                    invalidFileBlockPaths,
                    invalidPatchActions,
                    allowFileOverwrite,
                  } = extractAgentChanges(agentOutput));
                  commentResolution = agentCommentResolution ?? null;
                  if (fileBlocks.length && patches.length) {
                    if (!allowFileOverwrite) {
                      const { existing, remaining } = splitFileBlocksByExistence(fileBlocks, this.workspace.workspaceRoot);
                      if (existing.length) {
                        await this.logTask(taskRun.id, `Skipped FILE blocks for existing files: ${existing.join(", ")}`, "agent");
                      }
                      fileBlocks = remaining;
                    }
                  }
                  if (structuredActions.length && patches.length) {
                    await this.logTask(
                      taskRun.id,
                      "Structured patch actions detected; ignoring unified diff patches in favor of structured edits.",
                      "agent",
                    );
                    patches = [];
                  }
                  if (structuredActions.length && fileBlocks.length) {
                    await this.logTask(
                      taskRun.id,
                      "Structured patch actions detected; ignoring FILE blocks in favor of structured edits.",
                      "agent",
                    );
                    fileBlocks = [];
                  }
                  if (structuredActions.length && invalidPatchActions.length) {
                    await this.logTask(
                      taskRun.id,
                      `Some structured patch actions were invalid: ${invalidPatchActions.join("; ")}`,
                      "agent",
                    );
                  }
                  if (placeholderFileBlocks) {
                    await this.logTask(
                      taskRun.id,
                      "Agent retry output contained placeholder content in FILE blocks; rejecting output.",
                      "agent",
                    );
                    patches = [];
                    fileBlocks = [];
                    structuredActions = [];
                    invalidPatchActions = [];
                    jsonDetected = false;
                  }
                  if (unfencedFileHeader) {
                    await this.logTask(
                      taskRun.id,
                      "Agent retry output contained FILE headers without fenced blocks; rejecting output.",
                      "agent",
                    );
                    patches = [];
                    fileBlocks = [];
                    jsonDetected = false;
                  }
                  if (invalidFileBlockPaths.length) {
                    await this.logTask(
                      taskRun.id,
                      `Agent retry output contained FILE paths with diff metadata (${invalidFileBlockPaths.join(", ")}); rejecting output.`,
                      "agent",
                    );
                    patches = [];
                    fileBlocks = [];
                    structuredActions = [];
                    invalidPatchActions = [];
                    jsonDetected = false;
                  }
                  if ((patches.length > 0 || fileBlocks.length > 0) && hasExtraneousOutput(agentOutput, jsonDetected)) {
                    await this.logTask(
                      taskRun.id,
                      "Agent retry output contained non-code text; rejecting patch/FILE blocks.",
                      "agent",
                    );
                    patches = [];
                    fileBlocks = [];
                    structuredActions = [];
                    invalidPatchActions = [];
                    jsonDetected = false;
                  }
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  await this.logTask(taskRun.id, `Agent retry failed: ${message}`, "agent");
                }
              }
            } else {
              if (patchOutputDetected) {
                await this.logTask(
                  taskRun.id,
                  "Agent output included patch/FILE content, but direct-edit mode is enabled; ignoring patch output.",
                  "agent",
                );
              }
              patches = [];
              fileBlocks = [];
              jsonDetected = false;
            }

            if (unresolvedComments.length > 0) {
              const statusValue = commentResolution?.commentBacklogStatus;
              const normalizedStatus = typeof statusValue === "string" ? statusValue.trim().toLowerCase() : "";
              const claimsNoBacklog =
                normalizedStatus.length > 0 &&
                (normalizedStatus === "none" ||
                  normalizedStatus === "missing" ||
                  normalizedStatus === "not provided" ||
                  normalizedStatus === "no comments provided" ||
                  normalizedStatus.includes("no comments"));
              const outputClaimsNoBacklog = !normalizedStatus && /no comments provided/i.test(agentOutput);
              if (claimsNoBacklog || outputClaimsNoBacklog) {
                const openSlugs = unresolvedComments
                  .map((comment) => comment.slug)
                  .filter((slug): slug is string => Boolean(slug && slug.trim()));
                const slugList = openSlugs.length ? openSlugs.join(", ") : "untracked";
                const body = [
                  "[work-on-tasks]",
                  "Agent reported no comment backlog while unresolved review/QA comments exist.",
                  `Open comment slugs: ${slugList}`,
                  `Agent note: ${normalizedStatus || "no comments provided"}`,
                ].join("\n");
                await this.deps.workspaceRepo.createTaskComment({
                  taskId: task.task.id,
                  taskRunId: taskRun.id,
                  jobId: job.id,
                  sourceCommand: "work-on-tasks",
                  authorType: "agent",
                  authorAgentId: agent.id,
                  category: "comment_backlog",
                  body,
                  createdAt: new Date().toISOString(),
                  metadata: { reason: "comment_backlog_missing", openSlugs, status: normalizedStatus || "none" },
                });
                if (commentBacklogEnforced) {
                  await this.logTask(taskRun.id, "Comment backlog missing in agent output; failing task.", "execution");
                  await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                    status: "failed",
                    finishedAt: new Date().toISOString(),
                  });
                  await this.stateService.markFailed(task.task, "comment_backlog_missing", statusContext);
                  setFailureReason("comment_backlog_missing");
                  results.push({ taskKey: task.task.key, status: "failed", notes: "comment_backlog_missing" });
                  taskStatus = "failed";
                  await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                  continue taskLoop;
                }
                await this.logTask(
                  taskRun.id,
                  "Comment backlog missing in agent output; guardrails relaxed, continuing.",
                  "execution",
                );
              }
            }

            if (directEditsEnabled) {
              let dirtyAfterAgent: string[] = [];
              try {
                dirtyAfterAgent = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter(
                  (p) => !p.startsWith(".mcoda"),
                );
              } catch {
                dirtyAfterAgent = [];
              }
              const directTouched = dirtyBeforeAgent.length
                ? dirtyAfterAgent.filter((p) => !dirtyBeforeAgent.includes(p))
                : dirtyAfterAgent;
              if (directTouched.length) {
                const merged = new Set([...touched, ...directTouched]);
                touched = Array.from(merged);
                patchApplied = true;
              }
              if (!allowDocEdits && directTouched.length) {
                const guarded = directTouched.filter((path) => isGuardedDocPath(path));
                if (guarded.length) {
                  const details = guarded.map((path) => `- ${path}`).join("\n");
                  const body = [
                    "[work-on-tasks]",
                    "Blocked edits to SDS/RFP/OpenAPI content.",
                    "Set metadata.allow_doc_edits=true (or allow_large_doc_edits=true) to allow this change.",
                    "Touched paths:",
                    details,
                  ].join("\n");
                  await this.deps.workspaceRepo.createTaskComment({
                    taskId: task.task.id,
                    taskRunId: taskRun.id,
                    jobId: job.id,
                    sourceCommand: "work-on-tasks",
                    authorType: "agent",
                    authorAgentId: agent.id,
                    category: "doc_edit_guard",
                    body,
                    createdAt: new Date().toISOString(),
                    metadata: { reason: "doc_edit_guard", paths: guarded },
                  });
                  await this.logTask(
                    taskRun.id,
                    "Blocked edits to guarded docs; add allow_doc_edits=true to task metadata to override.",
                    "scope",
                  );
                  await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", {
                    error: "doc_edit_guard",
                    violations: guarded,
                    attempt,
                  });
                  await this.stateService.markFailed(task.task, "doc_edit_guard", statusContext);
                  await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                    status: "failed",
                    finishedAt: new Date().toISOString(),
                  });
                  setFailureReason("doc_edit_guard");
                  results.push({ taskKey: task.task.key, status: "failed", notes: "doc_edit_guard" });
                  taskStatus = "failed";
                  try {
                    await this.vcs.resetHard(this.workspace.workspaceRoot, { exclude: [".mcoda"] });
                    touched = [];
                    patchApplied = false;
                  } catch (error) {
                    await this.logTask(
                      taskRun.id,
                      `Failed to rollback workspace after doc guard violation: ${
                        error instanceof Error ? error.message : String(error)
                      }`,
                      "scope",
                    );
                  }
                  await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                  continue taskLoop;
                }
              }
              if (!allowLargeDocEdits && directTouched.length) {
                let diffText = "";
                try {
                  const { stdout } = await exec("git diff --no-color", { cwd: this.workspace.workspaceRoot });
                  diffText = String(stdout ?? "");
                } catch (error) {
                  await this.logTask(
                    taskRun.id,
                    `Failed to capture diff for doc edit guard: ${error instanceof Error ? error.message : String(error)}`,
                    "scope",
                  );
                }
                if (diffText.trim()) {
                  const violations = await detectLargeDocEdits([diffText], [], this.workspace.workspaceRoot);
                  if (violations.length) {
                    const details = violations
                      .map(
                        (item) =>
                          `${item.path} removed ${item.removedLines}/${item.beforeLines} lines (threshold ${item.threshold}, mode=${item.mode})`,
                      )
                      .join("\n");
                    const body = [
                      "[work-on-tasks]",
                      "Blocked destructive doc edit in SDS/RFP/OpenAPI content.",
                      "Set metadata.allow_doc_edits=true (or allow_large_doc_edits=true) on the task to allow this change.",
                      "Violations:",
                      details,
                    ].join("\n");
                    await this.deps.workspaceRepo.createTaskComment({
                      taskId: task.task.id,
                      taskRunId: taskRun.id,
                      jobId: job.id,
                      sourceCommand: "work-on-tasks",
                      authorType: "agent",
                      authorAgentId: agent.id,
                      category: "doc_edit_guard",
                      body,
                      createdAt: new Date().toISOString(),
                      metadata: { reason: "doc_edit_guard", violations },
                    });
                    await this.logTask(
                      taskRun.id,
                      "Blocked destructive doc edit; add allow_large_doc_edits=true to task metadata to override.",
                      "scope",
                    );
                    await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", {
                      error: "doc_edit_guard",
                      violations,
                      attempt,
                    });
                    await this.stateService.markFailed(task.task, "doc_edit_guard", statusContext);
                    await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                      status: "failed",
                      finishedAt: new Date().toISOString(),
                    });
                    setFailureReason("doc_edit_guard");
                    results.push({ taskKey: task.task.key, status: "failed", notes: "doc_edit_guard" });
                    taskStatus = "failed";
                    try {
                      await this.vcs.resetHard(this.workspace.workspaceRoot, { exclude: [".mcoda"] });
                      touched = [];
                      patchApplied = false;
                    } catch (error) {
                      await this.logTask(
                        taskRun.id,
                        `Failed to rollback workspace after doc guard violation: ${
                          error instanceof Error ? error.message : String(error)
                        }`,
                        "scope",
                      );
                    }
                    await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                    continue taskLoop;
                  }
                }
              }
            }

            if (patchModeEnabled && patches.length === 0 && fileBlocks.length === 0 && structuredActions.length === 0) {
              if (!commentResolution) {
                const message = "Agent output did not include a patch or file blocks.";
                await this.logTask(taskRun.id, message, "agent");
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
                setFailureReason("missing_patch");
                results.push({ taskKey: task.task.key, status: "failed", notes: "missing_patch" });
                taskStatus = "failed";
                await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                continue taskLoop;
              }
              await this.logTask(
                taskRun.id,
                "No patch output provided; proceeding with comment resolution only.",
                "agent",
              );
            }

            if (patchModeEnabled && patches.length) {
              const outOfScope = findOutOfScopePatchPaths(patches, this.workspace.workspaceRoot);
              if (outOfScope.length) {
                const message = `Patch references paths outside workspace: ${outOfScope.join(", ")}`;
                await this.logTask(taskRun.id, message, "scope");
                await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", {
                  error: "scope_violation",
                  outOfScope,
                  attempt,
                });
                await this.stateService.markFailed(task.task, "scope_violation", statusContext);
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                  status: "failed",
                  finishedAt: new Date().toISOString(),
                });
                setFailureReason("scope_violation");
                results.push({ taskKey: task.task.key, status: "failed", notes: "scope_violation" });
                taskStatus = "failed";
                await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                continue taskLoop;
              }
            }

            if (patchModeEnabled && structuredActions.length) {
              const outOfScopeActions = findOutOfScopeActionPaths(
                structuredActions,
                this.workspace.workspaceRoot,
              );
              if (outOfScopeActions.length) {
                const message = `Structured patch actions reference paths outside workspace: ${outOfScopeActions.join(", ")}`;
                await this.logTask(taskRun.id, message, "scope");
                await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", {
                  error: "scope_violation",
                  outOfScope: outOfScopeActions,
                  attempt,
                });
                await this.stateService.markFailed(task.task, "scope_violation", statusContext);
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                  status: "failed",
                  finishedAt: new Date().toISOString(),
                });
                setFailureReason("scope_violation");
                results.push({ taskKey: task.task.key, status: "failed", notes: "scope_violation" });
                taskStatus = "failed";
                await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                continue taskLoop;
              }
            }

            if (patchModeEnabled && !allowLargeDocEdits) {
              const structuredBlocks = structuredActions.length
                ? await this.buildStructuredFileBlocks(structuredActions, this.workspace.workspaceRoot)
                : { fileBlocks: [], errors: [] as string[] };
              if (structuredBlocks.errors.length) {
                await this.logTask(
                  taskRun.id,
                  `Structured patch actions failed validation: ${structuredBlocks.errors.join("; ")}`,
                  "patch",
                );
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                  status: "failed",
                  finishedAt: new Date().toISOString(),
                });
                setFailureReason("missing_patch");
                results.push({ taskKey: task.task.key, status: "failed", notes: "missing_patch" });
                taskStatus = "failed";
                await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                continue taskLoop;
              }
              const combinedFileBlocks = structuredBlocks.fileBlocks.length
                ? [...fileBlocks, ...structuredBlocks.fileBlocks]
                : fileBlocks;
              const violations = await detectLargeDocEdits(patches, combinedFileBlocks, this.workspace.workspaceRoot);
              if (violations.length) {
                const details = violations
                  .map(
                    (item) =>
                      `${item.path} removed ${item.removedLines}/${item.beforeLines} lines (threshold ${item.threshold}, mode=${item.mode})`,
                  )
                  .join("\n");
                const body = [
                  "[work-on-tasks]",
                  "Blocked destructive doc edit in SDS/RFP/OpenAPI content.",
                  "Set metadata.allow_doc_edits=true (or allow_large_doc_edits=true) on the task to allow this change.",
                  "Violations:",
                  details,
                ].join("\n");
                await this.deps.workspaceRepo.createTaskComment({
                  taskId: task.task.id,
                  taskRunId: taskRun.id,
                  jobId: job.id,
                  sourceCommand: "work-on-tasks",
                  authorType: "agent",
                  authorAgentId: agent.id,
                  category: "doc_edit_guard",
                  body,
                  createdAt: new Date().toISOString(),
                  metadata: { reason: "doc_edit_guard", violations },
                });
                await this.logTask(
                  taskRun.id,
                  "Blocked destructive doc edit; add allow_doc_edits=true (or allow_large_doc_edits=true) to task metadata to override.",
                  "scope",
                );
                await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", {
                  error: "doc_edit_guard",
                  violations,
                  attempt,
                });
                await this.stateService.markFailed(task.task, "doc_edit_guard", statusContext);
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                  status: "failed",
                  finishedAt: new Date().toISOString(),
                });
                setFailureReason("doc_edit_guard");
                results.push({ taskKey: task.task.key, status: "failed", notes: "doc_edit_guard" });
                taskStatus = "failed";
                await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                continue taskLoop;
              }
            }

            if (patchModeEnabled && (patches.length || fileBlocks.length || structuredActions.length)) {
              if (!(await refreshLock("apply_start", true))) {
                await this.logTask(taskRun.id, "Aborting task: lock lost before apply.", "vcs");
                throw new Error("Task lock lost before apply.");
              }
              const applyDetails: Record<string, unknown> = { attempt };
              if (structuredActions.length) applyDetails.actionCount = structuredActions.length;
              if (patches.length) applyDetails.patchCount = patches.length;
              if (fileBlocks.length) applyDetails.fileCount = fileBlocks.length;
              if (structuredActions.length && !patches.length && !fileBlocks.length) applyDetails.mode = "structured";
              if (fileBlocks.length && !patches.length && !structuredActions.length) applyDetails.mode = "direct";
              await startPhase("apply", applyDetails);
              let patchApplyError: string | null = null;
              const touchedBeforeApply = [...touched];
              let rollbackAttempted = false;
              let rollbackAllowed = false;
              let rollbackSkipReason = "";
              if (!request.dryRun) {
                try {
                  rollbackAllowed = await this.vcs.isRepo(this.workspace.workspaceRoot);
                  if (!rollbackAllowed) {
                    rollbackSkipReason = "workspace not under git";
                  } else {
                    const dirtyBeforeApply = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter(
                      (p) => !p.startsWith(".mcoda"),
                    );
                    if (dirtyBeforeApply.length) {
                      rollbackAllowed = false;
                      rollbackSkipReason = `dirty before apply (${dirtyBeforeApply.join(", ")})`;
                    }
                  }
                } catch (error) {
                  rollbackAllowed = false;
                  rollbackSkipReason = `rollback preflight failed: ${(error as Error).message}`;
                }
              } else {
                rollbackSkipReason = "dry run";
              }
              const rollbackWorkspace = async (reason: string) => {
                if (rollbackAttempted) return;
                rollbackAttempted = true;
                if (!rollbackAllowed) {
                  if (rollbackSkipReason) {
                    await this.logTask(
                      taskRun.id,
                      `Skipped workspace rollback after failed apply (${reason}); ${rollbackSkipReason}.`,
                      "patch",
                    );
                  }
                  return;
                }
                try {
                  await this.vcs.resetHard(this.workspace.workspaceRoot, { exclude: [".mcoda"] });
                  touched = [...touchedBeforeApply];
                  patchApplied = false;
                  await this.logTask(taskRun.id, `Rolled back workspace after failed apply (${reason}).`, "patch");
                } catch (error) {
                  await this.logTask(
                    taskRun.id,
                    `Workspace rollback failed after ${reason}: ${(error as Error).message}`,
                    "patch",
                  );
                }
              };
              if (structuredActions.length) {
                const allowStructuredOverwrite = request.allowFileOverwrite === true || allowFileOverwrite;
                const applied = await this.applyStructuredActions(
                  structuredActions,
                  this.workspace.workspaceRoot,
                  request.dryRun ?? false,
                  allowStructuredOverwrite,
                );
                if (applied.touched.length) {
                  const merged = new Set([...touched, ...applied.touched]);
                  touched = Array.from(merged);
                }
                if (applied.warnings?.length) {
                  await this.logTask(taskRun.id, applied.warnings.join("; "), "patch");
                }
                if (applied.error) {
                  patchApplyError = applied.error;
                  await this.logTask(taskRun.id, `Structured patch apply failed: ${applied.error}`, "patch");
                  await rollbackWorkspace(`structured patch apply failed: ${applied.error}`);
                }
                patches = [];
                fileBlocks = [];
              }
              if (patches.length) {
                const applied = await this.applyPatches(
                  patches,
                  this.workspace.workspaceRoot,
                  request.dryRun ?? false,
                  { jobId: job.id, taskKey: task.task.key, attempt },
                );
                if (applied.touched.length) {
                  const merged = new Set([...touched, ...applied.touched]);
                  touched = Array.from(merged);
                }
                if (applied.warnings?.length) {
                  await this.logTask(taskRun.id, applied.warnings.join("; "), "patch");
                }
                if (applied.error) {
                  patchApplyError = applied.error;
                  await this.logTask(taskRun.id, `Patch apply failed: ${applied.error}`, "patch");
                  if (applied.rejectDetails) {
                    const body = [
                      "[work-on-tasks]",
                      "Patch rejected while applying agent output.",
                      `Files: ${applied.rejectDetails.files.join(", ") || "unknown"}`,
                      `Details: ${applied.rejectDetails.message}`,
                    ].join("\n");
                    await this.deps.workspaceRepo.createTaskComment({
                      taskId: task.task.id,
                      taskRunId: taskRun.id,
                      jobId: job.id,
                      sourceCommand: "work-on-tasks",
                      authorType: "agent",
                      authorAgentId: agent.id,
                      category: "patch_reject",
                      body,
                      createdAt: new Date().toISOString(),
                      metadata: {
                        reason: "patch_reject",
                        files: applied.rejectDetails.files,
                        removedRejects: applied.rejectDetails.removedRejects,
                        cleanupErrors: applied.rejectDetails.cleanupErrors,
                      },
                    });
                    await this.logTask(taskRun.id, "Patch rejected; failing task after cleanup.", "patch");
                  }
                  await rollbackWorkspace(`patch apply failed: ${applied.error}`);
                  if (!fileBlocks.length && !triedPatchFallback) {
                    triedPatchFallback = true;
                    const files = Array.from(new Set(patches.flatMap((patch) => touchedFilesFromPatch(patch)))).filter(Boolean);
                    if (files.length) {
                      const fallbackPrompt = [
                        systemPrompt,
                        "",
                        attemptPrompt,
                        "",
                        `Patch apply failed (${applied.error}).`,
                        "Return FILE blocks only for these paths (full contents, no diffs, no prose):",
                        files.map((file) => `- ${file}`).join("\n"),
                      ].join("\n");
                      try {
                        const fallback = await invokeAgentOnce(fallbackPrompt, "agent");
                        agentDuration += fallback.durationSeconds;
                        await recordUsage(
                          "agent_retry",
                          fallback.output ?? "",
                          fallback.durationSeconds,
                          fallbackPrompt,
                          fallback.agentUsed,
                        );
                        const fallbackOutput = sanitizeAgentOutput(fallback.output ?? "");
                        const fallbackChanges = extractAgentChanges(fallbackOutput);
                        const fallbackExtraneous = hasExtraneousOutput(fallbackOutput, fallbackChanges.jsonDetected);
                        if (fallbackChanges.placeholderFileBlocks) {
                          await this.logTask(
                            taskRun.id,
                            "Patch fallback output contained placeholder content in FILE blocks; rejecting fallback output.",
                            "patch",
                          );
                          fallbackChanges.patches = [];
                          fallbackChanges.fileBlocks = [];
                          fallbackOutputInvalid = true;
                        }
                        if (fallbackChanges.unfencedFileHeader) {
                          await this.logTask(
                            taskRun.id,
                            "Patch fallback output contained FILE headers without fenced blocks; rejecting fallback output.",
                            "patch",
                          );
                          fallbackChanges.patches = [];
                          fallbackChanges.fileBlocks = [];
                          fallbackOutputInvalid = true;
                        }
                        if (fallbackChanges.invalidFileBlockPaths.length) {
                          await this.logTask(
                            taskRun.id,
                            `Patch fallback output contained FILE paths with diff metadata (${fallbackChanges.invalidFileBlockPaths.join(
                              ", ",
                            )}); rejecting fallback output.`,
                            "patch",
                          );
                          fallbackChanges.patches = [];
                          fallbackChanges.fileBlocks = [];
                          fallbackOutputInvalid = true;
                        }
                        if (fallbackChanges.patches.length) {
                          await this.logTask(
                            taskRun.id,
                            "Patch fallback output contained patches; rejecting fallback output (FILE-only required).",
                            "patch",
                          );
                          fallbackChanges.patches = [];
                          fallbackChanges.fileBlocks = [];
                          fallbackOutputInvalid = true;
                        }
                        if (fallbackChanges.jsonDetected) {
                          await this.logTask(
                            taskRun.id,
                            "Patch fallback output contained JSON; rejecting fallback output (FILE-only required).",
                            "patch",
                          );
                          fallbackChanges.patches = [];
                          fallbackChanges.fileBlocks = [];
                          fallbackOutputInvalid = true;
                        }
                        if (fallbackExtraneous) {
                          await this.logTask(
                            taskRun.id,
                            "Patch fallback output contained non-code text; rejecting fallback output (FILE-only required).",
                            "patch",
                          );
                          fallbackChanges.patches = [];
                          fallbackChanges.fileBlocks = [];
                          fallbackOutputInvalid = true;
                        }
                        if (!fallbackChanges.fileBlocks.length) {
                          fallbackOutputInvalid = true;
                          await this.logTask(
                            taskRun.id,
                            "Patch fallback output did not include valid FILE blocks; rejecting fallback output.",
                            "patch",
                          );
                        }
                        if (fallbackChanges.fileBlocks.length) {
                          fileBlocks = fallbackChanges.fileBlocks;
                          patches = [];
                          patchApplyError = null;
                          fileFallbackMode = true;
                          await this.logTask(taskRun.id, "Recovered from patch failure using FILE blocks.", "patch");
                          warnings.push(`Recovered from patch failure using FILE blocks for ${task.task.key}.`);
                        }
                      } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        await this.logTask(taskRun.id, `Patch fallback failed: ${message}`, "patch");
                      }
                    }
                  }
                  if (patchApplyError && !fileBlocks.length) {
                    const failureReason = "patch_failed";
                    await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", {
                      error: failureReason,
                      attempt,
                    });
                    await this.stateService.markFailed(task.task, failureReason, statusContext);
                    await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                      status: "failed",
                      finishedAt: new Date().toISOString(),
                    });
                    setFailureReason(failureReason);
                    results.push({ taskKey: task.task.key, status: "failed", notes: failureReason });
                    taskStatus = "failed";
                    await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                    continue taskLoop;
                  }
                }
              }
              if (fileBlocks.length) {
                const onlyExistingFileBlocks =
                  fileBlocks.length > 0 &&
                  fileBlocks.every((block) => {
                    const rawPath = block.path?.trim();
                    if (!rawPath) return false;
                    const resolved = path.resolve(this.workspace.workspaceRoot, rawPath);
                    const relative = path.relative(this.workspace.workspaceRoot, resolved);
                    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
                    return fs.existsSync(resolved);
                  });
                const allowNoop = patchApplyError === null && (touched.length > 0 || onlyExistingFileBlocks);
                const allowFileOverwriteForBlocks =
                  request.allowFileOverwrite === true || allowFileOverwrite || fileFallbackMode;
                const applied = await this.applyFileBlocks(
                  fileBlocks,
                  this.workspace.workspaceRoot,
                  request.dryRun ?? false,
                  allowNoop,
                  allowFileOverwriteForBlocks,
                );
                if (applied.touched.length) {
                  const merged = new Set([...touched, ...applied.touched]);
                  touched = Array.from(merged);
                }
                if (applied.warnings?.length) {
                  await this.logTask(taskRun.id, applied.warnings.join("; "), "patch");
                }
                if (applied.error) {
                  await this.logTask(taskRun.id, `Direct file apply failed: ${applied.error}`, "patch");
                  await rollbackWorkspace(`file apply failed: ${applied.error}`);
                  await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", { error: applied.error, attempt });
                  await this.stateService.markFailed(task.task, "patch_failed", statusContext);
                  await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                    status: "failed",
                    finishedAt: new Date().toISOString(),
                  });
                  setFailureReason("patch_failed");
                  results.push({ taskKey: task.task.key, status: "failed", notes: "patch_failed" });
                  taskStatus = "failed";
                  await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                  continue taskLoop;
                }
                if (patchApplyError && applied.appliedCount > 0) {
                  await this.logTask(
                    taskRun.id,
                    `Patch apply skipped; continued with file blocks. Reason: ${patchApplyError}`,
                    "patch",
                  );
                  patchApplyError = null;
                }
              }
              if (patchApplyError) {
                const failureReason = "patch_failed";
                await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", {
                  error: failureReason,
                  attempt,
                });
                await this.stateService.markFailed(task.task, failureReason, statusContext);
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                  status: "failed",
                  finishedAt: new Date().toISOString(),
                });
                setFailureReason(failureReason);
                results.push({ taskKey: task.task.key, status: "failed", notes: failureReason });
                taskStatus = "failed";
                await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                continue taskLoop;
              }
              patchApplied = patchApplied || touched.length > 0;
              await endPhase("apply", { touched, attempt });
              if (!(await refreshLock("apply"))) {
                await this.logTask(taskRun.id, "Aborting task: lock lost after apply.", "vcs");
                throw new Error("Task lock lost after apply.");
              }
            }
  
              if (patchApplied && allowedFiles.length) {
                const dirtyAfterApply = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter((p) => !p.startsWith(".mcoda"));
                const scopeCheck = this.validateScope(allowedFiles, normalizePaths(this.workspace.workspaceRoot, dirtyAfterApply));
                if (!scopeCheck.ok) {
                  await this.logTask(taskRun.id, scopeCheck.message ?? "Scope violation", "scope");
                  await this.stateService.markFailed(task.task, "scope_violation", statusContext);
                  await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
                  setFailureReason("scope_violation");
                  results.push({ taskKey: task.task.key, status: "failed", notes: "scope_violation" });
                  taskStatus = "failed";
                  await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                  continue taskLoop;
                }
              }
  
              if (shouldRunTests) {
                abortIfSignaled();
                testAttemptCount += 1;
                const runAllTestsCommand = testsRequired ? detectRunAllTestsCommand(this.workspace.workspaceRoot) : undefined;
                const combinedCommands = runAllTestsCommand
                  ? dedupeCommands([...testCommands, runAllTestsCommand])
                  : testCommands;
                if (!combinedCommands.length) {
                  if (testsRequired) {
                    await this.logTask(taskRun.id, "No runnable tests found; failing task.", "tests", {
                      attempt,
                      testRequirements,
                    });
                    lastTestErrorType = "tests_not_configured";
                    lastTestFailureSummary = "No runnable test commands configured.";
                    testsPassed = false;
                    break;
                  }
                  await this.logTask(taskRun.id, "No runnable tests found; skipping tests.", "tests", { attempt });
                  testsPassed = true;
                  break;
                }
                await startPhase("tests", { commands: combinedCommands, attempt, runAll: Boolean(runAllTestsCommand) });
                const testResult = await this.runTests(combinedCommands, this.workspace.workspaceRoot, abortSignal);
                await this.logTask(taskRun.id, "Test results", "tests", { results: testResult.results, attempt });
                if (!testResult.ok) {
                  lastTestResults = testResult.results;
                  lastTestFailureSummary = formatTestFailureSummary(testResult.results);
                  lastTestErrorType = "tests_failed";
                  await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "tests", "error", {
                    error: "tests_failed",
                    attempt,
                  });
                  await this.logTask(taskRun.id, "Tests failed; retrying with fixes.", "tests", {
                    attempt,
                    remainingAttempts: maxAttempts - attempt,
                  });
                  await endPhase("tests", { results: testResult.results, ok: false, attempt, retrying: attempt < maxAttempts });
                  if (!(await refreshLock("tests"))) {
                    await this.logTask(taskRun.id, "Aborting task: lock lost after tests.", "vcs");
                    throw new Error("Task lock lost after tests.");
                  }
                  if (attempt < maxAttempts) {
                    continue;
                  }
                  testsPassed = false;
                  break;
                }
                await endPhase("tests", { results: testResult.results, ok: true, attempt });
                testsPassed = true;
                if (!(await refreshLock("tests"))) {
                  await this.logTask(taskRun.id, "Aborting task: lock lost after tests.", "vcs");
                  throw new Error("Task lock lost after tests.");
                }
              } else {
                testsPassed = true;
              }
  
              if (testsPassed) {
                break;
              }
            }
  
            if (!testsPassed) {
              const failureReason = lastTestErrorType ?? "tests_failed";
              await this.logTask(taskRun.id, `Tests failed after ${testAttemptCount} attempt(s).`, "tests", {
                results: lastTestResults,
              });
              await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "tests", "error", {
                error: failureReason,
                attempts: testAttemptCount,
              });
              await this.stateService.markFailed(task.task, failureReason, statusContext);
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
              setFailureReason(failureReason);
              results.push({ taskKey: task.task.key, status: "failed", notes: failureReason });
              taskStatus = "failed";
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              continue taskLoop;
            }

            if (!request.dryRun) {
              hasChanges = touched.length > 0;
              let dirtyPaths: string[] = [];
              if (!hasChanges) {
                try {
                  dirtyPaths = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter(
                    (p) => !p.startsWith(".mcoda"),
                  );
                } catch {
                  dirtyPaths = [];
                }
              }
              const noChangeJustification = !hasChanges
                ? dirtyPaths.length
                  ? `No touched files detected; dirty paths present: ${dirtyPaths.join(", ")}`
                  : "No touched files detected after applying patches."
                : undefined;
              if (unresolvedComments.length > 0) {
                const openSlugs = unresolvedComments
                  .map((comment) => comment.slug)
                  .filter((slug): slug is string => Boolean(slug && slug.trim()));
                await addCommentProgress({
                  openSlugs,
                  resolvedSlugs: commentResolution?.resolvedSlugs ?? [],
                  unresolvedSlugs: commentResolution?.unresolvedSlugs ?? [],
                  status: commentResolution?.commentBacklogStatus ?? "missing",
                  touchedFiles: touched,
                  hasChanges,
                });
              }
              if (!hasChanges && unresolvedComments.length > 0) {
                const openSlugs = unresolvedComments
                  .map((comment) => comment.slug)
                  .filter((slug): slug is string => Boolean(slug && slug.trim()));
                const slugList = openSlugs.length ? openSlugs.join(", ") : "untracked";
                const body = [
                  "[work-on-tasks]",
                  "No repo changes were detected while comment backlog remains unresolved.",
                  "Comment backlog must be addressed before completing the task.",
                  `Open comment slugs: ${slugList}`,
                  `Justification: ${noChangeJustification ?? "No justification provided."}`,
                ].join("\n");
                await this.deps.workspaceRepo.createTaskComment({
                  taskId: task.task.id,
                  taskRunId: taskRun.id,
                  jobId: job.id,
                  sourceCommand: "work-on-tasks",
                  authorType: "agent",
                  authorAgentId: agent.id,
                  category: "comment_backlog",
                  body,
                  createdAt: new Date().toISOString(),
                  metadata: {
                    reason: "comment_backlog_unaddressed",
                    openSlugs,
                    justification: noChangeJustification,
                    dirtyPaths,
                    resolvedSlugs: commentResolution?.resolvedSlugs ?? [],
                    unresolvedSlugs: commentResolution?.unresolvedSlugs ?? [],
                  },
                });
                if (commentBacklogEnforced) {
                  await this.logTask(
                    taskRun.id,
                    `Comment backlog unresolved with no repo changes (${slugList}).`,
                    "execution",
                  );
                  await this.stateService.markChangesRequested(
                    task.task,
                    { failed_reason: "comment_backlog_unaddressed" },
                    statusContext,
                  );
                  await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                    status: "failed",
                    finishedAt: new Date().toISOString(),
                  });
                  setFailureReason("comment_backlog_unaddressed");
                  results.push({ taskKey: task.task.key, status: "failed", notes: "comment_backlog_unaddressed" });
                  taskStatus = "failed";
                  await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                  continue taskLoop;
                }
                await this.logTask(
                  taskRun.id,
                  `Comment backlog unresolved with no repo changes (${slugList}); guardrails relaxed, continuing.`,
                  "execution",
                );
              }
              if (!hasChanges) {
                const body = [
                  "[work-on-tasks]",
                  "No changes were required; task appears already satisfied.",
                  `Justification: ${noChangeJustification ?? "No justification provided."}`,
                ].join("\n");
                await this.deps.workspaceRepo.createTaskComment({
                  taskId: task.task.id,
                  taskRunId: taskRun.id,
                  jobId: job.id,
                  sourceCommand: "work-on-tasks",
                  authorType: "agent",
                  authorAgentId: agent.id,
                  category: "no_changes",
                  body,
                  createdAt: new Date().toISOString(),
                  metadata: { reason: "no_changes_completed", initialStatus, justification: noChangeJustification, dirtyPaths },
                });
                await this.logTask(taskRun.id, "No changes required; marking task ready for code review.", "execution");
                await this.stateService.markReadyToReview(task.task, { completed_reason: "no_changes" }, statusContext);
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "succeeded", finishedAt: new Date().toISOString() });
                results.push({ taskKey: task.task.key, status: "succeeded", notes: "no_changes" });
                taskStatus = "succeeded";
                await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                continue taskLoop;
              }
            }
  
        if (runVcsPhase) {
          const vcsOutcome = await runVcsPhase({ allowResultUpdate: true, reason: "primary" });
          if (vcsOutcome.halt) {
            continue taskLoop;
          }
        }

        if (commentResolution?.resolvedSlugs?.length || commentResolution?.unresolvedSlugs?.length) {
          if (!commentResolutionApplied) {
            if (!hasChanges && unresolvedComments.length > 0) {
              await this.logTask(
                taskRun.id,
                "Skipping comment resolution because no repo changes were detected for an unresolved backlog.",
                "comment_resolution",
              );
            } else {
              await applyCommentResolutionIfNeeded();
            }
          }
        }

        if (!request.dryRun) {
          const runAllTestsCommand = testsRequired ? detectRunAllTestsCommand(this.workspace.workspaceRoot) : undefined;
          const combinedCommands = runAllTestsCommand
            ? dedupeCommands([...testCommands, runAllTestsCommand])
            : testCommands;
          const summaryLines = [
            "[work-on-tasks]",
            `Summary: ${task.task.key} completed.`,
            `Touched files: ${touched.length ? touched.join(", ") : "(none)"}`,
            `Tests run: ${shouldRunTests ? (combinedCommands.length ? combinedCommands.join(" && ") : "(none)") : "skipped"}`,
            testsRequired ? `Run-all tests: ${runAllTestsCommand ?? "(missing)"}` : "",
            commentResolution
              ? `Comment backlog: resolved=${formatSlugList(commentResolution.resolvedSlugs ?? [])}, unresolved=${formatSlugList(
                  commentResolution.unresolvedSlugs ?? [],
                )}, status=${commentResolution.commentBacklogStatus ?? "missing"}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
          await this.deps.workspaceRepo.createTaskComment({
            taskId: task.task.id,
            taskRunId: taskRun.id,
            jobId: job.id,
            sourceCommand: "work-on-tasks",
            authorType: "agent",
            authorAgentId: agent.id,
            category: "work_summary",
            body: summaryLines,
            createdAt: new Date().toISOString(),
            metadata: {
              touchedFiles: touched,
              testCommands: combinedCommands,
              runAllTestsCommand: runAllTestsCommand ?? null,
              commentResolution: commentResolution ?? null,
            },
          });
        }

        await startPhase("finalize");
        const finishedAt = new Date().toISOString();
        const elapsedSeconds = Math.max(1, (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
        const spPerHour =
          task.task.storyPoints && task.task.storyPoints > 0 ? (task.task.storyPoints / elapsedSeconds) * 3600 : null;

        const reviewMetadata: Record<string, unknown> = { last_run: finishedAt };
        if (shouldRunTests) {
          const runAllTestsCommand = testsRequired ? detectRunAllTestsCommand(this.workspace.workspaceRoot) : undefined;
          const combinedCommands = runAllTestsCommand
            ? dedupeCommands([...testCommands, runAllTestsCommand])
            : testCommands;
          reviewMetadata.test_attempts = testAttemptCount;
          reviewMetadata.test_commands = combinedCommands;
          reviewMetadata.run_all_tests_command = runAllTestsCommand ?? null;
        }
        await this.stateService.markReadyToReview(task.task, reviewMetadata, statusContext);
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
          status: "succeeded",
          finishedAt,
          spPerHourEffective: spPerHour,
          gitBranch: branchInfo.branch,
          gitBaseBranch: branchInfo.base,
        });

        storyPointsProcessed += task.task.storyPoints ?? 0;
        await endPhase("finalize", { spPerHour: spPerHour ?? undefined });

        const resultNotes = READY_TO_CODE_REVIEW;
        taskStatus = "succeeded";
        results.push({
          taskKey: task.task.key,
          status: "succeeded",
          notes: resultNotes,
          branch: branchInfo.branch,
        });
        await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
        await this.checkpoint(job.id, "task_ready_for_review", { taskKey: task.task.key });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isAbortError(message)) {
            await this.logTask(taskRun.id, `Task aborted: ${message}`, "execution");
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
            await this.stateService.markFailed(task.task, "agent_timeout", statusContext);
            setFailureReason("agent_timeout");
            taskStatus = "failed";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            throw error;
          }
          if (/task lock lost/i.test(message)) {
            await this.logTask(taskRun.id, `Task aborted: ${message}`, "vcs");
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
            await this.stateService.markFailed(task.task, "task_lock_lost", statusContext);
            setFailureReason("task_lock_lost");
            results.push({ taskKey: task.task.key, status: "failed", notes: "task_lock_lost" });
            taskStatus = "failed";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            continue taskLoop;
          }
          throw error;
        } finally {
          if (runVcsPhase && !vcsFinalized) {
            try {
              await runVcsPhase({ allowResultUpdate: false, reason: "finalize" });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await this.logTask(taskRun.id, `Deferred VCS finalize failed: ${message}`, "vcs");
            }
          }
          if (lockAcquired) {
            await this.deps.workspaceRepo.releaseTaskLock(task.task.id, taskRun.id);
          }
          if (request.rateAgents && tokensPromptTotal + tokensCompletionTotal > 0) {
            try {
              const ratingService = this.ensureRatingService();
              await ratingService.rate({
                workspace: this.workspace,
                agentId: agent.id,
                commandName: "work-on-tasks",
                jobId: job.id,
                commandRunId: commandRun.id,
                taskId: task.task.id,
                taskKey: task.task.key,
                discipline: task.task.type ?? undefined,
                complexity: this.resolveTaskComplexity(task.task),
              });
            } catch (error) {
              const message = `Agent rating failed for ${task.task.key}: ${
                error instanceof Error ? error.message : String(error)
              }`;
              warnings.push(message);
              try {
                await this.logTask(taskRun.id, message, "rating");
              } catch {
                /* ignore rating log failures */
              }
            }
          }
        }
        } finally {
          await emitTaskEndOnce();
        }
    }

    if (abortRemainingReason) {
      warnings.push(`Stopped remaining tasks due to auth/rate limit: ${abortRemainingReason}`);
    }
    const failureCount = results.filter((r) => r.status === "failed").length;
    const state: JobState = abortRemainingReason
      ? "failed"
      : failureCount === 0
        ? "completed"
        : failureCount === results.length
          ? "failed"
          : ("partial" as JobState);
    const errorSummary = abortRemainingReason ?? (failureCount ? `${failureCount} task(s) failed` : undefined);
    const summaryTasks = results.map((result) => {
      const existing = taskSummaries.get(result.taskKey);
      if (existing) return existing;
      const fallbackAdapter = agent.adapter ?? "n/a";
      return {
        taskKey: result.taskKey,
        adapter: fallbackAdapter,
        adapterOverride: agentAdapterOverride,
        provider:
          codaliRequired && codaliProviderInfo ? codaliProviderInfo.provider : resolveProvider(fallbackAdapter),
        model: agent.defaultModel ?? "(default)",
        sourceAdapter: codaliProviderInfo?.sourceAdapter ?? fallbackAdapter,
      };
    });
    await this.deps.jobService.updateJobStatus(job.id, state, {
      processedItems: results.length,
      errorSummary,
      payload: {
        workOnTasks: {
          workRunner: resolvedWorkRunner,
          useCodali: codaliRequired,
          agentAdapterOverride,
          tasks: summaryTasks,
        },
      },
    });
    await this.deps.jobService.finishCommandRun(
      commandRun.id,
      state === "completed" ? "succeeded" : "failed",
      errorSummary,
      storyPointsProcessed || undefined,
    );

    return {
      jobId: job.id,
      commandRunId: commandRun.id,
      selection,
      results,
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await this.deps.jobService.updateJobStatus(job.id, "failed", {
      processedItems: undefined,
      errorSummary: message,
    });
    await this.deps.jobService.finishCommandRun(commandRun.id, "failed", message, storyPointsProcessed || undefined);
    throw error;
  } finally {
    // Best-effort return to base branch after processing.
    try {
      await this.vcs.checkoutBranch(this.workspace.workspaceRoot, baseBranch);
    } catch {
      // ignore if checkout fails (e.g., dirty tree); user can resolve manually.
    }
  }
  }
}
