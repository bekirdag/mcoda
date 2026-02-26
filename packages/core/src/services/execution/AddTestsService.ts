import fs from "node:fs";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { VcsClient } from "@mcoda/integrations";
import { PathHelper, WORK_ALLOWED_STATUSES, filterTaskStatuses } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { QaTestCommandBuilder } from "./QaTestCommandBuilder.js";
import { TaskSelectionFilters, TaskSelectionService, type TaskSelectionPlan } from "./TaskSelectionService.js";

const DEFAULT_BASE_BRANCH = "mcoda-dev";
const MISSING_HARNESS_BLOCKER = /No runnable test harness discovered/i;
const FALLBACK_BOOTSTRAP_COMMAND = "node -e \"console.log('mcoda add-tests bootstrap placeholder')\"";

type TestRequirements = {
  unit: string[];
  component: string[];
  integration: string[];
  api: string[];
};

type AddTestsDeps = {
  workspaceRepo: WorkspaceRepository;
  selectionService: TaskSelectionService;
  vcsClient?: VcsClient;
};

export interface AddTestsRequest extends TaskSelectionFilters {
  projectKey: string;
  dryRun?: boolean;
  commit?: boolean;
  baseBranch?: string;
}

export interface AddTestsResult {
  projectKey: string;
  selectedTaskKeys: string[];
  tasksRequiringTests: string[];
  updatedTaskKeys: string[];
  skippedTaskKeys: string[];
  createdFiles: string[];
  runAllScriptPath?: string;
  runAllCommand?: string;
  branch?: string;
  commitSha?: string;
  warnings: string[];
}

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

const dedupeCommands = (commands: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const resolveNodeCommand = (): string => {
  const override = process.env.NODE_BIN?.trim();
  const resolved = override || (process.platform === "win32" ? "node.exe" : "node");
  return resolved.includes(" ") ? `"${resolved}"` : resolved;
};

const quoteShellPath = (value: string): string => (value.includes(" ") ? `"${value}"` : value);

const buildRunAllTestsCommand = (relativePath: string): string => {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized.endsWith(".js")) return `${resolveNodeCommand()} ${normalized}`;
  if (normalized.endsWith(".ps1")) {
    const shell = process.platform === "win32" ? "powershell" : "pwsh";
    return `${shell} -File ${quoteShellPath(normalized)}`;
  }
  if (normalized.endsWith(".sh")) return `bash ${quoteShellPath(normalized)}`;
  if (normalized.startsWith(".")) return normalized;
  return `./${normalized}`;
};

const detectRunAllTestsScript = (workspaceRoot: string): string | undefined => {
  const candidates = ["tests/all.js", "tests/all.sh", "tests/all.ps1", "tests/all"];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(workspaceRoot, ...candidate.split("/")))) return candidate;
  }
  return undefined;
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
  suites[seedCategory] = seedCommands;
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

const stripHarnessBlocker = (metadata: Record<string, unknown>): Record<string, unknown> => {
  const rawQa = metadata.qa;
  if (!rawQa || typeof rawQa !== "object") return metadata;
  const qa = { ...(rawQa as Record<string, unknown>) };
  const blockers = normalizeStringArray(qa.blockers).filter((entry) => !MISSING_HARNESS_BLOCKER.test(entry));
  if (blockers.length > 0) {
    qa.blockers = blockers;
  } else {
    delete qa.blockers;
  }
  return { ...metadata, qa };
};

type TaskCommandResolution = {
  requirements: TestRequirements;
  existingCommands: string[];
  discoveredCommands: string[];
};

export class AddTestsService {
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly selectionService: TaskSelectionService;
  private readonly vcs: VcsClient;
  private readonly ownsWorkspaceRepo: boolean;
  private readonly ownsSelectionService: boolean;

  constructor(
    private workspace: WorkspaceResolution,
    deps: AddTestsDeps,
    ownership: { ownsWorkspaceRepo?: boolean; ownsSelectionService?: boolean } = {},
  ) {
    this.workspaceRepo = deps.workspaceRepo;
    this.selectionService = deps.selectionService;
    this.vcs = deps.vcsClient ?? new VcsClient();
    this.ownsWorkspaceRepo = ownership.ownsWorkspaceRepo === true;
    this.ownsSelectionService = ownership.ownsSelectionService === true;
  }

