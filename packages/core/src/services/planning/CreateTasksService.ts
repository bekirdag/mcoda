import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { AgentService } from "@mcoda/agents";
import {
  EpicInsert,
  EpicRow,
  GlobalRepository,
  StoryInsert,
  StoryRow,
  TaskDependencyInsert,
  TaskDependencyRow,
  TaskInsert,
  TaskRow,
  WorkspaceRepository,
} from "@mcoda/db";
import { Agent, type QaEntrypoint, type QaReadiness } from "@mcoda/shared";
import { setTimeout as delay } from "node:timers/promises";
import { DocdexClient, DocdexDocument } from "@mcoda/integrations";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { RoutingService } from "../agents/RoutingService.js";
import { AgentRatingService } from "../agents/AgentRatingService.js";
import { classifyTask } from "../backlog/TaskOrderingHeuristics.js";
import { TaskOrderingService } from "../backlog/TaskOrderingService.js";
import { QaTestCommandBuilder } from "../execution/QaTestCommandBuilder.js";
import {
  createEpicKeyGenerator,
  createStoryKeyGenerator,
  createTaskKeyGenerator,
} from "./KeyHelpers.js";
import { TaskSufficiencyService, type TaskSufficiencyAuditResult } from "./TaskSufficiencyService.js";

export interface CreateTasksOptions {
  workspace: WorkspaceResolution;
  projectKey: string;
  inputs: string[];
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  maxEpics?: number;
  maxStoriesPerEpic?: number;
  maxTasksPerStory?: number;
  force?: boolean;
  qaProfiles?: string[];
  qaEntryUrl?: string;
  qaStartCommand?: string;
  qaRequires?: string[];
}

export interface CreateTasksResult {
  jobId: string;
  commandRunId: string;
  epics: EpicRow[];
  stories: StoryRow[];
  tasks: TaskRow[];
  dependencies: TaskDependencyRow[];
}

interface AgentTaskNode {
  localId?: string;
  title: string;
  type?: string;
  description?: string;
  estimatedStoryPoints?: number;
  priorityHint?: number;
  dependsOnKeys?: string[];
  relatedDocs?: string[];
  unitTests?: string[];
  componentTests?: string[];
  integrationTests?: string[];
  apiTests?: string[];
  qa?: QaReadiness;
}

interface AgentStoryNode {
  localId?: string;
  title: string;
  userStory?: string;
  description?: string;
  acceptanceCriteria?: string[];
  relatedDocs?: string[];
  priorityHint?: number;
  tasks: AgentTaskNode[];
}

interface AgentEpicNode {
  localId?: string;
  area?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  relatedDocs?: string[];
  priorityHint?: number;
  stories: AgentStoryNode[];
}

interface AgentPlan {
  epics: AgentEpicNode[];
}

interface PlanEpic extends AgentEpicNode {
  localId: string;
}

interface PlanStory extends AgentStoryNode {
  localId: string;
  epicLocalId: string;
}

interface PlanTask extends AgentTaskNode {
  localId: string;
  storyLocalId: string;
  epicLocalId: string;
}

interface GeneratedPlan {
  epics: PlanEpic[];
  stories: PlanStory[];
  tasks: PlanTask[];
}

type ServiceDependencyGraph = {
  services: string[];
  dependencies: Map<string, Set<string>>;
  aliases: Map<string, Set<string>>;
  waveRank: Map<string, number>;
  startupWaves: Array<{ wave: number; services: string[] }>;
  foundationalDependencies: string[];
};

type QaPreflight = {
  scripts: Record<string, string>;
  entrypoints: QaEntrypoint[];
  blockers: string[];
};

type PersistPlanOptions = {
  force?: boolean;
  resetKeys?: boolean;
  qaPreflight?: QaPreflight;
  qaOverrides?: QaReadiness;
};

type TaskOrderingClient = Pick<TaskOrderingService, "orderTasks" | "close">;
type TaskOrderingFactory = (
  workspace: WorkspaceResolution,
  options?: { recordTelemetry?: boolean },
) => Promise<TaskOrderingClient>;

type TaskSufficiencyClient = Pick<TaskSufficiencyService, "runAudit" | "close">;
type TaskSufficiencyFactory = (workspace: WorkspaceResolution) => Promise<TaskSufficiencyClient>;

const formatBullets = (items: string[] | undefined, fallback: string): string => {
  if (!items || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeEntrypoints = (value: unknown): QaEntrypoint[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const kind = record.kind;
      if (kind !== "web" && kind !== "api" && kind !== "cli") return null;
      return {
        kind,
        base_url: typeof record.base_url === "string" ? record.base_url : undefined,
        command: typeof record.command === "string" ? record.command : undefined,
      } as QaEntrypoint;
    })
    .filter((entry): entry is QaEntrypoint => Boolean(entry));
};

const normalizeQaReadiness = (value: unknown): QaReadiness | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const qa: QaReadiness = {
    profiles_expected: normalizeStringArray(record.profiles_expected),
    requires: normalizeStringArray(record.requires),
    entrypoints: normalizeEntrypoints(record.entrypoints),
    data_setup: normalizeStringArray(record.data_setup),
    blockers: normalizeStringArray(record.blockers),
    notes: typeof record.notes === "string" ? record.notes : undefined,
  };
  const hasValues =
    (qa.profiles_expected?.length ?? 0) > 0 ||
    (qa.requires?.length ?? 0) > 0 ||
    (qa.entrypoints?.length ?? 0) > 0 ||
    (qa.data_setup?.length ?? 0) > 0 ||
    (qa.blockers?.length ?? 0) > 0 ||
    (qa.notes?.length ?? 0) > 0;
  return hasValues ? qa : undefined;
};

const uniqueStrings = (items: string[]): string[] => Array.from(new Set(items));

const uniqueEntrypoints = (items: QaEntrypoint[]): QaEntrypoint[] => {
  const seen = new Set<string>();
  const result: QaEntrypoint[] = [];
  for (const entry of items) {
    const key = `${entry.kind}|${entry.base_url ?? ""}|${entry.command ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
};

const buildQaReadiness = (params: {
  classification: { stage: string };
  planQa?: QaReadiness;
  preflight?: QaPreflight;
  overrides?: QaReadiness;
}): QaReadiness => {
  const derivedProfiles = ["cli"];
  if (params.classification.stage === "frontend") derivedProfiles.push("chromium");
  if (params.classification.stage === "backend") derivedProfiles.push("api");
  const profilesExpected = uniqueStrings([
    ...derivedProfiles,
    ...(params.overrides?.profiles_expected ?? []),
    ...(params.planQa?.profiles_expected ?? []),
  ]);
  const entrypoints = uniqueEntrypoints([
    ...(params.overrides?.entrypoints ?? []),
    ...(params.planQa?.entrypoints ?? []),
    ...(params.classification.stage === "frontend" ? params.preflight?.entrypoints ?? [] : []),
  ]);
  const blockers = uniqueStrings([
    ...(params.overrides?.blockers ?? []),
    ...(params.planQa?.blockers ?? []),
    ...(params.preflight?.blockers ?? []),
  ]);
  if (params.classification.stage === "frontend" && entrypoints.length === 0) {
    blockers.push("Missing UI entrypoint (dev/start script).");
  }
  return {
    profiles_expected: profilesExpected,
    requires: uniqueStrings([...(params.overrides?.requires ?? []), ...(params.planQa?.requires ?? [])]),
    entrypoints: entrypoints.length ? entrypoints : undefined,
    data_setup: uniqueStrings([...(params.overrides?.data_setup ?? []), ...(params.planQa?.data_setup ?? [])]),
    blockers: blockers.length ? blockers : undefined,
    notes: params.overrides?.notes ?? params.planQa?.notes,
  };
};

const formatTestList = (items: string[] | undefined): string => {
  if (!items || items.length === 0) return "Not applicable";
  return items.join("; ");
};

const ensureNonEmpty = (value: string | undefined, fallback: string): string =>
  value && value.trim().length > 0 ? value.trim() : fallback;

const normalizeTaskLine = (line: string): string => line.replace(/^[-*]\s+/, "").trim();

const looksLikeSectionHeader = (line: string): boolean => /^\* \*\*.+\*\*$/.test(line.trim());

const isReferenceOnlyLine = (line: string): boolean =>
  /^(epic|story|references?|related docs?|inputs?|objective|context|implementation plan|definition of done|testing & qa)\s*:/i.test(
    line.trim(),
  );

const extractActionableLines = (description: string | undefined, limit: number): string[] => {
  if (!description) return [];
  const lines = description
    .split(/\r?\n/)
    .map((line) => normalizeTaskLine(line))
    .filter(Boolean)
    .filter((line) => !looksLikeSectionHeader(line))
    .filter((line) => !isReferenceOnlyLine(line));
  const actionable = lines.filter((line) =>
    /^(?:\d+[.)]\s+|implement\b|create\b|update\b|add\b|define\b|wire\b|integrate\b|enforce\b|publish\b|configure\b|materialize\b|validate\b|verify\b)/i.test(
      line,
    ),
  );
  const source = actionable.length > 0 ? actionable : lines;
  return uniqueStrings(source.slice(0, limit));
};

const extractRiskLines = (description: string | undefined, limit: number): string[] => {
  if (!description) return [];
  const lines = description
    .split(/\r?\n/)
    .map((line) => normalizeTaskLine(line))
    .filter(Boolean)
    .filter((line) => !looksLikeSectionHeader(line));
  const risks = lines.filter((line) => /\b(risk|edge case|gotcha|constraint|failure|flaky|drift|regression)\b/i.test(line));
  return uniqueStrings(risks.slice(0, limit));
};

const extractScriptPort = (script: string): number | undefined => {
  const matches = [script.match(/(?:--port|-p)\s*(\d{2,5})/), script.match(/PORT\s*=\s*(\d{2,5})/)];
  for (const match of matches) {
    if (!match) continue;
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
};

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));
const DOC_CONTEXT_BUDGET = 8000;
const DOC_CONTEXT_SEGMENTS_PER_DOC = 8;
const DOC_CONTEXT_FALLBACK_CHUNK_LENGTH = 480;
const SDS_COVERAGE_HINT_HEADING_LIMIT = 24;
const SDS_COVERAGE_REPORT_SECTION_LIMIT = 80;
const OPENAPI_HINT_OPERATIONS_LIMIT = 30;
const DOCDEX_HANDLE = /^docdex:/i;
const DOCDEX_LOCAL_HANDLE = /^docdex:local[-:/]/i;
const RELATED_DOC_PATH_PATTERN =
  /^(?:~\/|\/|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+\/)[A-Za-z0-9._/-]+(?:\.[A-Za-z0-9._-]+)?(?:#[A-Za-z0-9._:-]+)?$/;
const RELATIVE_DOC_PATH_PATTERN = /^(?:\.{1,2}\/)+[A-Za-z0-9._/-]+(?:\.[A-Za-z0-9._-]+)?(?:#[A-Za-z0-9._:-]+)?$/;
const FUZZY_DOC_CANDIDATE_LIMIT = 64;
const DEPENDENCY_SCAN_LINE_LIMIT = 1400;
const STARTUP_WAVE_SCAN_LINE_LIMIT = 4000;
const VALID_AREAS = new Set(["web", "adm", "bck", "ops", "infra", "mobile"]);
const VALID_TASK_TYPES = new Set(["feature", "bug", "chore", "spike"]);

const inferDocType = (filePath: string): string => {
  const name = path.basename(filePath).toLowerCase();
  if (name.includes("openapi") || name.includes("swagger")) return "OPENAPI";
  if (name.includes("sds")) return "SDS";
  if (name.includes("pdr")) return "PDR";
  if (name.includes("rfp")) return "RFP";
  return "DOC";
};

const normalizeArea = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const tokens = value
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (VALID_AREAS.has(token)) return token;
  }
  return undefined;
};

const normalizeTaskType = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const tokens = value
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (VALID_TASK_TYPES.has(token)) return token;
  }
  return undefined;
};

const normalizeRelatedDocs = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    const candidate =
      typeof entry === "string"
        ? entry.trim()
        : entry && typeof entry === "object" && "handle" in entry && typeof entry.handle === "string"
          ? entry.handle.trim()
          : "";
    if (!candidate) continue;
    if (DOCDEX_LOCAL_HANDLE.test(candidate)) continue;
    const isDocHandle = DOCDEX_HANDLE.test(candidate);
    const isHttp = /^https?:\/\/\S+$/i.test(candidate);
    const isPath = RELATED_DOC_PATH_PATTERN.test(candidate) || RELATIVE_DOC_PATH_PATTERN.test(candidate);
    if (!isDocHandle && !isHttp && !isPath) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
};

const extractMarkdownHeadings = (value: string, limit: number): string[] => {
  if (!value) return [];
  const lines = value.split(/\r?\n/);
  const headings: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    const hashHeading = line.match(/^#{1,6}\s+(.+)$/);
    if (hashHeading) {
      headings.push(hashHeading[1]!.trim());
    } else if (
      index + 1 < lines.length &&
      /^[=-]{3,}\s*$/.test((lines[index + 1] ?? "").trim()) &&
      !line.startsWith("-") &&
      !line.startsWith("*")
    ) {
      headings.push(line);
    }
    if (headings.length >= limit) break;
  }
  return uniqueStrings(
    headings
      .map((entry) => entry.replace(/[`*_]/g, "").trim())
      .filter(Boolean),
  );
};

const pickDistributedIndices = (length: number, limit: number): number[] => {
  if (length <= 0 || limit <= 0) return [];
  if (length <= limit) return Array.from({ length }, (_, index) => index);
  const selected = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    const ratio = limit === 1 ? 0 : index / (limit - 1);
    selected.add(Math.round(ratio * (length - 1)));
  }
  return Array.from(selected)
    .sort((a, b) => a - b)
    .slice(0, limit);
};

const sampleRawContent = (value: string | undefined, chunkLength: number): string[] => {
  if (!value) return [];
  const content = value.trim();
  if (!content) return [];
  if (content.length <= chunkLength) return [content];
  const anchors = [
    0,
    Math.max(0, Math.floor(content.length / 2) - Math.floor(chunkLength / 2)),
    Math.max(0, content.length - chunkLength),
  ];
  const sampled = anchors.map((anchor) => content.slice(anchor, anchor + chunkLength).trim()).filter(Boolean);
  return uniqueStrings(sampled);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseStructuredDoc = (raw: string): Record<string, unknown> | undefined => {
  if (!raw || raw.trim().length === 0) return undefined;
  try {
    const parsed = YAML.parse(raw);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // fallback to JSON parse
  }
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // ignore invalid fallback parse
  }
  return undefined;
};

const describeDoc = (doc: DocdexDocument, idx: number): string => {
  const title = doc.title ?? doc.path ?? doc.id ?? `doc-${idx + 1}`;
  const source = doc.path ?? doc.id ?? "docdex";
  const head = doc.content ? doc.content.split(/\r?\n/).slice(0, 3).join(" ").slice(0, 240) : "";
  return `- [${doc.docType}] ${title} (handle: docdex:${doc.id ?? `doc-${idx + 1}`}, source: ${source})${
    head ? `\n  Excerpt: ${head}` : ""
  }`;
};

const extractJson = (raw: string): any | undefined => {
  const fencedMatches = [...raw.matchAll(/```json([\s\S]*?)```/g)].map((match) => match[1]);
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const candidates = [...fencedMatches, stripped, raw].filter((candidate) => candidate.trim().length > 0);
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed && isPlanShape(parsed)) return parsed;
  }
  return undefined;
};

const isPlanShape = (value: any): boolean => {
  if (!value || typeof value !== "object") return false;
  return Array.isArray(value.epics) || Array.isArray(value.stories) || Array.isArray(value.tasks);
};

const tryParseJson = (value: string): any | undefined => {
  try {
    return JSON.parse(value);
  } catch {
    // continue
  }
  const objects = extractJsonObjects(value).reverse();
  for (const obj of objects) {
    try {
      return JSON.parse(obj);
    } catch {
      // continue
    }
  }
  return undefined;
};

