import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentService } from "@mcoda/agents";
import { DocdexClient, VcsClient } from "@mcoda/integrations";
import { GlobalRepository, WorkspaceRepository, type TaskCommentRow } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService, type JobState } from "../jobs/JobService.js";
import { TaskSelectionService, TaskSelectionFilters, TaskSelectionPlan } from "./TaskSelectionService.js";
import { TaskStateService } from "./TaskStateService.js";
import { RoutingService } from "../agents/RoutingService.js";
import { AgentRatingService } from "../agents/AgentRatingService.js";
import { loadProjectGuidance } from "../shared/ProjectGuidance.js";

const exec = promisify(execCb);
const DEFAULT_BASE_BRANCH = "mcoda-dev";
const DEFAULT_TASK_BRANCH_PREFIX = "mcoda/task/";
const TASK_LOCK_TTL_SECONDS = 60 * 60;
const MAX_TEST_FIX_ATTEMPTS = 3;
const DEFAULT_TEST_OUTPUT_CHARS = 1200;
const REPO_PROMPTS_DIR = fileURLToPath(new URL("../../../../../prompts/", import.meta.url));
const resolveRepoPromptPath = (filename: string): string => path.join(REPO_PROMPTS_DIR, filename);
const DEFAULT_CODE_WRITER_PROMPT = [
  "You are the code-writing agent. Before coding, query docdex with the task key and feature keywords (MCP `docdex_search` limit 4–8 or CLI `docdexd query --repo <repo> --query \"<term>\" --limit 6 --snippets=false`). If results look stale, reindex (`docdex_index` or `docdexd index --repo <repo>`) then re-run search. Fetch snippets via `docdex_open` or `/snippet/:doc_id?text_only=true` only for specific hits.",
  "Use docdex snippets to ground decisions (data model, offline/online expectations, constraints, acceptance criteria). Note when docdex is unavailable and fall back to local docs.",
  "Re-use existing store/slices/adapters and tests; avoid inventing new backends or ad-hoc actions. Keep behavior backward-compatible and scoped to the documented contracts.",
  "If you encounter merge conflicts, resolve them first (clean conflict markers and ensure code compiles) before continuing task work.",
  "If a target file does not exist, create it by outputting a FILE block (not a diff): `FILE: path/to/file.ext` followed by a fenced code block containing the full file contents. Do not respond with JSON-only output; if the runtime forces JSON, include a top-level `patch` string (unified diff) or `files` array of {path, content}.",
].join("\n");
const DEFAULT_JOB_PROMPT = "You are an mcoda agent that follows workspace runbooks and responds with actionable, concise output.";
const DEFAULT_CHARACTER_PROMPT =
  "Write clearly, avoid hallucinations, cite assumptions, and prioritize risk mitigation for the user.";

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
  onAgentChunk?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  maxAgentSeconds?: number;
  allowFileOverwrite?: boolean;
}