  static async create(workspace: WorkspaceResolution): Promise<AddTestsService> {
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    const selectionService = new TaskSelectionService(workspace, workspaceRepo);
    return new AddTestsService(
      workspace,
      { workspaceRepo, selectionService },
      { ownsWorkspaceRepo: true, ownsSelectionService: true },
    );
  }

  async close(): Promise<void> {
    if (this.ownsSelectionService) {
      await this.selectionService.close();
      return;
    }
    if (this.ownsWorkspaceRepo) {
      await this.workspaceRepo.close();
    }
  }

  private async resolveTaskSelection(request: AddTestsRequest): Promise<TaskSelectionPlan> {
    const ignoreStatusFilter = request.taskKeys?.length ? true : request.ignoreStatusFilter;
    const { filtered } = ignoreStatusFilter
      ? { filtered: request.statusFilter ?? [] }
      : filterTaskStatuses(request.statusFilter, WORK_ALLOWED_STATUSES, WORK_ALLOWED_STATUSES);
    return this.selectionService.selectTasks({
      projectKey: request.projectKey,
      epicKey: request.epicKey,
      storyKey: request.storyKey,
      taskKeys: request.taskKeys,
      statusFilter: filtered,
      ignoreStatusFilter,
      includeTypes: request.includeTypes,
      excludeTypes: request.excludeTypes,
      limit: request.limit,
      parallel: request.parallel,
      ignoreDependencies: request.ignoreDependencies ?? true,
      missingContextPolicy: request.missingContextPolicy ?? "allow",
    });
  }