const extractJsonObjects = (value: string): string[] => {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(value.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
};

const buildEpicDescription = (
  epicKey: string,
  title: string,
  description: string | undefined,
  acceptance: string[] | undefined,
  relatedDocs: string[] | undefined,
): string => {
  return [
    `* **Epic Key**: ${epicKey}`,
    `* **Epic Title**: ${title}`,
    "* **Context / Problem**",
    "",
    ensureNonEmpty(description, "Summarize the problem, users, and constraints for this epic."),
    "* **Goals & Outcomes**",
    formatBullets(acceptance, "List measurable outcomes for this epic."),
    "* **In Scope**",
    "- Clarify during refinement; derived from RFP/PDR/SDS.",
    "* **Out of Scope**",
    "- To be defined; exclude unrelated systems.",
    "* **Key Flows / Scenarios**",
    "- Outline primary user flows for this epic.",
    "* **Non-functional Requirements**",
    "- Performance, security, reliability expectations go here.",
    "* **Dependencies & Constraints**",
    "- Capture upstream/downstream systems and blockers.",
    "* **Risks & Open Questions**",
    "- Identify risks and unknowns to resolve.",
    "* **Acceptance Criteria**",
    formatBullets(acceptance, "Provide 5–10 testable acceptance criteria."),
    "* **Related Documentation / References**",
    formatBullets(relatedDocs, "Link relevant docdex entries and sections."),
  ].join("\n");
};

const buildStoryDescription = (
  storyKey: string,
  title: string,
  userStory: string | undefined,
  description: string | undefined,
  acceptanceCriteria: string[] | undefined,
  relatedDocs: string[] | undefined,
): string => {
  return [
    `* **Story Key**: ${storyKey}`,
    "* **User Story**",
    "",
    ensureNonEmpty(userStory, `As a user, I want ${title} so that it delivers value.`),
    "* **Context**",
    "",
    ensureNonEmpty(description, "Context for systems, dependencies, and scope."),
    "* **Preconditions / Assumptions**",
    "- Confirm required data, environments, and access.",
    "* **Main Flow**",
    "- Outline the happy path for this story.",
    "* **Alternative / Error Flows**",
    "- Capture error handling and non-happy paths.",
    "* **UX / UI Notes**",
    "- Enumerate screens/states if applicable.",
    "* **Data & Integrations**",
    "- Note key entities, APIs, queues, or third-party dependencies.",
    "* **Acceptance Criteria**",
    formatBullets(acceptanceCriteria, "List testable outcomes for this story."),
    "* **Non-functional Requirements**",
    "- Add story-specific performance/reliability/security expectations.",
    "* **Related Documentation / References**",
    formatBullets(relatedDocs, "Docdex handles, OpenAPI endpoints, code modules."),
  ].join("\n");
};

const buildTaskDescription = (
  taskKey: string,
  title: string,
  description: string | undefined,
  storyKey: string,
  epicKey: string,
  relatedDocs: string[] | undefined,
  dependencies: string[],
  tests: {
    unitTests?: string[];
    componentTests?: string[];
    integrationTests?: string[];
    apiTests?: string[];
  },
  qa?: QaReadiness,
): string => {
  const formatEntrypoints = (entrypoints: QaEntrypoint[] | undefined): string => {
    if (!entrypoints || entrypoints.length === 0) return "- Not specified";
    return entrypoints
      .map((entry) => {
        const target = entry.base_url ?? entry.command ?? "TBD";
        return `- ${entry.kind}: ${target}`;
      })
      .join("\n");
  };
  const objectiveText = ensureNonEmpty(description, `Deliver ${title} for story ${storyKey}.`);
  const implementationLines = extractActionableLines(description, 4);
  const riskLines = extractRiskLines(description, 3);
  const testsDefined =
    (tests.unitTests?.length ?? 0) +
      (tests.componentTests?.length ?? 0) +
      (tests.integrationTests?.length ?? 0) +
      (tests.apiTests?.length ?? 0) >
    0;
  const definitionOfDone = [
    `- Implementation for \`${taskKey}\` is complete and scoped to ${storyKey}.`,
    testsDefined
      ? "- Task-specific tests are added/updated and green in the task validation loop."
      : "- Verification evidence is captured in task logs/checklists for this scope.",
    relatedDocs?.length
      ? "- Related contracts/docs are consistent with delivered behavior."
      : "- Documentation impact is reviewed and no additional contract docs are required.",
    qa?.blockers?.length ? "- Remaining QA blockers are explicit and actionable." : "- QA blockers are resolved or not present.",
  ];
  const defaultImplementationPlan = [
    `- Implement ${title} with file/module-level changes aligned to the objective.`,
    dependencies.length
      ? `- Respect dependency order before completion: ${dependencies.join(", ")}.`
      : "- Validate assumptions and finalize concrete implementation steps before coding.",
  ];
  const defaultRisks = dependencies.length
    ? [`- Delivery depends on upstream tasks: ${dependencies.join(", ")}.`]
    : ["- Keep implementation aligned to SDS/OpenAPI contracts to avoid drift."];
  return [
    `* **Task Key**: ${taskKey}`,
    "* **Objective**",
    "",
    objectiveText,
    "* **Context**",
    "",
    `- Epic: ${epicKey}`,
    `- Story: ${storyKey}`,
    "* **Inputs**",
    formatBullets(relatedDocs, "Docdex excerpts, SDS/PDR/RFP sections, OpenAPI endpoints."),
    "* **Implementation Plan**",
    formatBullets(implementationLines, defaultImplementationPlan.join(" ")),
    "* **Definition of Done**",
    definitionOfDone.join("\n"),
    "* **Testing & QA**",
    `- Unit tests: ${formatTestList(tests.unitTests)}`,
    `- Component tests: ${formatTestList(tests.componentTests)}`,
    `- Integration tests: ${formatTestList(tests.integrationTests)}`,
    `- API tests: ${formatTestList(tests.apiTests)}`,
    "* **QA Readiness**",
    `- Profiles: ${qa?.profiles_expected?.length ? qa.profiles_expected.join(", ") : "TBD"}`,
    `- Requires: ${qa?.requires?.length ? qa.requires.join("; ") : "None specified"}`,
    `- Data setup: ${qa?.data_setup?.length ? qa.data_setup.join("; ") : "None specified"}`,
    "* **QA Entry Points**",
    formatEntrypoints(qa?.entrypoints),
    "* **QA Blockers**",
    formatBullets(qa?.blockers, "None known."),
    "* **Dependencies**",
    formatBullets(dependencies, "Enumerate prerequisite tasks by key."),
    "* **Risks & Gotchas**",
    formatBullets(riskLines, defaultRisks.join(" ")),
    "* **Related Documentation / References**",
    formatBullets(relatedDocs, "Docdex handles or file paths to consult."),
  ].join("\n");
};

const collectFilesRecursively = async (target: string): Promise<string[]> => {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target);
    const results: string[] = [];
    for (const entry of entries) {
      const child = path.join(target, entry);
      const childStat = await fs.stat(child);
      if (childStat.isDirectory()) {
        results.push(...(await collectFilesRecursively(child)));
      } else {
        results.push(child);
      }
    }
    return results;
  }
  return [target];
};

const DOC_SCAN_MAX_DEPTH = 5;
const DOC_SCAN_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".mcoda",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "tmp",
  "temp",
]);
const DOC_SCAN_FILE_PATTERN = /\.(md|markdown|txt|rst|ya?ml|json)$/i;
const STRICT_SDS_PATH_PATTERN =
  /(^|\/)(sds(?:[-_. ][a-z0-9]+)?|software[-_ ]design(?:[-_ ](?:spec|specification|outline|doc))?|design[-_ ]spec(?:ification)?)(\/|[-_.]|$)/i;
const STRICT_SDS_CONTENT_PATTERN =
  /\b(software design specification|software design document|system design specification|\bSDS\b)\b/i;
const SDS_LIKE_PATH_PATTERN =
  /(^|\/)(sds|software[-_ ]design|design[-_ ]spec|requirements|prd|pdr|rfp|architecture|solution[-_ ]design)/i;
const OPENAPI_LIKE_PATH_PATTERN = /(openapi|swagger)/i;
const STRUCTURE_LIKE_PATH_PATTERN = /(^|\/)(tree|structure|layout|folder|directory|services?|modules?)(\/|[-_.]|$)/i;
const DOC_PATH_TOKEN_PATTERN = /(^|[\s`"'([{<])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?=$|[\s`"')\]}>.,;:!?])/g;
const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{1,10}$/i;
const TOP_LEVEL_STRUCTURE_PATTERN = /^[a-z][a-z0-9._-]{1,60}$/i;
const SERVICE_PATH_CONTAINER_SEGMENTS = new Set([
  "services",
  "service",
  "apps",
  "app",
  "packages",
  "package",
  "modules",
  "module",
  "libs",
  "lib",
  "src",
]);
const SERVICE_NAME_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "with",
  "by",
  "from",
  "layer",
  "stack",
  "system",
  "platform",
  "project",
  "repository",
  "codebase",
  "component",
  "feature",
  "implement",
  "build",
  "create",
  "develop",
  "deliver",
  "setup",
  "set",
  "provision",
  "define",
  "configure",
  "add",
  "update",
  "refactor",
  "init",
  "initialize",
  "prepare",
  "establish",
  "support",
  "enable",
]);
const SERVICE_NAME_INVALID = new Set([
  "service",
  "services",
  "module",
  "modules",
  "app",
  "apps",
  "layer",
  "stack",
  "system",
  "project",
  "repository",
  "codebase",
]);
const SERVICE_LABEL_PATTERN =
  /\b([A-Za-z][A-Za-z0-9]*(?:[ _/-]+[A-Za-z][A-Za-z0-9]*){0,3})\s+(service|api|backend|frontend|worker|gateway|database|db|ui|client|server|adapter)\b/gi;
const SERVICE_ARROW_PATTERN =
  /([A-Za-z][A-Za-z0-9 _/-]{1,80})\s*(?:->|=>|→)\s*([A-Za-z][A-Za-z0-9 _/-]{1,80})/g;
const SERVICE_HANDLE_PATTERN = /\b((?:svc|ui|worker)-[a-z0-9-*]+)\b/gi;
const WAVE_LABEL_PATTERN = /\bwave\s*([0-9]{1,2})\b/i;

const nextUniqueLocalId = (prefix: string, existing: Set<string>): string => {
  let index = 1;
  let candidate = `${prefix}-${index}`;
  while (existing.has(candidate)) {
    index += 1;
    candidate = `${prefix}-${index}`;
  }
  existing.add(candidate);
  return candidate;
};

const looksLikeSdsPath = (value: string): boolean => STRICT_SDS_PATH_PATTERN.test(value.replace(/\\/g, "/").toLowerCase());

const looksLikeSdsDoc = (doc: DocdexDocument): boolean => {
  if ((doc.docType ?? "").toUpperCase() === "SDS") return true;
  const pathOrTitle = `${doc.path ?? ""}\n${doc.title ?? ""}`;
  if (looksLikeSdsPath(pathOrTitle)) return true;
  const sample = [doc.content ?? "", ...(doc.segments ?? []).slice(0, 4).map((seg) => seg.content ?? "")]
    .join("\n")
    .slice(0, 5000);
  return STRICT_SDS_CONTENT_PATTERN.test(sample);
};

const EPIC_SCHEMA_SNIPPET = `{
  "epics": [
    {
      "localId": "e1",
      "area": "web|adm|bck|ops|infra|mobile",
      "title": "Epic title",
      "description": "Epic description using the epic template",
      "acceptanceCriteria": ["criterion"],
      "relatedDocs": ["docdex:..."],
      "priorityHint": 50
    }
  ]
}`;

const STORY_SCHEMA_SNIPPET = `{
  "stories": [
    {
      "localId": "us1",
      "title": "Story title",
      "userStory": "As a ...",
      "description": "Story description using the template",
      "acceptanceCriteria": ["criterion"],
      "relatedDocs": ["docdex:..."],
      "priorityHint": 50
    }
  ]
}`;

const TASK_SCHEMA_SNIPPET = `{
  "tasks": [
    {
      "localId": "t1",
      "title": "Task title",
      "type": "feature|bug|chore|spike",
      "description": "Task description using the template",
      "estimatedStoryPoints": 3,
      "priorityHint": 50,
      "dependsOnKeys": ["t0"],
      "relatedDocs": ["docdex:..."],
      "unitTests": ["unit test description"],
      "componentTests": ["component test description"],
      "integrationTests": ["integration test description"],
      "apiTests": ["api test description"],
      "qa": {
        "profiles_expected": ["cli", "api", "chromium"],
        "requires": ["dev server", "seed data"],
        "entrypoints": [{ "kind": "web", "base_url": "http://localhost:<PORT>", "command": "npm run dev" }],
        "data_setup": ["seed sample data"],
        "notes": "optional QA notes"
      }
    }
  ]
}`;

export class CreateTasksService {
  private static readonly MAX_BUSY_RETRIES = 6;
  private static readonly BUSY_BACKOFF_MS = 500;
  private docdex: DocdexClient;
  private jobService: JobService;
  private agentService: AgentService;
  private repo: GlobalRepository;
  private workspaceRepo: WorkspaceRepository;
  private routingService: RoutingService;
  private workspace: WorkspaceResolution;
  private ratingService?: AgentRatingService;
  private taskOrderingFactory: TaskOrderingFactory;
  private taskSufficiencyFactory: TaskSufficiencyFactory;

  constructor(
    workspace: WorkspaceResolution,
    deps: {
      docdex: DocdexClient;
      jobService: JobService;
      agentService: AgentService;
      repo: GlobalRepository;
      workspaceRepo: WorkspaceRepository;
      routingService: RoutingService;
      ratingService?: AgentRatingService;
      taskOrderingFactory?: TaskOrderingFactory;
      taskSufficiencyFactory?: TaskSufficiencyFactory;
    },
  ) {
    this.workspace = workspace;
    this.docdex = deps.docdex;
    this.jobService = deps.jobService;
    this.agentService = deps.agentService;
    this.repo = deps.repo;
    this.workspaceRepo = deps.workspaceRepo;
    this.routingService = deps.routingService;
    this.ratingService = deps.ratingService;
    this.taskOrderingFactory = deps.taskOrderingFactory ?? TaskOrderingService.create;
    this.taskSufficiencyFactory = deps.taskSufficiencyFactory ?? TaskSufficiencyService.create;
  }

  static async create(workspace: WorkspaceResolution): Promise<CreateTasksService> {
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
    const jobService = new JobService(workspace);
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    return new CreateTasksService(workspace, {
      docdex,
      jobService,
      agentService,
      repo,
      workspaceRepo,
      routingService,
      taskSufficiencyFactory: TaskSufficiencyService.create,
    });
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
    await swallow((this.workspaceRepo as any).close?.bind(this.workspaceRepo));
    await swallow((this.routingService as any).close?.bind(this.routingService));
    const docdex = this.docdex as any;
    await swallow(docdex?.close?.bind(docdex));
  }

  private storyScopeKey(epicLocalId: string, storyLocalId: string): string {
    return `${epicLocalId}::${storyLocalId}`;
  }

  private taskScopeKey(epicLocalId: string, storyLocalId: string, taskLocalId: string): string {
    return `${epicLocalId}::${storyLocalId}::${taskLocalId}`;
  }

  private scopeStory(story: Pick<PlanStory, "epicLocalId" | "localId">): string {
    return this.storyScopeKey(story.epicLocalId, story.localId);
  }

  private scopeTask(task: Pick<PlanTask, "epicLocalId" | "storyLocalId" | "localId">): string {
    return this.taskScopeKey(task.epicLocalId, task.storyLocalId, task.localId);
  }

  private async seedPriorities(projectKey: string): Promise<void> {
    const ordering = await this.taskOrderingFactory(this.workspace, { recordTelemetry: false });
    try {
      await ordering.orderTasks({
        projectKey,
        apply: true,
      });
    } finally {
      await ordering.close();
    }
  }