export interface TaskExecutionResult {
  taskKey: string;
  status: "succeeded" | "blocked" | "failed" | "skipped";
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

const looksLikeUnifiedDiff = (value: string): boolean => {
  if (/^diff --git /m.test(value) || /\*\*\* Begin Patch/.test(value)) return true;
  const hasFileHeaders = /^---\s+\S+/m.test(value) && /^\+\+\+\s+\S+/m.test(value);
  const hasHunk = /^@@\s+-\d+/m.test(value);
  return hasFileHeaders && hasHunk;
};

const extractPatches = (output: string): string[] => {
  const patches = new Set<string>();
  const fenceRegex = /```(\w+)?\s*\r?\n([\s\S]*?)\r?\n```/g;

  for (const match of output.matchAll(fenceRegex)) {
    const lang = (match[1] ?? "").toLowerCase();
    const content = (match[2] ?? "").trim();
    if (!content) continue;
    if (lang === "patch" || lang === "diff" || looksLikeUnifiedDiff(content)) {
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

const extractPlainCodeFence = (output: string): string | null => {
  const match = output.match(/```(\w+)?\s*\r?\n([\s\S]*?)\r?\n```/);
  if (!match) return null;
  const lang = (match[1] ?? "").toLowerCase();
  if (lang === "patch" || lang === "diff") return null;
  const content = (match[2] ?? "").trimEnd();
  return content ? content : null;
};

const normalizeFileBlockPath = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.replace(/^[`'"]+|[`'"]+$/g, "");
};

const extractFileBlocks = (output: string): Array<{ path: string; content: string }> => {
  const files: Array<{ path: string; content: string }> = [];
  const regex = /(?:^|\r?\n)\s*(?:[-*]\s*)?FILE:\s*([^\r\n]+)\r?\n```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/g;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(output)) !== null) {
    const filePath = normalizeFileBlockPath(match[1] ?? "");
    if (!filePath) continue;
    const content = match[2] ?? "";
    const key = `${filePath}::${content.length}`;
    if (!seen.has(key)) {
      files.push({ path: filePath, content });
      seen.add(key);
    }
  }
  if (!files.length) {
    const lines = output.split(/\r?\n/);
    let currentPath: string | null = null;
    let buffer: string[] = [];
    const flush = () => {
      if (!currentPath) return;
      let content = buffer.join("\n");
      const trimmed = content.trim();
      if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
        const contentLines = content.split(/\r?\n/);
        contentLines.shift();
        contentLines.pop();
        content = contentLines.join("\n");
      }
      const key = `${currentPath}::${content.length}`;
      if (!seen.has(key)) {
        files.push({ path: currentPath, content });
        seen.add(key);
      }
      currentPath = null;
      buffer = [];
    };
    for (const line of lines) {
      const fileMatch = line.match(/^\s*(?:[-*]\s*)?FILE:\s*(.+)$/);
      if (fileMatch) {
        flush();
        currentPath = normalizeFileBlockPath(fileMatch[1] ?? "");
        if (!currentPath) {
          currentPath = null;
        }
        buffer = [];
        continue;
      }
      if (currentPath) buffer.push(line);
    }
    flush();
  }
  return files;
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

const extractFileBlocksFromJson = (payload: unknown): Array<{ path: string; content: string }> => {
  const files = new Map<string, string>();
  const seen = new Set<unknown>();
  const addFile = (filePath: string, content: string) => {
    const normalizedPath = filePath.trim();
    if (!normalizedPath) return;
    files.set(normalizedPath, content);
  };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string" && typeof record.content === "string") {
      addFile(record.path, record.content);
    }
    if (typeof record.file === "string" && typeof record.contents === "string") {
      addFile(record.file, record.contents);
    }
    const fileContainers = ["files", "fileBlocks", "file_blocks", "newFiles", "writeFiles"];
    for (const key of fileContainers) {
      const container = record[key];
      if (!container || typeof container !== "object") continue;
      if (Array.isArray(container)) {
        container.forEach(visit);
        continue;
      }
      const entries = Object.entries(container as Record<string, unknown>);
      if (entries.length && entries.every(([, val]) => typeof val === "string")) {
        entries.forEach(([filePath, content]) => addFile(filePath, content as string));
      } else {
        visit(container);
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(payload);
  return Array.from(files.entries()).map(([filePath, content]) => ({ path: filePath, content }));
};

const extractAgentChanges = (
  output: string,
): { patches: string[]; fileBlocks: Array<{ path: string; content: string }>; jsonDetected: boolean } => {
  const placeholderRegex = /\?\?\?|rest of existing code/i;
  let patches = extractPatches(output);
  let fileBlocks = extractFileBlocks(output);
  let jsonDetected = false;
  if (patches.length) {
    patches = patches.filter((patch) => !placeholderRegex.test(patch));
  }
  if (patches.length === 0 && fileBlocks.length === 0) {
    const payload = parseJsonPayload(output);
    if (payload) {
      jsonDetected = true;
      patches = extractPatchesFromJson(payload);
      fileBlocks = extractFileBlocksFromJson(payload);
      if (patches.length) {
        patches = patches.filter((patch) => !placeholderRegex.test(patch));
      }
    } else if (looksLikeJsonOutput(output)) {
      jsonDetected = true;
    }
  }
  return { patches, fileBlocks, jsonDetected };
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

const detectDefaultTestCommand = (workspaceRoot: string): string | undefined => {
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
  const execPath = process.execPath;
  return execPath.includes(" ") ? `"${execPath}"` : execPath;
};

const detectRunAllTestsCommand = (workspaceRoot: string): string | undefined => {
  const scriptPath = path.join(workspaceRoot, "tests", "all.js");
  if (!fs.existsSync(scriptPath)) return undefined;
  const relative = path.relative(workspaceRoot, scriptPath).split(path.sep).join("/");
  return `${resolveNodeCommand()} ${relative}`;
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
    'import { spawnSync } from "node:child_process";',
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
  const hasPackageJson = fs.existsSync(path.join(workspaceRoot, "package.json"));
  const skipped: string[] = [];
  const sanitized = commands.filter((command) => {
    const trimmed = command.trim();
    if (!trimmed) return false;
    const normalized = trimmed.replace(/\s+/g, " ");
    const isPkgManager = /^(npm|yarn|pnpm)\b/i.test(normalized);
    if (!isPkgManager) return true;
    const hasExplicitCwd = /\s(--prefix|-C)\s|\s(--prefix|-C)=/i.test(normalized);
    if (!hasPackageJson && !hasExplicitCwd) {
      skipped.push(command);
      return false;
    }
    return true;
  });
  return { commands: sanitized, skipped };
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

const normalizePaths = (workspaceRoot: string, files: string[]): string[] =>
  files.map((f) => path.relative(workspaceRoot, path.isAbsolute(f) ? f : path.join(workspaceRoot, f))).map((f) => f.replace(/\\/g, "/"));
const resolveLockTtlSeconds = (maxAgentSeconds?: number): number => {
  if (!maxAgentSeconds || maxAgentSeconds <= 0) return TASK_LOCK_TTL_SECONDS;
  return Math.max(1, Math.min(TASK_LOCK_TTL_SECONDS, maxAgentSeconds + 60));
};
const MCODA_GITIGNORE_ENTRY = ".mcoda/\n";
const WORK_DIR = (jobId: string, workspaceRoot: string) => path.join(workspaceRoot, ".mcoda", "jobs", jobId, "work");

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
    value = value.replace(/^a\//, "").replace(/^b\//, "");
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

const isPlaceholderPatch = (patch: string): boolean => /\?\?\?/.test(patch) || /rest of existing code/i.test(patch);

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
    const mcodaPromptPath = path.join(this.workspace.workspaceRoot, ".mcoda", "prompts", "code-writer.md");
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
    const commandPromptFiles = await this.readPromptFiles([
      mcodaPromptPath,
      workspacePromptPath,
      repoPromptPath,
    ]);
    const mergedCommandPrompt = (() => {
      const parts = [...commandPromptFiles];
      if (agentPrompts?.commandPrompts?.["work-on-tasks"]) {
        parts.push(agentPrompts.commandPrompts["work-on-tasks"]);
      }
      if (!parts.length) parts.push(DEFAULT_CODE_WRITER_PROMPT);
      return parts.filter(Boolean).join("\n\n");
    })();
    return {
      jobPrompt: agentPrompts?.jobPrompt ?? DEFAULT_JOB_PROMPT,
      characterPrompt: agentPrompts?.characterPrompt ?? DEFAULT_CHARACTER_PROMPT,
      commandPrompt: mergedCommandPrompt || undefined,
    };
  }

  private async ensureMcoda(): Promise<void> {
    await PathHelper.ensureDir(this.workspace.mcodaDir);
    const gitignorePath = path.join(this.workspace.workspaceRoot, ".gitignore");
    try {
      const content = await fs.promises.readFile(gitignorePath, "utf8");
      if (!content.includes(".mcoda/")) {
        await fs.promises.writeFile(gitignorePath, `${content.trimEnd()}\n${MCODA_GITIGNORE_ENTRY}`, "utf8");
      }
    } catch {
      await fs.promises.writeFile(gitignorePath, MCODA_GITIGNORE_ENTRY, "utf8");
    }
  }

  private async writeWorkCheckpoint(jobId: string, data: Record<string, unknown>): Promise<void> {
    const dir = WORK_DIR(jobId, this.workspace.workspaceRoot);
    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, "state.json");
    await fs.promises.writeFile(target, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), "utf8");
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
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
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

  private async resolveAgent(agentName?: string) {
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: "work-on-tasks",
      overrideAgentSlug: agentName,
    });
    return resolved.agent;
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
      metadata: { commandName: "work-on-tasks", phase: params.phase ?? "agent", action: params.phase ?? "agent" },
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

  private async gatherDocContext(projectKey?: string, docLinks: string[] = []): Promise<{ summary: string; warnings: string[] }> {
    const warnings: string[] = [];
    const parts: string[] = [];
    try {
      const docs = await this.deps.docdex.search({ projectKey, profile: "workspace-code" });
      parts.push(
        ...docs
          .slice(0, 5)
          .map((doc) => `- [${doc.docType}] ${doc.title ?? doc.path ?? doc.id}`),
      );
    } catch (error) {
      warnings.push(`docdex search failed: ${(error as Error).message}`);
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
        let doc = undefined;
        if (type === "path" && "findDocumentByPath" in this.deps.docdex) {
          doc = await (this.deps.docdex as DocdexClient).findDocumentByPath(ref);
        }
        if (!doc) {
          doc = await this.deps.docdex.fetchDocumentById(ref);
        }
        if (!doc) {
          warnings.push(`docdex fetch returned no document for ${link}`);
          continue;
        }
        const excerpt = doc.segments?.[0]?.content?.slice(0, 240);
        parts.push(`- [linked:${doc.docType}] ${doc.title ?? doc.id}${excerpt ? ` — ${excerpt}` : ""}`);
      } catch (error) {
        warnings.push(`docdex fetch failed for ${link}: ${(error as Error).message}`);
      }
    }
    const summary = parts.join("\n");
    return { summary, warnings };
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
      const slug = comment.slug?.trim() || undefined;
      const details = this.parseCommentBody(comment.body);
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

  private async loadUnresolvedComments(taskId: string): Promise<TaskCommentRow[]> {
    return this.deps.workspaceRepo.listTaskComments(taskId, {
      sourceCommands: ["code-review", "qa-tasks"],
      resolved: false,
      limit: 20,
    });
  }

  private buildPrompt(
    task: TaskSelectionPlan["ordered"][number],
    docSummary: string,
    fileScope: string[],
    commentBacklog: string,
  ): string {
    const deps = task.dependencies.keys.length ? `Depends on: ${task.dependencies.keys.join(", ")}` : "No open dependencies.";
    const acceptance = (task.task.acceptanceCriteria ?? []).join("; ");
    const docdexHint =
      docSummary ||
      "Use docdex: search workspace docs with project key and fetch linked documents when present (doc_links metadata).";
    const backlog = commentBacklog ? `Comment backlog:\n${commentBacklog}` : "";
    return [
      `Task ${task.task.key}: ${task.task.title}`,
      `Description: ${task.task.description ?? "(none)"}`,
      `Epic: ${task.task.epicKey} (${task.task.epicTitle ?? "n/a"}), Story: ${task.task.storyKey} (${task.task.storyTitle ?? "n/a"})`,
      `Acceptance: ${acceptance || "Refer to SDS/OpenAPI for expected behavior."}`,
      deps,
      backlog,
      `Allowed files: ${fileScope.length ? fileScope.join(", ") : "(not constrained)"}`,
      `Doc context:\n${docdexHint}`,
      "Verify target paths against the current workspace (use docdex/file hints); do not assume hashed or generated asset names exist. If a path is missing, emit a new-file diff with full content (and parent dirs) instead of editing a non-existent file so git apply succeeds. Use valid unified diffs without JSON wrappers.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async checkoutBaseBranch(baseBranch: string): Promise<void> {
    await this.vcs.ensureRepo(this.workspace.workspaceRoot);
    await this.vcs.ensureBaseBranch(this.workspace.workspaceRoot, baseBranch);
    const dirtyBefore = await this.vcs.dirtyPaths(this.workspace.workspaceRoot);
    const nonMcodaBefore = dirtyBefore.filter((p: string) => !p.startsWith(".mcoda"));
    if (nonMcodaBefore.length) {
      await this.vcs.stage(this.workspace.workspaceRoot, nonMcodaBefore);
      const status = await this.vcs.status(this.workspace.workspaceRoot);
      if (status.trim().length) {
        await this.vcs.commit(this.workspace.workspaceRoot, "[mcoda] auto-commit workspace changes");
      }
    }
    const dirtyAfter = await this.vcs.dirtyPaths(this.workspace.workspaceRoot);
    const nonMcodaAfter = dirtyAfter.filter((p: string) => !p.startsWith(".mcoda"));
    if (nonMcodaAfter.length) {
      throw new Error(`Working tree dirty: ${nonMcodaAfter.join(", ")}`);
    }
    await this.vcs.checkoutBranch(this.workspace.workspaceRoot, baseBranch);
  }

  private async commitPendingChanges(
    branchInfo: { branch: string; base: string } | null,
    taskKey: string,
    taskTitle: string,
    reason: string,
    taskId: string,
    taskRunId: string,
  ): Promise<void> {
    const dirty = await this.vcs.dirtyPaths(this.workspace.workspaceRoot);
    const nonMcoda = dirty.filter((p: string) => !p.startsWith(".mcoda"));
    if (!nonMcoda.length) return;
    await this.vcs.stage(this.workspace.workspaceRoot, nonMcoda);
    const status = await this.vcs.status(this.workspace.workspaceRoot);
    if (!status.trim().length) return;
    const message = `[${taskKey}] ${taskTitle} (${reason})`;
    await this.vcs.commit(this.workspace.workspaceRoot, message);
    const head = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
    await this.deps.workspaceRepo.updateTask(taskId, {
      vcsLastCommitSha: head,
      vcsBranch: branchInfo?.branch ?? null,
      vcsBaseBranch: branchInfo?.base ?? null,
    });
    await this.logTask(taskRunId, `Auto-committed pending changes (${reason})`, "vcs", {
      branch: branchInfo?.branch,
      base: branchInfo?.base,
      head,
    });
  }

  private async ensureBranches(
    taskKey: string,
    baseBranch: string,
    taskRunId: string,
  ): Promise<{ branch: string; base: string; mergeConflicts?: string[]; remoteSyncNote?: string }> {
    const branch = `${DEFAULT_TASK_BRANCH_PREFIX}${taskKey}`;
    await this.checkoutBaseBranch(baseBranch);
    const hasRemote = await this.vcs.hasRemote(this.workspace.workspaceRoot);
    if (hasRemote) {
      try {
        await this.vcs.pull(this.workspace.workspaceRoot, "origin", baseBranch, true);
      } catch (error) {
        await this.logTask(taskRunId, `Warning: failed to pull ${baseBranch} from origin; continuing with local base.`, "vcs", {
          error: (error as Error).message,
        });
      }
    }
    const branchExists = await this.vcs.branchExists(this.workspace.workspaceRoot, branch);
    let remoteSyncNote = "";
    if (branchExists) {
      await this.vcs.checkoutBranch(this.workspace.workspaceRoot, branch);
      const dirty = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter((p) => !p.startsWith(".mcoda"));
      if (dirty.length) {
        throw new Error(`Task branch ${branch} has uncommitted changes: ${dirty.join(", ")}`);
      }
      if (hasRemote) {
        try {
          await this.vcs.pull(this.workspace.workspaceRoot, "origin", branch, true);
        } catch (error) {
          const errorText = this.formatGitError(error);
          await this.logTask(taskRunId, `Warning: failed to pull ${branch} from origin; continuing with local branch.`, "vcs", {
            error: errorText,
          });
          if (this.isNonFastForwardPull(errorText)) {
            remoteSyncNote = `Remote task branch ${branch} is ahead/diverged. Sync it with origin (pull/rebase or merge) and resolve conflicts before continuing task work.`;
          }
        }
      }
      try {
        await this.vcs.merge(this.workspace.workspaceRoot, baseBranch, branch, true);
      } catch (error) {
        const conflicts = await this.vcs.conflictPaths(this.workspace.workspaceRoot);
        if (conflicts.length) {
          await this.logTask(taskRunId, `Merge conflicts detected while merging ${baseBranch} into ${branch}.`, "vcs", {
            conflicts,
          });
          await this.vcs.abortMerge(this.workspace.workspaceRoot);
          return { branch, base: baseBranch, mergeConflicts: conflicts, remoteSyncNote };
        }
        throw new Error(`Failed to merge ${baseBranch} into ${branch}: ${(error as Error).message}`);
      }
    } else {
      await this.vcs.createOrCheckoutBranch(this.workspace.workspaceRoot, branch, baseBranch);
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
    const normalizedAllowed = allowed.map((f) => f.replace(/\\/g, "/"));
    const outOfScope = touched.filter((f) => !normalizedAllowed.some((allowedPath) => f === allowedPath || f.startsWith(`${allowedPath}/`)));
    if (outOfScope.length) {
      return { ok: false, message: `Patch touches files outside allowed scope: ${outOfScope.join(", ")}` };
    }
    return { ok: true };
  }

  private async applyPatches(
    patches: string[],
    cwd: string,
    dryRun: boolean,
  ): Promise<{ touched: string[]; error?: string; warnings?: string[] }> {
    const touched = new Set<string>();
    const warnings: string[] = [];
    let applied = 0;
    for (const patch of patches) {
      const normalized = maybeConvertApplyPatch(patch);
      const withHeader = ensureDiffHeader(normalized);
      const withPaths = normalizeDiffPaths(withHeader, cwd);
      const withAdds = convertMissingFilePatchToAdd(withPaths, cwd);
      const withHunks = normalizeHunkHeaders(withAdds);
      const withPrefixes = fixMissingPrefixesInHunks(withHunks);
      const sanitized = stripInvalidIndexLines(withPrefixes);
      if (isPlaceholderPatch(sanitized)) {
        warnings.push("Skipped placeholder patch that contained ??? or 'rest of existing code'.");
        continue;
      }
      const files = touchedFilesFromPatch(sanitized);
      if (!files.length) {
        warnings.push("Skipped patch with no recognizable file paths.");
        continue;
      }
      const segments = splitPatchIntoDiffs(sanitized);
      for (const segment of segments) {
        const segmentFiles = touchedFilesFromPatch(segment);
        const existingFiles = new Set(segmentFiles.map((f) => path.join(cwd, f)).filter((f) => fs.existsSync(f)));
        let patchToApply = segment;
        if (existingFiles.size > 0) {
          const { patch: converted, skipped } = updateAddPatchForExistingFile(segment, existingFiles, cwd);
          patchToApply = converted;
          if (skipped.length) {
            warnings.push(`Skipped add patch for existing files: ${skipped.join(", ")}`);
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
              warnings.push(
                `Patch segment failed and fallback write failed (${segmentFiles.join(", ") || "unknown files"}): ${(writeError as Error).message}`,
              );
              continue;
            }
          }
          warnings.push(`Patch segment failed (${segmentFiles.join(", ") || "unknown files"}): ${(error as Error).message}`);
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

  private async runTests(
    commands: string[],
    cwd: string,
    abortSignal?: AbortSignal,
  ): Promise<{ ok: boolean; results: { command: string; stdout: string; stderr: string; code: number }[] }> {
    const results: { command: string; stdout: string; stderr: string; code: number }[] = [];
    for (const command of commands) {
      try {
        if (abortSignal?.aborted) {
          throw new Error("work_on_tasks_aborted");
        }
        const { stdout, stderr } = await exec(command, { cwd, signal: abortSignal });
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
    const agentStream = request.agentStream !== false;
    const configuredBaseBranch = this.workspace.config?.branch;
    const requestedBaseBranch = request.baseBranch;
    const resolvedBaseBranch = (requestedBaseBranch ?? configuredBaseBranch ?? DEFAULT_BASE_BRANCH).trim();
    const baseBranch = resolvedBaseBranch.length ? resolvedBaseBranch : DEFAULT_BASE_BRANCH;
    const configuredAutoMerge = this.workspace.config?.autoMerge;
    const configuredAutoPush = this.workspace.config?.autoPush;
    const autoMerge = request.autoMerge ?? configuredAutoMerge ?? true;
    const autoPush = request.autoPush ?? configuredAutoPush ?? true;
    const baseBranchWarnings =
      requestedBaseBranch && configuredBaseBranch && requestedBaseBranch !== configuredBaseBranch
        ? [`Base branch override ${requestedBaseBranch} differs from workspace config ${configuredBaseBranch}.`]
        : [];
    const commandRun = await this.deps.jobService.startCommandRun("work-on-tasks", request.projectKey, {
      taskIds: request.taskKeys,
    });
    const job = await this.deps.jobService.startJob("work", commandRun.id, request.projectKey, {
      commandName: "work-on-tasks",
      payload: {
        projectKey: request.projectKey,
        epicKey: request.epicKey,
        storyKey: request.storyKey,
        tasks: request.taskKeys,
        statusFilter: request.statusFilter,
        limit: request.limit,
        parallel: request.parallel,
        noCommit: request.noCommit ?? false,
        dryRun: request.dryRun ?? false,
        agent: request.agentName,
        agentStream,
      },
    });

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
      await this.checkoutBaseBranch(baseBranch);
      selection = await this.selectionService.selectTasks({
        projectKey: request.projectKey,
        epicKey: request.epicKey,
        storyKey: request.storyKey,
        taskKeys: request.taskKeys,
        statusFilter: request.statusFilter,
        limit: request.limit,
        parallel: request.parallel,
      });

      await this.checkpoint(job.id, "selection", {
        ordered: selection.ordered.map((t) => t.task.key),
        blocked: selection.blocked.map((t) => t.task.key),
      });

      await this.deps.jobService.updateJobStatus(job.id, "running", {
        payload: {
          ...(job.payload ?? {}),
          selection: selection.ordered.map((t) => t.task.key),
          blocked: selection.blocked.map((t) => t.task.key),
        },
        totalItems: selection.ordered.length,
        processedItems: 0,
      });

      const results: TaskExecutionResult[] = [];
      const warnings: string[] = [...baseBranchWarnings, ...selection.warnings];
      const agent = await this.resolveAgent(request.agentName);
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
      }): void => {
        emitLine("╭──────────────────────────────────────────────────────────╮");
        emitLine("│                      START OF TASK                       │");
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
        emitBlank();
        emitLine("    ░░░░░ START OF A NEW TASK ░░░░░");
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
        headSha?: string | null;
      }): Promise<void> => {
        const tokensTotal = details.tokensPrompt + details.tokensCompletion;
        const promptEstimate = Math.max(1, details.promptEstimate);
        const usagePercent = (tokensTotal / promptEstimate) * 100;
        const completion = details.status === "succeeded" ? 100 : 0;
        const completionBar = "💰".repeat(15);
        const statusLabel =
          details.status === "succeeded"
            ? "COMPLETED"
            : details.status === "skipped"
              ? "SKIPPED"
              : details.status === "blocked"
                ? "BLOCKED"
                : "FAILED";
        const hasRemote = await this.vcs.hasRemote(this.workspace.workspaceRoot);
        const tracking = details.taskBranch ? (hasRemote ? `origin/${details.taskBranch}` : "n/a") : "n/a";
        const headSha = details.headSha ?? "n/a";
        const baseLabel = details.baseBranch ?? baseBranch;
        emitLine("╭──────────────────────────────────────────────────────────╮");
        emitLine("│                       END OF TASK                        │");
        emitLine("╰──────────────────────────────────────────────────────────╯");
        emitLine(
          `  👏🏼 TASK ${details.taskKey} | 📜 STATUS ${statusLabel} | 🏠 TERMINAL ${details.terminal} | ⚡ SP ${
            details.storyPoints ?? 0
          } | ⌛ TIME ${formatDuration(details.elapsedMs)}`,
        );
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
        emitLine(`  [🚀] Merge→dev:   ${details.mergeStatus}`);
        emitLine(`  [🐲] HEAD:        ${headSha}`);
        emitLine(`  [♨️] Files:       ${details.touchedFiles}`);
        emitLine(`  [🔑] Base:        ${baseLabel}`);
        emitLine("  [🧾] Git log:    n/a");
        emitBlank();
        emitLine("🗂 Artifacts");
        emitLine("────────────────────────────────────────────────────────────");
        emitLine("  • History:    n/a");
        emitLine("  • Git log:    n/a");
        emitBlank();
        emitLine("    ░░░░░ END OF THE TASK WORK ░░░░░");
        emitBlank();
      };

      taskLoop: for (const [index, task] of selection.ordered.entries()) {
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

        const sessionId = formatSessionId(startedAt);
        const initialStatus = (task.task.status ?? "").toLowerCase().trim();
        const taskAlias = `Working on task ${task.task.key}`;
        const taskSummary = task.task.title || task.task.description || "(none)";
        const modelLabel = agent.defaultModel ?? "(default)";
        const providerLabel = resolveProvider(agent.adapter);
        const reasoningLabel = resolveReasoning(agent.config as Record<string, unknown> | undefined);
        const stepLabel = "patch";
        const taskStartMs = Date.now();
        let taskStatus: TaskExecutionResult["status"] | null = null;
        let tokensPromptTotal = 0;
        let tokensCompletionTotal = 0;
        let promptEstimateBase = 0;
        let promptEstimateTotal = 0;
        let mergeStatus: "merged" | "skipped" | "failed" = "skipped";
        let patchApplied = false;
        let runAllScriptCreated = false;
        let touched: string[] = [];
        let unresolvedComments: TaskCommentRow[] = [];
        let taskBranchName: string | null = task.task.vcsBranch ?? null;
        let baseBranchName: string | null = task.task.vcsBaseBranch ?? baseBranch;
        let branchInfo: { branch: string; base: string; mergeConflicts?: string[]; remoteSyncNote?: string } | null = {
          branch: task.task.vcsBranch ?? "",
          base: task.task.vcsBaseBranch ?? baseBranch,
        };
        let headSha: string | null = task.task.vcsLastCommitSha ?? null;
        let taskEndEmitted = false;

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
        });

        const emitTaskEndOnce = async () => {
          if (taskEndEmitted) return;
          taskEndEmitted = true;
          const status = taskStatus ?? "failed";
          const terminal =
            status === "succeeded"
              ? touched.length
                ? "COMPLETED_WITH_CHANGES"
                : "COMPLETED_NO_CHANGES"
              : status === "blocked"
                ? "BLOCKED"
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
            headSha: resolvedHead,
          });
        };

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
            blockedReason: task.blockedReason,
          });
          await this.logTask(taskRun.id, `Selected task ${task.task.key}`, "selection", {
            dependencies: task.dependencies.keys,
            blockedReason: task.blockedReason,
          });

          if (task.blockedReason && !request.dryRun) {
            await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "selection", "error", {
              blockedReason: task.blockedReason,
            });
            await this.stateService.markBlocked(task.task, task.blockedReason);
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
              status: "failed",
              finishedAt: new Date().toISOString(),
            });
            results.push({ taskKey: task.task.key, status: "blocked", notes: task.blockedReason });
            taskStatus = "blocked";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            await emitTaskEndOnce();
            continue taskLoop;
          }

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
          let allowedFiles = Array.isArray(metadata.files) ? normalizePaths(this.workspace.workspaceRoot, metadata.files) : [];
          const testRequirements = normalizeTestRequirements(metadata.test_requirements ?? metadata.testRequirements);
          const testRequirementsNote = formatTestRequirementsNote(testRequirements);
          let testCommands = normalizeTestCommands(metadata.tests);
          const sanitized = sanitizeTestCommands(testCommands, this.workspace.workspaceRoot);
          testCommands = sanitized.commands;
          if (sanitized.skipped.length) {
            await this.logTask(
              taskRun.id,
              `Skipped test commands without workspace package.json: ${sanitized.skipped.join("; ")}`,
              "tests",
            );
          }
          if (!testCommands.length && hasTestRequirements(testRequirements)) {
            const fallbackCommand = detectScopedTestCommand(this.workspace.workspaceRoot, allowedFiles);
            if (fallbackCommand) testCommands = [fallbackCommand];
          }
          let runAllTestsCommandHint = detectRunAllTestsCommand(this.workspace.workspaceRoot);
          if (!runAllTestsCommandHint && !request.dryRun && hasTestRequirements(testRequirements)) {
            try {
              runAllScriptCreated = await ensureRunAllTestsScript(
                this.workspace.workspaceRoot,
                testRequirements,
                testCommands,
              );
              if (runAllScriptCreated) {
                runAllTestsCommandHint = detectRunAllTestsCommand(this.workspace.workspaceRoot);
                await this.logTask(taskRun.id, "Created run-all tests script (tests/all.js).", "tests");
              }
            } catch (error) {
              await this.logTask(
                taskRun.id,
                `Failed to create run-all tests script: ${error instanceof Error ? error.message : String(error)}`,
                "tests",
              );
            }
          }
          if (runAllScriptCreated && allowedFiles.length && !allowedFiles.includes("tests/all.js")) {
            allowedFiles = [...allowedFiles, "tests/all.js"];
          }
          if (!testCommands.length && hasTestRequirements(testRequirements) && runAllTestsCommandHint) {
            testCommands = [runAllTestsCommandHint];
          }
          const runAllTestsNote = request.dryRun
            ? ""
            : runAllTestsCommandHint
              ? `Run-all tests command: ${runAllTestsCommandHint}`
              : "Run-all tests script missing (tests/all.js). Create it and register new tests.";
          const shouldRunTests = !request.dryRun;
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

          if (!request.dryRun && hasTestRequirements(testRequirements) && testCommands.length === 0) {
            const message = "Task has test requirements but no test command is configured.";
            await this.logTask(taskRun.id, message, "tests", { testRequirements });
            await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "tests", "error", { error: "tests_not_configured" });
            await this.stateService.markBlocked(task.task, "tests_not_configured");
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
              status: "failed",
              finishedAt: new Date().toISOString(),
            });
            results.push({ taskKey: task.task.key, status: "failed", notes: "tests_not_configured" });
            taskStatus = "failed";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            await emitTaskEndOnce();
            continue taskLoop;
          }

          if (!request.dryRun) {
            try {
              branchInfo = await this.ensureBranches(task.task.key, baseBranch, taskRun.id);
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
                await this.logTask(taskRun.id, `Blocking task due to merge conflicts: ${mergeConflicts.join(", ")}`, "vcs");
                await this.stateService.markBlocked(task.task, "merge_conflict");
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                  status: "failed",
                  finishedAt: new Date().toISOString(),
                });
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
              results.push({ taskKey: task.task.key, status: "failed", notes: message });
              taskStatus = "failed";
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              continue taskLoop;
            }
          }

          await startPhase("context", { allowedFiles, tests: testCommands, testRequirements });
          const docLinks = Array.isArray((metadata as any).doc_links) ? (metadata as any).doc_links : [];
          const { summary: docSummary, warnings: docWarnings } = await this.gatherDocContext(request.projectKey, docLinks);
          if (docWarnings.length) {
            warnings.push(...docWarnings);
            await this.logTask(taskRun.id, docWarnings.join("; "), "docdex");
          }
          await endPhase("context", { docWarnings, docSummary: Boolean(docSummary) });

          const projectGuidance = await loadProjectGuidance(this.workspace.workspaceRoot);
          if (projectGuidance) {
            await this.logTask(taskRun.id, `Loaded project guidance from ${projectGuidance.source}`, "project_guidance");
          }

          await startPhase("prompt", { docSummary: Boolean(docSummary), agent: agent.id });
          unresolvedComments = await this.loadUnresolvedComments(task.task.id);
          const commentBacklog = this.buildCommentBacklog(unresolvedComments);
          const promptBase = this.buildPrompt(task, docSummary, allowedFiles, commentBacklog);
          const testCommandNote = testCommands.length ? `Test commands: ${testCommands.join(" && ")}` : "";
          const testExpectationNote = shouldRunTests
            ? "Tests must pass before the task can be finalized. Run task-specific tests first, then run-all tests."
            : "";
          const outputRequirementNote = [
            "Output requirements (strict):",
            "- Return only code changes.",
            "- For edits to existing files, output a unified diff inside ```patch fences.",
            "- For new files, output FILE blocks in this format:",
            "  FILE: path/to/file.ext",
            "  ```",
            "  <full file contents>",
            "  ```",
            "- Do not include plans, narration, or JSON unless the runtime forces it; if forced, return JSON with a top-level `patch` string or `files` array of {path, content}.",
          ].join("\n");
          const promptExtras = [testRequirementsNote, testCommandNote, runAllTestsNote, testExpectationNote, outputRequirementNote]
            .filter(Boolean)
            .join("\n");
          const promptWithTests = promptExtras ? `${promptBase}\n${promptExtras}` : promptBase;
          const guidanceBlock = projectGuidance?.content ? `Project Guidance (read first):\n${projectGuidance.content}` : "";
          const notes = remoteSyncNote;
          const prompt = [guidanceBlock, notes, promptWithTests].filter(Boolean).join("\n\n");
          const commandPrompt = prompts.commandPrompt ?? "";
          const systemPrompt = [prompts.jobPrompt, prompts.characterPrompt, commandPrompt].filter(Boolean).join("\n\n");
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
            await this.stateService.transitionToInProgress(task.task);
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

          const invokeAgentOnce = async (input: string, phaseLabel: string) => {
            abortIfSignaled();
            let output = "";
            const started = Date.now();
            if (agentStream && this.deps.agentService.invokeStream) {
              const stream = await withAbort(
                this.deps.agentService.invokeStream(agent.id, {
                  input,
                  metadata: { taskKey: task.task.key },
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
                this.deps.agentService.invoke(agent.id, { input, metadata: { taskKey: task.task.key } }),
              ).catch((error) => {
                if (pollLockLost) return null as any;
                throw error;
              });
              try {
                const result = await Promise.race([invokePromise, lockLostPromise]);
                if (result) {
                  output = result.output ?? "";
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
            return { output, durationSeconds: (Date.now() - started) / 1000 };
          };

          const recordUsage = async (
            phase: "agent" | "agent_retry",
            output: string,
            durationSeconds: number,
            promptText: string,
          ) => {
            const promptTokens = estimateTokens(promptText);
            const completionTokens = estimateTokens(output);
            tokensPromptTotal += promptTokens;
            tokensCompletionTotal += completionTokens;
            promptEstimateTotal += promptTokens;
            await this.recordTokenUsage({
              agentId: agent.id,
              model: agent.defaultModel,
              jobId: job.id,
              commandRunId: commandRun.id,
              taskRunId: taskRun.id,
              taskId: task.task.id,
              projectId: selection.project?.id,
              tokensPrompt: promptTokens,
              tokensCompletion: completionTokens,
              phase,
              durationSeconds,
            });
          };

          const maxAttempts = shouldRunTests ? MAX_TEST_FIX_ATTEMPTS : 1;
          let testsPassed = !shouldRunTests;
          let lastTestFailureSummary = "";
          let lastTestResults: TestRunResult[] = [];
          let lastTestErrorType: "tests_failed" | "tests_not_configured" | null = null;

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
            let triedRetry = false;
            let triedPatchFallback = false;

            try {
              await startPhase("agent", { agent: agent.id, stream: agentStream, attempt, maxAttempts });
              const first = await invokeAgentOnce(agentInput, "agent");
              agentOutput = first.output;
              agentDuration = first.durationSeconds;
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
              results.push({ taskKey: task.task.key, status: "failed", notes: message });
              taskStatus = "failed";
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              continue taskLoop;
            }

            await recordUsage("agent", agentOutput, agentDuration, agentInput);

            let { patches, fileBlocks, jsonDetected } = extractAgentChanges(agentOutput);
            if (fileBlocks.length && patches.length) {
              const { existing, remaining } = splitFileBlocksByExistence(fileBlocks, this.workspace.workspaceRoot);
              if (existing.length) {
                await this.logTask(taskRun.id, `Skipped FILE blocks for existing files: ${existing.join(", ")}`, "agent");
              }
              fileBlocks = remaining;
            }
            if (patches.length === 0 && fileBlocks.length === 0 && !triedRetry) {
              triedRetry = true;
              const retryReason = jsonDetected
                ? "Agent output was JSON-only and did not include patch or file blocks; retrying with explicit output instructions."
                : "Agent output did not include a patch or file blocks; retrying with explicit output instructions.";
              await this.logTask(taskRun.id, retryReason, "agent");
              try {
                const retryInput = `${systemPrompt}\n\n${attemptPrompt}\n\nOutput only code changes. If editing existing files, output a unified diff inside \`\`\`patch\`\`\` fences. If creating new files, output FILE blocks in this format:\nFILE: path/to/file.ext\n\`\`\`\n<full file contents>\n\`\`\`\nDo not include analysis or narration. Do not output JSON unless the runtime forces it; if forced, return a top-level JSON object with either a \`patch\` string (unified diff) or a \`files\` array of {path, content}.`;
                const retry = await invokeAgentOnce(retryInput, "agent");
                agentOutput = retry.output;
                agentDuration += retry.durationSeconds;
                await recordUsage("agent_retry", retry.output, retry.durationSeconds, retryInput);
                ({ patches, fileBlocks, jsonDetected } = extractAgentChanges(agentOutput));
                if (fileBlocks.length && patches.length) {
                  const { existing, remaining } = splitFileBlocksByExistence(fileBlocks, this.workspace.workspaceRoot);
                  if (existing.length) {
                    await this.logTask(taskRun.id, `Skipped FILE blocks for existing files: ${existing.join(", ")}`, "agent");
                  }
                  fileBlocks = remaining;
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await this.logTask(taskRun.id, `Agent retry failed: ${message}`, "agent");
              }
            }

            if (patches.length === 0 && fileBlocks.length === 0) {
              const message = "Agent output did not include a patch or file blocks.";
              await this.logTask(taskRun.id, message, "agent");
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
              await this.stateService.markBlocked(task.task, "missing_patch");
              results.push({ taskKey: task.task.key, status: "failed", notes: "missing_patch" });
              taskStatus = "failed";
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              continue taskLoop;
            }

            if (patches.length || fileBlocks.length) {
              if (!(await refreshLock("apply_start", true))) {
                await this.logTask(taskRun.id, "Aborting task: lock lost before apply.", "vcs");
                throw new Error("Task lock lost before apply.");
              }
              const applyDetails: Record<string, unknown> = { attempt };
              if (patches.length) applyDetails.patchCount = patches.length;
              if (fileBlocks.length) applyDetails.fileCount = fileBlocks.length;
              if (fileBlocks.length && !patches.length) applyDetails.mode = "direct";
              await startPhase("apply", applyDetails);
              let patchApplyError: string | null = null;
              if (patches.length) {
                const applied = await this.applyPatches(
                  patches,
                  this.workspace.workspaceRoot,
                  request.dryRun ?? false,
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
                  if (!fileBlocks.length && !triedPatchFallback) {
                    triedPatchFallback = true;
                    const files = Array.from(
                      new Set(patches.flatMap((patch) => touchedFilesFromPatch(patch))),
                    ).filter(Boolean);
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
                        await recordUsage("agent_retry", fallback.output, fallback.durationSeconds, fallbackPrompt);
                        const fallbackChanges = extractAgentChanges(fallback.output);
                        if (!fallbackChanges.fileBlocks.length && !fallbackChanges.patches.length && files.length === 1) {
                          const inferred = extractPlainCodeFence(fallback.output);
                          if (inferred) {
                            fallbackChanges.fileBlocks = [{ path: files[0], content: inferred }];
                          }
                        }
                        if (fallbackChanges.fileBlocks.length) {
                          fileBlocks = fallbackChanges.fileBlocks;
                          patches = [];
                          patchApplyError = null;
                          await this.logTask(taskRun.id, "Recovered from patch failure using FILE blocks.", "patch");
                        }
                      } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        await this.logTask(taskRun.id, `Patch fallback failed: ${message}`, "patch");
                      }
                    }
                  }
                  if (patchApplyError && !fileBlocks.length) {
                    await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", { error: applied.error, attempt });
                    await this.stateService.markBlocked(task.task, "patch_failed");
                    await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
                    results.push({ taskKey: task.task.key, status: "failed", notes: "patch_failed" });
                    taskStatus = "failed";
                    if (!request.dryRun && request.noCommit !== true) {
                      await this.commitPendingChanges(
                        branchInfo,
                        task.task.key,
                        task.task.title,
                        "auto-save (patch_failed)",
                        task.task.id,
                        taskRun.id,
                      );
                    }
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
                const allowFileOverwrite = request.allowFileOverwrite === true && patches.length === 0;
                const applied = await this.applyFileBlocks(
                  fileBlocks,
                  this.workspace.workspaceRoot,
                  request.dryRun ?? false,
                  allowNoop,
                  allowFileOverwrite,
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
                    await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", { error: applied.error, attempt });
                    await this.stateService.markBlocked(task.task, "patch_failed");
                    await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
                    results.push({ taskKey: task.task.key, status: "failed", notes: "patch_failed" });
                    taskStatus = "failed";
                    if (!request.dryRun && request.noCommit !== true) {
                      await this.commitPendingChanges(
                        branchInfo,
                        task.task.key,
                        task.task.title,
                        "auto-save (patch_failed)",
                        task.task.id,
                        taskRun.id,
                      );
                    }
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
                  await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", { error: patchApplyError, attempt });
                  await this.stateService.markBlocked(task.task, "patch_failed");
                  await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
                  results.push({ taskKey: task.task.key, status: "failed", notes: "patch_failed" });
                  taskStatus = "failed";
                  if (!request.dryRun && request.noCommit !== true) {
                    await this.commitPendingChanges(
                      branchInfo,
                      task.task.key,
                      task.task.title,
                      "auto-save (patch_failed)",
                      task.task.id,
                      taskRun.id,
                    );
                  }
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
                  await this.stateService.markBlocked(task.task, "scope_violation");
                  await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
                  results.push({ taskKey: task.task.key, status: "failed", notes: "scope_violation" });
                  taskStatus = "failed";
                  if (!request.dryRun && request.noCommit !== true && patchApplied) {
                    await this.commitPendingChanges(
                      branchInfo,
                      task.task.key,
                      task.task.title,
                      "auto-save (scope_violation)",
                      task.task.id,
                      taskRun.id,
                    );
                  }
                  await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                  continue taskLoop;
                }
              }
  
              if (shouldRunTests) {
                abortIfSignaled();
                testAttemptCount += 1;
                const runAllTestsCommand = detectRunAllTestsCommand(this.workspace.workspaceRoot);
                if (!runAllTestsCommand) {
                  const expectedCommand = `${resolveNodeCommand()} tests/all.js`;
                  lastTestResults = [
                    {
                      command: expectedCommand,
                      stdout: "",
                      stderr: "Run-all tests script missing (tests/all.js).",
                      code: 1,
                    },
                  ];
                  lastTestFailureSummary = formatTestFailureSummary(lastTestResults);
                  lastTestErrorType = "tests_not_configured";
                  await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "tests", "error", {
                    error: "tests_not_configured",
                    attempt,
                  });
                  await this.logTask(taskRun.id, "Run-all tests script missing; retrying with fixes.", "tests", {
                    attempt,
                    remainingAttempts: maxAttempts - attempt,
                  });
                  await endPhase("tests", { results: lastTestResults, ok: false, attempt, retrying: attempt < maxAttempts });
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
                const combinedCommands = [...testCommands, runAllTestsCommand];
                await startPhase("tests", { commands: combinedCommands, attempt, runAll: true });
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
              await this.stateService.markBlocked(task.task, failureReason);
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
              results.push({ taskKey: task.task.key, status: "failed", notes: failureReason });
              taskStatus = "failed";
              if (!request.dryRun && request.noCommit !== true) {
                await this.commitPendingChanges(
                  branchInfo,
                  task.task.key,
                  task.task.title,
                  "auto-save (tests_failed)",
                  task.task.id,
                  taskRun.id,
                );
              }
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              continue taskLoop;
            }

            if (!request.dryRun) {
              let hasChanges = touched.length > 0;
              if (!hasChanges) {
                try {
                  const dirty = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter(
                    (p) => !p.startsWith(".mcoda"),
                  );
                  hasChanges = dirty.length > 0;
                } catch {
                  hasChanges = false;
                }
              }
              if (!hasChanges && unresolvedComments.length > 0) {
                const openSlugs = unresolvedComments
                  .map((comment) => comment.slug)
                  .filter((slug): slug is string => Boolean(slug && slug.trim()));
                const slugList = openSlugs.length ? openSlugs.join(", ") : "untracked";
                const body = [
                  "[work-on-tasks]",
                  "No changes detected while unresolved review/QA comments remain.",
                  `Open comment slugs: ${slugList}`,
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
                  metadata: { reason: "no_changes", openSlugs },
                });
                await this.logTask(
                  taskRun.id,
                  `No changes detected; unresolved comments remain (${slugList}).`,
                  "execution",
                );
                await this.stateService.markBlocked(task.task, "no_changes");
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
                results.push({ taskKey: task.task.key, status: "failed", notes: "no_changes" });
                taskStatus = "failed";
                await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                continue taskLoop;
              }
              if (!hasChanges) {
                const body = [
                  "[work-on-tasks]",
                  "No changes were applied for this task run.",
                  "Re-run with a stronger agent or clarify the task requirements.",
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
                  metadata: { reason: "no_changes", initialStatus },
                });
                await this.logTask(taskRun.id, "No changes detected; blocking task for escalation.", "execution");
                await this.stateService.markBlocked(task.task, "no_changes");
                await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
                results.push({ taskKey: task.task.key, status: "failed", notes: "no_changes" });
                taskStatus = "failed";
                await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                continue taskLoop;
              }
            }
  
        if (!request.dryRun && request.noCommit !== true) {
          if (!(await refreshLock("vcs_start", true))) {
            await this.logTask(taskRun.id, "Aborting task: lock lost before VCS phase.", "vcs");
            throw new Error("Task lock lost before VCS phase.");
          }
          await startPhase("vcs", { branch: branchInfo.branch, base: branchInfo.base });
          try {
            const dirty = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter((p) => !p.startsWith(".mcoda"));
            const toStage = dirty.length ? dirty : touched.length ? touched : ["."];
            await this.vcs.stage(this.workspace.workspaceRoot, toStage);
            const status = await this.vcs.status(this.workspace.workspaceRoot);
            const hasChanges = status.trim().length > 0;
            if (hasChanges) {
              const commitMessage = `[${task.task.key}] ${task.task.title}`;
              let committed = false;
              try {
                await this.vcs.commit(this.workspace.workspaceRoot, commitMessage);
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
  
            const restrictAutoMergeWithoutScope = Boolean(this.workspace.config?.restrictAutoMergeWithoutScope);
            const shouldSkipAutoMerge = !autoMerge || (restrictAutoMergeWithoutScope && allowedFiles.length === 0);
            if (shouldSkipAutoMerge) {
              mergeStatus = "skipped";
              const changedFiles = dirty.length ? dirty : touched.length ? touched : [];
              const changedNote = changedFiles.length ? `Changed files: ${changedFiles.join(", ")}` : "No changed files detected.";
              const reason = !autoMerge ? "auto_merge_disabled" : "no_file_scope";
              const message = !autoMerge
                ? `Auto-merge disabled; leaving branch ${branchInfo.branch} for manual PR. ${changedNote}`
                : `Auto-merge skipped because task has no file scope (metadata.files empty). ${changedNote}`;
              await this.logTask(taskRun.id, message, "vcs", { reason, changedFiles });
              await this.vcs.checkoutBranch(this.workspace.workspaceRoot, branchInfo.base);
            } else {
              // Always merge back into base and end on base branch.
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
                  throw new Error("Task lock lost after merge.");
                }
              } catch (error) {
                mergeStatus = "failed";
                const conflicts = await this.vcs.conflictPaths(this.workspace.workspaceRoot);
                if (conflicts.length) {
                  await this.logTask(
                    taskRun.id,
                    `Merge conflicts while merging ${branchInfo.branch} into ${branchInfo.base}.`,
                    "vcs",
                    {
                      conflicts,
                    },
                  );
                  await this.vcs.abortMerge(this.workspace.workspaceRoot);
                  await this.stateService.markBlocked(task.task, "merge_conflict");
                  await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
                    status: "failed",
                    finishedAt: new Date().toISOString(),
                  });
                  results.push({ taskKey: task.task.key, status: "failed", notes: "merge_conflict" });
                  taskStatus = "failed";
                  await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
                  continue taskLoop;
                }
                throw error;
              }
            }
  
            if (await this.vcs.hasRemote(this.workspace.workspaceRoot)) {
              if (!autoPush) {
                await this.logTask(
                  taskRun.id,
                  `Auto-push disabled; skipping remote push for ${branchInfo.branch} and ${branchInfo.base}.`,
                  "vcs",
                  { reason: "auto_push_disabled" },
                );
              } else {
                const branchPush = await this.pushWithRecovery(taskRun.id, branchInfo.branch);
                if (branchPush.pushed) {
                  await this.logTask(taskRun.id, "Pushed branch to remote origin", "vcs");
                } else if (branchPush.skipped) {
                  await this.logTask(taskRun.id, "Skipped pushing branch to remote origin due to permissions/protection.", "vcs");
                }
                if (!(await refreshLock("vcs_push_branch"))) {
                  await this.logTask(taskRun.id, "Aborting task: lock lost after pushing branch.", "vcs");
                  throw new Error("Task lock lost after pushing branch.");
                }
                if (mergeStatus === "merged") {
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
                    throw new Error("Task lock lost after pushing base branch.");
                  }
                } else {
                  await this.logTask(taskRun.id, `Skipped pushing base branch ${branchInfo.base} because auto-merge was skipped.`, "vcs");
                }
              }
            } else {
              const message =
                mergeStatus === "skipped"
                  ? "No remote configured; auto-merge skipped due to missing file scope."
                  : "No remote configured; merge completed locally.";
              await this.logTask(taskRun.id, message, "vcs");
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/task lock lost/i.test(message)) {
              throw error;
            }
            await this.logTask(taskRun.id, `VCS commit/push failed: ${message}`, "vcs");
            await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "vcs", "error", { error: message });
            await this.stateService.markBlocked(task.task, "vcs_failed");
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
            results.push({ taskKey: task.task.key, status: "failed", notes: "vcs_failed" });
            taskStatus = "failed";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            continue taskLoop;
          }
          await endPhase("vcs", { branch: branchInfo.branch, base: branchInfo.base });
        } else if (request.dryRun) {
          await this.logTask(taskRun.id, "Dry-run: skipped commit/push.", "vcs");
        } else if (request.noCommit) {
          await this.logTask(taskRun.id, "no-commit set: skipped commit/push.", "vcs");
        }
  
        await startPhase("finalize");
        const finishedAt = new Date().toISOString();
        const elapsedSeconds = Math.max(1, (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
        const spPerHour =
          task.task.storyPoints && task.task.storyPoints > 0 ? (task.task.storyPoints / elapsedSeconds) * 3600 : null;

        const reviewMetadata: Record<string, unknown> = { last_run: finishedAt };
        if (shouldRunTests) {
          const runAllTestsCommand = detectRunAllTestsCommand(this.workspace.workspaceRoot);
          const combinedCommands = [...testCommands, ...(runAllTestsCommand ? [runAllTestsCommand] : [])];
          reviewMetadata.test_attempts = testAttemptCount;
          reviewMetadata.test_commands = combinedCommands;
          reviewMetadata.run_all_tests_command = runAllTestsCommand ?? null;
        }
        await this.stateService.markReadyToReview(task.task, reviewMetadata);
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
          status: "succeeded",
          finishedAt,
          spPerHourEffective: spPerHour,
          gitBranch: branchInfo.branch,
          gitBaseBranch: branchInfo.base,
        });

        storyPointsProcessed += task.task.storyPoints ?? 0;
        await endPhase("finalize", { spPerHour: spPerHour ?? undefined });

        const resultNotes = "ready_to_review";
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
            await this.stateService.markBlocked(task.task, "agent_timeout");
            taskStatus = "failed";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            throw error;
          }
          if (/task lock lost/i.test(message)) {
            await this.logTask(taskRun.id, `Task aborted: ${message}`, "vcs");
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
            await this.stateService.markBlocked(task.task, "task_lock_lost");
            if (!request.dryRun && request.noCommit !== true) {
              await this.commitPendingChanges(branchInfo, task.task.key, task.task.title, "auto-save (lock_lost)", task.task.id, taskRun.id);
            }
            results.push({ taskKey: task.task.key, status: "failed", notes: "task_lock_lost" });
            taskStatus = "failed";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            continue taskLoop;
          }
          throw error;
        } finally {
          await emitTaskEndOnce();
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
    }

    const failureCount = results.filter((r) => r.status === "failed" || r.status === "blocked").length;
    const state: JobState =
      failureCount === 0 ? "completed" : failureCount === results.length ? "failed" : ("partial" as JobState);
    const errorSummary = failureCount ? `${failureCount} task(s) failed or blocked` : undefined;
    await this.deps.jobService.updateJobStatus(job.id, state, {
      processedItems: results.length,
      errorSummary,
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