  private async resolveTaskCommands(task: TaskSelectionPlan["ordered"][number]): Promise<TaskCommandResolution> {
    const metadata = ((task.task.metadata as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
    const requirements = normalizeTestRequirements(metadata.test_requirements ?? metadata.testRequirements);
    const existingCommands = dedupeCommands(normalizeTestCommands(metadata.tests ?? metadata.testCommands));
    if (!hasTestRequirements(requirements)) {
      return { requirements, existingCommands, discoveredCommands: [] };
    }
    if (existingCommands.length > 0) {
      return { requirements, existingCommands, discoveredCommands: existingCommands };
    }
    const commandBuilder = new QaTestCommandBuilder(this.workspace.workspaceRoot);
    try {
      const plan = await commandBuilder.build({ task: task.task });
      const discoveredCommands = dedupeCommands(plan.commands);
      return { requirements, existingCommands, discoveredCommands };
    } catch {
      return { requirements, existingCommands, discoveredCommands: [] };
    }
  }

  private async ensureBaseBranchForCommit(baseBranch: string): Promise<{ branch?: string; warning?: string }> {
    const cwd = this.workspace.workspaceRoot;
    const isRepo = await this.vcs.isRepo(cwd);
    if (!isRepo) {
      return { warning: "add-tests commit skipped: workspace is not a git repository." };
    }
    const status = await this.vcs.status(cwd);
    if (status.trim().length > 0) {
      return { warning: "add-tests commit skipped: working tree is dirty before bootstrap." };
    }
    try {
      await this.vcs.ensureBaseBranch(cwd, baseBranch);
      await this.vcs.checkoutBranch(cwd, baseBranch);
      return { branch: baseBranch };
    } catch (error) {
      return {
        warning: `add-tests commit skipped: failed to prepare base branch ${baseBranch} (${(error as Error).message}).`,
      };
    }
  }

  async addTests(request: AddTestsRequest): Promise<AddTestsResult> {
    const warnings: string[] = [];
    const createdFiles: string[] = [];
    const updatedTaskKeys: string[] = [];
    const skippedTaskKeys: string[] = [];
    const dryRun = request.dryRun === true;
    const commitEnabled = request.commit !== false && !dryRun;
    const selection = await this.resolveTaskSelection(request);
    const selectedTaskKeys = selection.ordered.map((entry) => entry.task.key);
    warnings.push(...selection.warnings);

    const requiringTests: Array<{
      entry: TaskSelectionPlan["ordered"][number];
      commands: TaskCommandResolution;
    }> = [];
    for (const entry of selection.ordered) {
      const commands = await this.resolveTaskCommands(entry);
      if (!hasTestRequirements(commands.requirements)) continue;
      requiringTests.push({ entry, commands });
    }

    const tasksRequiringTests = requiringTests.map((item) => item.entry.task.key);
    if (tasksRequiringTests.length === 0) {
      return {
        projectKey: request.projectKey,
        selectedTaskKeys,
        tasksRequiringTests: [],
        updatedTaskKeys,
        skippedTaskKeys,
        createdFiles,
        warnings,
      };
    }

    let runAllScriptPath = detectRunAllTestsScript(this.workspace.workspaceRoot);
    let runAllCommand = runAllScriptPath ? buildRunAllTestsCommand(runAllScriptPath) : undefined;
    let commitBranch: string | undefined;
    let commitSha: string | undefined;
    const baseBranch = (request.baseBranch ?? this.workspace.config?.branch ?? DEFAULT_BASE_BRANCH).trim() || DEFAULT_BASE_BRANCH;

    const seedRequirements = requiringTests[0]?.commands.requirements ?? {
      unit: [],
      component: [],
      integration: [],
      api: [],
    };
    const discoveredSeedCommands = dedupeCommands(
      requiringTests.flatMap((item) => item.commands.discoveredCommands),
    );
    const seedCommands = discoveredSeedCommands.length > 0 ? discoveredSeedCommands : [FALLBACK_BOOTSTRAP_COMMAND];

    if (!runAllScriptPath) {
      if (!dryRun) {
        if (commitEnabled) {
          const branchPrep = await this.ensureBaseBranchForCommit(baseBranch);
          if (branchPrep.branch) {
            commitBranch = branchPrep.branch;
          } else if (branchPrep.warning) {
            warnings.push(branchPrep.warning);
          }
        }
        const scriptPath = path.join(this.workspace.workspaceRoot, "tests", "all.js");
        await PathHelper.ensureDir(path.dirname(scriptPath));
        const seedCategory = pickSeedTestCategory(seedRequirements);
        const contents = buildRunAllTestsScript(seedCategory, seedCommands);
        await fs.promises.writeFile(scriptPath, contents, "utf8");
        createdFiles.push("tests/all.js");
        runAllScriptPath = "tests/all.js";
      } else {
        warnings.push("Dry-run: add-tests would create tests/all.js.");
      }
      runAllCommand = buildRunAllTestsCommand("tests/all.js");
      if (discoveredSeedCommands.length === 0) {
        warnings.push(
          "No stack-specific test commands were discovered; created a placeholder run-all harness. Replace tests/all.js commands with real suites.",
        );
      }
    }

    for (const item of requiringTests) {
      const metadata = ((item.entry.task.metadata as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
      const existingCommands = item.commands.existingCommands;
      const fallbackCommands =
        item.commands.discoveredCommands.length > 0
          ? item.commands.discoveredCommands
          : runAllCommand
            ? [runAllCommand]
            : [];
      const resolvedCommands = dedupeCommands(existingCommands.length > 0 ? existingCommands : fallbackCommands);
      if (resolvedCommands.length === 0) {
        skippedTaskKeys.push(item.entry.task.key);
        continue;
      }
      const nextMetadata = stripHarnessBlocker({
        ...metadata,
        tests: resolvedCommands,
        testCommands: resolvedCommands,
      });
      const before = JSON.stringify(metadata);
      const after = JSON.stringify(nextMetadata);
      if (before !== after) {
        if (!dryRun) {
          await this.workspaceRepo.updateTask(item.entry.task.id, { metadata: nextMetadata });
        }
        updatedTaskKeys.push(item.entry.task.key);
      }
    }

    if (commitEnabled && createdFiles.includes("tests/all.js")) {
      try {
        await this.vcs.stage(this.workspace.workspaceRoot, ["tests/all.js"]);
        await this.vcs.commit(this.workspace.workspaceRoot, "chore(mcoda): bootstrap test harness");
        commitSha = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
      } catch (error) {
        warnings.push(`add-tests commit failed: ${(error as Error).message}`);
      }
    }

    return {
      projectKey: request.projectKey,
      selectedTaskKeys,
      tasksRequiringTests,
      updatedTaskKeys,
      skippedTaskKeys,
      createdFiles,
      runAllScriptPath,
      runAllCommand,
      branch: commitBranch,
      commitSha,
      warnings,
    };
  }
}