  private async resolveAgent(agentName?: string): Promise<Agent> {
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: "create-tasks",
      overrideAgentSlug: agentName,
    });
    return resolved.agent;
  }

  private ensureRatingService(): AgentRatingService {
    if (!this.ratingService) {
      this.ratingService = new AgentRatingService(this.workspace, {
        workspaceRepo: this.workspaceRepo,
        globalRepo: this.repo,
        agentService: this.agentService,
        routingService: this.routingService,
      });
    }
    return this.ratingService;
  }

  private async prepareDocs(inputs: string[]): Promise<DocdexDocument[]> {
    const primaryInputs = inputs.length > 0 ? inputs : await this.resolveDefaultDocInputs();
    let documents = await this.collectDocsFromInputs(primaryInputs);
    if (!documents.some((doc) => looksLikeSdsDoc(doc))) {
      const fallbackInputs = await this.resolveDefaultDocInputs();
      if (fallbackInputs.length > 0) {
        const alreadyUsed = new Set(primaryInputs.map((input) => this.normalizeDocInputForSet(input)));
        const missingInputs = fallbackInputs.filter(
          (candidate) => !alreadyUsed.has(this.normalizeDocInputForSet(candidate)),
        );
        if (missingInputs.length > 0) {
          const discovered = await this.collectDocsFromInputs(missingInputs);
          documents = this.mergeDocs(documents, discovered);
        }
      }
    }
    if (!documents.some((doc) => looksLikeSdsDoc(doc))) {
      throw new Error(
        "create-tasks requires at least one SDS document. Add an SDS file (for example docs/sds.md) or pass SDS paths as input.",
      );
    }
    return this.sortDocsForPlanning(documents);
  }

  private normalizeDocInputForSet(input: string): string {
    if (input.startsWith("docdex:")) return input.trim().toLowerCase();
    const resolved = path.isAbsolute(input) ? input : path.join(this.workspace.workspaceRoot, input);
    return path.resolve(resolved).toLowerCase();
  }

  private docIdentity(doc: DocdexDocument): string {
    const pathKey = `${doc.path ?? ""}`.trim().toLowerCase();
    const idKey = `${doc.id ?? ""}`.trim().toLowerCase();
    if (pathKey) return `path:${pathKey}`;
    if (idKey) return `id:${idKey}`;
    const titleKey = `${doc.title ?? ""}`.trim().toLowerCase();
    if (titleKey) return `title:${titleKey}`;
    const sample = `${doc.content ?? doc.segments?.[0]?.content ?? ""}`.slice(0, 120).toLowerCase();
    return `sample:${sample}`;
  }

  private mergeDocs(base: DocdexDocument[], incoming: DocdexDocument[]): DocdexDocument[] {
    const merged = [...base];
    const seen = new Set(merged.map((doc) => this.docIdentity(doc)));
    for (const doc of incoming) {
      const identity = this.docIdentity(doc);
      if (seen.has(identity)) continue;
      seen.add(identity);
      merged.push(doc);
    }
    return merged;
  }

  private sortDocsForPlanning(docs: DocdexDocument[]): DocdexDocument[] {
    return [...docs].sort((a, b) => {
      const aIsSds = looksLikeSdsDoc(a) ? 0 : 1;
      const bIsSds = looksLikeSdsDoc(b) ? 0 : 1;
      if (aIsSds !== bIsSds) return aIsSds - bIsSds;
      const byUpdated = `${b.updatedAt ?? ""}`.localeCompare(`${a.updatedAt ?? ""}`);
      if (byUpdated !== 0) return byUpdated;
      return `${a.path ?? a.title ?? ""}`.localeCompare(`${b.path ?? b.title ?? ""}`);
    });
  }

  private async collectDocsFromInputs(resolvedInputs: string[]): Promise<DocdexDocument[]> {
    if (resolvedInputs.length === 0) return [];
    const documents: DocdexDocument[] = [];
    for (const input of resolvedInputs) {
      if (input.startsWith("docdex:")) {
        const docId = input.replace(/^docdex:/, "");
        try {
          const doc = await this.docdex.fetchDocumentById(docId);
          documents.push(doc);
        } catch (error) {
          throw new Error(`Docdex reference failed (${docId}): ${(error as Error).message}`);
        }
        continue;
      }
      const resolved = path.isAbsolute(input) ? input : path.join(this.workspace.workspaceRoot, input);
      let paths: string[];
      try {
        paths = await collectFilesRecursively(resolved);
      } catch (error) {
        throw new Error(`Failed to read input ${input}: ${(error as Error).message}`);
      }
      for (const filePath of paths) {
        const baseName = path.basename(filePath);
        if (baseName.endsWith(".meta.json") || baseName.endsWith("-first-draft.md")) continue;
        if (!/\.(md|markdown|ya?ml|json)$/i.test(baseName)) continue;
        const docType = inferDocType(filePath);
        try {
          const doc = await this.docdex.ensureRegisteredFromFile(filePath, docType, {
            projectKey: this.workspace.workspaceId,
          });
          documents.push(doc);
        } catch (error) {
          throw new Error(`Docdex register failed for ${filePath}: ${(error as Error).message}`);
        }
      }
    }
    return documents;
  }

  private async resolveDefaultDocInputs(): Promise<string[]> {
    const candidates = [
      path.join(this.workspace.mcodaDir, "docs"),
      path.join(this.workspace.workspaceRoot, "docs"),
      path.join(this.workspace.workspaceRoot, "openapi"),
      path.join(this.workspace.workspaceRoot, "openapi.yaml"),
      path.join(this.workspace.workspaceRoot, "openapi.yml"),
      path.join(this.workspace.workspaceRoot, "openapi.json"),
    ];
    const existing: string[] = [];
    const existingSet = new Set<string>();
    const existingDirectories: string[] = [];
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        const resolved = path.resolve(candidate);
        if (!stat.isFile() && !stat.isDirectory()) continue;
        if (existingSet.has(resolved)) continue;
        existing.push(resolved);
        existingSet.add(resolved);
        if (stat.isDirectory()) existingDirectories.push(resolved);
      } catch {
        // Ignore missing candidates; fall back to empty inputs.
      }
    }
    const fuzzy = await this.findFuzzyDocInputs();
    if (existing.length === 0) return fuzzy;
    const isCoveredByDefaultInputs = (candidate: string): boolean => {
      const resolved = path.resolve(candidate);
      if (existingSet.has(resolved)) return true;
      for (const directory of existingDirectories) {
        const relative = path.relative(directory, resolved);
        if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return true;
      }
      return false;
    };
    const extras = fuzzy.filter((candidate) => !isCoveredByDefaultInputs(candidate));
    return [...existing, ...extras];
  }

  private async walkDocCandidates(
    currentDir: string,
    depth: number,
    collector: (filePath: string) => void,
  ): Promise<void> {
    if (depth > DOC_SCAN_MAX_DEPTH) return;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (DOC_SCAN_IGNORE_DIRS.has(entry.name.toLowerCase())) continue;
        await this.walkDocCandidates(entryPath, depth + 1, collector);
        continue;
      }
      if (entry.isFile()) {
        collector(entryPath);
      }
    }
  }

  private scoreDocCandidate(filePath: string): number {
    const workspaceRelative = path.relative(this.workspace.workspaceRoot, filePath).replace(/\\/g, "/").toLowerCase();
    const mcodaRelative = path.relative(this.workspace.mcodaDir, filePath).replace(/\\/g, "/").toLowerCase();
    const relative =
      workspaceRelative && !workspaceRelative.startsWith("..")
        ? workspaceRelative
        : mcodaRelative && !mcodaRelative.startsWith("..")
          ? mcodaRelative
          : path.basename(filePath).toLowerCase();
    const normalized = `/${relative}`;
    const baseName = path.basename(relative);
    if (!DOC_SCAN_FILE_PATTERN.test(baseName)) return 0;
    let score = 0;
    if (SDS_LIKE_PATH_PATTERN.test(normalized)) score += 100;
    if (OPENAPI_LIKE_PATH_PATTERN.test(normalized)) score += 80;
    if (STRUCTURE_LIKE_PATH_PATTERN.test(normalized)) score += 30;
    if (normalized.includes("/docs/")) score += 20;
    if (normalized.endsWith(".md") || normalized.endsWith(".markdown")) score += 10;
    return score;
  }

  private async findFuzzyDocInputs(): Promise<string[]> {
    const ranked: Array<{ path: string; score: number }> = [];
    const seen = new Set<string>();
    const collect = (candidate: string) => {
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) return;
      const score = this.scoreDocCandidate(resolved);
      if (score <= 0) return;
      ranked.push({ path: resolved, score });
      seen.add(resolved);
    };
    await this.walkDocCandidates(this.workspace.workspaceRoot, 0, collect);
    const mcodaDocs = path.join(this.workspace.mcodaDir, "docs");
    try {
      const stat = await fs.stat(mcodaDocs);
      if (stat.isDirectory()) {
        await this.walkDocCandidates(mcodaDocs, 0, collect);
      }
    } catch {
      // Ignore missing workspace docs.
    }
    return ranked
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, FUZZY_DOC_CANDIDATE_LIMIT)
      .map((entry) => entry.path);
  }

  private normalizeStructurePathToken(value: string): string | undefined {
    const normalized = value
      .replace(/\\/g, "/")
      .replace(/^[./]+/, "")
      .replace(/^\/+/, "")
      .trim();
    if (!normalized) return undefined;
    if (normalized.length > 140) return undefined;
    if (!normalized.includes("/")) return undefined;
    if (normalized.includes("://")) return undefined;
    if (/[\u0000-\u001f]/.test(normalized)) return undefined;
    const hadTrailingSlash = /\/$/.test(normalized);
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length < 2 && !(hadTrailingSlash && parts.length === 1)) return undefined;
    if (parts.some((part) => part === "." || part === "..")) return undefined;
    if (parts.length === 1 && !TOP_LEVEL_STRUCTURE_PATTERN.test(parts[0])) return undefined;
    if (DOC_SCAN_IGNORE_DIRS.has(parts[0].toLowerCase())) return undefined;
    return parts.join("/");
  }

  private extractStructureTargets(docs: DocdexDocument[]): { directories: string[]; files: string[] } {
    const directories = new Set<string>();
    const files = new Set<string>();
    for (const doc of docs) {
      const segments = (doc.segments ?? []).map((segment) => segment.content).filter(Boolean).join("\n");
      const corpus = [doc.title, doc.path, doc.content, segments].filter(Boolean).join("\n");
      for (const match of corpus.matchAll(DOC_PATH_TOKEN_PATTERN)) {
        const token = match[2];
        if (!token) continue;
        const normalized = this.normalizeStructurePathToken(token);
        if (!normalized) continue;
        if (FILE_EXTENSION_PATTERN.test(path.basename(normalized))) {
          files.add(normalized);
          const parent = path.dirname(normalized).replace(/\\/g, "/");
          if (parent && parent !== ".") directories.add(parent);
        } else {
          directories.add(normalized);
        }
      }
    }
    return {
      directories: Array.from(directories).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 32),
      files: Array.from(files).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 32),
    };
  }

  private normalizeServiceName(value: string): string | undefined {
    const normalized = value
      .toLowerCase()
      .replace(/[`"'()[\]{}]/g, " ")
      .replace(/[._/-]+/g, " ")
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) return undefined;
    const keepTokens = new Set(["api", "ui", "db", "qa", "ml", "ai", "etl"]);
    const tokens = normalized
      .split(" ")
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => keepTokens.has(token) || !SERVICE_NAME_STOPWORDS.has(token))
      .slice(0, 4);
    if (!tokens.length) return undefined;
    const candidate = tokens.join(" ");
    if (SERVICE_NAME_INVALID.has(candidate)) return undefined;
    return candidate.length >= 2 ? candidate : undefined;
  }

  private deriveServiceFromPathToken(pathToken: string): string | undefined {
    const parts = pathToken
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) return undefined;
    let idx = 0;
    while (idx < parts.length - 1 && SERVICE_PATH_CONTAINER_SEGMENTS.has(parts[idx])) {
      idx += 1;
    }
    return this.normalizeServiceName(parts[idx] ?? parts[0]);
  }

  private addServiceAlias(aliases: Map<string, Set<string>>, rawValue: string): string | undefined {
    const canonical = this.normalizeServiceName(rawValue);
    if (!canonical) return undefined;
    const existing = aliases.get(canonical) ?? new Set<string>();
    existing.add(canonical);
    const alias = rawValue
      .toLowerCase()
      .replace(/[._/-]+/g, " ")
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (alias) existing.add(alias);
    aliases.set(canonical, existing);
    return canonical;
  }

  private extractServiceMentionsFromText(text: string): string[] {
    if (!text) return [];
    const mentions = new Set<string>();
    for (const match of text.matchAll(SERVICE_LABEL_PATTERN)) {
      const phrase = `${match[1] ?? ""} ${match[2] ?? ""}`.trim();
      const normalized = this.normalizeServiceName(phrase);
      if (normalized) mentions.add(normalized);
    }
    for (const match of text.matchAll(DOC_PATH_TOKEN_PATTERN)) {
      const token = match[2];
      if (!token) continue;
      const normalized = this.deriveServiceFromPathToken(token);
      if (normalized) mentions.add(normalized);
    }
    return Array.from(mentions);
  }

  private resolveServiceMentionFromPhrase(phrase: string, aliases: Map<string, Set<string>>): string | undefined {
    const normalizedPhrase = phrase
      .toLowerCase()
      .replace(/[._/-]+/g, " ")
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalizedPhrase) return undefined;
    let best: { key: string; aliasLength: number } | undefined;
    const haystack = ` ${normalizedPhrase} `;
    for (const [service, names] of aliases.entries()) {
      for (const alias of names) {
        const needle = ` ${alias} `;
        if (!haystack.includes(needle)) continue;
        if (!best || alias.length > best.aliasLength) {
          best = { key: service, aliasLength: alias.length };
        }
      }
    }
    if (best) return best.key;
    const mention = this.extractServiceMentionsFromText(phrase)[0];
    if (!mention) return undefined;
    return this.addServiceAlias(aliases, mention);
  }

  private collectDependencyStatements(text: string): Array<{ dependent: string; dependency: string }> {
    const statements: Array<{ dependent: string; dependency: string }> = [];
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, DEPENDENCY_SCAN_LINE_LIMIT);
    const dependencyPatterns: Array<{
      regex: RegExp;
      dependentGroup: number;
      dependencyGroup: number;
    }> = [
      {
        regex:
          /^(.+?)\b(?:depends on|requires|needs|uses|consumes|calls|reads from|writes to|must come after|comes after|built after|runs after|backed by)\b(.+)$/i,
        dependentGroup: 1,
        dependencyGroup: 2,
      },
      {
        regex: /^(.+?)\b(?:before|prerequisite for)\b(.+)$/i,
        dependentGroup: 2,
        dependencyGroup: 1,
      },
    ];
    for (const rawLine of lines) {
      const line = rawLine.replace(/^[-*]\s+/, "").trim();
      if (!line) continue;
      for (const match of line.matchAll(SERVICE_ARROW_PATTERN)) {
        const dependent = match[1]?.trim();
        const dependency = match[2]?.trim();
        if (dependent && dependency) {
          statements.push({ dependent, dependency });
        }
      }
      for (const pattern of dependencyPatterns) {
        const match = line.match(pattern.regex);
        if (!match) continue;
        const dependent = match[pattern.dependentGroup]?.trim();
        const dependency = match[pattern.dependencyGroup]?.trim();
        if (!dependent || !dependency) continue;
        statements.push({ dependent, dependency });
      }
    }
    return statements;
  }

  private extractStartupWaveHints(
    text: string,
    aliases: Map<string, Set<string>>,
  ): {
    waveRank: Map<string, number>;
    startupWaves: Array<{ wave: number; services: string[] }>;
    foundationalDependencies: string[];
  } {
    const waveRank = new Map<string, number>();
    const startupWavesMap = new Map<number, Set<string>>();
    const foundational = new Set<string>();
    const registerWave = (service: string, wave: number) => {
      const normalizedWave = Number.isFinite(wave) ? Math.max(0, wave) : Number.MAX_SAFE_INTEGER;
      const current = waveRank.get(service);
      if (current === undefined || normalizedWave < current) {
        waveRank.set(service, normalizedWave);
      }
      const bucket = startupWavesMap.get(normalizedWave) ?? new Set<string>();
      bucket.add(service);
      startupWavesMap.set(normalizedWave, bucket);
    };
    const resolveServicesFromCell = (cell: string): string[] => {
      const resolved = new Set<string>();
      for (const match of cell.matchAll(SERVICE_HANDLE_PATTERN)) {
        const token = match[1]?.trim();
        if (!token) continue;
        if (token.includes("*")) {
          const normalizedPrefix = this.normalizeServiceName(token.replace(/\*+/g, ""));
          if (!normalizedPrefix) continue;
          for (const service of aliases.keys()) {
            if (service.startsWith(normalizedPrefix)) resolved.add(service);
          }
          continue;
        }
        const canonical = this.resolveServiceMentionFromPhrase(token, aliases) ?? this.addServiceAlias(aliases, token);
        if (canonical) resolved.add(canonical);
      }
      if (resolved.size === 0) {
        for (const mention of this.extractServiceMentionsFromText(cell)) {
          const canonical = this.addServiceAlias(aliases, mention);
          if (canonical) resolved.add(canonical);
        }
      }
      return Array.from(resolved);
    };
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, STARTUP_WAVE_SCAN_LINE_LIMIT);
    for (const line of lines) {
      if (!line.startsWith("|")) continue;
      const cells = line
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length < 2) continue;
      const waveFromFirst = cells[0].match(WAVE_LABEL_PATTERN);
      if (waveFromFirst) {
        const waveIndex = Number.parseInt(waveFromFirst[1] ?? "", 10);
        const services = resolveServicesFromCell(cells[1]);
        for (const service of services) registerWave(service, waveIndex);
        if (waveIndex === 0 && services.length === 0) {
          for (const token of cells[1]
            .replace(/[`_*]/g, "")
            .split(/[,+]/)
            .map((entry) => entry.trim())
            .filter(Boolean)) {
            foundational.add(token);
          }
        }
        continue;
      }
      const waveFromSecond = cells[1].match(WAVE_LABEL_PATTERN);
      if (!waveFromSecond) continue;
      const waveIndex = Number.parseInt(waveFromSecond[1] ?? "", 10);
      for (const service of resolveServicesFromCell(cells[0])) registerWave(service, waveIndex);
    }
    const startupWaves = Array.from(startupWavesMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([wave, services]) => ({ wave, services: Array.from(services).sort((a, b) => a.localeCompare(b)) }));
    return {
      waveRank,
      startupWaves,
      foundationalDependencies: Array.from(foundational).slice(0, 12),
    };
  }

  private sortServicesByDependency(
    services: string[],
    dependencies: Map<string, Set<string>>,
    waveRank: Map<string, number> = new Map(),
  ): string[] {
    const nodes = Array.from(new Set(services));
    const indegree = new Map<string, number>();
    const adjacency = new Map<string, Set<string>>();
    const dependedBy = new Map<string, number>();
    for (const node of nodes) {
      indegree.set(node, 0);
      dependedBy.set(node, 0);
    }
    for (const [dependent, dependencySet] of dependencies.entries()) {
      if (!indegree.has(dependent)) {
        indegree.set(dependent, 0);
        dependedBy.set(dependent, 0);
        nodes.push(dependent);
      }
      for (const dependency of dependencySet) {
        if (!indegree.has(dependency)) {
          indegree.set(dependency, 0);
          dependedBy.set(dependency, 0);
          nodes.push(dependency);
        }
        indegree.set(dependent, (indegree.get(dependent) ?? 0) + 1);
        const out = adjacency.get(dependency) ?? new Set<string>();
        out.add(dependent);
        adjacency.set(dependency, out);
        dependedBy.set(dependency, (dependedBy.get(dependency) ?? 0) + 1);
      }
    }
    const compare = (a: string, b: string): number => {
      const waveA = waveRank.get(a) ?? Number.MAX_SAFE_INTEGER;
      const waveB = waveRank.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (waveA !== waveB) return waveA - waveB;
      const dependedByA = dependedBy.get(a) ?? 0;
      const dependedByB = dependedBy.get(b) ?? 0;
      if (dependedByA !== dependedByB) return dependedByB - dependedByA;
      return a.localeCompare(b);
    };
    const queue = nodes.filter((node) => (indegree.get(node) ?? 0) === 0).sort(compare);
    const ordered: string[] = [];
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      ordered.push(current);
      const out = adjacency.get(current);
      if (!out) continue;
      for (const neighbor of out) {
        const nextInDegree = (indegree.get(neighbor) ?? 0) - 1;
        indegree.set(neighbor, nextInDegree);
        if (nextInDegree === 0) {
          queue.push(neighbor);
        }
      }
      queue.sort(compare);
    }
    if (ordered.length === nodes.length) return ordered;
    const remaining = nodes.filter((node) => !ordered.includes(node)).sort(compare);
    return [...ordered, ...remaining];
  }

  private buildServiceDependencyGraph(plan: GeneratedPlan, docs: DocdexDocument[]): ServiceDependencyGraph {
    const aliases = new Map<string, Set<string>>();
    const dependencies = new Map<string, Set<string>>();
    const register = (value: string | undefined): string | undefined => {
      if (!value) return undefined;
      return this.addServiceAlias(aliases, value);
    };
    const docsText = docs
      .map((doc) => [doc.title, doc.path, doc.content, ...(doc.segments ?? []).map((segment) => segment.content)].filter(Boolean).join("\n"))
      .join("\n");
    const planText = [
      ...plan.epics.map((epic) => `${epic.title}\n${epic.description ?? ""}`),
      ...plan.stories.map((story) => `${story.title}\n${story.description ?? ""}\n${story.userStory ?? ""}`),
      ...plan.tasks.map((task) => `${task.title}\n${task.description ?? ""}`),
    ].join("\n");
    const structureTargets = this.extractStructureTargets(docs);
    for (const token of [...structureTargets.directories, ...structureTargets.files]) {
      register(this.deriveServiceFromPathToken(token));
    }
    for (const match of docsText.matchAll(SERVICE_HANDLE_PATTERN)) register(match[1]);
    for (const match of planText.matchAll(SERVICE_HANDLE_PATTERN)) register(match[1]);
    for (const mention of this.extractServiceMentionsFromText(docsText)) register(mention);
    for (const mention of this.extractServiceMentionsFromText(planText)) register(mention);
    const corpus = [docsText, planText].filter(Boolean);
    for (const text of corpus) {
      const statements = this.collectDependencyStatements(text);
      for (const statement of statements) {
        const dependent = this.resolveServiceMentionFromPhrase(statement.dependent, aliases);
        const dependency = this.resolveServiceMentionFromPhrase(statement.dependency, aliases);
        if (!dependent || !dependency || dependent === dependency) continue;
        const next = dependencies.get(dependent) ?? new Set<string>();
        next.add(dependency);
        dependencies.set(dependent, next);
      }
    }
    const waveHints = this.extractStartupWaveHints(corpus.join("\n"), aliases);
    const services = this.sortServicesByDependency(Array.from(aliases.keys()), dependencies, waveHints.waveRank);
    return {
      services,
      dependencies,
      aliases,
      waveRank: waveHints.waveRank,
      startupWaves: waveHints.startupWaves,
      foundationalDependencies: waveHints.foundationalDependencies,
    };
  }

  private buildProjectConstructionMethod(docs: DocdexDocument[], graph: ServiceDependencyGraph): string {
    const toLabel = (value: string): string => value.replace(/\s+/g, "-");
    const structureTargets = this.extractStructureTargets(docs);
    const topDirectories = structureTargets.directories.slice(0, 10);
    const topFiles = structureTargets.files.slice(0, 10);
    const startupWaveLines = graph.startupWaves
      .slice(0, 8)
      .map((wave) => `- Wave ${wave.wave}: ${wave.services.map(toLabel).join(", ")}`);
    const serviceOrderLine =
      graph.services.length > 0
        ? graph.services
            .slice(0, 16)
            .map(toLabel)
            .join(" -> ")
        : "infer from SDS service dependencies and startup waves";
    const dependencyPairs: string[] = [];
    for (const [dependent, needs] of graph.dependencies.entries()) {
      for (const dependency of needs) {
        dependencyPairs.push(`${toLabel(dependent)} after ${toLabel(dependency)}`);
      }
    }
    return [
      "Project construction method (strict):",
      "1) Build repository structure from SDS folder tree first.",
      ...topDirectories.map((dir) => `   - create dir: ${dir}`),
      ...topFiles.map((file) => `   - create file: ${file}`),
      "2) Build foundational dependencies and low-wave services before consumers.",
      ...(graph.foundationalDependencies.length > 0
        ? graph.foundationalDependencies.map((dependency) => `   - foundation: ${dependency}`)
        : ["   - foundation: infer runtime prerequisites from SDS deployment sections"]),
      ...(startupWaveLines.length > 0 ? startupWaveLines : ["   - startup waves: infer from dependency contracts"]),
      "3) Implement services by dependency direction and startup wave.",
      `   - service order: ${serviceOrderLine}`,
      ...(dependencyPairs.length > 0
        ? dependencyPairs.slice(0, 14).map((pair) => `   - dependency: ${pair}`)
        : ["   - dependency: infer explicit \"depends on\" relations from SDS"]),
      "4) Only then sequence user-facing features, QA hardening, and release chores.",
      "5) Keep task dependencies story-scoped while preserving epic/story/task ordering by this build method.",
    ].join("\n");
  }

  private orderStoryTasksByDependencies(
    storyTasks: PlanTask[],
    serviceRank: Map<string, number>,
    taskServiceByScope: Map<string, string | undefined>,
  ): PlanTask[] {
    const byLocalId = new Map(storyTasks.map((task) => [task.localId, task]));
    const indegree = new Map<string, number>();
    const outgoing = new Map<string, Set<string>>();
    for (const task of storyTasks) {
      indegree.set(task.localId, 0);
    }
    for (const task of storyTasks) {
      for (const dep of task.dependsOnKeys ?? []) {
        if (!byLocalId.has(dep) || dep === task.localId) continue;
        indegree.set(task.localId, (indegree.get(task.localId) ?? 0) + 1);
        const edges = outgoing.get(dep) ?? new Set<string>();
        edges.add(task.localId);
        outgoing.set(dep, edges);
      }
    }
    const priorityComparator = (a: PlanTask, b: PlanTask): number => {
      const classA = classifyTask({ title: a.title ?? "", description: a.description, type: a.type });
      const classB = classifyTask({ title: b.title ?? "", description: b.description, type: b.type });
      if (classA.foundation !== classB.foundation) return classA.foundation ? -1 : 1;
      const rankA =
        serviceRank.get(taskServiceByScope.get(this.scopeTask(a)) ?? "") ?? Number.MAX_SAFE_INTEGER;
      const rankB =
        serviceRank.get(taskServiceByScope.get(this.scopeTask(b)) ?? "") ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      const priorityA = a.priorityHint ?? Number.MAX_SAFE_INTEGER;
      const priorityB = b.priorityHint ?? Number.MAX_SAFE_INTEGER;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.localId.localeCompare(b.localId);
    };
    const queue = storyTasks.filter((task) => (indegree.get(task.localId) ?? 0) === 0).sort(priorityComparator);
    const ordered: PlanTask[] = [];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || seen.has(next.localId)) continue;
      seen.add(next.localId);
      ordered.push(next);
      const dependents = outgoing.get(next.localId);
      if (!dependents) continue;
      for (const dependent of dependents) {
        const updated = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, updated);
        if (updated === 0) {
          const depTask = byLocalId.get(dependent);
          if (depTask) queue.push(depTask);
        }
      }
      queue.sort(priorityComparator);
    }
    if (ordered.length === storyTasks.length) return ordered;
    const remaining = storyTasks.filter((task) => !seen.has(task.localId)).sort(priorityComparator);
    return [...ordered, ...remaining];
  }

  private applyServiceDependencySequencing(plan: GeneratedPlan, docs: DocdexDocument[]): GeneratedPlan {
    const graph = this.buildServiceDependencyGraph(plan, docs);
    if (!graph.services.length) return plan;
    const serviceOrderRank = new Map(graph.services.map((service, index) => [service, index]));
    const serviceRank = new Map(
      graph.services.map((service) => {
        const wave = graph.waveRank.get(service) ?? Number.MAX_SAFE_INTEGER;
        const order = serviceOrderRank.get(service) ?? Number.MAX_SAFE_INTEGER;
        return [service, wave * 10_000 + order] as const;
      }),
    );
    const resolveEntityService = (text: string): string | undefined => this.resolveServiceMentionFromPhrase(text, graph.aliases);
    const epics = plan.epics.map((epic) => ({ ...epic }));
    const stories = plan.stories.map((story) => ({ ...story }));
    const tasks = plan.tasks.map((task) => ({ ...task, dependsOnKeys: uniqueStrings(task.dependsOnKeys ?? []) }));
    const storyByScope = new Map(stories.map((story) => [this.scopeStory(story), story]));
    const taskServiceByScope = new Map<string, string | undefined>();

    for (const task of tasks) {
      const text = `${task.title ?? ""}\n${task.description ?? ""}`;
      taskServiceByScope.set(this.scopeTask(task), resolveEntityService(text));
    }

    const tasksByStory = new Map<string, PlanTask[]>();
    for (const task of tasks) {
      const storyScope = this.storyScopeKey(task.epicLocalId, task.storyLocalId);
      const bucket = tasksByStory.get(storyScope) ?? [];
      bucket.push(task);
      tasksByStory.set(storyScope, bucket);
    }

    for (const storyTasks of tasksByStory.values()) {
      const tasksByService = new Map<string, PlanTask[]>();
      for (const task of storyTasks) {
        const service = taskServiceByScope.get(this.scopeTask(task));
        if (!service) continue;
        const serviceTasks = tasksByService.get(service) ?? [];
        serviceTasks.push(task);
        tasksByService.set(service, serviceTasks);
      }
      for (const serviceTasks of tasksByService.values()) {
        serviceTasks.sort((a, b) => (a.priorityHint ?? Number.MAX_SAFE_INTEGER) - (b.priorityHint ?? Number.MAX_SAFE_INTEGER));
      }
      for (const task of storyTasks) {
        const service = taskServiceByScope.get(this.scopeTask(task));
        if (!service) continue;
        const requiredServices = graph.dependencies.get(service);
        if (!requiredServices || requiredServices.size === 0) continue;
        for (const requiredService of requiredServices) {
          const candidate = tasksByService.get(requiredService)?.[0];
          if (!candidate || candidate.localId === task.localId) continue;
          if (!(task.dependsOnKeys ?? []).includes(candidate.localId)) {
            task.dependsOnKeys = uniqueStrings([...(task.dependsOnKeys ?? []), candidate.localId]);
          }
        }
      }
    }

    const storyRankByScope = new Map<string, number>();
    for (const story of stories) {
      const storyScope = this.scopeStory(story);
      const storyTasks = tasksByStory.get(storyScope) ?? [];
      const taskRanks = storyTasks
        .map((task) => serviceRank.get(taskServiceByScope.get(this.scopeTask(task)) ?? ""))
        .filter((value): value is number => typeof value === "number");
      const storyTextRank = serviceRank.get(resolveEntityService(`${story.title}\n${story.description ?? ""}\n${story.userStory ?? ""}`) ?? "");
      const rank = taskRanks.length > 0 ? Math.min(...taskRanks) : storyTextRank ?? Number.MAX_SAFE_INTEGER;
      storyRankByScope.set(storyScope, rank);
    }

    const epicRankByLocalId = new Map<string, number>();
    for (const epic of epics) {
      const epicStories = stories.filter((story) => story.epicLocalId === epic.localId);
      const storyRanks = epicStories
        .map((story) => storyRankByScope.get(this.scopeStory(story)))
        .filter((value): value is number => typeof value === "number");
      const epicTextRank = serviceRank.get(resolveEntityService(`${epic.title}\n${epic.description ?? ""}`) ?? "");
      const rank = storyRanks.length > 0 ? Math.min(...storyRanks) : epicTextRank ?? Number.MAX_SAFE_INTEGER;
      epicRankByLocalId.set(epic.localId, rank);
    }

    const isBootstrap = (value: string): boolean => /bootstrap|foundation|structure/i.test(value);
    epics.sort((a, b) => {
      const bootstrapA = isBootstrap(`${a.title} ${a.description ?? ""}`);
      const bootstrapB = isBootstrap(`${b.title} ${b.description ?? ""}`);
      if (bootstrapA !== bootstrapB) return bootstrapA ? -1 : 1;
      const rankA = epicRankByLocalId.get(a.localId) ?? Number.MAX_SAFE_INTEGER;
      const rankB = epicRankByLocalId.get(b.localId) ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      const priorityA = a.priorityHint ?? Number.MAX_SAFE_INTEGER;
      const priorityB = b.priorityHint ?? Number.MAX_SAFE_INTEGER;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.localId.localeCompare(b.localId);
    });
    epics.forEach((epic, index) => {
      epic.priorityHint = index + 1;
    });

    const storiesOrdered: PlanStory[] = [];
    const tasksOrdered: PlanTask[] = [];
    for (const epic of epics) {
      const epicStories = stories
        .filter((story) => story.epicLocalId === epic.localId)
        .sort((a, b) => {
          const bootstrapA = isBootstrap(`${a.title} ${a.description ?? ""}`);
          const bootstrapB = isBootstrap(`${b.title} ${b.description ?? ""}`);
          if (bootstrapA !== bootstrapB) return bootstrapA ? -1 : 1;
          const rankA = storyRankByScope.get(this.scopeStory(a)) ?? Number.MAX_SAFE_INTEGER;
          const rankB = storyRankByScope.get(this.scopeStory(b)) ?? Number.MAX_SAFE_INTEGER;
          if (rankA !== rankB) return rankA - rankB;
          const priorityA = a.priorityHint ?? Number.MAX_SAFE_INTEGER;
          const priorityB = b.priorityHint ?? Number.MAX_SAFE_INTEGER;
          if (priorityA !== priorityB) return priorityA - priorityB;
          return a.localId.localeCompare(b.localId);
        });
      epicStories.forEach((story, index) => {
        story.priorityHint = index + 1;
        storiesOrdered.push(story);
        const storyTasks = tasksByStory.get(this.scopeStory(story)) ?? [];
        const orderedTasks = this.orderStoryTasksByDependencies(storyTasks, serviceRank, taskServiceByScope);
        orderedTasks.forEach((task, taskIndex) => {
          task.priorityHint = taskIndex + 1;
          tasksOrdered.push(task);
        });
      });
    }

    const orderedStoryScopes = new Set(storiesOrdered.map((story) => this.scopeStory(story)));
    for (const story of stories) {
      if (orderedStoryScopes.has(this.scopeStory(story))) continue;
      storiesOrdered.push(story);
    }
    const orderedTaskScopes = new Set(tasksOrdered.map((task) => this.scopeTask(task)));
    for (const task of tasks) {
      if (orderedTaskScopes.has(this.scopeTask(task))) continue;
      tasksOrdered.push(task);
    }

    // Keep parent linkage intact even if malformed story references exist.
    for (const story of storiesOrdered) {
      if (!storyByScope.has(this.scopeStory(story))) continue;
      story.epicLocalId = storyByScope.get(this.scopeStory(story))?.epicLocalId ?? story.epicLocalId;
    }

    return { epics, stories: storiesOrdered, tasks: tasksOrdered };
  }

  private shouldInjectStructureBootstrap(plan: GeneratedPlan, docs: DocdexDocument[]): boolean {
    if (docs.length === 0) return false;
    return !plan.tasks.some((task) =>
      /codebase structure|folder tree|scaffold|bootstrap|repository layout|project skeleton/i.test(
        `${task.title} ${task.description ?? ""}`,
      ),
    );
  }

  private injectStructureBootstrapPlan(
    plan: GeneratedPlan,
    docs: DocdexDocument[],
    projectKey: string,
  ): GeneratedPlan {
    if (!this.shouldInjectStructureBootstrap(plan, docs)) return plan;
    const localIds = new Set<string>([
      ...plan.epics.map((epic) => epic.localId),
      ...plan.stories.map((story) => story.localId),
      ...plan.tasks.map((task) => task.localId),
    ]);
    const epicLocalId = nextUniqueLocalId("bootstrap-epic", localIds);
    const storyLocalId = nextUniqueLocalId("bootstrap-story", localIds);
    const task1LocalId = nextUniqueLocalId("bootstrap-task", localIds);
    const task2LocalId = nextUniqueLocalId("bootstrap-task", localIds);
    const task3LocalId = nextUniqueLocalId("bootstrap-task", localIds);
    const structureTargets = this.extractStructureTargets(docs);
    const directoryPreview = structureTargets.directories.length
      ? structureTargets.directories.slice(0, 20).map((item) => `- ${item}`).join("\n")
      : "- Infer top-level source directories from SDS sections and create them.";
    const filePreview = structureTargets.files.length
      ? structureTargets.files.slice(0, 20).map((item) => `- ${item}`).join("\n")
      : "- Create minimal entrypoint/config placeholders required by the SDS-defined architecture.";
    const relatedDocs = docs
      .map((doc) => (doc.id ? `docdex:${doc.id}` : undefined))
      .filter((value): value is string => Boolean(value))
      .slice(0, 12);
    const bootstrapEpic: PlanEpic = {
      localId: epicLocalId,
      area: normalizeArea(projectKey) ?? "infra",
      title: "Codebase Foundation and Structure Setup",
      description:
        "Create the SDS-defined codebase scaffold first (folders/files/service boundaries) before feature implementation tasks.",
      acceptanceCriteria: [
        "Required folder tree exists for the planned architecture.",
        "Minimal entrypoint/config files exist for each discovered service/module.",
        "Service dependency assumptions are explicit and actionable in follow-up tasks.",
      ],
      relatedDocs,
      priorityHint: 1,
      stories: [],
    };
    const bootstrapStory: PlanStory = {
      localId: storyLocalId,
      epicLocalId,
      title: "Bootstrap repository structure from SDS",
      userStory:
        "As an engineer, I want a concrete codebase scaffold first so implementation tasks can target real modules instead of only tests.",
      description: [
        "Parse SDS/PDR/OpenAPI context and establish the expected folder/file tree.",
        "Start with dependencies-first service ordering (foundational components before dependents).",
      ].join("\n"),
      acceptanceCriteria: [
        "Repository scaffold matches documented architecture at a high level.",
        "Core service/module placeholders are committed as executable starting points.",
        "Follow-up tasks reference real directories/files under the scaffold.",
      ],
      relatedDocs,
      priorityHint: 1,
      tasks: [],
    };
    const bootstrapTasks: PlanTask[] = [
      {
        localId: task1LocalId,
        storyLocalId,
        epicLocalId,
        title: "Create SDS-aligned folder tree",
        type: "chore",
        description: [
          "Create the initial folder tree inferred from SDS and related docs.",
          "Target directories:",
          directoryPreview,
        ].join("\n"),
        estimatedStoryPoints: 2,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs,
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
      {
        localId: task2LocalId,
        storyLocalId,
        epicLocalId,
        title: "Create foundational file stubs for discovered modules",
        type: "chore",
        description: [
          "Create minimal file stubs/config entrypoints for the scaffolded modules/services.",
          "Target files:",
          filePreview,
        ].join("\n"),
        estimatedStoryPoints: 3,
        priorityHint: 2,
        dependsOnKeys: [task1LocalId],
        relatedDocs,
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
      {
        localId: task3LocalId,
        storyLocalId,
        epicLocalId,
        title: "Define service dependency baseline for implementation sequencing",
        type: "spike",
        description:
          "Document and codify service/module dependency direction so highly depended foundational services are implemented first.",
        estimatedStoryPoints: 2,
        priorityHint: 3,
        dependsOnKeys: [task2LocalId],
        relatedDocs,
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ];
    return {
      epics: [bootstrapEpic, ...plan.epics],
      stories: [bootstrapStory, ...plan.stories],
      tasks: [...bootstrapTasks, ...plan.tasks],
    };
  }

  private enforceStoryScopedDependencies(plan: GeneratedPlan): GeneratedPlan {
    const taskMap = new Map(
      plan.tasks.map((task) => [
        this.scopeTask(task),
        {
          ...task,
          dependsOnKeys: uniqueStrings((task.dependsOnKeys ?? []).filter(Boolean)),
        },
      ]),
    );
    const tasksByStory = new Map<string, PlanTask[]>();
    for (const task of taskMap.values()) {
      const storyScope = this.storyScopeKey(task.epicLocalId, task.storyLocalId);
      const storyTasks = tasksByStory.get(storyScope) ?? [];
      storyTasks.push(task);
      tasksByStory.set(storyScope, storyTasks);
    }
    for (const storyTasks of tasksByStory.values()) {
      const localIds = new Set(storyTasks.map((task) => task.localId));
      const foundationTasks = storyTasks
        .filter((task) =>
          classifyTask({
            title: task.title ?? "",
            description: task.description,
            type: task.type,
          }).foundation,
        )
        .sort((a, b) => (a.priorityHint ?? Number.MAX_SAFE_INTEGER) - (b.priorityHint ?? Number.MAX_SAFE_INTEGER));
      const foundationAnchor =
        foundationTasks.find((task) => !(task.dependsOnKeys ?? []).some((dep) => localIds.has(dep)))?.localId ??
        foundationTasks[0]?.localId;
      for (const task of storyTasks) {
        const filtered = (task.dependsOnKeys ?? []).filter((dep) => dep !== task.localId && localIds.has(dep));
        const classification = classifyTask({
          title: task.title ?? "",
          description: task.description,
          type: task.type,
        });
        if (
          foundationAnchor &&
          foundationAnchor !== task.localId &&
          !classification.foundation &&
          !filtered.includes(foundationAnchor)
        ) {
          filtered.push(foundationAnchor);
        }
        task.dependsOnKeys = uniqueStrings(filtered);
      }
    }
    return {
      ...plan,
      tasks: plan.tasks.map((task) => taskMap.get(this.scopeTask(task)) ?? task),
    };
  }

  private validatePlanLocalIdentifiers(plan: GeneratedPlan): void {
    const errors: string[] = [];
    const epicIds = new Set<string>();
    for (const epic of plan.epics) {
      if (!epic.localId || !epic.localId.trim()) {
        errors.push("epic has missing localId");
        continue;
      }
      if (epicIds.has(epic.localId)) {
        errors.push(`duplicate epic localId: ${epic.localId}`);
        continue;
      }
      epicIds.add(epic.localId);
    }

    const storyScopes = new Set<string>();
    for (const story of plan.stories) {
      const scope = this.scopeStory(story);
      if (!epicIds.has(story.epicLocalId)) {
        errors.push(`story ${scope} references unknown epicLocalId ${story.epicLocalId}`);
      }
      if (storyScopes.has(scope)) {
        errors.push(`duplicate story scope: ${scope}`);
        continue;
      }
      storyScopes.add(scope);
    }

    const taskScopes = new Set<string>();
    const storyTaskLocals = new Map<string, Set<string>>();
    for (const task of plan.tasks) {
      const storyScope = this.storyScopeKey(task.epicLocalId, task.storyLocalId);
      const taskScope = this.scopeTask(task);
      if (!storyScopes.has(storyScope)) {
        errors.push(`task ${taskScope} references unknown story scope ${storyScope}`);
      }
      if (taskScopes.has(taskScope)) {
        errors.push(`duplicate task scope: ${taskScope}`);
        continue;
      }
      taskScopes.add(taskScope);
      const locals = storyTaskLocals.get(storyScope) ?? new Set<string>();
      locals.add(task.localId);
      storyTaskLocals.set(storyScope, locals);
    }

    for (const task of plan.tasks) {
      const storyScope = this.storyScopeKey(task.epicLocalId, task.storyLocalId);
      const localIds = storyTaskLocals.get(storyScope) ?? new Set<string>();
      for (const dep of task.dependsOnKeys ?? []) {
        if (!dep || dep === task.localId) continue;
        if (!localIds.has(dep)) {
          errors.push(
            `task ${this.scopeTask(task)} has dependency ${dep} that is outside story scope ${storyScope}`,
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Invalid generated plan local identifiers:\n- ${errors.join("\n- ")}`);
    }
  }

  private async buildQaPreflight(): Promise<QaPreflight> {
    const preflight: QaPreflight = {
      scripts: {},
      entrypoints: [],
      blockers: [],
    };
    const packagePath = path.join(this.workspace.workspaceRoot, "package.json");
    let pkg: Record<string, unknown> | null = null;
    try {
      const raw = await fs.readFile(packagePath, "utf8");
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return preflight;
    }
    const scripts = pkg?.scripts;
    if (scripts && typeof scripts === "object") {
      for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
        if (typeof value === "string") {
          preflight.scripts[name] = value;
        }
      }
    }
    const dependencies = {
      ...(pkg?.dependencies && typeof pkg.dependencies === "object" ? (pkg.dependencies as Record<string, unknown>) : {}),
      ...(pkg?.devDependencies && typeof pkg.devDependencies === "object"
        ? (pkg.devDependencies as Record<string, unknown>)
        : {}),
    };
    const hasDev = typeof preflight.scripts.dev === "string";
    const hasStart = typeof preflight.scripts.start === "string";
    const devPort = hasDev ? extractScriptPort(preflight.scripts.dev) : undefined;
    const startPort = hasStart ? extractScriptPort(preflight.scripts.start) : undefined;
    if (hasDev) {
      preflight.entrypoints.push({
        kind: "web",
        base_url: devPort ? `http://localhost:${devPort}` : undefined,
        command: "npm run dev",
      });
    } else if (hasStart) {
      preflight.entrypoints.push({
        kind: "web",
        base_url: startPort ? `http://localhost:${startPort}` : undefined,
        command: "npm start",
      });
    }
    const testDirs = [
      path.join(this.workspace.workspaceRoot, "tests"),
      path.join(this.workspace.workspaceRoot, "__tests__"),
    ];
    const testFiles: string[] = [];
    for (const dir of testDirs) {
      try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) continue;
        testFiles.push(...(await collectFilesRecursively(dir)));
      } catch {
        // ignore missing test dirs
      }
    }
    const testCandidates = testFiles.filter((file) => /\b(test|spec)\b/i.test(path.basename(file)));
    const hasSupertest = typeof dependencies.supertest === "string";
    if (!hasSupertest && testCandidates.length > 0) {
      for (const file of testCandidates) {
        try {
          const content = await fs.readFile(file, "utf8");
          if (content.includes("supertest")) {
            preflight.blockers.push(
              "Missing devDependency: supertest (required by test files).",
            );
            break;
          }
        } catch {
          // ignore read errors
        }
      }
    }
    return preflight;
  }

  private buildQaOverrides(options: CreateTasksOptions): QaReadiness | undefined {
    const profiles = options.qaProfiles?.filter(Boolean);
    const requires = options.qaRequires?.filter(Boolean);
    const entrypoints: QaEntrypoint[] = [];
    if (options.qaEntryUrl || options.qaStartCommand) {
      entrypoints.push({
        kind: "web",
        base_url: options.qaEntryUrl,
        command: options.qaStartCommand,
      });
    }
    if (!profiles?.length && !requires?.length && entrypoints.length === 0) return undefined;
    return {
      profiles_expected: profiles,
      requires,
      entrypoints: entrypoints.length ? entrypoints : undefined,
    };
  }

  private isOpenApiDoc(doc: DocdexDocument): boolean {
    const type = (doc.docType ?? "").toLowerCase();
    if (type.includes("openapi") || type.includes("swagger")) return true;
    const pathTitle = `${doc.path ?? ""} ${doc.title ?? ""}`.toLowerCase();
    return OPENAPI_LIKE_PATH_PATTERN.test(pathTitle);
  }

  private buildOpenApiHintSummary(docs: DocdexDocument[]): string {
    const lines: string[] = [];
    for (const doc of docs) {
      if (!this.isOpenApiDoc(doc)) continue;
      const rawContent =
        doc.content && doc.content.trim().length > 0
          ? doc.content
          : (doc.segments ?? []).map((segment) => segment.content).join("\n\n");
      const parsed = parseStructuredDoc(rawContent);
      if (!parsed) continue;
      const paths = parsed.paths;
      if (!isPlainObject(paths)) continue;
      for (const [apiPath, pathItem] of Object.entries(paths)) {
        if (!isPlainObject(pathItem)) continue;
        for (const [method, operation] of Object.entries(pathItem)) {
          const normalizedMethod = method.toLowerCase();
          if (!["get", "post", "put", "patch", "delete", "options", "head", "trace"].includes(normalizedMethod)) {
            continue;
          }
          if (!isPlainObject(operation)) continue;
          const hints = (operation as Record<string, unknown>)["x-mcoda-task-hints"];
          if (!isPlainObject(hints)) continue;
          const service = typeof hints.service === "string" ? hints.service : "-";
          const capability = typeof hints.capability === "string" ? hints.capability : "-";
          const stage = typeof hints.stage === "string" ? hints.stage : "-";
          const complexity =
            typeof hints.complexity === "number" && Number.isFinite(hints.complexity)
              ? hints.complexity.toFixed(1)
              : "-";
          const dependsOn = Array.isArray(hints.depends_on_operations)
            ? hints.depends_on_operations.filter((entry): entry is string => typeof entry === "string").length
            : 0;
          const tests = isPlainObject(hints.test_requirements) ? hints.test_requirements : undefined;
          const countEntries = (value: unknown): number =>
            Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").length : 0;
          const unitCount = countEntries(tests?.unit);
          const componentCount = countEntries(tests?.component);
          const integrationCount = countEntries(tests?.integration);
          const apiCount = countEntries(tests?.api);
          lines.push(
            `- ${normalizedMethod.toUpperCase()} ${apiPath} :: service=${service}; capability=${capability}; stage=${stage}; complexity=${complexity}; deps=${dependsOn}; tests(u/c/i/a)=${unitCount}/${componentCount}/${integrationCount}/${apiCount}`,
          );
          if (lines.length >= OPENAPI_HINT_OPERATIONS_LIMIT) {
            return lines.join("\n");
          }
        }
      }
    }
    return lines.join("\n");
  }

  private extractSdsSectionCandidates(docs: DocdexDocument[], limit: number): string[] {
    const sections: string[] = [];
    for (const doc of docs) {
      if (!looksLikeSdsDoc(doc)) continue;
      const segmentHeadings = (doc.segments ?? [])
        .map((segment) => segment.heading?.trim())
        .filter((heading): heading is string => Boolean(heading));
      const contentHeadings = extractMarkdownHeadings(doc.content ?? "", limit);
      for (const heading of [...segmentHeadings, ...contentHeadings]) {
        const normalized = heading.replace(/[`*_]/g, "").trim();
        if (!normalized) continue;
        sections.push(normalized);
        if (sections.length >= limit) break;
      }
      if (sections.length >= limit) break;
    }
    return uniqueStrings(sections).slice(0, limit);
  }

  private buildSdsCoverageHints(docs: DocdexDocument[]): string {
    const hints = this.extractSdsSectionCandidates(docs, SDS_COVERAGE_HINT_HEADING_LIMIT);
    if (hints.length === 0) return "";
    return hints.map((hint) => `- ${hint}`).join("\n");
  }

  private buildDocContext(docs: DocdexDocument[]): { docSummary: string; warnings: string[] } {
    const warnings: string[] = [];
    const blocks: string[] = [];
    let budget = DOC_CONTEXT_BUDGET;
    const sorted = [...docs].sort((a, b) => {
      const sdsDelta = Number(looksLikeSdsDoc(b)) - Number(looksLikeSdsDoc(a));
      if (sdsDelta !== 0) return sdsDelta;
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    });
    for (const [idx, doc] of sorted.entries()) {
      const segments = doc.segments ?? [];
      const sampledSegments = pickDistributedIndices(segments.length, DOC_CONTEXT_SEGMENTS_PER_DOC)
        .map((index) => segments[index]!)
        .filter(Boolean);
      const content = sampledSegments.length
        ? sampledSegments
            .map((seg, i) => {
              const trimmed = seg.content.length > 600 ? `${seg.content.slice(0, 600)}...` : seg.content;
              return `  - (${i + 1}) ${seg.heading ? `${seg.heading}: ` : ""}${trimmed}`;
            })
            .join("\n")
        : sampleRawContent(doc.content, DOC_CONTEXT_FALLBACK_CHUNK_LENGTH)
            .map((chunk, i) => `  - (${i + 1}) ${chunk.length > 600 ? `${chunk.slice(0, 600)}...` : chunk}`)
            .join("\n");
      const entry = [`[${doc.docType}] docdex:${doc.id ?? `doc-${idx + 1}`}`, describeDoc(doc, idx), content]
        .filter(Boolean)
        .join("\n");
      const cost = estimateTokens(entry);
      if (budget - cost < 0) {
        warnings.push(`Context truncated due to token budget; skipped doc ${doc.id ?? doc.path ?? idx + 1}.`);
        continue;
      }
      budget -= cost;
      blocks.push(entry);
      if (budget <= 0) break;
    }
    const openApiHints = this.buildOpenApiHintSummary(sorted);
    if (openApiHints) {
      const hintBlock = ["[OPENAPI_HINTS]", openApiHints].join("\n");
      const hintCost = estimateTokens(hintBlock);
      if (budget - hintCost >= 0) {
        budget -= hintCost;
        blocks.push(hintBlock);
      } else {
        warnings.push("Context truncated due to token budget; skipped OpenAPI hint summary.");
      }
    }
    const sdsCoverageHints = this.buildSdsCoverageHints(sorted);
    if (sdsCoverageHints) {
      const hintBlock = ["[SDS_COVERAGE_HINTS]", sdsCoverageHints].join("\n");
      const hintCost = estimateTokens(hintBlock);
      if (budget - hintCost >= 0) {
        budget -= hintCost;
        blocks.push(hintBlock);
      } else {
        warnings.push("Context truncated due to token budget; skipped SDS coverage hints.");
      }
    }
    return { docSummary: blocks.join("\n\n") || "(no docs)", warnings };
  }

  private buildPrompt(
    projectKey: string,
    docs: DocdexDocument[],
    projectBuildMethod: string,
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number },
  ): { prompt: string; docSummary: string } {
    const docSummary = docs.map((doc, idx) => describeDoc(doc, idx)).join("\n");
    const limits = [
      options.maxEpics ? `Limit epics to ${options.maxEpics}.` : "",
      options.maxStoriesPerEpic ? `Limit stories per epic to ${options.maxStoriesPerEpic}.` : "",
      options.maxTasksPerStory ? `Limit tasks per story to ${options.maxTasksPerStory}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const prompt = [
      `You are assisting in creating EPICS ONLY for project ${projectKey}.`,
      "Follow mcoda SDS epic template:",
      "- Context/Problem; Goals & Outcomes; In Scope; Out of Scope; Key Flows; Non-functional Requirements; Dependencies & Constraints; Risks & Open Questions; Acceptance Criteria; Related Documentation.",
      "Return strictly valid JSON (no prose) matching:",
      EPIC_SCHEMA_SNIPPET,
      "Rules:",
      "- Do NOT include final slugs; the system will assign keys.",
      "- Use docdex handles when referencing docs.",
      "- acceptanceCriteria must be an array of strings (5-10 items).",
      "- Prefer dependency-first sequencing: foundational codebase/service setup epics should precede dependent feature epics.",
      "- Keep output technology-agnostic and derived from docs; do not assume specific stacks unless docs state them.",
      "Project construction method to follow:",
      projectBuildMethod,
      limits || "Use reasonable scope without over-generating epics.",
      "Docs available:",
      docSummary || "- (no docs provided; propose sensible epics).",
    ].join("\n\n");
    return { prompt, docSummary };
  }

  private fallbackPlan(projectKey: string, docs: DocdexDocument[]): AgentPlan {
    const docRefs = docs.map((doc) => (doc.id ? `docdex:${doc.id}` : doc.path ?? doc.title ?? "doc"));
    return {
      epics: [
        {
          area: projectKey,
          title: `Initial planning for ${projectKey}`,
          description: `Seed epic derived from provided documentation (${docRefs.join(", ")})`,
          acceptanceCriteria: ["Backlog created with actionable tasks", "Dependencies identified", "Tasks grouped by user value"],
          relatedDocs: docRefs,
          stories: [
            {
              localId: "story-1",
              title: "Review inputs and draft backlog",
              userStory: "As a planner, I want a decomposed backlog so that work can be prioritized.",
              description: "Review provided docs and produce a first-pass backlog.",
              acceptanceCriteria: [
                "Epics, stories, and tasks are listed",
                "Each task has an objective and DoD",
                "Dependencies noted",
              ],
              relatedDocs: docRefs,
              tasks: [
                {
                  localId: "task-1",
                  title: "Implement baseline project scaffolding",
                  type: "feature",
                  description: "Create SDS-aligned baseline structure and core implementation entrypoints from the available docs.",
                  estimatedStoryPoints: 3,
                  priorityHint: 10,
                  relatedDocs: docRefs,
                  unitTests: [],
                  componentTests: [],
                  integrationTests: [],
                  apiTests: [],
                },
                {
                  localId: "task-2",
                  title: "Integrate core contracts and dependencies",
                  type: "feature",
                  description: "Wire key contracts/interfaces and dependency paths so core behavior can execute end-to-end.",
                  estimatedStoryPoints: 3,
                  priorityHint: 20,
                  dependsOnKeys: ["task-1"],
                  relatedDocs: docRefs,
                  unitTests: [],
                  componentTests: [],
                  integrationTests: [],
                  apiTests: [],
                },
                {
                  localId: "task-3",
                  title: "Validate baseline behavior and regressions",
                  type: "chore",
                  description: "Add targeted validation coverage and readiness evidence for the implemented baseline capabilities.",
                  estimatedStoryPoints: 2,
                  priorityHint: 30,
                  dependsOnKeys: ["task-2"],
                  relatedDocs: docRefs,
                  unitTests: [],
                  componentTests: [],
                  integrationTests: [],
                  apiTests: [],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  private materializePlanFromSeed(
    seed: AgentPlan,
    options: { maxEpics?: number; maxStoriesPerEpic?: number; maxTasksPerStory?: number },
  ): GeneratedPlan {
    const epics: PlanEpic[] = [];
    const stories: PlanStory[] = [];
    const tasks: PlanTask[] = [];
    const epicLimit = options.maxEpics ?? Number.MAX_SAFE_INTEGER;
    const storyLimit = options.maxStoriesPerEpic ?? Number.MAX_SAFE_INTEGER;
    const taskLimit = options.maxTasksPerStory ?? Number.MAX_SAFE_INTEGER;
    const seedEpics = Array.isArray(seed.epics) ? seed.epics.slice(0, epicLimit) : [];
    for (const [epicIndex, epic] of seedEpics.entries()) {
      const epicLocalId =
        typeof epic.localId === "string" && epic.localId.trim().length > 0 ? epic.localId : `e${epicIndex + 1}`;
      const planEpic: PlanEpic = {
        ...epic,
        localId: epicLocalId,
        area: normalizeArea(epic.area),
        relatedDocs: normalizeRelatedDocs(epic.relatedDocs),
        acceptanceCriteria: Array.isArray(epic.acceptanceCriteria) ? epic.acceptanceCriteria : [],
        stories: [],
      };
      epics.push(planEpic);
      const epicStories = Array.isArray(epic.stories) ? epic.stories.slice(0, storyLimit) : [];
      for (const [storyIndex, story] of epicStories.entries()) {
        const storyLocalId =
          typeof story.localId === "string" && story.localId.trim().length > 0 ? story.localId : `us${storyIndex + 1}`;
        const planStory: PlanStory = {
          ...story,
          localId: storyLocalId,
          epicLocalId,
          relatedDocs: normalizeRelatedDocs(story.relatedDocs),
          acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
          tasks: [],
        };
        stories.push(planStory);
        const storyTasks = Array.isArray(story.tasks) ? story.tasks.slice(0, taskLimit) : [];
        for (const [taskIndex, task] of storyTasks.entries()) {
          const localId =
            typeof task.localId === "string" && task.localId.trim().length > 0 ? task.localId : `t${taskIndex + 1}`;
          tasks.push({
            ...task,
            localId,
            storyLocalId,
            epicLocalId,
            title: task.title ?? "Task",
            type: normalizeTaskType(task.type) ?? "feature",
            description: task.description ?? "",
            estimatedStoryPoints: typeof task.estimatedStoryPoints === "number" ? task.estimatedStoryPoints : undefined,
            priorityHint: typeof task.priorityHint === "number" ? task.priorityHint : undefined,
            dependsOnKeys: normalizeStringArray(task.dependsOnKeys),
            relatedDocs: normalizeRelatedDocs(task.relatedDocs),
            unitTests: normalizeStringArray(task.unitTests),
            componentTests: normalizeStringArray(task.componentTests),
            integrationTests: normalizeStringArray(task.integrationTests),
            apiTests: normalizeStringArray(task.apiTests),
            qa: normalizeQaReadiness(task.qa),
          });
        }
      }
    }
    return { epics, stories, tasks };
  }

  private async invokeAgentWithRetry(
    agent: Agent,
    prompt: string,
    action: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ output: string; promptTokens: number; completionTokens: number }> {
    const startedAt = Date.now();
    let output = "";
    const logChunk = async (chunk?: string) => {
      if (!chunk) return;
      await this.jobService.appendLog(jobId, chunk);
      if (stream) process.stdout.write(chunk);
    };
    try {
      if (stream) {
        const gen = await this.agentService.invokeStream(agent.id, { input: prompt });
        for await (const chunk of gen) {
          output += chunk.output ?? "";
          await logChunk(chunk.output);
        }
      } else {
        const result = await this.agentService.invoke(agent.id, { input: prompt });
        output = result.output ?? "";
        await logChunk(output);
      }
    } catch (error) {
      throw new Error(`Agent invocation failed (${action}): ${(error as Error).message}`);
    }
    let parsed = extractJson(output);
    if (!parsed) {
      const attempt = 2;
      const fixPrompt = [
        "Rewrite the previous response into valid JSON matching the expected schema.",
        `Schema hint:\n${action === "epics" ? EPIC_SCHEMA_SNIPPET : action === "stories" ? STORY_SCHEMA_SNIPPET : TASK_SCHEMA_SNIPPET}`,
        "Return JSON only; no prose.",
        `Original content:\n${output}`,
      ].join("\n\n");
      try {
        const fix = await this.agentService.invoke(agent.id, { input: fixPrompt });
        output = fix.output ?? "";
        parsed = extractJson(output);
        if (parsed) {
          const promptTokens = estimateTokens(prompt);
          const completionTokens = estimateTokens(output);
          const durationSeconds = (Date.now() - startedAt) / 1000;
          await this.jobService.recordTokenUsage({
            timestamp: new Date().toISOString(),
            workspaceId: this.workspace.workspaceId,
            jobId,
            commandRunId,
            agentId: agent.id,
            modelName: agent.defaultModel,
            promptTokens,
            completionTokens,
            tokensPrompt: promptTokens,
            tokensCompletion: completionTokens,
            tokensTotal: promptTokens + completionTokens,
            durationSeconds,
            metadata: {
              action: `create_tasks_${action}`,
              phase: `create_tasks_${action}`,
              attempt,
              ...(metadata ?? {}),
            },
          });
          return { output, promptTokens, completionTokens };
        }
      } catch (error) {
        throw new Error(`Agent retry failed (${action}): ${(error as Error).message}`);
      }
    }
    if (!parsed) {
      throw new Error(`Agent output was not valid JSON for ${action}`);
    }
    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(output);
    const durationSeconds = (Date.now() - startedAt) / 1000;
    await this.jobService.recordTokenUsage({
      timestamp: new Date().toISOString(),
      workspaceId: this.workspace.workspaceId,
      jobId,
      commandRunId,
      agentId: agent.id,
      modelName: agent.defaultModel,
      promptTokens,
      completionTokens,
      tokensPrompt: promptTokens,
      tokensCompletion: completionTokens,
      tokensTotal: promptTokens + completionTokens,
      durationSeconds,
      metadata: {
        action: `create_tasks_${action}`,
        phase: `create_tasks_${action}`,
        attempt: 1,
        ...(metadata ?? {}),
      },
    });
    return { output, promptTokens, completionTokens };
  }

  private parseEpics(output: string, fallbackDocs: DocdexDocument[], projectKey: string): AgentEpicNode[] {
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.epics) || parsed.epics.length === 0) {
      throw new Error("Agent did not return epics in expected format");
    }
    return (parsed.epics as any[])
      .map((epic, idx) => ({
        localId: epic.localId ?? `e${idx + 1}`,
        area: normalizeArea(epic.area),
        title: epic.title ?? "Epic",
        description: epic.description,
        acceptanceCriteria: Array.isArray(epic.acceptanceCriteria) ? epic.acceptanceCriteria : [],
        relatedDocs: normalizeRelatedDocs(epic.relatedDocs),
        priorityHint: typeof epic.priorityHint === "number" ? epic.priorityHint : undefined,
        stories: [],
      }))
      .filter((e) => e.title);
  }

  private async generateStoriesForEpic(
    agent: Agent,
    epic: AgentEpicNode & { key?: string },
    docSummary: string,
    projectBuildMethod: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
  ): Promise<AgentStoryNode[]> {
    const prompt = [
      `Generate user stories for epic "${epic.title}".`,
      "Use the User Story template: User Story; Context; Preconditions; Main Flow; Alternative/Error Flows; UX/UI; Data & Integrations; Acceptance Criteria; NFR; Related Docs.",
      "Return JSON only matching:",
      STORY_SCHEMA_SNIPPET,
      "Rules:",
      "- No tasks in this step.",
      "- acceptanceCriteria must be an array of strings.",
      "- Use docdex handles when citing docs.",
      "- Keep story sequencing aligned with the project construction method.",
      `Epic context (key=${epic.key ?? epic.localId ?? "TBD"}):`,
      epic.description ?? "(no description provided)",
      "Project construction method:",
      projectBuildMethod,
      `Docs: ${docSummary || "none"}`,
    ].join("\n\n");
    const { output } = await this.invokeAgentWithRetry(agent, prompt, "stories", stream, jobId, commandRunId, {
      epicKey: epic.key ?? epic.localId,
    });
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.stories) || parsed.stories.length === 0) {
      throw new Error(`Agent did not return stories for epic ${epic.title}`);
    }
    return parsed.stories
      .map((story: any, idx: number) => ({
        localId: story.localId ?? `us${idx + 1}`,
        title: story.title ?? "Story",
        userStory: story.userStory ?? story.description,
        description: story.description,
        acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
        relatedDocs: normalizeRelatedDocs(story.relatedDocs),
        priorityHint: typeof story.priorityHint === "number" ? story.priorityHint : undefined,
        tasks: [],
      }))
      .filter((s: AgentStoryNode) => s.title);
  }

  private async generateTasksForStory(
    agent: Agent,
    epic: { key?: string; title: string },
    story: AgentStoryNode & { key?: string },
    docSummary: string,
    projectBuildMethod: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
  ): Promise<AgentTaskNode[]> {
    const parseTestList = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      return value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    };
    const prompt = [
      `Generate tasks for story "${story.title}" (Epic: ${epic.title}).`,
      "Use the Task template: Objective; Context; Inputs; Implementation Plan; DoD; Testing & QA; Dependencies; Risks; References.",
      "Return JSON only matching:",
      TASK_SCHEMA_SNIPPET,
      "Rules:",
      "- Each task must include localId, title, description, type, estimatedStoryPoints, priorityHint.",
      "- Descriptions must be implementation-concrete and include target modules/files/services where work happens.",
      "- Prioritize software construction tasks before test-only/docs-only chores unless story scope explicitly requires those first.",
      "- Include test arrays: unitTests, componentTests, integrationTests, apiTests. Use [] when not applicable.",
      "- Only include tests that are relevant to the task's scope.",
      "- Prefer including task-relevant tests when they are concrete and actionable; do not invent generic placeholders.",
      "- When known, include qa object with profiles_expected/requires/entrypoints/data_setup to guide QA.",
      "- Do not hardcode ports. For QA entrypoints, use http://localhost:<PORT> placeholders or omit base_url when unknown.",
      "- dependsOnKeys must reference localIds in this story.",
      "- If dependsOnKeys is non-empty, include dependency rationale in the task description.",
      "- Start from prerequisite codebase setup: add structure/bootstrap tasks before feature tasks when missing.",
      "- Keep dependencies strictly inside this story; never reference tasks from other stories/epics.",
      "- Order tasks from foundational prerequisites to dependents based on documented dependency direction and startup constraints.",
      "- Avoid placeholder wording (TBD, TODO, to be defined, generic follow-up phrases).",
      "- Use docdex handles when citing docs.",
      "- If OPENAPI_HINTS are present in Docs, align tasks with hinted service/capability/stage/test_requirements.",
      "- If SDS_COVERAGE_HINTS are present in Docs, cover the relevant SDS sections in implementation tasks.",
      "- Follow the project construction method and startup-wave order from SDS when available.",
      `Story context (key=${story.key ?? story.localId ?? "TBD"}):`,
      story.description ?? story.userStory ?? "",
      `Acceptance criteria: ${(story.acceptanceCriteria ?? []).join("; ")}`,
      "Project construction method:",
      projectBuildMethod,
      `Docs: ${docSummary || "none"}`,
    ].join("\n\n");
    const { output } = await this.invokeAgentWithRetry(agent, prompt, "tasks", stream, jobId, commandRunId, {
      epicKey: epic.key,
      storyKey: story.key ?? story.localId,
    });
    const parsed = extractJson(output);
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new Error(`Agent did not return tasks for story ${story.title}`);
    }
    return parsed.tasks
      .map((task: any, idx: number) => {
        const unitTests = parseTestList(task.unitTests);
        const componentTests = parseTestList(task.componentTests);
        const integrationTests = parseTestList(task.integrationTests);
        const apiTests = parseTestList(task.apiTests);
        const title = task.title ?? "Task";
        const description = task.description ?? "";
        const qa = normalizeQaReadiness(task.qa);
        return {
          localId: task.localId ?? `t${idx + 1}`,
          title,
          type: normalizeTaskType(task.type) ?? "feature",
          description,
          estimatedStoryPoints: typeof task.estimatedStoryPoints === "number" ? task.estimatedStoryPoints : undefined,
          priorityHint: typeof task.priorityHint === "number" ? task.priorityHint : undefined,
          dependsOnKeys: Array.isArray(task.dependsOnKeys) ? task.dependsOnKeys : [],
          relatedDocs: normalizeRelatedDocs(task.relatedDocs),
          unitTests,
          componentTests,
          integrationTests,
          apiTests,
          qa,
        };
      })
      .filter((t: AgentTaskNode) => t.title);
  }

  private buildFallbackStoryForEpic(epic: PlanEpic): AgentStoryNode {
    const criteria = epic.acceptanceCriteria?.filter(Boolean) ?? [];
    return {
      localId: "us-fallback-1",
      title: `Deliver ${epic.title}`,
      userStory: `As a delivery team, we need an executable implementation story for ${epic.title}.`,
      description: [
        `Deterministic fallback story generated because model output for epic "${epic.title}" could not be parsed reliably.`,
        "Use SDS and related docs to decompose this story into concrete implementation tasks.",
      ].join("\n"),
      acceptanceCriteria:
        criteria.length > 0
          ? criteria
          : [
              "Story has actionable implementation tasks.",
              "Dependencies are explicit and story-scoped.",
              "Tasks are ready for execution.",
            ],
      relatedDocs: epic.relatedDocs ?? [],
      priorityHint: 1,
      tasks: [],
    };
  }

  private buildFallbackTasksForStory(story: PlanStory): AgentTaskNode[] {
    const criteriaLines = (story.acceptanceCriteria ?? [])
      .slice(0, 6)
      .map((criterion) => `- ${criterion}`)
      .join("\n");
    const objectiveLine =
      story.description && story.description.trim().length > 0
        ? story.description.trim().split(/\r?\n/)[0]
        : `Deliver story scope for "${story.title}".`;
    return [
      {
        localId: "t-fallback-1",
        title: `Implement core scope for ${story.title}`,
        type: "feature",
        description: [
          `Implement the core product behavior for story "${story.title}".`,
          `Primary objective: ${objectiveLine}`,
          "Create or update concrete modules/files and wire baseline runtime paths first.",
          "Capture exact implementation targets and sequencing in commit-level task notes.",
          criteriaLines ? `Acceptance criteria to satisfy:\n${criteriaLines}` : "Acceptance criteria: use story definition.",
        ].join("\n"),
        estimatedStoryPoints: 3,
        priorityHint: 1,
        dependsOnKeys: [],
        relatedDocs: story.relatedDocs ?? [],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
      {
        localId: "t-fallback-2",
        title: `Integrate contracts for ${story.title}`,
        type: "feature",
        description: [
          `Integrate dependent contracts/interfaces for "${story.title}" after core scope implementation.`,
          "Align internal/external interfaces, data contracts, and dependency wiring with SDS/OpenAPI context.",
          "Record dependency rationale and compatibility constraints in the task output.",
        ].join("\n"),
        estimatedStoryPoints: 3,
        priorityHint: 2,
        dependsOnKeys: ["t-fallback-1"],
        relatedDocs: story.relatedDocs ?? [],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
      {
        localId: "t-fallback-3",
        title: `Validate ${story.title} regressions and readiness`,
        type: "chore",
        description: [
          `Validate "${story.title}" end-to-end with focused regression coverage and readiness evidence.`,
          "Add/update targeted tests and verification scripts tied to implemented behavior.",
          "Document release/code-review/QA evidence and unresolved risks explicitly.",
        ].join("\n"),
        estimatedStoryPoints: 2,
        priorityHint: 3,
        dependsOnKeys: ["t-fallback-2"],
        relatedDocs: story.relatedDocs ?? [],
        unitTests: [],
        componentTests: [],
        integrationTests: [],
        apiTests: [],
      },
    ];
  }

  private async generatePlanFromAgent(
    epics: AgentEpicNode[],
    agent: Agent,
    docSummary: string,
    options: {
      agentStream: boolean;
      jobId: string;
      commandRunId: string;
      maxStoriesPerEpic?: number;
      maxTasksPerStory?: number;
      projectBuildMethod: string;
    },
  ): Promise<GeneratedPlan> {
    const planEpics: PlanEpic[] = epics.map((epic, idx) => ({
      ...epic,
      localId: epic.localId ?? `e${idx + 1}`,
    }));

    const planStories: PlanStory[] = [];
    const planTasks: PlanTask[] = [];
    const fallbackStoryScopes = new Set<string>();

    for (const epic of planEpics) {
      let stories: AgentStoryNode[] = [];
      let usedFallbackStories = false;
      try {
        stories = await this.generateStoriesForEpic(
          agent,
          { ...epic },
          docSummary,
          options.projectBuildMethod,
          options.agentStream,
          options.jobId,
          options.commandRunId,
        );
      } catch (error) {
        usedFallbackStories = true;
        await this.jobService.appendLog(
          options.jobId,
          `Story generation failed for epic "${epic.title}". Using deterministic fallback story. Reason: ${
            (error as Error).message ?? String(error)
          }\n`,
        );
        stories = [this.buildFallbackStoryForEpic(epic)];
      }
      let limitedStories = stories.slice(0, options.maxStoriesPerEpic ?? stories.length);
      if (limitedStories.length === 0) {
        usedFallbackStories = true;
        await this.jobService.appendLog(
          options.jobId,
          `Story generation returned no stories for epic "${epic.title}". Using deterministic fallback story.\n`,
        );
        limitedStories = [this.buildFallbackStoryForEpic(epic)];
      }
      limitedStories.forEach((story, idx) => {
        const planStory: PlanStory = {
          ...story,
          localId: story.localId ?? `us${idx + 1}`,
          epicLocalId: epic.localId,
        };
        planStories.push(planStory);
        if (usedFallbackStories) {
          fallbackStoryScopes.add(this.storyScopeKey(planStory.epicLocalId, planStory.localId));
        }
      });
    }

    for (const story of planStories) {
      const storyScope = this.storyScopeKey(story.epicLocalId, story.localId);
      let tasks: AgentTaskNode[] = [];
      if (fallbackStoryScopes.has(storyScope)) {
        tasks = this.buildFallbackTasksForStory(story);
      } else {
        try {
          tasks = await this.generateTasksForStory(
            agent,
            { key: story.epicLocalId, title: story.title },
            story,
            docSummary,
            options.projectBuildMethod,
            options.agentStream,
            options.jobId,
            options.commandRunId,
          );
        } catch (error) {
          await this.jobService.appendLog(
            options.jobId,
            `Task generation failed for story "${story.title}" (${storyScope}). Using deterministic fallback tasks. Reason: ${
              (error as Error).message ?? String(error)
            }\n`,
          );
          tasks = this.buildFallbackTasksForStory(story);
        }
      }
      let limitedTasks = tasks.slice(0, options.maxTasksPerStory ?? tasks.length);
      if (limitedTasks.length === 0) {
        await this.jobService.appendLog(
          options.jobId,
          `Task generation returned no tasks for story "${story.title}" (${storyScope}). Using deterministic fallback tasks.\n`,
        );
        limitedTasks = this.buildFallbackTasksForStory(story).slice(
          0,
          options.maxTasksPerStory ?? Number.MAX_SAFE_INTEGER,
        );
      }
      limitedTasks.forEach((task, idx) => {
        planTasks.push({
          ...task,
          localId: task.localId ?? `t${idx + 1}`,
          storyLocalId: story.localId,
          epicLocalId: story.epicLocalId,
        });
      });
    }

    return { epics: planEpics, stories: planStories, tasks: planTasks };
  }

  private buildSdsCoverageReport(projectKey: string, docs: DocdexDocument[], plan: GeneratedPlan): Record<string, unknown> {
    const sections = this.extractSdsSectionCandidates(docs, SDS_COVERAGE_REPORT_SECTION_LIMIT);
    const normalize = (value: string): string =>
      value
        .toLowerCase()
        .replace(/[`*_]/g, "")
        .replace(/[^a-z0-9\s/-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const planCorpus = normalize(
      [
        ...plan.epics.map((epic) => `${epic.title} ${epic.description ?? ""} ${(epic.acceptanceCriteria ?? []).join(" ")}`),
        ...plan.stories.map(
          (story) =>
            `${story.title} ${story.userStory ?? ""} ${story.description ?? ""} ${(story.acceptanceCriteria ?? []).join(" ")}`,
        ),
        ...plan.tasks.map((task) => `${task.title} ${task.description ?? ""}`),
      ].join("\n"),
    );
    const matched: string[] = [];
    const unmatched: string[] = [];
    for (const section of sections) {
      const normalizedSection = normalize(section);
      if (!normalizedSection) continue;
      const keywords = normalizedSection
        .split(/\s+/)
        .filter((token) => token.length >= 4)
        .slice(0, 6);
      const hasDirectMatch = normalizedSection.length >= 6 && planCorpus.includes(normalizedSection);
      const hasKeywordMatch = keywords.some((keyword) => planCorpus.includes(keyword));
      if (hasDirectMatch || hasKeywordMatch) {
        matched.push(section);
      } else {
        unmatched.push(section);
      }
    }
    const totalSections = matched.length + unmatched.length;
    const coverageRatio = totalSections === 0 ? 1 : matched.length / totalSections;
    return {
      projectKey,
      generatedAt: new Date().toISOString(),
      totalSections,
      matched,
      unmatched,
      coverageRatio: Number(coverageRatio.toFixed(4)),
      notes:
        totalSections === 0
          ? ["No SDS section headings detected; coverage defaults to 1.0."]
          : ["Coverage is heading-based heuristic match between SDS sections and generated epic/story/task corpus."],
    };
  }

  private async writePlanArtifacts(
    projectKey: string,
    plan: GeneratedPlan,
    docSummary: string,
    docs: DocdexDocument[],
  ): Promise<{ folder: string }> {
    const baseDir = path.join(this.workspace.mcodaDir, "tasks", projectKey);
    await fs.mkdir(baseDir, { recursive: true });
    const write = async (file: string, data: unknown) => {
      const target = path.join(baseDir, file);
      await fs.writeFile(target, JSON.stringify(data, null, 2), "utf8");
    };
    await write("plan.json", { projectKey, generatedAt: new Date().toISOString(), docSummary, ...plan });
    await write("epics.json", plan.epics);
    await write("stories.json", plan.stories);
    await write("tasks.json", plan.tasks);
    await write("coverage-report.json", this.buildSdsCoverageReport(projectKey, docs, plan));
    return { folder: baseDir };
  }

  private async persistPlanToDb(
    projectId: string,
    projectKey: string,
    plan: GeneratedPlan,
    jobId: string,
    commandRunId: string,
    options?: PersistPlanOptions,
  ): Promise<{ epics: EpicRow[]; stories: StoryRow[]; tasks: TaskRow[]; dependencies: TaskDependencyRow[] }> {
    const resetKeys = options?.resetKeys ?? false;
    const existingEpicKeys = resetKeys ? [] : await this.workspaceRepo.listEpicKeys(projectId);
    const epicKeyGen = createEpicKeyGenerator(projectKey, existingEpicKeys);

    const epicInserts: EpicInsert[] = [];
    const epicMeta: { key: string; node: PlanEpic }[] = [];

    for (const epic of plan.epics) {
      const key = epicKeyGen(epic.area);
      epicInserts.push({
        projectId,
        key,
        title: epic.title || `Epic ${key}`,
        description: buildEpicDescription(
          key,
          epic.title || `Epic ${key}`,
          epic.description,
          epic.acceptanceCriteria,
          epic.relatedDocs,
        ),
        storyPointsTotal: null,
        priority: epic.priorityHint ?? (epicInserts.length + 1),
        metadata: epic.relatedDocs ? { doc_links: epic.relatedDocs } : undefined,
      });
      epicMeta.push({ key, node: epic });
    }

    let epicRows: EpicRow[] = [];
    let storyRows: StoryRow[] = [];
    let taskRows: TaskRow[] = [];
    let dependencyRows: TaskDependencyRow[] = [];

    await this.workspaceRepo.withTransaction(async () => {
      if (options?.force) {
        await this.workspaceRepo.deleteProjectBacklog(projectId, false);
      }
      epicRows = await this.workspaceRepo.insertEpics(epicInserts, false);

      const storyInserts: StoryInsert[] = [];
      const storyMeta: { storyKey: string; epicKey: string; node: PlanStory }[] = [];
      for (const epic of epicMeta) {
        const epicRow = epicRows.find((row) => row.key === epic.key);
        if (!epicRow) continue;
        const stories = plan.stories.filter((s) => s.epicLocalId === epic.node.localId);
        const existingStoryKeys = await this.workspaceRepo.listStoryKeys(epicRow.id);
        const storyKeyGen = createStoryKeyGenerator(epicRow.key, existingStoryKeys);
        for (const story of stories) {
          const storyKey = storyKeyGen();
          storyInserts.push({
            projectId,
            epicId: epicRow.id,
            key: storyKey,
            title: story.title || `Story ${storyKey}`,
            description: buildStoryDescription(
              storyKey,
              story.title || `Story ${storyKey}`,
              story.userStory,
              story.description,
              story.acceptanceCriteria,
              story.relatedDocs,
            ),
            acceptanceCriteria: story.acceptanceCriteria?.join("\n") ?? undefined,
            storyPointsTotal: null,
            priority: story.priorityHint ?? (storyInserts.length + 1),
            metadata: story.relatedDocs ? { doc_links: story.relatedDocs } : undefined,
          });
          storyMeta.push({ storyKey, epicKey: epicRow.key, node: story });
        }
      }

      storyRows = await this.workspaceRepo.insertStories(storyInserts, false);
      const storyIdByKey = new Map(storyRows.map((row) => [row.key, row.id]));
      const epicIdByKey = new Map(epicRows.map((row) => [row.key, row.id]));

      type TaskDetail = {
        localId: string;
        epicLocalId: string;
        key: string;
        storyLocalId: string;
        storyKey: string;
        epicKey: string;
        plan: PlanTask;
      };
      const taskDetails: TaskDetail[] = [];
      for (const story of storyMeta) {
        const storyId = storyIdByKey.get(story.storyKey);
        const existingTaskKeys = storyId ? await this.workspaceRepo.listTaskKeys(storyId) : [];
        const tasks = plan.tasks.filter(
          (t) => t.storyLocalId === story.node.localId && t.epicLocalId === story.node.epicLocalId,
        );
        const taskKeyGen = createTaskKeyGenerator(story.storyKey, existingTaskKeys);
        for (const task of tasks) {
          const key = taskKeyGen();
          const localId = task.localId ?? key;
          taskDetails.push({
            localId,
            epicLocalId: story.node.epicLocalId,
            key,
            storyLocalId: story.node.localId,
            storyKey: story.storyKey,
            epicKey: story.epicKey,
            plan: task,
          });
        }
      }

      const scopedLocalKey = (epicLocalId: string, storyLocalId: string, localId: string): string =>
        this.taskScopeKey(epicLocalId, storyLocalId, localId);
      const localToKey = new Map(
        taskDetails.map((t) => [scopedLocalKey(t.epicLocalId, t.storyLocalId, t.localId), t.key]),
      );
      const taskInserts: TaskInsert[] = [];
      const testCommandBuilder = new QaTestCommandBuilder(this.workspace.workspaceRoot);
      for (const task of taskDetails) {
        const storyId = storyIdByKey.get(task.storyKey);
        const epicId = epicIdByKey.get(task.epicKey);
        if (!storyId || !epicId) continue;
        const classification = classifyTask({
          title: task.plan.title ?? `Task ${task.key}`,
          description: task.plan.description,
          type: task.plan.type,
        });
        const qaReadiness = buildQaReadiness({
          classification,
          planQa: task.plan.qa,
          preflight: options?.qaPreflight,
          overrides: options?.qaOverrides,
        });
        const testRequirements = {
          unit: task.plan.unitTests ?? [],
          component: task.plan.componentTests ?? [],
          integration: task.plan.integrationTests ?? [],
          api: task.plan.apiTests ?? [],
        };
        const testsRequired =
          testRequirements.unit.length > 0 ||
          testRequirements.component.length > 0 ||
          testRequirements.integration.length > 0 ||
          testRequirements.api.length > 0;
        let discoveredTestCommands: string[] = [];
        if (testsRequired) {
          try {
            const commandPlan = await testCommandBuilder.build({
              task: {
                id: task.key,
                key: task.key,
                title: task.plan.title ?? `Task ${task.key}`,
                description: task.plan.description ?? "",
                type: task.plan.type ?? "feature",
                status: "not_started",
                metadata: { test_requirements: testRequirements },
              } as TaskRow & { metadata?: any },
            });
            discoveredTestCommands = Array.from(new Set(commandPlan.commands.map((command) => command.trim()).filter(Boolean)));
          } catch {
            discoveredTestCommands = [];
          }
        }
        const qaBlockers = uniqueStrings(qaReadiness.blockers ?? []);
        const qaReadinessWithHarness: QaReadiness = {
          ...qaReadiness,
          blockers: qaBlockers.length ? qaBlockers : undefined,
        };
        const depSlugs = (task.plan.dependsOnKeys ?? [])
          .map((dep) => localToKey.get(scopedLocalKey(task.plan.epicLocalId, task.storyLocalId, dep)))
          .filter((value): value is string => Boolean(value));
        const metadata: Record<string, unknown> = {
          doc_links: task.plan.relatedDocs ?? [],
          test_requirements: testRequirements,
          stage: classification.stage,
          foundation: classification.foundation,
          qa: qaReadinessWithHarness,
        };
        if (discoveredTestCommands.length > 0) {
          metadata.tests = discoveredTestCommands;
          metadata.testCommands = discoveredTestCommands;
        }
        taskInserts.push({
          projectId,
          epicId,
          userStoryId: storyId,
          key: task.key,
          title: task.plan.title ?? `Task ${task.key}`,
          description: buildTaskDescription(
            task.key,
            task.plan.title ?? `Task ${task.key}`,
            task.plan.description,
            task.storyKey,
            task.epicKey,
            task.plan.relatedDocs,
            depSlugs,
            {
              unitTests: task.plan.unitTests,
              componentTests: task.plan.componentTests,
              integrationTests: task.plan.integrationTests,
              apiTests: task.plan.apiTests,
            },
            qaReadinessWithHarness,
          ),
          type: task.plan.type ?? "feature",
          status: "not_started",
          storyPoints: task.plan.estimatedStoryPoints ?? null,
          priority: task.plan.priorityHint ?? (taskInserts.length + 1),
          metadata,
        });
      }

      taskRows = await this.workspaceRepo.insertTasks(taskInserts, false);
      const taskByLocal = new Map<string, TaskRow>();
      for (const detail of taskDetails) {
        const row = taskRows.find((t) => t.key === detail.key);
        if (row) {
          taskByLocal.set(scopedLocalKey(detail.epicLocalId, detail.storyLocalId, detail.localId), row);
        }
      }

      const depKeys = new Set<string>();
      const dependencies: TaskDependencyInsert[] = [];
      for (const detail of taskDetails) {
        const current = taskByLocal.get(scopedLocalKey(detail.epicLocalId, detail.storyLocalId, detail.localId));
        if (!current) continue;
        for (const dep of detail.plan.dependsOnKeys ?? []) {
          const target = taskByLocal.get(scopedLocalKey(detail.plan.epicLocalId, detail.storyLocalId, dep));
          if (!target || target.id === current.id) continue;
          const depKey = `${current.id}|${target.id}|blocks`;
          if (depKeys.has(depKey)) continue;
          depKeys.add(depKey);
          dependencies.push({
            taskId: current.id,
            dependsOnTaskId: target.id,
            relationType: "blocks",
          });
        }
      }

      if (dependencies.length > 0) {
        dependencyRows = await this.workspaceRepo.insertTaskDependencies(dependencies, false);
      }

      // Roll up story and epic story point totals.
      const storySpTotals = new Map<string, number>();
      for (const task of taskRows) {
        if (typeof task.storyPoints === "number") {
          storySpTotals.set(task.userStoryId, (storySpTotals.get(task.userStoryId) ?? 0) + task.storyPoints);
        }
      }
      for (const [storyId, total] of storySpTotals.entries()) {
        await this.workspaceRepo.updateStoryPointsTotal(storyId, total);
      }
      const epicSpTotals = new Map<string, number>();
      for (const story of storyRows) {
        if (typeof story.storyPointsTotal === "number") {
          epicSpTotals.set(story.epicId, (epicSpTotals.get(story.epicId) ?? 0) + (story.storyPointsTotal ?? 0));
        }
      }
      for (const [epicId, total] of epicSpTotals.entries()) {
        await this.workspaceRepo.updateEpicStoryPointsTotal(epicId, total);
      }

      const now = new Date().toISOString();
      for (const task of taskRows) {
        await this.workspaceRepo.createTaskRun({
          taskId: task.id,
          command: "create-tasks",
          status: "succeeded",
          jobId,
          commandRunId,
          startedAt: now,
          finishedAt: now,
          runContext: { key: task.key },
        });
      }
    });

    return { epics: epicRows, stories: storyRows, tasks: taskRows, dependencies: dependencyRows };
  }

  async createTasks(options: CreateTasksOptions): Promise<CreateTasksResult> {
    const agentStream = options.agentStream !== false;
    const commandRun = await this.jobService.startCommandRun("create-tasks", options.projectKey);
    const job = await this.jobService.startJob(
      "create_tasks",
      commandRun.id,
      options.projectKey,
      {
        commandName: "create-tasks",
        payload: {
          projectKey: options.projectKey,
          inputs: options.inputs,
          agent: options.agentName,
          agentStream,
        },
      },
    );

    let lastError: unknown;
    for (let attempt = 1; attempt <= CreateTasksService.MAX_BUSY_RETRIES; attempt++) {
      try {
        const project = await this.workspaceRepo.createProjectIfMissing({
          key: options.projectKey,
          name: options.projectKey,
          description: `Workspace project ${options.projectKey}`,
        });

        const docs = await this.prepareDocs(options.inputs);
        const { docSummary, warnings: docWarnings } = this.buildDocContext(docs);
        const discoveryGraph = this.buildServiceDependencyGraph({ epics: [], stories: [], tasks: [] }, docs);
        const projectBuildMethod = this.buildProjectConstructionMethod(docs, discoveryGraph);
        const { prompt } = this.buildPrompt(options.projectKey, docs, projectBuildMethod, options);
        const qaPreflight = await this.buildQaPreflight();
        const qaOverrides = this.buildQaOverrides(options);
        await this.jobService.writeCheckpoint(job.id, {
          stage: "docs_indexed",
          timestamp: new Date().toISOString(),
          details: { count: docs.length, warnings: docWarnings, startupWaves: discoveryGraph.startupWaves.slice(0, 8) },
        });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "qa_preflight",
          timestamp: new Date().toISOString(),
          details: qaPreflight,
        });

        let agent: Agent | undefined;
        let planSource: "agent" | "fallback" = "agent";
        let fallbackReason: string | undefined;
        let plan: GeneratedPlan;
        try {
          agent = await this.resolveAgent(options.agentName);
          const { output: epicOutput } = await this.invokeAgentWithRetry(
            agent,
            prompt,
            "epics",
            agentStream,
            job.id,
            commandRun.id,
            { docWarnings },
          );
          const epics = this.parseEpics(epicOutput, docs, options.projectKey).slice(
            0,
            options.maxEpics ?? Number.MAX_SAFE_INTEGER,
          );
          await this.jobService.writeCheckpoint(job.id, {
            stage: "epics_generated",
            timestamp: new Date().toISOString(),
            details: { epics: epics.length, source: "agent" },
          });
          plan = await this.generatePlanFromAgent(epics, agent, docSummary, {
            agentStream,
            jobId: job.id,
            commandRunId: commandRun.id,
            maxStoriesPerEpic: options.maxStoriesPerEpic,
            maxTasksPerStory: options.maxTasksPerStory,
            projectBuildMethod,
          });
        } catch (error) {
          fallbackReason = (error as Error).message ?? String(error);
          planSource = "fallback";
          await this.jobService.appendLog(
            job.id,
            `Agent planning failed, using deterministic fallback plan: ${fallbackReason}\n`,
          );
          plan = this.materializePlanFromSeed(this.fallbackPlan(options.projectKey, docs), {
            maxEpics: options.maxEpics,
            maxStoriesPerEpic: options.maxStoriesPerEpic,
            maxTasksPerStory: options.maxTasksPerStory,
          });
          await this.jobService.writeCheckpoint(job.id, {
            stage: "epics_generated",
            timestamp: new Date().toISOString(),
            details: { epics: plan.epics.length, source: planSource, reason: fallbackReason },
          });
        }

        plan = this.enforceStoryScopedDependencies(plan);
        plan = this.injectStructureBootstrapPlan(plan, docs, options.projectKey);
        plan = this.enforceStoryScopedDependencies(plan);
        this.validatePlanLocalIdentifiers(plan);
        plan = this.applyServiceDependencySequencing(plan, docs);
        plan = this.enforceStoryScopedDependencies(plan);
        this.validatePlanLocalIdentifiers(plan);

        await this.jobService.writeCheckpoint(job.id, {
          stage: "stories_generated",
          timestamp: new Date().toISOString(),
          details: { stories: plan.stories.length, source: planSource, fallbackReason },
        });
        await this.jobService.writeCheckpoint(job.id, {
          stage: "tasks_generated",
          timestamp: new Date().toISOString(),
          details: { tasks: plan.tasks.length, source: planSource, fallbackReason },
        });

        const { folder } = await this.writePlanArtifacts(options.projectKey, plan, docSummary, docs);
        await this.jobService.writeCheckpoint(job.id, {
          stage: "plan_written",
          timestamp: new Date().toISOString(),
          details: { folder },
        });

        const { epics: epicRows, stories: storyRows, tasks: taskRows, dependencies: dependencyRows } =
          await this.persistPlanToDb(project.id, options.projectKey, plan, job.id, commandRun.id, {
            force: options.force,
            resetKeys: options.force,
            qaPreflight,
            qaOverrides,
          });
        await this.seedPriorities(options.projectKey);
        let sufficiencyAudit: TaskSufficiencyAuditResult | undefined;
        let sufficiencyAuditError: string | undefined;
        if (this.taskSufficiencyFactory) {
          try {
            const sufficiencyService = await this.taskSufficiencyFactory(this.workspace);
            try {
              try {
                sufficiencyAudit = await sufficiencyService.runAudit({
                  workspace: options.workspace,
                  projectKey: options.projectKey,
                  sourceCommand: "create-tasks",
                });
              } catch (error) {
                sufficiencyAuditError = (error as Error)?.message ?? String(error);
                await this.jobService.appendLog(
                  job.id,
                  `Task sufficiency audit failed; continuing with created backlog: ${sufficiencyAuditError}\n`,
                );
              }
            } finally {
              try {
                await sufficiencyService.close();
              } catch (closeError) {
                const closeMessage = (closeError as Error)?.message ?? String(closeError);
                const details = `Task sufficiency audit close failed; continuing with created backlog: ${closeMessage}`;
                sufficiencyAuditError = sufficiencyAuditError ? `${sufficiencyAuditError}; ${details}` : details;
                await this.jobService.appendLog(job.id, `${details}\n`);
              }
            }
          } catch (error) {
            sufficiencyAuditError = (error as Error)?.message ?? String(error);
            await this.jobService.appendLog(
              job.id,
              `Task sufficiency audit setup failed; continuing with created backlog: ${sufficiencyAuditError}\n`,
            );
          }
          await this.jobService.writeCheckpoint(job.id, {
            stage: "task_sufficiency_audit",
            timestamp: new Date().toISOString(),
            details: {
              status: sufficiencyAudit ? "succeeded" : "failed",
              error: sufficiencyAuditError,
              jobId: sufficiencyAudit?.jobId,
              commandRunId: sufficiencyAudit?.commandRunId,
              satisfied: sufficiencyAudit?.satisfied,
              dryRun: sufficiencyAudit?.dryRun,
              totalTasksAdded: sufficiencyAudit?.totalTasksAdded,
              totalTasksUpdated: sufficiencyAudit?.totalTasksUpdated,
              finalCoverageRatio: sufficiencyAudit?.finalCoverageRatio,
              reportPath: sufficiencyAudit?.reportPath,
              remainingSectionCount: sufficiencyAudit?.remainingSectionHeadings.length,
              remainingFolderCount: sufficiencyAudit?.remainingFolderEntries.length,
              remainingGapCount: sufficiencyAudit?.remainingGaps.total,
              warnings: sufficiencyAudit?.warnings,
            },
          });
        }

        await this.jobService.updateJobStatus(job.id, "completed", {
          payload: {
            epicsCreated: epicRows.length,
            storiesCreated: storyRows.length,
            tasksCreated: taskRows.length,
            dependenciesCreated: dependencyRows.length,
            docs: docSummary,
            planFolder: folder,
            planSource,
            fallbackReason,
            sufficiencyAudit: sufficiencyAudit
              ? {
                  jobId: sufficiencyAudit.jobId,
                  commandRunId: sufficiencyAudit.commandRunId,
                  satisfied: sufficiencyAudit.satisfied,
                  totalTasksAdded: sufficiencyAudit.totalTasksAdded,
                  totalTasksUpdated: sufficiencyAudit.totalTasksUpdated,
                  finalCoverageRatio: sufficiencyAudit.finalCoverageRatio,
                  reportPath: sufficiencyAudit.reportPath,
                  remainingSectionCount: sufficiencyAudit.remainingSectionHeadings.length,
                  remainingFolderCount: sufficiencyAudit.remainingFolderEntries.length,
                  remainingGapCount: sufficiencyAudit.remainingGaps.total,
                  warnings: sufficiencyAudit.warnings,
                }
              : undefined,
            sufficiencyAuditError,
          },
        });
        await this.jobService.finishCommandRun(commandRun.id, "succeeded");
        if (options.rateAgents && planSource === "agent" && agent) {
          try {
            const ratingService = this.ensureRatingService();
            await ratingService.rate({
              workspace: this.workspace,
              agentId: agent.id,
              commandName: "create-tasks",
              jobId: job.id,
              commandRunId: commandRun.id,
            });
          } catch (error) {
            const message = `Agent rating failed: ${(error as Error).message ?? String(error)}`;
            try {
              await this.jobService.appendLog(job.id, `${message}\n`);
            } catch {
              /* ignore rating log failures */
            }
          }
        }

        return {
          jobId: job.id,
          commandRunId: commandRun.id,
          epics: epicRows,
          stories: storyRows,
          tasks: taskRows,
          dependencies: dependencyRows,
        };
      } catch (error) {
        lastError = error;
        const message = (error as Error).message;
        const isBusy =
          message?.includes("SQLITE_BUSY") ||
          message?.includes("database is locked") ||
          message?.includes("busy");
        const remaining = CreateTasksService.MAX_BUSY_RETRIES - attempt;
        if (isBusy && remaining > 0) {
          const backoff = CreateTasksService.BUSY_BACKOFF_MS * attempt;
          await this.jobService.appendLog(
            job.id,
            `Encountered SQLITE_BUSY, retrying create-tasks (attempt ${attempt}/${CreateTasksService.MAX_BUSY_RETRIES}) after ${backoff}ms...\n`,
          );
          await delay(backoff);
          continue;
        }
        await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: message });
        await this.jobService.finishCommandRun(commandRun.id, "failed", message);
        throw error;
      }
    }
    await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: (lastError as Error)?.message });
    await this.jobService.finishCommandRun(commandRun.id, "failed", (lastError as Error)?.message);
    throw lastError ?? new Error("create-tasks failed");
  }

  async migratePlanFromFolder(options: {
    projectKey: string;
    planDir?: string;
    force?: boolean;
    refinePlanPath?: string;
    refinePlanPaths?: string[];
    refinePlansDir?: string;
  }): Promise<CreateTasksResult> {
    const projectKey = options.projectKey;
    const commandRun = await this.jobService.startCommandRun("migrate-tasks", projectKey);
    const job = await this.jobService.startJob("migrate_tasks", commandRun.id, projectKey, {
      commandName: "migrate-tasks",
      payload: { projectKey, planDir: options.planDir },
    });
    const planDir =
      options.planDir ?? path.join(this.workspace.mcodaDir, "tasks", projectKey);
    try {
      const planPath = path.join(planDir, "plan.json");
      const loadJson = async <T>(file: string): Promise<T | undefined> => {
        try {
          const raw = await fs.readFile(file, "utf8");
          return JSON.parse(raw) as T;
        } catch {
          return undefined;
        }
      };

      const planFromPlan = await loadJson<{ docSummary?: string } & GeneratedPlan>(planPath);
      const epicsFromFile = await loadJson<PlanEpic[]>(path.join(planDir, "epics.json"));
      const storiesFromFile = await loadJson<PlanStory[]>(path.join(planDir, "stories.json"));
      const tasksFromFile = await loadJson<PlanTask[]>(path.join(planDir, "tasks.json"));

      const epics = epicsFromFile ?? planFromPlan?.epics;
      const stories = storiesFromFile ?? planFromPlan?.stories;
      const tasks = tasksFromFile ?? planFromPlan?.tasks;
      const docSummary = planFromPlan?.docSummary;

      if (!epics || !stories || !tasks) {
        throw new Error(
          `Plan files missing required sections. Expected epics/stories/tasks in ${planDir} (plan.json or separate files).`,
        );
      }

      const project = await this.workspaceRepo.createProjectIfMissing({
        key: projectKey,
        name: projectKey,
        description: `Workspace project ${projectKey}`,
      });

      let plan: GeneratedPlan = {
        epics: epics as PlanEpic[],
        stories: stories as PlanStory[],
        tasks: tasks as PlanTask[],
      };
      plan = this.enforceStoryScopedDependencies(plan);
      plan = this.applyServiceDependencySequencing(plan, []);
      plan = this.enforceStoryScopedDependencies(plan);
      this.validatePlanLocalIdentifiers(plan);

      const loadRefinePlans = async (): Promise<string[]> => {
        const candidates: string[] = [];
        if (options.refinePlanPath) candidates.push(options.refinePlanPath);
        if (options.refinePlanPaths && options.refinePlanPaths.length) candidates.push(...options.refinePlanPaths);
        if (options.refinePlansDir) {
          const dir = path.resolve(options.refinePlansDir);
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              candidates.push(path.join(dir, entry.name, "plan.json"));
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
              candidates.push(path.join(dir, entry.name));
            }
          }
        }
        const uniq = Array.from(new Set(candidates.map((p) => path.resolve(p))));
        const existing: string[] = [];
        for (const file of uniq) {
          try {
            await fs.access(file);
            existing.push(file);
          } catch {
            // ignore missing file candidates (e.g., directory entries without plan.json)
          }
        }
        return existing.sort((a, b) => a.localeCompare(b));
      };

      const refinePlanPaths = await loadRefinePlans();

      // If refinement plans are provided, default to wiping existing backlog to avoid mixing old tasks.
      const forceBacklogReset = refinePlanPaths.length ? true : !!options.force;

      await this.jobService.writeCheckpoint(job.id, {
        stage: "plan_loaded",
        timestamp: new Date().toISOString(),
        details: { planDir, epics: plan.epics.length, stories: plan.stories.length, tasks: plan.tasks.length },
      });

      const { epics: epicRows, stories: storyRows, tasks: taskRows, dependencies: dependencyRows } =
        await this.persistPlanToDb(project.id, projectKey, plan, job.id, commandRun.id, {
          force: forceBacklogReset,
          resetKeys: forceBacklogReset,
        });

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: {
          epicsCreated: epicRows.length,
          storiesCreated: storyRows.length,
          tasksCreated: taskRows.length,
          dependenciesCreated: dependencyRows.length,
          docs: docSummary,
          planFolder: planDir,
        },
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");

      // Optionally apply a refinement plan from disk after seeding the backlog.
      if (refinePlanPaths.length > 0) {
        const { RefineTasksService } = await import("./RefineTasksService.js");
        const refineService = await RefineTasksService.create(this.workspace);
        try {
          for (const refinePlanPath of refinePlanPaths) {
            await refineService.refineTasks({
              workspace: this.workspace,
              projectKey,
              planInPath: path.resolve(refinePlanPath),
              fromDb: true,
              apply: true,
              agentStream: false,
              dryRun: false,
            });
          }
        } finally {
          await refineService.close();
        }
      }

      return {
        jobId: job.id,
        commandRunId: commandRun.id,
        epics: epicRows,
        stories: storyRows,
        tasks: taskRows,
        dependencies: dependencyRows,
      };
    } catch (error) {
      const message = (error as Error).message;
      await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: message });
      await this.jobService.finishCommandRun(commandRun.id, "failed", message);
      throw error;
    }
  }
}
