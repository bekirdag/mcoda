import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { TaskRow, WorkspaceRepository, TaskRunRow, TaskRunStatus, TaskQaRunRow, TaskCommentRow } from '@mcoda/db';
import { PathHelper, QA_ALLOWED_STATUSES, QaApiRequest, QaTaskPlan, filterTaskStatuses } from '@mcoda/shared';
import { QaProfile } from '@mcoda/shared/qa/QaProfile.js';
import { WorkspaceResolution } from '../../workspace/WorkspaceManager.js';
import { JobService, JobState } from '../jobs/JobService.js';
import { TaskSelectionFilters, TaskSelectionPlan, TaskSelectionService } from './TaskSelectionService.js';
import { TaskStateService, type TaskStatusEventContext } from './TaskStateService.js';
import { QaProfileService } from './QaProfileService.js';
import { QaFollowupService, FollowupSuggestion } from './QaFollowupService.js';
import { QaAdapter } from '@mcoda/integrations/qa/QaAdapter.js';
import { CliQaAdapter } from '@mcoda/integrations/qa/CliQaAdapter.js';
import { ChromiumQaAdapter, resolveChromiumBinary } from '@mcoda/integrations/qa/ChromiumQaAdapter.js';
import { MaestroQaAdapter } from '@mcoda/integrations/qa/MaestroQaAdapter.js';
import { QaContext, QaRunResult } from '@mcoda/integrations/qa/QaTypes.js';
import { VcsClient } from '@mcoda/integrations';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AgentService } from '@mcoda/agents';
import { GlobalRepository } from '@mcoda/db';
import { DocdexClient } from '@mcoda/integrations';
import { RoutingService } from '../agents/RoutingService.js';
import { AgentRatingService } from '../agents/AgentRatingService.js';
import { isDocContextExcluded, loadProjectGuidance, normalizeDocType } from '../shared/ProjectGuidance.js';
import { buildDocdexUsageGuidance } from '../shared/DocdexGuidance.js';
import { createTaskCommentSlug, formatTaskCommentBody } from '../tasks/TaskCommentFormatter.js';
import { AUTH_ERROR_REASON, isAuthErrorMessage } from '../shared/AuthErrors.js';
import { normalizeQaPlanOutput } from './QaPlanValidator.js';
import { QaApiRunner } from './QaApiRunner.js';
import { QaTestCommandBuilder } from './QaTestCommandBuilder.js';
const execFileAsync = promisify(execFile);
const DEFAULT_QA_PROMPT = [
  'You are the QA agent.',
  buildDocdexUsageGuidance({ contextLabel: 'the QA report', includeHeading: false, includeFallback: true }),
  'Use docdex snippets to derive acceptance criteria, data contracts, edge cases, and non-functional requirements (performance, accessibility, offline/online assumptions).',
  'QA policy: always run automated tests. Use browser (Chromium) tests only when the project has a web UI; otherwise run API/endpoint/CLI tests that simulate real usage. When test_requirements list unit/component/integration/api, run them in that order using stack-appropriate tools. Prefer tests/all.js or package manager test scripts when no category split is available; do not suggest Jest configs unless the repo explicitly documents them.',
].join('\n');
const REPO_PROMPTS_DIR = fileURLToPath(new URL('../../../../../prompts/', import.meta.url));
const resolveRepoPromptPath = (filename: string): string => path.join(REPO_PROMPTS_DIR, filename);
const QA_TEST_POLICY =
  'QA policy: always run automated tests. Use browser (Chromium) tests only when the project has a web UI; otherwise run API/endpoint/CLI tests that simulate real usage. When test_requirements list unit/component/integration/api, run them in that order using stack-appropriate tools. Prefer tests/all.js or package manager test scripts when no category split is available; do not suggest Jest configs unless the repo explicitly documents them.';
const QA_ROUTING_PROMPT = [
  'You are the mcoda QA routing agent.',
  'Decide which QA profiles should run for each task in this job.',
  'Return a QA plan that maps tasks to profiles and action lists (cli/api/browser/stress).',
  'Only use the provided profile names.',
  'Always include CLI when tests are available.',
  'When adding CLI commands, cover functional checks: unit -> component -> integration -> api (when test_requirements exist), then tests/all.js or package.json test script, plus build, lint, and CLI smoke commands where relevant.',
  'Prefer category scripts (test:unit/test:component/test:integration/test:api) when they exist; otherwise use stack-appropriate test tools.',
  'UI/front-end tasks must include chromium alongside CLI and include browser actions.',
  'Only include chromium when the task itself is UI/front-end (ui_task=yes). Do not add chromium just because ui_repo=yes.',
  'Include at least one light stress action for UI tasks (repeat navigation or submit) when safe.',
  'Browser actions must use types navigate/click/type/wait_for/snapshot/script; do not emit assertText/assert_text. For text checks, use a script action (optionally preceded by snapshot).',
  'API/back-end tasks (api_task=yes) must include API requests with sample data/auth when available.',
  'Only include API requests when api_task=yes or the plan explicitly defines api base_url/requests.',
  'Do not hardcode ports. If base_url is unknown, omit it and rely on MCODA_QA_API_BASE_URL or detected server ports.',
  'If unsure, choose a safe minimal set (usually [\"cli\"]) and avoid guessing API endpoints.',
].join('\n');
const QA_ROUTING_OUTPUT_SCHEMA = [
  'Return strict JSON only with shape:',
  'Browser action types: navigate/click/type/wait_for/snapshot/script. Use script+expect for text checks; never emit assertText/assert_text.',
  '{',
  '  \"task_profiles\": { \"TASK_KEY\": [\"profile1\", \"profile2\"] },',
  '  \"task_plans\": {',
  '    \"TASK_KEY\": {',
  '      \"profiles\": [\"cli\", \"chromium\"],',
  '      \"cli\": { \"commands\": [\"pnpm test\", \"node tests/all.js\"] },',
  '      \"api\": { \"base_url\": \"http://localhost:<PORT>\", \"requests\": [{ \"method\": \"GET\", \"path\": \"/health\", \"expect\": { \"status\": 200 } }] },',
  '      \"browser\": { \"base_url\": \"http://localhost:<PORT>\", \"actions\": [{ \"type\": \"navigate\", \"url\": \"/\" }, { \"type\": \"snapshot\", \"name\": \"home\" }, { \"type\": \"script\", \"expression\": \"document.body ? document.body.innerText : \\\"\\\"\", \"expect\": \"Welcome\" }] },',
  '      \"stress\": { \"api\": [], \"browser\": [] }',
  '    }',
  '  },',
  '  \"notes\": \"optional\"',
  '}',
  'No markdown or prose. task_profiles is required; task_plans is optional when actions are unknown.',
].join('\n');
const QA_AGENT_INTERPRETATION_ENV = 'MCODA_QA_AGENT_INTERPRETATION';
const QA_REQUIRED_DEPS = ['argon2', 'pg', 'ioredis', '@jest/globals'];
const QA_REQUIRED_ENV = [
  { dep: 'pg', env: 'TEST_DB_URL' },
  { dep: 'ioredis', env: 'TEST_REDIS_URL' },
];
const DEFAULT_JOB_PROMPT = 'You are an mcoda agent that follows workspace runbooks and responds with actionable, concise output.';
const DEFAULT_CHARACTER_PROMPT =
  'Write clearly, avoid hallucinations, cite assumptions, and prioritize risk mitigation for the user.';
const GATEWAY_PROMPT_MARKERS = [
  'you are the gateway agent',
  'return json only',
  'output json only',
  'docdexnotes',
  'fileslikelytouched',
  'filestocreate',
  'do not include fields outside the schema',
];

const sanitizeNonGatewayPrompt = (value?: string): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (GATEWAY_PROMPT_MARKERS.some((marker) => lower.includes(marker))) return undefined;
  return trimmed;
};

const readPromptFile = async (promptPath: string, fallback: string): Promise<string> => {
  try {
    const content = await fs.readFile(promptPath, 'utf8');
    const trimmed = content.trim();
    if (trimmed) return trimmed;
  } catch {
    // fall through to fallback
  }
  return fallback;
};
const RUN_ALL_TESTS_MARKER = 'mcoda_run_all_tests_complete';
const RUN_ALL_TESTS_GUIDANCE =
  'Run-all tests did not emit the expected marker. Ensure tests/all.js prints "MCODA_RUN_ALL_TESTS_COMPLETE".';
const QA_CLEAN_IGNORE_DEFAULTS = ['test-results', 'repo_meta.json', 'logs/', '.docdexignore'];
const DEFAULT_QA_HOST = '127.0.0.1';
const QA_HOST_ENV_KEYS = ['HOST', 'BIND_ADDR', 'BIND_ADDRESS', 'LISTEN_HOST', 'VITE_HOST', 'NUXT_HOST'];
const QA_PORT_ENV_KEYS = ['PORT', 'VITE_PORT', 'NUXT_PORT', 'NEXT_PORT'];
const QA_SERVER_START_ENV = 'MCODA_QA_START_SERVER';
const QA_SERVER_TIMEOUT_ENV = 'MCODA_QA_SERVER_TIMEOUT_MS';
const DEFAULT_QA_SERVER_TIMEOUT_MS = 5_000;
const QA_INSTALL_DEPS_ENV = 'MCODA_QA_INSTALL_DEPS';
type RunAllMarkerPolicy = 'strict' | 'warn';
type RunAllMarkerStatus = {
  policy: RunAllMarkerPolicy;
  present: boolean;
  action: 'none' | 'warn' | 'block';
};
type QaServerHandle = {
  baseUrl: string;
  command: string;
  logPath: string;
  process: ReturnType<typeof spawn>;
  stop: () => Promise<void>;
};
const normalizeSlugList = (input?: string[] | null): string[] => {
  if (!Array.isArray(input)) return [];
  const cleaned = new Set<string>();
  for (const slug of input) {
    if (typeof slug !== 'string') continue;
    const trimmed = slug.trim();
    if (trimmed) cleaned.add(trimmed);
  }
  return Array.from(cleaned);
};

const normalizePath = (value: string): string =>
  value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');

const normalizeCleanIgnorePaths = (input: Array<string | undefined | null>): string[] => {
  const normalized = new Set<string>();
  for (const entry of input) {
    if (!entry) continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    normalized.add(normalizePath(trimmed));
  }
  return Array.from(normalized).filter(Boolean);
};

const normalizeLineNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.round(value));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(1, parsed);
  }
  return undefined;
};

const detectApiTask = (task: TaskRow & { metadata?: any }): boolean => {
  const metadata = (task.metadata as any) ?? {};
  const files: string[] = Array.isArray(metadata.files) ? metadata.files : [];
  const reviewFiles: string[] = Array.isArray(metadata.last_review_changed_paths)
    ? metadata.last_review_changed_paths
    : [];
  const combined = [...files, ...reviewFiles].map((file) => String(file).toLowerCase());
  const apiHints = ['/api/', '/routes/', '/controllers/', '/server/', '/backend/', '/services/'];
  if (combined.some((file) => apiHints.some((hint) => file.includes(hint)))) return true;
  const key = (task.key ?? '').toLowerCase();
  if (key.startsWith('bck-') || key.startsWith('api-')) return true;
  const type = String(task.type ?? '').toLowerCase();
  if (type.includes('backend') || type.includes('api')) return true;
  const acceptance: string[] = Array.isArray((task as any).acceptanceCriteria)
    ? ((task as any).acceptanceCriteria as string[])
    : [];
  const text = [task.key, task.title, task.description, task.type, ...acceptance]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return false;
  const apiPhrases = [
    'endpoint',
    'route',
    'router',
    'controller',
    'backend',
    'server',
    'openapi',
    'swagger',
    'graphql',
    'rest',
  ];
  return apiPhrases.some((phrase) => text.includes(phrase));
};

const applyQaHostDefaults = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next = { ...env };
  for (const key of QA_HOST_ENV_KEYS) {
    const value = next[key];
    if (!value || value === '0.0.0.0') {
      next[key] = DEFAULT_QA_HOST;
    }
  }
  return next;
};

const resolveEnvPort = (env: NodeJS.ProcessEnv): number | undefined => {
  for (const key of QA_PORT_ENV_KEYS) {
    const raw = env[key];
    if (!raw) continue;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
};

const applyQaPortDefaults = (env: NodeJS.ProcessEnv, port: number): void => {
  for (const key of QA_PORT_ENV_KEYS) {
    if (!env[key]) {
      env[key] = String(port);
    }
  }
};

const resolveUrlPort = (value: string): { url: URL; port: number } | undefined => {
  try {
    const url = new URL(value);
    const port =
      url.port !== ''
        ? Number.parseInt(url.port, 10)
        : url.protocol === 'https:'
          ? 443
          : 80;
    if (!Number.isFinite(port) || port <= 0) return undefined;
    return { url, port };
  } catch {
    return undefined;
  }
};

const isPortOpen = async (host: string, port: number, timeoutMs = 500): Promise<boolean> =>
  await new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.connect(port, host);
  });

const pickFreePort = async (host: string): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (typeof address === 'object' && address?.port) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to acquire free port')));
      }
    });
  });

const normalizeQaUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname === '0.0.0.0') {
      url.hostname = DEFAULT_QA_HOST;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
};


const isEnvEnabled = (name: string): boolean => {
  const raw = process.env[name];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(normalized);
};

const shouldAutoStartServer = (): boolean => {
  if (process.env[QA_SERVER_START_ENV] === undefined) return true;
  return isEnvEnabled(QA_SERVER_START_ENV);
};

const resolveServerTimeoutMs = (): number => {
  const raw = process.env[QA_SERVER_TIMEOUT_ENV];
  if (!raw) return DEFAULT_QA_SERVER_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed)) {
    if (parsed <= 0) return 0;
    return parsed;
  }
  return DEFAULT_QA_SERVER_TIMEOUT_MS;
};

const isLocalBaseUrl = (value?: string): boolean => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
};

const parseCommentBody = (body: string): { message: string; suggestedFix?: string } => {
  const trimmed = (body ?? '').trim();
  if (!trimmed) return { message: '(no details provided)' };
  const lines = trimmed.split(/\r?\n/);
  const normalize = (value: string) => value.trim().toLowerCase();
  const messageIndex = lines.findIndex((line) => normalize(line) === 'message:');
  const suggestedIndex = lines.findIndex((line) => {
    const normalized = normalize(line);
    return normalized === 'suggested_fix:' || normalized === 'suggested fix:';
  });
  if (messageIndex >= 0) {
    const messageLines = lines.slice(messageIndex + 1, suggestedIndex >= 0 ? suggestedIndex : undefined);
    const message = messageLines.join('\n').trim();
    const suggestedLines = suggestedIndex >= 0 ? lines.slice(suggestedIndex + 1) : [];
    const suggestedFix = suggestedLines.join('\n').trim();
    return { message: message || trimmed, suggestedFix: suggestedFix || undefined };
  }
  if (suggestedIndex >= 0) {
    const message = lines.slice(0, suggestedIndex).join('\n').trim() || trimmed;
    const inlineFix = lines[suggestedIndex]?.split(/suggested fix:/i)[1]?.trim();
    const suggestedTail = lines.slice(suggestedIndex + 1).join('\n').trim();
    const suggestedFix = inlineFix || suggestedTail || undefined;
    return { message, suggestedFix };
  }
  return { message: trimmed };
};

const buildCommentBacklog = (comments: TaskCommentRow[]): string => {
  if (!comments.length) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  const toSingleLine = (value: string) => value.replace(/\s+/g, ' ').trim();
  for (const comment of comments) {
    const details = parseCommentBody(comment.body);
    const slug =
      comment.slug?.trim() ||
      createTaskCommentSlug({
        source: comment.sourceCommand ?? 'comment',
        message: details.message || comment.body,
        file: comment.file,
        line: comment.line,
        category: comment.category ?? null,
      });
    const key =
      slug ??
      `${comment.sourceCommand}:${comment.file ?? ''}:${comment.line ?? ''}:${details.message || comment.body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const location = comment.file
      ? `${comment.file}${typeof comment.line === 'number' ? `:${comment.line}` : ''}`
      : '(location not specified)';
    const message = toSingleLine(details.message || comment.body || '(no details provided)');
    lines.push(`- [${slug ?? 'untracked'}] ${location} ${message}`);
    const suggestedFix =
      (comment.metadata?.suggestedFix as string | undefined) ?? details.suggestedFix ?? undefined;
    if (suggestedFix) {
      lines.push(`  Suggested fix: ${toSingleLine(suggestedFix)}`);
    }
  }
  return lines.join('\n');
};

const formatSlugList = (slugs: string[], limit = 12): string => {
  if (!slugs.length) return 'none';
  if (slugs.length <= limit) return slugs.join(', ');
  return `${slugs.slice(0, limit).join(', ')} (+${slugs.length - limit} more)`;
};

export interface QaTasksRequest extends TaskSelectionFilters {
  workspace: WorkspaceResolution;
  mode?: 'auto' | 'manual';
  resumeJobId?: string;
  profileName?: string;
  level?: string;
  testCommand?: string;
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  createFollowupTasks?: 'auto' | 'none' | 'prompt';
  dryRun?: boolean;
  result?: 'pass' | 'fail';
  notes?: string;
  evidenceUrl?: string;
  allowDirty?: boolean;
  cleanIgnorePaths?: string[];
  abortSignal?: AbortSignal;
}

export interface QaTaskResult {
  taskKey: string;
  outcome: 'pass' | 'fix_required' | 'infra_issue' | 'unclear';
  profile?: string;
  runner?: string;
  artifacts?: string[];
  followups?: string[];
  commentId?: string;
  notes?: string;
}

export interface QaTasksResponse {
  jobId: string;
  commandRunId: string;
  selection: TaskSelectionPlan;
  results: QaTaskResult[];
  warnings: string[];
}


type AgentFailure = { kind?: string; message: string; evidence?: string; file?: string; line?: number };
type AgentFollowUp = {
  title?: string;
  description?: string;
  type?: string;
  priority?: number;
  story_points?: number;
  tags?: string[];
  related_task_key?: string;
  epic_key?: string;
  story_key?: string;
  components?: string[];
  doc_links?: string[];
  evidence_url?: string;
  artifacts?: string[];
};

type PromptBundle = { jobPrompt?: string; characterPrompt?: string; commandPrompt?: string };

interface AgentInterpretation {
  recommendation: 'pass' | 'fix_required' | 'infra_issue' | 'unclear';
  testedScope?: string;
  coverageSummary?: string;
  failures?: AgentFailure[];
  followUps?: AgentFollowUp[];
  resolvedSlugs?: string[];
  unresolvedSlugs?: string[];
  rawOutput?: string;
  tokensPrompt?: number;
  tokensCompletion?: number;
  agentId?: string;
  modelName?: string;
  invalidJson?: boolean;
}

export class QaTasksService {
  private profileService: QaProfileService;
  private selectionService: TaskSelectionService;
  private stateService: TaskStateService;
  private followupService: QaFollowupService;
  private jobService: JobService;
  private vcs: VcsClient;
  private agentService?: AgentService;
  private docdex?: DocdexClient;
  private repo?: GlobalRepository;
  private routingService?: RoutingService;
  private ratingService?: AgentRatingService;
  private dryRunGuard = false;
  private qaProfilePlan?: Map<string, QaProfile[]>;
  private qaTaskPlans?: Map<string, QaTaskPlan>;

  constructor(
    private workspace: WorkspaceResolution,
    private deps: {
      workspaceRepo: WorkspaceRepository;
      jobService: JobService;
      selectionService?: TaskSelectionService;
      stateService?: TaskStateService;
      profileService?: QaProfileService;
      followupService?: QaFollowupService;
      vcsClient?: VcsClient;
      agentService?: AgentService;
      docdex?: DocdexClient;
      repo?: GlobalRepository;
      routingService?: RoutingService;
      ratingService?: AgentRatingService;
    },
  ) {
    this.selectionService = deps.selectionService ?? new TaskSelectionService(workspace, deps.workspaceRepo);
    this.stateService = deps.stateService ?? new TaskStateService(deps.workspaceRepo);
    this.profileService =
      deps.profileService ?? new QaProfileService(workspace.workspaceRoot, { noRepoWrites: workspace.noRepoWrites });
    this.followupService = deps.followupService ?? new QaFollowupService(deps.workspaceRepo, workspace.workspaceRoot);
    this.jobService = deps.jobService;
    this.vcs = deps.vcsClient ?? new VcsClient();
    this.agentService = deps.agentService;
    this.docdex = deps.docdex;
    this.repo = deps.repo;
    this.routingService = deps.routingService;
    this.ratingService = deps.ratingService;
  }

  static async create(workspace: WorkspaceResolution, options: { noTelemetry?: boolean } = {}): Promise<QaTasksService> {
    const repo = await GlobalRepository.create();
    const agentService = new AgentService(repo);
    const docdexRepoId =
      workspace.config?.docdexRepoId ?? process.env.MCODA_DOCDEX_REPO_ID ?? process.env.DOCDEX_REPO_ID;
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
      repoId: docdexRepoId,
    });
    const routingService = await RoutingService.create();
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    const jobService = new JobService(workspace, workspaceRepo, {
      noTelemetry: options.noTelemetry ?? false,
    });
    const selectionService = new TaskSelectionService(workspace, workspaceRepo);
    const stateService = new TaskStateService(workspaceRepo);
    const profileService = new QaProfileService(workspace.workspaceRoot, { noRepoWrites: workspace.noRepoWrites });
    const followupService = new QaFollowupService(workspaceRepo, workspace.workspaceRoot);
    const vcsClient = new VcsClient();
    return new QaTasksService(workspace, {
      workspaceRepo,
      jobService,
      selectionService,
      stateService,
      profileService,
      followupService,
      vcsClient,
      agentService,
      docdex,
      repo,
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
    await maybeClose(this.deps.jobService);
    await maybeClose(this.deps.workspaceRepo);
    await maybeClose(this.agentService);
    await maybeClose(this.repo);
    await maybeClose(this.docdex);
    await maybeClose(this.deps.routingService);
  }

  setDocdexAvailability(available: boolean, reason?: string): void {
    if (available) return;
    const docdex = this.docdex as any;
    if (docdex && typeof docdex.disable === "function") {
      docdex.disable(reason);
    }
  }

  private async readPromptFiles(paths: string[]): Promise<string[]> {
    const contents: string[] = [];
    const seen = new Set<string>();
    for (const promptPath of paths) {
      try {
        const content = await fs.readFile(promptPath, 'utf8');
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

  private async loadPrompts(agentId: string): Promise<PromptBundle> {
    const mcodaPromptPath = path.join(this.workspace.mcodaDir, 'prompts', 'qa-agent.md');
    const workspacePromptPath = path.join(this.workspace.workspaceRoot, 'prompts', 'qa-agent.md');
    const repoPromptPath = resolveRepoPromptPath('qa-agent.md');
    const isStalePrompt = (value?: string): boolean => {
      if (!value) return false;
      return (
        /playwright/i.test(value) ||
        /legacy/i.test(value) ||
        /MCODA_QA_BROWSER_URL/i.test(value) ||
        /http:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}/i.test(value)
      );
    };
    try {
      await fs.mkdir(path.dirname(mcodaPromptPath), { recursive: true });
      let existingPrompt: string | undefined;
      try {
        existingPrompt = await fs.readFile(mcodaPromptPath, 'utf8');
      } catch {
        existingPrompt = undefined;
      }
      if (existingPrompt && !isStalePrompt(existingPrompt)) {
        console.info(`[qa-tasks] using existing QA prompt at ${mcodaPromptPath}`);
      } else {
        if (existingPrompt) {
          console.info(`[qa-tasks] refreshing stale QA prompt at ${mcodaPromptPath}`);
        }
        let sourcePrompt: string | undefined;
        try {
          const workspacePrompt = await fs.readFile(workspacePromptPath, 'utf8');
          if (!isStalePrompt(workspacePrompt)) {
            sourcePrompt = workspacePrompt;
            console.info(`[qa-tasks] copied QA prompt to ${mcodaPromptPath}`);
          }
        } catch {
          // ignore workspace prompt
        }
        if (!sourcePrompt) {
          try {
            const repoPrompt = await fs.readFile(repoPromptPath, 'utf8');
            if (!isStalePrompt(repoPrompt)) {
              sourcePrompt = repoPrompt;
              console.info(`[qa-tasks] copied repo QA prompt to ${mcodaPromptPath}`);
            }
          } catch {
            // ignore repo prompt
          }
        }
        if (!sourcePrompt) {
          console.info(
            `[qa-tasks] no QA prompt found at ${workspacePromptPath} or repo prompts; writing default prompt to ${mcodaPromptPath}`,
          );
          sourcePrompt = DEFAULT_QA_PROMPT;
        }
        await fs.writeFile(mcodaPromptPath, sourcePrompt, 'utf8');
      }
    } catch {
      try {
        await fs.access(workspacePromptPath);
        await fs.copyFile(workspacePromptPath, mcodaPromptPath);
        console.info(`[qa-tasks] copied QA prompt to ${mcodaPromptPath}`);
      } catch {
        try {
          await fs.access(repoPromptPath);
          await fs.copyFile(repoPromptPath, mcodaPromptPath);
          console.info(`[qa-tasks] copied repo QA prompt to ${mcodaPromptPath}`);
        } catch {
          console.info(
            `[qa-tasks] no QA prompt found at ${workspacePromptPath} or repo prompts; writing default prompt to ${mcodaPromptPath}`,
          );
          await fs.writeFile(mcodaPromptPath, DEFAULT_QA_PROMPT, 'utf8');
        }
      }
    }
    const agentPrompts =
      this.agentService && 'getPrompts' in this.agentService ? await (this.agentService as any).getPrompts(agentId) : undefined;
    const filePrompt = await readPromptFile(mcodaPromptPath, DEFAULT_QA_PROMPT);
    const commandPrompt = agentPrompts?.commandPrompts?.['qa-tasks']?.trim() || filePrompt;
    return {
      jobPrompt: sanitizeNonGatewayPrompt(agentPrompts?.jobPrompt) ?? DEFAULT_JOB_PROMPT,
      characterPrompt: sanitizeNonGatewayPrompt(agentPrompts?.characterPrompt) ?? DEFAULT_CHARACTER_PROMPT,
      commandPrompt: commandPrompt || undefined,
    };
  }

  private async checkpoint(jobId: string, stage: string, details?: Record<string, unknown>): Promise<void> {
    await this.jobService.writeCheckpoint(jobId, {
      stage,
      timestamp: new Date().toISOString(),
      details,
    });
  }

  private async ensureTaskBranch(
    task: TaskSelectionPlan['ordered'][number],
    taskRunId: string,
    jobId: string,
    allowDirty: boolean,
    cleanIgnorePaths?: string[],
  ): Promise<{
    ok: boolean;
    message?: string;
    workspaceRoot?: string;
    cleanup?: () => Promise<void>;
    branch?: string;
  }> {
    try {
      const repoRoot = this.workspace.workspaceRoot;
      await this.vcs.ensureRepo(repoRoot);
      if (!allowDirty) {
        const ignorePaths = this.buildCleanIgnorePaths(cleanIgnorePaths);
        if (ignorePaths.length) {
          await this.logTask(taskRunId, `VCS clean ignore paths: ${ignorePaths.join(", ")}`, 'vcs', { ignorePaths });
        }
        await this.vcs.ensureClean(repoRoot, true, ignorePaths);
      }
      let branch = task.task.vcsBranch;
      if (branch) {
        const exists = await this.vcs.branchExists(repoRoot, branch);
        if (!exists) {
          return { ok: false, message: `Task branch ${branch} not found` };
        }
      } else {
        const base = this.workspace.config?.branch ?? 'mcoda-dev';
        await this.vcs.ensureBaseBranch(repoRoot, base);
        branch = base;
      }

      const worktreeRoot = path.join(
        this.workspace.mcodaDir,
        'jobs',
        jobId,
        'qa-worktrees',
        task.task.key,
      );
      await fs.rm(worktreeRoot, { recursive: true, force: true });
      await PathHelper.ensureDir(path.dirname(worktreeRoot));
      const repoBranch = await this.vcs.currentBranch(repoRoot);
      const preferDetached = repoBranch === branch;
      await this.vcs.addWorktree(repoRoot, worktreeRoot, branch, { detach: preferDetached });
      const reportedBranch = await this.vcs.currentBranch(worktreeRoot);
      let activeBranch = reportedBranch ?? branch;
      if (reportedBranch && reportedBranch !== branch) {
        if (reportedBranch === 'HEAD') {
          await this.logTask(
            taskRunId,
            `QA worktree is detached at ${branch}; keeping detached HEAD to avoid branch lock.`,
            'vcs',
            { expected: branch, found: reportedBranch },
          );
          activeBranch = branch;
        } else {
          await this.logTask(taskRunId, `QA worktree branch mismatch (${reportedBranch}); switching to ${branch}`, 'vcs', {
            expected: branch,
            found: reportedBranch,
          });
          try {
            await this.vcs.checkoutBranch(worktreeRoot, branch);
            activeBranch = (await this.vcs.currentBranch(worktreeRoot)) ?? branch;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('already used by worktree')) {
              await this.logTask(
                taskRunId,
                `QA worktree branch ${branch} already checked out elsewhere; continuing in detached HEAD.`,
                'vcs',
                { error: message },
              );
              activeBranch = branch;
            } else {
              throw error;
            }
          }
        }
      }
      await this.logTask(taskRunId, `QA worktree ready on branch ${activeBranch}`, 'vcs', {
        branch: activeBranch,
      });
      const cleanup = async () => {
        await this.vcs.removeWorktree(repoRoot, worktreeRoot);
        await fs.rm(worktreeRoot, { recursive: true, force: true });
      };
      return { ok: true, workspaceRoot: worktreeRoot, cleanup, branch: activeBranch };
    } catch (error: any) {
      await this.logTask(taskRunId, `VCS check failed: ${error?.message ?? error}`, 'vcs');
      return { ok: false, message: error?.message ?? String(error) };
    }
  }

  private async ensureMcoda(): Promise<void> {
    await PathHelper.ensureDir(this.workspace.mcodaDir);
  }

  private buildCleanIgnorePaths(extra?: string[]): string[] {
    const configPaths = this.workspace.config?.qa?.cleanIgnorePaths ?? [];
    const envPaths = (process.env.MCODA_QA_CLEAN_IGNORE ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return normalizeCleanIgnorePaths([
      ...QA_CLEAN_IGNORE_DEFAULTS,
      ...configPaths,
      ...envPaths,
      ...(extra ?? []),
    ]);
  }

  private adapterForProfile(profile?: QaProfile): QaAdapter | undefined {
    const runner = profile?.runner ?? 'cli';
    if (runner === 'cli') return new CliQaAdapter();
    if (runner === 'chromium') return new ChromiumQaAdapter();
    if (runner === 'maestro') return new MaestroQaAdapter();
    return new CliQaAdapter();
  }

  private mapOutcome(result: QaRunResult): 'pass' | 'fix_required' | 'infra_issue' {
    if (result.outcome === 'pass') return 'pass';
    if (result.outcome === 'infra_issue') return 'infra_issue';
    return 'fix_required';
  }

  private shouldUseAgentInterpretation(): boolean {
    if (process.env[QA_AGENT_INTERPRETATION_ENV] === undefined) return true;
    return isEnvEnabled(QA_AGENT_INTERPRETATION_ENV);
  }

  private buildDeterministicInterpretation(
    task: TaskSelectionPlan['ordered'][number],
    profile: QaProfile,
    result: QaRunResult,
  ): AgentInterpretation {
    const recommendation = this.mapOutcome(result);
    const runner = profile.runner ?? 'cli';
    const testedScope = `Ran ${profile.name} (${runner}) QA for ${task.task.key}.`;
    const coverageSummary =
      recommendation === 'pass'
        ? `Automated QA completed successfully with exit code ${result.exitCode}.`
        : `Automated QA reported outcome ${result.outcome} (exit code ${result.exitCode}). Review logs/artifacts for details.`;
    return {
      recommendation,
      testedScope,
      coverageSummary,
      failures: [],
      followUps: [],
    };
  }

  private async buildRunnerFailureMessage(params: {
    outcome: 'fix_required' | 'infra_issue' | 'unclear';
    result: QaRunResult;
    runs: Array<{
      profile: QaProfile;
      runner: string;
      command?: string;
      testCommand?: string;
      result: QaRunResult;
    }>;
    runSummary?: string;
    workspaceRoot: string;
  }): Promise<string> {
    const { outcome, result, runs, runSummary, workspaceRoot } = params;
    const artifacts = result.artifacts ?? [];
    const lines: string[] = [`QA ${outcome} based on runner output.`];
    if (runSummary) lines.push(`Runs:\n${runSummary}`);

    const tail = (text: string, maxLines = 16, maxChars = 2000): string => {
      const trimmed = text.trim();
      if (!trimmed) return '';
      const lines = trimmed.split(/\r?\n/);
      const slice = lines.slice(-maxLines).join('\n');
      return slice.length > maxChars ? `${slice.slice(0, maxChars)}…` : slice;
    };

    const resolveArtifactPath = (artifact: string): string => path.resolve(workspaceRoot, artifact);
    const loadJson = async <T>(artifact: string): Promise<T | undefined> => {
      try {
        const raw = await fs.readFile(resolveArtifactPath(artifact), 'utf8');
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    };

    const browserArtifact = artifacts.find((artifact) => artifact.endsWith('browser-actions.json'));
    if (browserArtifact) {
      type BrowserActionsFile = {
        actions?: Array<{ index: number; type: string; ok: boolean; message?: string }>;
      };
      const payload = await loadJson<BrowserActionsFile>(browserArtifact);
      const failures = (payload?.actions ?? []).filter((action) => action.ok === false).slice(0, 8);
      if (failures.length) {
        lines.push(
          `Browser action failures:\n${failures
            .map((action) => `- ${action.index}. ${action.type}: ${action.message ?? 'failed'}`)
            .join('\n')}`,
        );
      }
    }

    const apiArtifact = artifacts.find((artifact) => artifact.endsWith('api-results.json'));
    if (apiArtifact) {
      type ApiResultsFile = {
        results?: Array<{
          method?: string;
          url?: string;
          status?: number;
          ok?: boolean;
          error?: string;
          expectations?: string[];
        }>;
      };
      const payload = await loadJson<ApiResultsFile>(apiArtifact);
      const failures = (payload?.results ?? []).filter((item) => item.ok === false).slice(0, 8);
      if (failures.length) {
        lines.push(
          `API request failures:\n${failures
            .map((item) => {
              const parts = [item.method ?? 'GET', item.url ?? '', item.status ? `status=${item.status}` : ''];
              const detail = item.error ?? item.expectations?.[0];
              return `- ${parts.filter(Boolean).join(' ')}${detail ? ` (${detail})` : ''}`;
            })
            .join('\n')}`,
        );
      }
    }

    const cliFailure = runs.find((run) => run.runner === 'cli' && run.result.outcome !== 'pass');
    const stderrSnippet = cliFailure?.result.stderr ?? result.stderr;
    const stderrTail = stderrSnippet ? tail(stderrSnippet) : '';
    if (stderrTail) {
      lines.push(`Runner stderr (tail):\n${stderrTail}`);
    }

    return lines.join('\n\n');
  }

  private async createRunnerFailureComments(params: {
    task: TaskRow;
    taskRunId: string;
    jobId: string;
    outcome: 'fix_required' | 'infra_issue' | 'unclear';
    result: QaRunResult;
    runs: Array<{
      profile: QaProfile;
      runner: string;
      command?: string;
      testCommand?: string;
      result: QaRunResult;
    }>;
    workspaceRoot: string;
    runSummary?: string;
    existingSlugs?: Set<string>;
  }): Promise<number> {
    const { task, taskRunId, jobId, result, runs, workspaceRoot, runSummary } = params;
    const existingSlugs = params.existingSlugs ?? new Set<string>();
    const artifacts = result.artifacts ?? [];
    const resolveArtifactPath = (artifact: string): string => path.resolve(workspaceRoot, artifact);
    const loadJson = async <T>(artifact: string): Promise<T | undefined> => {
      try {
        const raw = await fs.readFile(resolveArtifactPath(artifact), 'utf8');
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    };
    const comments: Array<{ message: string; metadata?: Record<string, unknown> }> = [];

    const browserArtifact = artifacts.find((artifact) => artifact.endsWith('browser-actions.json'));
    if (browserArtifact) {
      type BrowserActionsFile = {
        actions?: Array<{ index: number; type: string; ok: boolean; message?: string; url?: string }>;
      };
      const payload = await loadJson<BrowserActionsFile>(browserArtifact);
      const failures = (payload?.actions ?? []).filter((action) => action.ok === false).slice(0, 8);
      for (const action of failures) {
        const message = `Browser action ${action.index} (${action.type}) failed${action.message ? `: ${action.message}` : ''}`;
        comments.push({
          message,
          metadata: {
            runner: 'chromium',
            actionIndex: action.index,
            actionType: action.type,
            url: action.url,
            artifact: browserArtifact,
            runSummary,
          },
        });
      }
    }

    const apiArtifact = artifacts.find((artifact) => artifact.endsWith('api-results.json'));
    if (apiArtifact) {
      type ApiResultsFile = {
        results?: Array<{
          id?: string;
          method?: string;
          url?: string;
          status?: number;
          ok?: boolean;
          error?: string;
          expectations?: string[];
        }>;
      };
      const payload = await loadJson<ApiResultsFile>(apiArtifact);
      const failures = (payload?.results ?? []).filter((item) => item.ok === false).slice(0, 8);
      for (const item of failures) {
        const detail = item.error ?? item.expectations?.[0];
        const parts = [item.method ?? 'GET', item.url ?? '', item.status ? `status=${item.status}` : '']
          .filter(Boolean)
          .join(' ');
        const message = `API ${parts} failed${detail ? `: ${detail}` : ''}`;
        comments.push({
          message,
          metadata: {
            runner: 'api',
            requestId: item.id,
            method: item.method,
            url: item.url,
            status: item.status,
            expectations: item.expectations,
            artifact: apiArtifact,
            runSummary,
          },
        });
      }
    }

    const tail = (text: string, maxLines = 16, maxChars = 2000): string => {
      const trimmed = text.trim();
      if (!trimmed) return '';
      const lines = trimmed.split(/\r?\n/);
      const slice = lines.slice(-maxLines).join('\n');
      return slice.length > maxChars ? `${slice.slice(0, maxChars)}…` : slice;
    };
    const cliFailures = runs.filter((run) => run.runner === 'cli' && run.result.outcome !== 'pass');
    for (const run of cliFailures) {
      const stderrTail = tail(run.result.stderr ?? '');
      const message = stderrTail
        ? `CLI QA failed${run.command ? ` (${run.command})` : ''}: ${stderrTail}`
        : `CLI QA failed${run.command ? ` (${run.command})` : ''}.`;
      comments.push({
        message,
        metadata: {
          runner: 'cli',
          command: run.command,
          testCommand: run.testCommand,
          runSummary,
        },
      });
    }

    let created = 0;
    for (const entry of comments) {
      const slug = createTaskCommentSlug({ source: 'qa-tasks', message: entry.message, category: 'qa_issue' });
      if (existingSlugs.has(slug)) continue;
      existingSlugs.add(slug);
      await this.createQaComment({
        task,
        taskRunId,
        jobId,
        message: entry.message,
        category: 'qa_issue',
        status: 'open',
        metadata: entry.metadata,
      });
      created += 1;
    }
    return created;
  }

  private resolveRunAllMarkerPolicy(): RunAllMarkerPolicy {
    return this.workspace.config?.qa?.runAllMarkerRequired === false ? 'warn' : 'strict';
  }

  private adjustOutcomeForSkippedTests(
    profile: QaProfile,
    result: QaRunResult,
    testCommand?: string,
  ): { result: QaRunResult; markerStatus?: RunAllMarkerStatus } {
    if ((profile.runner ?? 'cli') !== 'cli') return { result };
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const outputLower = output.toLowerCase();
    const markers = ['no test script configured', 'skipping tests', 'no tests found'];
    if (markers.some((marker) => outputLower.includes(marker))) {
      return { result: { ...result, outcome: 'infra_issue', exitCode: result.exitCode ?? 1 } };
    }
    let markerStatus: RunAllMarkerStatus | undefined;
    if (testCommand && testCommand.includes('tests/all.js')) {
      const present = outputLower.includes(RUN_ALL_TESTS_MARKER);
      const policy = this.resolveRunAllMarkerPolicy();
      markerStatus = {
        policy,
        present,
        action: present ? 'none' : policy === 'strict' ? 'block' : 'warn',
      };
      if (!present) {
        const passed = result.outcome === 'pass' || result.exitCode === 0;
        if (passed) {
          markerStatus.action = 'warn';
          const warning = `Warning: ${RUN_ALL_TESTS_GUIDANCE}`;
          const stderr = result.stderr?.includes(RUN_ALL_TESTS_GUIDANCE)
            ? result.stderr
            : [result.stderr, warning].filter(Boolean).join('\n');
          return { result: { ...result, stderr }, markerStatus };
        }
        if (policy === 'strict') {
          const stderr = [result.stderr, RUN_ALL_TESTS_GUIDANCE].filter(Boolean).join('\n');
          return {
            result: { ...result, outcome: 'infra_issue', exitCode: result.exitCode ?? 1, stderr },
            markerStatus,
          };
        }
      }
    }
    return { result, markerStatus };
  }

  private combineOutcome(
    result: QaRunResult,
    recommendation?: AgentInterpretation['recommendation'],
  ): 'pass' | 'fix_required' | 'infra_issue' | 'unclear' {
    const base = this.mapOutcome(result);
    if (!recommendation) return base;
    if (base === 'infra_issue' || recommendation === 'infra_issue') return 'infra_issue';
    if (base === 'fix_required') return 'fix_required';
    if (recommendation === 'fix_required') return 'fix_required';
    if (recommendation === 'unclear') return 'unclear';
    return 'pass';
  }

  private async gatherDocContext(
    task: TaskSelectionPlan['ordered'][number]['task'],
    taskRunId?: string,
    docLinks: string[] = [],
  ): Promise<string> {
    if (!this.docdex) return '';
    let openApiIncluded = false;
    const shouldIncludeDocType = (docType: string): boolean => {
      if (docType.toUpperCase() !== 'OPENAPI') return true;
      if (openApiIncluded) return false;
      openApiIncluded = true;
      return true;
    };
    try {
      if (typeof (this.docdex as any)?.ensureRepoScope === 'function') {
        await (this.docdex as any).ensureRepoScope();
      }
      const querySeeds = [task.key, task.title, ...(task.acceptanceCriteria ?? [])]
        .filter(Boolean)
        .join(' ')
        .slice(0, 200);
      const docs = await this.docdex.search({
        projectKey: task.projectId,
        profile: 'qa',
        query: querySeeds,
      });
      const snippets: string[] = [];
      const resolveDocType = async (doc: { docType?: string; path?: string; title?: string; content?: string; segments?: Array<{ content?: string }> }) => {
        const content = doc.segments?.[0]?.content ?? doc.content ?? '';
        const normalized = normalizeDocType({
          docType: doc.docType,
          path: doc.path,
          title: doc.title,
          content,
        });
        if (normalized.downgraded && taskRunId) {
          await this.logTask(
            taskRunId,
            `Docdex docType downgraded from SDS to DOC for ${doc.path ?? doc.title ?? doc.docType ?? 'unknown'}: ${normalized.reason ?? 'not_sds'}`,
            'docdex',
          );
        }
        return normalized.docType;
      };
      const filteredDocs = docs.filter((doc) => !isDocContextExcluded(doc.path ?? doc.title ?? doc.id, true));
      for (const doc of filteredDocs.slice(0, 5)) {
        const segments = (doc.segments ?? []).slice(0, 2);
        const body = segments.length
          ? segments
              .map((seg, idx) => `  (${idx + 1}) ${seg.heading ? `${seg.heading}: ` : ''}${seg.content.slice(0, 400)}`)
              .join('\n')
          : doc.content
            ? doc.content.slice(0, 600)
            : '';
        const docType = await resolveDocType(doc);
        if (!shouldIncludeDocType(docType)) continue;
        snippets.push(`- [${docType}] ${doc.title ?? doc.path ?? doc.id}\n${body}`.trim());
      }
      const normalizeDocLink = (value: string): { type: 'id' | 'path'; ref: string } => {
        const trimmed = value.trim();
        const stripped = trimmed.replace(/^docdex:/i, '').replace(/^doc:/i, '');
        const candidate = stripped || trimmed;
        const looksLikePath =
          candidate.includes('/') ||
          candidate.includes('\\') ||
          /\.(md|markdown|txt|rst|yaml|yml|json)$/i.test(candidate);
        return { type: looksLikePath ? 'path' : 'id', ref: candidate };
      };
      for (const link of docLinks) {
        try {
          const { type, ref } = normalizeDocLink(link);
          if (type === 'path' && isDocContextExcluded(ref, true)) {
            snippets.push(`- [linked:filtered] ${link} — excluded from context`);
            continue;
          }
          let doc = undefined;
          if (type === 'path' && 'findDocumentByPath' in this.docdex) {
            doc = await (this.docdex as DocdexClient).findDocumentByPath(ref);
          }
          if (!doc) {
            doc = await this.docdex.fetchDocumentById(ref);
          }
        if (!doc) {
          snippets.push(`- [linked:missing] ${link} — no docdex entry found`);
          continue;
        }
        const body = (doc.segments?.[0]?.content ?? doc.content ?? '').slice(0, 600);
        const docType = await resolveDocType(doc);
        if (!shouldIncludeDocType(docType)) continue;
        snippets.push(`- [linked:${docType}] ${doc.title ?? doc.path ?? doc.id}\n${body}`.trim());
      } catch (error: any) {
        snippets.push(`- [linked:missing] ${link} — ${error?.message ?? error}`);
      }
      }
      return snippets.join('\n\n');
    } catch (error: any) {
      if (taskRunId) {
        await this.logTask(taskRunId, `Docdex search failed: ${error?.message ?? error}`, 'docdex');
      }
      return '';
    }
  }

  private async resolveAgent(agentName?: string) {
    if (!this.routingService || !this.agentService) {
      throw new Error('RoutingService not available for QA routing');
    }
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: 'qa-tasks',
      overrideAgentSlug: agentName,
    });
    return resolved.agent;
  }

  private ensureRatingService(): AgentRatingService {
    if (!this.ratingService) {
      if (!this.repo || !this.agentService || !this.routingService) {
        throw new Error('Agent rating requires routing, agent, and repository services.');
      }
      this.ratingService = new AgentRatingService(this.workspace, {
        workspaceRepo: this.deps.workspaceRepo,
        globalRepo: this.repo,
        agentService: this.agentService,
        routingService: this.routingService,
      });
    }
    return this.ratingService;
  }

  private resolveTaskComplexity(task: TaskRow): number | undefined {
    const metadata = (task.metadata as Record<string, unknown> | null | undefined) ?? {};
    const metaComplexity =
      typeof metadata.complexity === 'number' && Number.isFinite(metadata.complexity) ? metadata.complexity : undefined;
    const storyPoints = typeof task.storyPoints === 'number' && Number.isFinite(task.storyPoints) ? task.storyPoints : undefined;
    const candidate = metaComplexity ?? storyPoints;
    if (!Number.isFinite(candidate ?? NaN)) return undefined;
    return Math.min(10, Math.max(1, Math.round(candidate as number)));
  }

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil((text?.length ?? 0) / 4));
  }

  private async fileExists(absolutePath: string): Promise<boolean> {
    try {
      await fs.access(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  private async readPackageJson(root = this.workspace.workspaceRoot): Promise<Record<string, any> | undefined> {
    const pkgPath = path.join(root, 'package.json');
    try {
      const raw = await fs.readFile(pkgPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private async detectPackageManager(
    root = this.workspace.workspaceRoot,
  ): Promise<'pnpm' | 'yarn' | 'npm' | undefined> {
    if (await this.fileExists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
    if (await this.fileExists(path.join(root, 'pnpm-workspace.yaml'))) return 'pnpm';
    if (await this.fileExists(path.join(root, 'yarn.lock'))) return 'yarn';
    if (await this.fileExists(path.join(root, 'package-lock.json'))) return 'npm';
    if (await this.fileExists(path.join(root, 'npm-shrinkwrap.json'))) return 'npm';
    if (await this.fileExists(path.join(root, 'package.json'))) return 'npm';
    return undefined;
  }

  private async resolveTestCommand(
    profile: QaProfile,
    requestTestCommand?: string,
    workspaceRoot = this.workspace.workspaceRoot,
  ): Promise<string | undefined> {
    if (requestTestCommand) return requestTestCommand;
    if ((profile.runner ?? 'cli') !== 'cli') return undefined;
    if (profile.test_command) return profile.test_command;
    if (await this.fileExists(path.join(workspaceRoot, 'tests', 'all.js'))) {
      return 'node tests/all.js';
    }
    const pkg = await this.readPackageJson(workspaceRoot);
    if (pkg?.scripts?.test) {
      const pm = (await this.detectPackageManager(workspaceRoot)) ?? 'npm';
      return `${pm} test`;
    }
    return undefined;
  }

  private isCliTask(task: TaskRow & { metadata?: any }): boolean {
    const metadata = (task.metadata as any) ?? {};
    const files: string[] = Array.isArray(metadata.files) ? metadata.files : [];
    const reviewFiles: string[] = Array.isArray(metadata.last_review_changed_paths)
      ? metadata.last_review_changed_paths
      : [];
    const combined = [...files, ...reviewFiles].map((file) => String(file).toLowerCase());
    const cliHints = ['/cli/', '/packages/cli/', '/bin/', '/cmd/'];
    if (combined.some((file) => cliHints.some((hint) => file.includes(hint)))) return true;
    const text = [task.key, task.title, task.description, task.type]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!text) return false;
    return ['cli', 'command', 'terminal'].some((hint) => text.includes(hint));
  }

  private async findCliBinCommand(workspaceRoot: string): Promise<string | undefined> {
    const resolveBin = (pkg: Record<string, any> | undefined): string | undefined => {
      if (!pkg) return undefined;
      const bin = pkg.bin;
      if (typeof bin === 'string') return bin;
      if (bin && typeof bin === 'object') {
        const first = Object.values(bin).find((value) => typeof value === 'string');
        return typeof first === 'string' ? first : undefined;
      }
      return undefined;
    };
    const rootPkg = await this.readPackageJson(workspaceRoot);
    let binPath = resolveBin(rootPkg);
    if (!binPath) {
      const cliPkgPath = path.join(workspaceRoot, 'packages', 'cli', 'package.json');
      try {
        const raw = await fs.readFile(cliPkgPath, 'utf8');
        const cliPkg = JSON.parse(raw);
        binPath = resolveBin(cliPkg);
        if (binPath) {
          binPath = path.join('packages', 'cli', binPath);
        }
      } catch {
        // ignore
      }
    }
    if (!binPath) return undefined;
    const normalized = path.isAbsolute(binPath) ? binPath : path.join(workspaceRoot, binPath);
    if (!(await this.fileExists(normalized))) return undefined;
    const relative = path.isAbsolute(binPath) ? path.relative(workspaceRoot, binPath) : binPath;
    return `node ${relative} --help`;
  }

  private async resolveCliChecklistCommands(params: {
    workspaceRoot: string;
    task: TaskRow & { metadata?: any };
    existing: string[];
  }): Promise<string[]> {
    const pkg = await this.readPackageJson(params.workspaceRoot);
    if (!pkg?.scripts) return [];
    const pm = (await this.detectPackageManager(params.workspaceRoot)) ?? 'npm';
    const existingLower = params.existing.map((cmd) => cmd.toLowerCase());
    const addIfScript = (script: string, matcher: string) => {
      if (!pkg.scripts?.[script]) return undefined;
      if (existingLower.some((cmd) => cmd.includes(matcher))) return undefined;
      return this.buildScriptCommand(pm, script);
    };
    const extras: string[] = [];
    const lintCmd = addIfScript('lint', 'lint');
    if (lintCmd) extras.push(lintCmd);
    const typecheckCmd =
      addIfScript('typecheck', 'typecheck') ??
      addIfScript('type-check', 'type-check') ??
      addIfScript('tsc', 'tsc');
    if (typecheckCmd) extras.push(typecheckCmd);
    const buildCmd = addIfScript('build', 'build');
    if (buildCmd) extras.push(buildCmd);
    if (this.isCliTask(params.task)) {
      const cliSmoke = await this.findCliBinCommand(params.workspaceRoot);
      if (cliSmoke && !existingLower.some((cmd) => cmd.includes('--help'))) {
        extras.push(cliSmoke);
      }
    }
    return extras;
  }

  private softenOptionalNpmScripts(commands: string[]): string[] {
    if (!commands.length) return commands;
    const scripts = ['lint', 'build'];
    return commands.map((command) => {
      let next = command;
      for (const script of scripts) {
        const pattern = new RegExp(`\\bnpm\\s+run\\s+${script}\\b(?!\\s+--if-present)`, 'i');
        next = next.replace(pattern, '$& --if-present');
      }
      return next;
    });
  }

  private usesCliBrowserTools(commands: string[]): boolean {
    const pattern = /(cypress|puppeteer|selenium|capybara|dusk)/i;
    return commands.some((command) => pattern.test(command));
  }

  private ensureCypressChromium(command: string): string {
    if (!/cypress/i.test(command)) return command;
    const browserMatch = /--browser(\s+|=)(\S+)/i.exec(command);
    if (browserMatch) {
      const current = browserMatch[2] ?? "";
      if (/chromium/i.test(current)) return command;
      return command.replace(browserMatch[0], "--browser chromium");
    }
    if (/\bcypress\s+(run|open)\b/i.test(command)) {
      return `${command} --browser chromium`;
    }
    return command;
  }

  private async applyChromiumForCli(
    env: NodeJS.ProcessEnv,
    commands: string[],
  ): Promise<{ ok: boolean; commands: string[]; message?: string }> {
    if (!this.usesCliBrowserTools(commands)) {
      return { ok: true, commands };
    }
    const chromiumPath = await resolveChromiumBinary();
    if (!chromiumPath) {
      return {
        ok: false,
        commands,
        message:
          'Chromium binary not found for CLI browser tests. Install Docdex Chromium (docdex setup or MCODA_QA_CHROMIUM_PATH).',
      };
    }
    env.CHROME_PATH = chromiumPath;
    env.CHROME_BIN = chromiumPath;
    env.PUPPETEER_EXECUTABLE_PATH = chromiumPath;
    env.PUPPETEER_PRODUCT = 'chrome';
    env.CYPRESS_BROWSER = 'chromium';
    const updated = commands.map((command) => this.ensureCypressChromium(command));
    return { ok: true, commands: updated };
  }

  private buildScriptCommand(pm: 'pnpm' | 'yarn' | 'npm', script: string): string {
    if (pm === 'yarn') return `yarn ${script}`;
    if (pm === 'pnpm') return `pnpm ${script}`;
    return `npm run ${script}`;
  }

  private async resolveDevServerCommand(
    workspaceRoot: string,
  ): Promise<{ script: string; command: string } | undefined> {
    const pkg = await this.readPackageJson(workspaceRoot);
    if (!pkg?.scripts) return undefined;
    const script =
      typeof pkg.scripts.dev === 'string'
        ? 'dev'
        : typeof pkg.scripts.start === 'string'
          ? 'start'
          : typeof pkg.scripts.serve === 'string'
            ? 'serve'
            : undefined;
    if (!script) return undefined;
    const pm = (await this.detectPackageManager(workspaceRoot)) ?? 'npm';
    return { script, command: this.buildScriptCommand(pm, script) };
  }

  private shouldInstallQaDeps(): boolean {
    if (process.env[QA_INSTALL_DEPS_ENV] === undefined) return true;
    return isEnvEnabled(QA_INSTALL_DEPS_ENV);
  }

  private async hasFileWithExtension(workspaceRoot: string, ext: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
      return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(ext));
    } catch {
      return false;
    }
  }

  private async resolveInstallCommands(workspaceRoot: string): Promise<string[]> {
    const commands: string[] = [];
    const pkgPath = path.join(workspaceRoot, 'package.json');
    if (await this.fileExists(pkgPath)) {
      const pm = (await this.detectPackageManager(workspaceRoot)) ?? 'npm';
      if (pm === 'pnpm') commands.push('pnpm install');
      else if (pm === 'yarn') commands.push('yarn install');
      else commands.push('npm install');
    }

    if (await this.fileExists(path.join(workspaceRoot, 'requirements.txt'))) {
      commands.push('python -m pip install -r requirements.txt');
    } else if (
      (await this.fileExists(path.join(workspaceRoot, 'pyproject.toml'))) ||
      (await this.fileExists(path.join(workspaceRoot, 'setup.py')))
    ) {
      commands.push('python -m pip install .');
    }

    if (
      (await this.hasFileWithExtension(workspaceRoot, '.sln')) ||
      (await this.hasFileWithExtension(workspaceRoot, '.csproj'))
    ) {
      commands.push('dotnet restore');
    }

    if (await this.fileExists(path.join(workspaceRoot, 'pom.xml'))) {
      commands.push('mvn -q -DskipTests dependency:resolve');
    } else if (
      (await this.fileExists(path.join(workspaceRoot, 'build.gradle'))) ||
      (await this.fileExists(path.join(workspaceRoot, 'build.gradle.kts')))
    ) {
      const gradlew = path.join(workspaceRoot, 'gradlew');
      if (await this.fileExists(gradlew)) {
        commands.push('./gradlew --no-daemon dependencies');
      } else {
        commands.push('gradle --no-daemon dependencies');
      }
    }

    if (await this.fileExists(path.join(workspaceRoot, 'go.mod'))) {
      commands.push('go mod download');
    }

    if (await this.fileExists(path.join(workspaceRoot, 'composer.json'))) {
      commands.push('composer install');
    }

    if (await this.fileExists(path.join(workspaceRoot, 'Gemfile'))) {
      commands.push('bundle install');
    }

    if (await this.fileExists(path.join(workspaceRoot, 'pubspec.yaml'))) {
      commands.push('flutter pub get');
    }

    if (await this.fileExists(path.join(workspaceRoot, 'Podfile'))) {
      commands.push('pod install');
    }

    return Array.from(new Set(commands));
  }

  private async runShellCommand(params: {
    command: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
    return await new Promise((resolve) => {
      const child = spawn(params.command, {
        cwd: params.cwd,
        env: params.env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.once('close', (code) => {
        const exitCode = typeof code === 'number' ? code : 0;
        resolve({ ok: exitCode === 0, exitCode, stdout, stderr });
      });
    });
  }

  private async commitInstallChanges(workspaceRoot: string, message: string): Promise<string | null> {
    const status = await this.vcs.status(workspaceRoot);
    if (!status.trim()) return null;
    await execFileAsync('git', ['add', '-A'], { cwd: workspaceRoot });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'mcoda-qa',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'qa@mcoda.local',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'mcoda-qa',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'qa@mcoda.local',
    };
    await execFileAsync('git', ['commit', '-m', message, '--no-verify'], { cwd: workspaceRoot, env });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot });
    const trimmed =
      typeof stdout === 'string' ? stdout.trim() : Buffer.from(stdout).toString('utf8').trim();
    return trimmed || null;
  }

  private isBranchInUseError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /already used by worktree/i.test(message);
  }

  private buildQaInstallBranch(taskKey: string, taskRunId: string, baseBranch: string): string {
    const suffix = createHash('sha1').update(`${taskKey}:${taskRunId}`).digest('hex').slice(0, 8);
    const safeKey = taskKey.replace(/[^a-zA-Z0-9._-]+/g, '-');
    return `mcoda/qa/${safeKey}-${baseBranch}-${suffix}`;
  }

  private async prepareQaWorkspace(params: {
    workspaceRoot: string;
    taskRunId: string;
    baseBranch: string;
    taskBranch: string;
    taskKey: string;
  }): Promise<{ ok: boolean; message?: string }> {
    if (!this.shouldInstallQaDeps()) {
      await this.logTask(params.taskRunId, 'QA dependency install disabled; skipping.', 'qa-install');
      return { ok: true };
    }
    await this.vcs.ensureBaseBranch(params.workspaceRoot, params.baseBranch);
    const current = await this.vcs.currentBranch(params.workspaceRoot);
    let installBranch = params.baseBranch;
    if (current !== params.baseBranch) {
      try {
        await this.vcs.checkoutBranch(params.workspaceRoot, params.baseBranch);
      } catch (error) {
        if (this.isBranchInUseError(error)) {
          installBranch = this.buildQaInstallBranch(params.taskKey, params.taskRunId, params.baseBranch);
          await this.logTask(
            params.taskRunId,
            `Base branch ${params.baseBranch} already used by another worktree; using ${installBranch} for QA install.`,
            'qa-install',
          );
          await this.vcs.createOrCheckoutBranch(params.workspaceRoot, installBranch, params.baseBranch);
        } else {
          throw error;
        }
      }
    }
    const commands = await this.resolveInstallCommands(params.workspaceRoot);
    for (const command of commands) {
      await this.logTask(params.taskRunId, `Installing deps: ${command}`, 'qa-install');
      const result = await this.runShellCommand({ command, cwd: params.workspaceRoot });
      if (!result.ok) {
        const message = `QA dependency install failed (${command}) with exit ${result.exitCode}.`;
        await this.logTask(params.taskRunId, message, 'qa-install', {
          stdout: result.stdout.slice(0, 2000),
          stderr: result.stderr.slice(0, 2000),
        });
        return { ok: false, message };
      }
    }
    const installCommit = await this.commitInstallChanges(
      params.workspaceRoot,
      'chore: qa install dependencies',
    );
    if (installCommit) {
      await this.logTask(params.taskRunId, 'Committed QA dependency install changes.', 'qa-install');
    }
    if (params.taskBranch && params.taskBranch !== installBranch) {
      try {
        await this.vcs.checkoutBranch(params.workspaceRoot, params.taskBranch);
      } catch (error) {
        if (this.isBranchInUseError(error)) {
          await this.logTask(
            params.taskRunId,
            `Task branch ${params.taskBranch} already used by another worktree; continuing on ${installBranch}.`,
            'qa-install',
          );
        } else {
          throw error;
        }
      }
      if (installCommit) {
        try {
          await this.vcs.cherryPick(params.workspaceRoot, installCommit);
        } catch (error) {
          await this.logTask(
            params.taskRunId,
            `Warning: failed to cherry-pick QA install commit onto ${params.taskBranch}.`,
            'qa-install',
            { error: error instanceof Error ? error.message : String(error) },
          );
        }
      }
    }
    return { ok: true };
  }

  private async isUrlReachable(url: string, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(url, { method: 'GET', signal: controller.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForUrlReady(url: string, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.isUrlReachable(url, Math.min(2000, timeoutMs));
      if (ok) return true;
      await delay(500);
    }
    return false;
  }

  private async startQaServer(params: {
    workspaceRoot: string;
    baseUrl: string;
    env: NodeJS.ProcessEnv;
    jobId: string;
    taskKey: string;
  }): Promise<QaServerHandle | undefined> {
    const command = await this.resolveDevServerCommand(params.workspaceRoot);
    if (!command) return undefined;
    const serverDir = path.join(this.workspace.mcodaDir, 'jobs', params.jobId, 'qa', params.taskKey, 'server');
    await PathHelper.ensureDir(serverDir);
    const logPath = path.join(serverDir, 'server.log');
    const stream = fsSync.createWriteStream(logPath, { flags: 'a' });
    const env: NodeJS.ProcessEnv = { ...params.env };
    try {
      const url = new URL(params.baseUrl);
      if (!env.HOST) env.HOST = url.hostname;
      if (!env.PORT && url.port) env.PORT = url.port;
    } catch {
      // ignore invalid base URLs
    }
    const child = spawn(command.command, {
      cwd: params.workspaceRoot,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(stream);
    child.stderr?.pipe(stream);
    child.on('error', (error) => {
      stream.write(`\n[qa-server] spawn error: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    const stop = async () => {
      if (child.exitCode !== null) {
        stream.end();
        return;
      }
      child.kill('SIGTERM');
      try {
        await Promise.race([once(child, 'exit'), delay(5000)]);
      } catch {
        // ignore
      }
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      stream.end();
    };
    return { baseUrl: params.baseUrl, command: command.command, logPath, process: child, stop };
  }

  private async checkQaPreflight(
    testCommand?: string,
    workspaceRoot = this.workspace.workspaceRoot,
  ): Promise<{
    ok: boolean;
    missingDeps: string[];
    missingEnv: string[];
    message?: string;
  }> {
    const pkg = await this.readPackageJson(workspaceRoot);
    const declared = new Set([
      ...Object.keys(pkg?.dependencies ?? {}),
      ...Object.keys(pkg?.devDependencies ?? {}),
    ]);
    if (declared.size === 0 && !testCommand) {
      return { ok: true, missingDeps: [], missingEnv: [] };
    }
    const usesJest = testCommand?.toLowerCase().includes('jest') ?? false;
    const depsToCheck = QA_REQUIRED_DEPS.filter((dep) => {
      if (dep === '@jest/globals') {
        return usesJest || declared.has('@jest/globals') || declared.has('jest');
      }
      return declared.has(dep);
    });
    if (depsToCheck.length === 0 && !usesJest) {
      return { ok: true, missingDeps: [], missingEnv: [] };
    }
    const requireFromWorkspace = createRequire(path.join(workspaceRoot, 'package.json'));
    const missingDeps = depsToCheck.filter((dep) => {
      try {
        requireFromWorkspace.resolve(dep);
        return false;
      } catch {
        return true;
      }
    });
    const missingEnv: string[] = [];
    for (const requirement of QA_REQUIRED_ENV) {
      if (!declared.has(requirement.dep) && !missingDeps.includes(requirement.dep)) continue;
      const value = process.env[requirement.env];
      if (!value) missingEnv.push(requirement.env);
    }
    const messages: string[] = [];
    if (missingDeps.length) {
      messages.push(
        `Missing QA dependencies: ${missingDeps.join(', ')}. Install them with your package manager (e.g., pnpm add -D ${missingDeps.join(
          ' ',
        )}).`,
      );
    }
    if (missingEnv.length) {
      messages.push(`Missing QA environment variables: ${missingEnv.join(', ')}. Set them (e.g., in .env.test).`);
    }
    return {
      ok: messages.length === 0,
      missingDeps,
      missingEnv,
      message: messages.join(' '),
    };
  }

  private isHttpUrl(value?: string): boolean {
    if (!value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private async loadAvailableProfiles(): Promise<QaProfile[]> {
    const loader = (this.profileService as any)?.loadProfiles;
    if (typeof loader !== 'function') return [];
    try {
      const profiles = await loader.call(this.profileService);
      return Array.isArray(profiles) ? (profiles.filter(Boolean) as QaProfile[]) : [];
    } catch {
      return [];
    }
  }

  private pickDefaultProfile(profiles: QaProfile[]): QaProfile | undefined {
    if (!profiles.length) return undefined;
    const explicitDefault = profiles.find((profile) => profile.default);
    if (explicitDefault) return explicitDefault;
    const cliProfile = profiles.find((profile) => profile.name === 'cli' || (profile.runner ?? 'cli') === 'cli');
    if (cliProfile) return cliProfile;
    return profiles[0];
  }

  private async planProfilesWithAgent(
    tasks: TaskSelectionPlan['ordered'],
    request: QaTasksRequest,
    ctx: { jobId?: string; commandRunId?: string; warnings?: string[] },
  ): Promise<Map<string, QaProfile[]>> {
    const plan = new Map<string, QaProfile[]>();
    if (request.profileName) return plan;
    if (!this.agentService) return plan;
    const profiles = await this.loadAvailableProfiles();
    if (!profiles.length) return plan;
    const defaultProfile = this.pickDefaultProfile(profiles);
    const profileByName = new Map(profiles.map((profile) => [profile.name, profile]));
    const runnerPlans = new Map<
      string,
      { hasWebInterface: boolean; uiTask: boolean; mobileTask: boolean }
    >();
    const resolveProfileForRunner = (runner: string): QaProfile | undefined => {
      const normalized = runner ?? 'cli';
      const matches = profiles.filter(
        (profile) => (profile.runner ?? 'cli') === normalized || profile.name === normalized,
      );
      if (!matches.length) return undefined;
      const defaults = matches.filter((profile) => profile.default);
      if (defaults.length === 1) return defaults[0];
      return matches[0];
    };
    const taskKeys = new Set(tasks.map((task) => task.task.key));
    const agent = await this.resolveAgent(request.agentName);
    const prompts = await this.loadPrompts(agent.id);
    const projectGuidance = await loadProjectGuidance(this.workspace.workspaceRoot, this.workspace.mcodaDir);
    const guidanceBlock = projectGuidance?.content ? `Project Guidance (read first):\n${projectGuidance.content}` : undefined;
    const systemPrompt = [guidanceBlock, prompts.jobPrompt, prompts.characterPrompt]
      .filter(Boolean)
      .join('\n\n');
    const availableProfiles = profiles
      .map((profile) => `- ${profile.name} (runner=${profile.runner ?? 'cli'})`)
      .join('\n');
    const taskLines: string[] = [];
    for (const task of tasks) {
      const desc = (task.task.description ?? '').replace(/\s+/g, ' ').trim();
      const shortDesc = desc ? ` — ${desc.slice(0, 240)}` : '';
      const metadata = (task.task.metadata as any) ?? {};
      const files: string[] = Array.isArray(metadata.files) ? metadata.files : [];
      const reviewFiles: string[] = Array.isArray(metadata.last_review_changed_paths)
        ? metadata.last_review_changed_paths
        : [];
      const combined = [...files, ...reviewFiles].map((file) => String(file)).filter(Boolean);
      const changedSummary =
        combined.length > 0 ? ` | changed: ${combined.slice(0, 8).join(', ')}` : '';
      const apiTask = detectApiTask(task.task);
      let runnerHint = ` | api_task=${apiTask ? 'yes' : 'no'}`;
      if (this.profileService && typeof (this.profileService as any).getRunnerPlan === 'function') {
        const runnerPlan = await (this.profileService as any).getRunnerPlan(task.task);
        runnerPlans.set(task.task.key, runnerPlan);
        runnerHint = ` | ui_repo=${runnerPlan.hasWebInterface ? 'yes' : 'no'} ui_task=${runnerPlan.uiTask ? 'yes' : 'no'} mobile_task=${runnerPlan.mobileTask ? 'yes' : 'no'} api_task=${apiTask ? 'yes' : 'no'}`;
      }
      taskLines.push(`- ${task.task.key}: ${task.task.title ?? '(untitled)'}${shortDesc}${changedSummary}${runnerHint}`);
    }
    const tasksBlock = taskLines.join('\n');
    const prompt = [
      systemPrompt,
      QA_ROUTING_PROMPT,
      `Available QA profiles:\n${availableProfiles}`,
      `Tasks:\n${tasksBlock}`,
      QA_ROUTING_OUTPUT_SCHEMA,
    ]
      .filter(Boolean)
      .join('\n\n');
    const res = await this.agentService.invoke(agent.id, {
      input: prompt,
      metadata: { command: 'qa-tasks', action: 'qa-profile-plan' },
    });
    const output = res.output ?? '';
    const tokensPrompt = this.estimateTokens(prompt);
    const tokensCompletion = this.estimateTokens(output);
    if (!this.dryRunGuard) {
      await this.jobService.recordTokenUsage({
        workspaceId: this.workspace.workspaceId,
        agentId: agent.id,
        modelName: agent.defaultModel,
        jobId: ctx.jobId ?? 'qa-profile-plan',
        commandRunId: ctx.commandRunId ?? 'qa-profile-plan',
        tokensPrompt,
        tokensCompletion,
        tokensTotal: tokensPrompt + tokensCompletion,
        timestamp: new Date().toISOString(),
        metadata: {
          commandName: 'qa-tasks',
          action: 'qa-profile-plan',
          phase: 'qa-plan',
          taskCount: tasks.length,
        },
      });
    }
    const parsed = this.extractJsonCandidate(output);
    const normalizedPlan = normalizeQaPlanOutput(parsed);
    if (normalizedPlan.warnings.length) {
      ctx.warnings?.push(...normalizedPlan.warnings);
    }
    const taskProfiles = normalizedPlan.taskProfiles;
    const taskPlans = normalizedPlan.taskPlans;
    if (!Object.keys(taskProfiles).length && !Object.keys(taskPlans).length) {
      ctx.warnings?.push('QA routing agent output invalid; defaulting to CLI profiles.');
    }
    this.qaTaskPlans = new Map(Object.entries(taskPlans));
    for (const task of tasks) {
      const planEntry = taskPlans[task.task.key];
      const selection = taskProfiles[task.task.key] ?? planEntry?.profiles ?? [];
      const rawList = Array.isArray(selection) ? selection : typeof selection === 'string' ? [selection] : [];
      const resolved = rawList
        .map((name) => (typeof name === 'string' ? profileByName.get(name) : undefined))
        .filter(Boolean) as QaProfile[];
      let selected = resolved.length ? [...resolved] : [];
      if (!selected.length && defaultProfile) {
        selected = [defaultProfile];
      }

      const runnerPlan = runnerPlans.get(task.task.key);
      const allowChromium = Boolean(runnerPlan?.uiTask && runnerPlan?.hasWebInterface);
      const allowMaestro = Boolean(runnerPlan?.mobileTask);
      const planBrowserActions = (planEntry?.browser?.actions ?? []).filter(Boolean);
      const planWantsChromium =
        rawList.some((name) => String(name).toLowerCase() === 'chromium') ||
        (planEntry?.profiles ?? []).some((name) => String(name).toLowerCase() === 'chromium') ||
        planBrowserActions.length > 0;
      if (planWantsChromium && allowChromium) {
        const chromiumProfile = resolveProfileForRunner('chromium');
        if (chromiumProfile && !selected.some((entry) => entry.name === chromiumProfile.name)) {
          selected.push(chromiumProfile);
        }
      }

      const cliProfile = resolveProfileForRunner('cli');
      if (cliProfile && !selected.some((entry) => entry.name === cliProfile.name)) {
        selected.push(cliProfile);
      }

      if (runnerPlan) {
        if (allowChromium) {
          const chromiumProfile = resolveProfileForRunner('chromium');
          if (chromiumProfile && !selected.some((entry) => entry.name === chromiumProfile.name)) {
            selected.push(chromiumProfile);
          }
        }
        if (allowMaestro) {
          const maestroProfile = resolveProfileForRunner('maestro');
          if (maestroProfile && !selected.some((entry) => entry.name === maestroProfile.name)) {
            selected.push(maestroProfile);
          }
        }
        if (!allowChromium) {
          selected = selected.filter((entry) => (entry.runner ?? 'cli') !== 'chromium' && entry.name !== 'chromium');
        }
        if (!allowMaestro) {
          selected = selected.filter((entry) => (entry.runner ?? 'cli') !== 'maestro' && entry.name !== 'maestro');
        }
      }
      if (selected.length) {
        plan.set(task.task.key, selected);
      }
    }
    const summary = Object.fromEntries(
      Array.from(plan.entries()).map(([key, entries]) => [key, entries.map((profile) => profile.name)]),
    );
    if (ctx.jobId) {
      await this.checkpoint(ctx.jobId, 'qa-profile-plan', { profiles: summary, notes: normalizedPlan.notes });
    }
    const unusedProfileKeys = Object.keys(taskProfiles).filter((key) => !taskKeys.has(key));
    const unusedPlanKeys = Object.keys(taskPlans).filter((key) => !taskKeys.has(key));
    const unusedKeys = Array.from(new Set([...unusedProfileKeys, ...unusedPlanKeys]));
    if (unusedKeys.length) {
      ctx.warnings?.push(`QA routing agent returned unknown task keys: ${unusedKeys.join(', ')}`);
    }
    return plan;
  }

  private async resolveProfilesForRequest(
    task: TaskRow & { metadata?: any },
    request: QaTasksRequest,
  ): Promise<QaProfile[]> {
    const profileName = request.profileName;
    if (profileName) {
      const profile = await this.profileService.resolveProfileForTask(task, {
        profileName,
        level: request.level,
      });
      return profile ? [profile] : [];
    }
    const planned = this.qaProfilePlan?.get(task.key) ?? [];
    const profiles: QaProfile[] = [...planned];
    const seen = new Set(profiles.map((profile) => profile.name));
    const shouldUseRunnerProfiles = profiles.length === 0;
    if (
      shouldUseRunnerProfiles &&
      this.profileService &&
      typeof (this.profileService as any).resolveProfilesForTask === 'function'
    ) {
      try {
        const runnerProfiles = await (this.profileService as any).resolveProfilesForTask(task, {
          level: request.level,
        });
        if (Array.isArray(runnerProfiles)) {
          for (const profile of runnerProfiles) {
            if (!profile || seen.has(profile.name)) continue;
            profiles.push(profile);
            seen.add(profile.name);
          }
        }
      } catch {
        // ignore runner plan resolution failures and fall back to planned/default
      }
    }
    if (profiles.length) return profiles;
    const available = await this.loadAvailableProfiles();
    const fallback = this.pickDefaultProfile(available);
    return fallback ? [fallback] : [];
  }

  private isApprovedReviewDecision(decision?: string): boolean {
    if (!decision) return false;
    const normalized = decision.toLowerCase();
    return normalized === 'approve' || normalized === 'info_only';
  }

  private async shouldSkipQaForNoChanges(
    task: TaskRow,
  ): Promise<{ skip: boolean; decision?: string; reviewId?: string }> {
    const metadata = (task.metadata as Record<string, unknown> | null | undefined) ?? {};
    const diffEmptyValue = metadata.last_review_diff_empty;
    const diffEmpty =
      diffEmptyValue === true ||
      diffEmptyValue === 'true' ||
      diffEmptyValue === 1 ||
      diffEmptyValue === '1';
    const decision =
      typeof metadata.last_review_decision === 'string' ? metadata.last_review_decision : undefined;
    if (diffEmpty && this.isApprovedReviewDecision(decision)) {
      return {
        skip: true,
        decision,
        reviewId: typeof metadata.last_review_id === 'string' ? metadata.last_review_id : undefined,
      };
    }
    const latestReview = await this.deps.workspaceRepo.getLatestTaskReview(task.id);
    if (latestReview?.metadata?.diffEmpty === true && this.isApprovedReviewDecision(latestReview.decision)) {
      return { skip: true, decision: latestReview.decision, reviewId: latestReview.id };
    }
    return { skip: false };
  }

  private extractJsonCandidate(raw: string): any | undefined {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) return undefined;
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }

  private normalizeAgentOutput(parsed: any): AgentInterpretation | undefined {
    if (!parsed || typeof parsed !== 'object') return undefined;
    const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value.trim() : undefined);
    const asNumber = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const asLine = (value: unknown): number | undefined => normalizeLineNumber(value);
    const asFile = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      return trimmed ? normalizePath(trimmed) : undefined;
    };
    const asStringArray = (value: unknown): string[] | undefined =>
      Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean) : undefined;
    const recommendation = parsed.recommendation as AgentInterpretation['recommendation'];
    if (!recommendation || !['pass', 'fix_required', 'infra_issue', 'unclear'].includes(recommendation)) return undefined;
    const testedScope = asString(parsed.tested_scope ?? parsed.scope);
    const coverageSummary = asString(parsed.coverage_summary ?? parsed.coverage);
    const rawFollowUps = Array.isArray(parsed.follow_up_tasks)
      ? parsed.follow_up_tasks
      : Array.isArray(parsed.follow_ups)
        ? parsed.follow_ups
        : undefined;
    const followUps: AgentFollowUp[] | undefined = rawFollowUps
      ? rawFollowUps.map((item: any) => ({
          title: asString(item?.title),
          description: asString(item?.description),
          type: asString(item?.type),
          priority: asNumber(item?.priority),
          story_points: asNumber(item?.story_points ?? item?.storyPoints),
          tags: asStringArray(item?.tags),
          related_task_key: asString(item?.related_task_key ?? item?.relatedTaskKey),
          epic_key: asString(item?.epic_key ?? item?.epicKey),
          story_key: asString(item?.story_key ?? item?.storyKey),
          components: asStringArray(item?.components),
          doc_links: asStringArray(item?.doc_links ?? item?.docLinks),
          evidence_url: asString(item?.evidence_url ?? item?.evidenceUrl),
          artifacts: asStringArray(item?.artifacts),
        }))
      : undefined;
    const failures: AgentFailure[] | undefined = Array.isArray(parsed.failures)
      ? parsed.failures.map((f: any) => ({
          kind: asString(f?.kind),
          message: asString(f?.message) ?? String(f),
          evidence: asString(f?.evidence),
          file: asFile(f?.file ?? f?.path ?? f?.file_path ?? f?.filePath),
          line: asLine(f?.line ?? f?.line_number ?? f?.lineNumber),
        }))
      : undefined;
    const resolvedSlugs = normalizeSlugList(parsed.resolved_slugs ?? parsed.resolvedSlugs);
    const unresolvedSlugs = normalizeSlugList(parsed.unresolved_slugs ?? parsed.unresolvedSlugs);
    return {
      recommendation,
      testedScope,
      coverageSummary,
      failures,
      followUps,
      resolvedSlugs,
      unresolvedSlugs,
    };
  }

  private validateInterpretation(
    result: AgentInterpretation,
    options: { requireCommentSlugs?: boolean } = {},
  ): string | undefined {
    if (typeof result.testedScope !== "string" || !result.testedScope.trim()) {
      return "tested_scope must be a non-empty string.";
    }
    if (typeof result.coverageSummary !== "string" || !result.coverageSummary.trim()) {
      return "coverage_summary must be a non-empty string.";
    }
    if (options.requireCommentSlugs && result.resolvedSlugs === undefined && result.unresolvedSlugs === undefined) {
      return "resolvedSlugs/unresolvedSlugs required when comment backlog exists.";
    }
    if (!result.failures || result.failures.length === 0) return undefined;
    for (const failure of result.failures) {
      const file = failure.file?.trim();
      const line = normalizeLineNumber(failure.line);
      if (!file || !line) {
        return "Each QA failure must include file and line.";
      }
      failure.file = normalizePath(file);
      failure.line = line;
    }
    return undefined;
  }

  private async interpretResult(
    task: TaskSelectionPlan['ordered'][number],
    profile: QaProfile,
    result: QaRunResult,
    agentName: string | undefined,
    stream: boolean,
    jobId: string,
    commandRunId: string,
    taskRunId?: string,
    commentBacklog?: string,
    abortSignal?: AbortSignal,
  ): Promise<AgentInterpretation> {
    if (!this.agentService) {
      return { recommendation: this.mapOutcome(result) };
    }
    const resolveAbortReason = () => {
      const reason = abortSignal?.reason;
      if (typeof reason === "string" && reason.trim().length > 0) return reason;
      if (reason instanceof Error && reason.message) return reason.message;
      return "qa_tasks_aborted";
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
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error(resolveAbortReason()));
        abortSignal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => {
          abortSignal.removeEventListener("abort", onAbort);
        });
      });
    };
    try {
      abortIfSignaled();
      const agent = await this.resolveAgent(agentName);
      const prompts = await this.loadPrompts(agent.id);
      const projectGuidance = await loadProjectGuidance(this.workspace.workspaceRoot, this.workspace.mcodaDir);
      if (projectGuidance && taskRunId) {
        await this.logTask(taskRunId, `Loaded project guidance from ${projectGuidance.source}`, 'project_guidance');
      }
      const guidanceBlock = projectGuidance?.content ? `Project Guidance (read first):\n${projectGuidance.content}` : undefined;
      const systemPrompt = [guidanceBlock, prompts.jobPrompt, prompts.characterPrompt, prompts.commandPrompt, QA_TEST_POLICY]
        .filter(Boolean)
        .join('\n\n');
      const docLinks = Array.isArray((task.task.metadata as any)?.doc_links) ? (task.task.metadata as any).doc_links : [];
      const docCtx = await this.gatherDocContext(task.task, taskRunId, docLinks);
      const acceptance = (task.task.acceptanceCriteria ?? []).map((line) => `- ${line}`).join('\n');
      const prompt = [
        systemPrompt,
        'You are the mcoda QA agent. Interpret the QA execution results and return structured JSON.',
        `Task: ${task.task.key} ${task.task.title}`,
        `Task type: ${task.task.type ?? 'n/a'}, status: ${task.task.status}`,
        task.task.description ? `Task description:\n${task.task.description}` : '',
        `Epic/Story: ${task.task.epicKey ?? task.task.epicId} / ${task.task.storyKey ?? task.task.userStoryId}`,
        acceptance ? `Task DoD / acceptance criteria:\n${acceptance}` : 'Task DoD / acceptance criteria: (not provided)',
        commentBacklog ? `Comment backlog (unresolved slugs):\n${commentBacklog}` : 'Comment backlog: none',
        `QA profile: ${profile.name} (${profile.runner ?? 'cli'})`,
        `Test command / runner outcome: exit=${result.exitCode} outcome=${result.outcome}`,
        result.stdout ? `Stdout (truncated):\n${result.stdout.slice(0, 3000)}` : '',
        result.stderr ? `Stderr (truncated):\n${result.stderr.slice(0, 3000)}` : '',
        result.artifacts?.length ? `Artifacts:\n${result.artifacts.join('\n')}` : '',
        docCtx ? `Relevant docs (SDS/RFP/OpenAPI):\n${docCtx}` : '',
        [
          'Return strict JSON with keys:',
          '{',
          '  "tested_scope": string (single sentence),',
          '  "coverage_summary": string (single paragraph),',
          '  "failures": [{ "kind": "functional|contract|perf|security|infra", "message": string, "file": string, "line": number, "evidence": string }],',
          '  "recommendation": "pass|fix_required|infra_issue|unclear",',
          '  "follow_up_tasks": [{ "title": string, "description": string, "type": "bug|qa_followup|chore", "priority": number, "story_points": number, "tags": string[], "related_task_key": string, "epic_key": string, "story_key": string, "doc_links": string[], "evidence_url": string, "artifacts": string[] }],',
          '  "resolvedSlugs": ["Optional list of comment slugs that are confirmed fixed"],',
          '  "unresolvedSlugs": ["Optional list of comment slugs still open or reintroduced"]',
          '}',
          'Do not include prose outside the JSON. No markdown fences or comments. Include resolvedSlugs/unresolvedSlugs when reviewing comment backlog.',
        ].join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n');
      const separator = "============================================================";
      console.info(separator);
      console.info("[qa-tasks] START OF TASK");
      console.info(`[qa-tasks] Task key: ${task.task.key}`);
      console.info(`[qa-tasks] Title: ${task.task.title ?? '(none)'}`);
      console.info(`[qa-tasks] Description: ${task.task.description ?? '(none)'}`);
      console.info(
        `[qa-tasks] Story points: ${typeof task.task.storyPoints === 'number' ? task.task.storyPoints : '(none)'}`,
      );
      console.info(
        `[qa-tasks] Dependencies: ${
          task.dependencies.keys.length ? task.dependencies.keys.join(', ') : '(none available)'
        }`,
      );
      if (acceptance) console.info(`[qa-tasks] Acceptance criteria:\n${acceptance}`);
      console.info(`[qa-tasks] System prompt used:\n${systemPrompt || '(none)'}`);
      console.info(`[qa-tasks] Task prompt used:\n${prompt}`);
      console.info(separator);
      let output = '';
      let chunkCount = 0;
      if (stream && this.agentService.invokeStream) {
        const gen = await withAbort(
          this.agentService.invokeStream(agent.id, { input: prompt, metadata: { command: 'qa-tasks' } }),
        );
        while (true) {
          abortIfSignaled();
          const { value, done } = await withAbort(gen.next());
          if (done) break;
          const chunk = value;
          output += chunk.output ?? '';
          chunkCount += 1;
        }
      } else {
        const res = await withAbort(
          this.agentService.invoke(agent.id, { input: prompt, metadata: { command: 'qa-tasks' } }),
        );
        output = res.output ?? '';
      }
      const tokensPrompt = this.estimateTokens(prompt);
      const tokensCompletion = this.estimateTokens(output);
      if (!this.dryRunGuard) {
        await this.jobService.recordTokenUsage({
          workspaceId: this.workspace.workspaceId,
          agentId: agent.id,
          modelName: agent.defaultModel,
          jobId,
          taskId: task.task.id,
          commandRunId,
          taskRunId,
          tokensPrompt,
          tokensCompletion,
          tokensTotal: tokensPrompt + tokensCompletion,
          timestamp: new Date().toISOString(),
          metadata: {
            commandName: 'qa-tasks',
            action: 'qa-interpret-results',
            phase: 'qa-interpret',
            attempt: 1,
            taskKey: task.task.key,
            streaming: stream,
            streamChunks: chunkCount || undefined,
          },
        });
      }
      const parsed = this.extractJsonCandidate(output);
      let normalized = this.normalizeAgentOutput(parsed);
      const requireCommentSlugs = Boolean(commentBacklog && commentBacklog.trim());
      let validationError = normalized ? this.validateInterpretation(normalized, { requireCommentSlugs }) : undefined;
      if (normalized && validationError) {
        if (taskRunId) {
          await this.logTask(taskRunId, `QA agent output missing required fields (${validationError}); retrying once.`, 'qa-agent');
        }
        normalized = undefined;
      }
      if (normalized) {
        return {
          ...normalized,
          rawOutput: output,
          tokensPrompt,
          tokensCompletion,
          agentId: agent.id,
          modelName: agent.defaultModel,
        };
      }
      const retryPrompt = `${prompt}\n\nReturn STRICT JSON only. Do not include prose, markdown fences, or comments.`;
      let retryOutput = "";
      if (stream && this.agentService.invokeStream) {
        const gen = await withAbort(
          this.agentService.invokeStream(agent.id, { input: retryPrompt, metadata: { command: 'qa-tasks' } }),
        );
        while (true) {
          abortIfSignaled();
          const { value, done } = await withAbort(gen.next());
          if (done) break;
          const chunk = value;
          retryOutput += chunk.output ?? '';
        }
      } else {
        const res = await withAbort(
          this.agentService.invoke(agent.id, { input: retryPrompt, metadata: { command: 'qa-tasks' } }),
        );
        retryOutput = res.output ?? '';
      }
      const retryTokensPrompt = this.estimateTokens(retryPrompt);
      const retryTokensCompletion = this.estimateTokens(retryOutput);
      if (!this.dryRunGuard) {
        await this.jobService.recordTokenUsage({
          workspaceId: this.workspace.workspaceId,
          agentId: agent.id,
          modelName: agent.defaultModel,
          jobId,
          taskId: task.task.id,
          commandRunId,
          taskRunId,
          tokensPrompt: retryTokensPrompt,
          tokensCompletion: retryTokensCompletion,
          tokensTotal: retryTokensPrompt + retryTokensCompletion,
          timestamp: new Date().toISOString(),
          metadata: {
            commandName: 'qa-tasks',
            action: 'qa-interpret-retry',
            phase: 'qa-interpret-retry',
            attempt: 2,
            taskKey: task.task.key,
          },
        });
      }
      const retryParsed = this.extractJsonCandidate(retryOutput);
      let retryNormalized = this.normalizeAgentOutput(retryParsed);
      validationError = retryNormalized ? this.validateInterpretation(retryNormalized, { requireCommentSlugs }) : undefined;
      if (retryNormalized && validationError) {
        retryNormalized = undefined;
      }
      if (retryNormalized) {
        return {
          ...retryNormalized,
          rawOutput: retryOutput,
          tokensPrompt: tokensPrompt + retryTokensPrompt,
          tokensCompletion: tokensCompletion + retryTokensCompletion,
          agentId: agent.id,
          modelName: agent.defaultModel,
        };
      }
      if (taskRunId) {
        const message = validationError
          ? `QA agent output missing required fields (${validationError}); falling back to QA outcome.`
          : "QA agent returned invalid JSON after retry; falling back to QA outcome.";
        await this.logTask(taskRunId, message, "qa-agent");
      }
      return {
        recommendation: 'unclear',
        rawOutput: retryOutput || output,
        tokensPrompt: tokensPrompt + retryTokensPrompt,
        tokensCompletion: tokensCompletion + retryTokensCompletion,
        agentId: agent.id,
        modelName: agent.defaultModel,
        invalidJson: true,
      };
    } catch (error: any) {
      const message = error?.message ?? String(error);
      if (taskRunId) {
        await this.logTask(taskRunId, `QA agent failed: ${message}`, 'qa-agent');
      }
      if (isAuthErrorMessage(message)) {
        throw error;
      }
      return { recommendation: this.mapOutcome(result) };
    }
  }

  private async loadCommentContext(taskId: string): Promise<{ comments: TaskCommentRow[]; unresolved: TaskCommentRow[] }> {
    const comments = await this.deps.workspaceRepo.listTaskComments(taskId, {
      sourceCommands: ['code-review', 'qa-tasks'],
      limit: 50,
    });
    const unresolved = comments.filter((comment) => !comment.resolvedAt);
    return { comments, unresolved };
  }

  private resolveFailureSlug(failure: AgentFailure): string {
    const message = (failure.message ?? '').trim() || 'QA issue';
    return createTaskCommentSlug({
      source: 'qa-tasks',
      message,
      category: failure.kind ?? 'qa_issue',
      file: failure.file,
      line: failure.line,
    });
  }

  private async applyCommentResolutions(params: {
    task: TaskRow;
    taskRunId: string;
    jobId: string;
    agentId?: string;
    failures: AgentFailure[];
    resolvedSlugs?: string[] | null;
    unresolvedSlugs?: string[] | null;
    existingComments: TaskCommentRow[];
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

    const resolvedSlugs = normalizeSlugList(params.resolvedSlugs ?? undefined);
    const resolvedSet = new Set(resolvedSlugs);
    const unresolvedSet = new Set(normalizeSlugList(params.unresolvedSlugs ?? undefined));

    const failureSlugs: string[] = [];
    for (const failure of params.failures ?? []) {
      const slug = this.resolveFailureSlug(failure);
      failureSlugs.push(slug);
      if (!resolvedSet.has(slug)) {
        unresolvedSet.add(slug);
      }
    }
    for (const slug of resolvedSet) {
      unresolvedSet.delete(slug);
    }

    const toResolve = resolvedSlugs.filter((slug) => openBySlug.has(slug));
    const toReopen = Array.from(unresolvedSet).filter((slug) => resolvedBySlug.has(slug));

    if (!this.dryRunGuard) {
      for (const slug of toResolve) {
        await this.deps.workspaceRepo.resolveTaskComment({
          taskId: params.task.id,
          slug,
          resolvedAt: new Date().toISOString(),
          resolvedBy: params.agentId ?? null,
        });
      }
      for (const slug of toReopen) {
        await this.deps.workspaceRepo.reopenTaskComment({ taskId: params.task.id, slug });
      }
    }

    const createdSlugs = new Set<string>();
    for (const failure of params.failures ?? []) {
      const slug = this.resolveFailureSlug(failure);
      if (existingBySlug.has(slug) || createdSlugs.has(slug)) continue;
      const baseMessage = (failure.message ?? '').trim() || '(no details provided)';
      const message = failure.evidence ? `${baseMessage}\nEvidence: ${failure.evidence}` : baseMessage;
      const body = formatTaskCommentBody({
        slug,
        source: 'qa-tasks',
        message,
        status: 'open',
        category: failure.kind ?? 'qa_issue',
        file: failure.file ?? null,
        line: failure.line ?? null,
      });
      if (!this.dryRunGuard) {
        await this.deps.workspaceRepo.createTaskComment({
          taskId: params.task.id,
          taskRunId: params.taskRunId,
          jobId: params.jobId,
          sourceCommand: 'qa-tasks',
          authorType: 'agent',
          authorAgentId: params.agentId ?? null,
          category: failure.kind ?? 'qa_issue',
          slug,
          status: 'open',
          file: failure.file ?? null,
          line: failure.line ?? null,
          pathHint: failure.file ?? null,
          body,
          createdAt: new Date().toISOString(),
          metadata: {
            kind: failure.kind,
            evidence: failure.evidence,
          },
        });
      }
      createdSlugs.add(slug);
    }

    const openSet = new Set(openBySlug);
    for (const slug of unresolvedSet) {
      openSet.add(slug);
    }
    for (const slug of resolvedSet) {
      openSet.delete(slug);
    }

    if ((resolvedSlugs.length || toReopen.length || unresolvedSet.size) && !this.dryRunGuard) {
      const resolutionMessage = [
        `Resolved slugs: ${formatSlugList(toResolve)}`,
        `Reopened slugs: ${formatSlugList(toReopen)}`,
        `Open slugs: ${formatSlugList(Array.from(openSet))}`,
      ].join('\n');
      const resolutionSlug = createTaskCommentSlug({
        source: 'qa-tasks',
        message: resolutionMessage,
        category: 'comment_resolution',
      });
      const resolutionBody = formatTaskCommentBody({
        slug: resolutionSlug,
        source: 'qa-tasks',
        message: resolutionMessage,
        status: 'resolved',
        category: 'comment_resolution',
      });
      const createdAt = new Date().toISOString();
      await this.deps.workspaceRepo.createTaskComment({
        taskId: params.task.id,
        taskRunId: params.taskRunId,
        jobId: params.jobId,
        sourceCommand: 'qa-tasks',
        authorType: 'agent',
        authorAgentId: params.agentId ?? null,
        category: 'comment_resolution',
        slug: resolutionSlug,
        status: 'resolved',
        body: resolutionBody,
        createdAt,
        resolvedAt: createdAt,
        resolvedBy: params.agentId ?? null,
        metadata: {
          resolvedSlugs: toResolve,
          reopenedSlugs: toReopen,
          openSlugs: Array.from(openSet),
        },
      });
    }

    return { resolved: toResolve, reopened: toReopen, open: Array.from(openSet) };
  }

  private async createTaskRun(
    task: TaskRow & { storyPoints?: number | null },
    jobId: string,
    commandRunId: string,
  ): Promise<TaskRunRow> {
    const startedAt = new Date().toISOString();
    return this.deps.workspaceRepo.createTaskRun({
      taskId: task.id,
      command: 'qa-tasks',
      jobId,
      commandRunId,
      status: 'running',
      startedAt,
      storyPointsAtRun: task.storyPoints ?? null,
      gitBranch: task.vcsBranch ?? null,
      gitBaseBranch: task.vcsBaseBranch ?? null,
      gitCommitSha: task.vcsLastCommitSha ?? null,
    });
  }

  private async finishTaskRun(taskRun: TaskRunRow, status: TaskRunStatus, extra?: Partial<TaskRunRow>): Promise<void> {
    await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
      status,
      finishedAt: new Date().toISOString(),
      gitBranch: extra?.gitBranch ?? taskRun.gitBranch,
      gitBaseBranch: extra?.gitBaseBranch ?? taskRun.gitBaseBranch,
      gitCommitSha: extra?.gitCommitSha ?? taskRun.gitCommitSha,
      spPerHourEffective: extra?.spPerHourEffective ?? null,
    });
  }

  private async logTask(taskRunId: string, message: string, source?: string, details?: Record<string, unknown>): Promise<void> {
    await this.deps.workspaceRepo.insertTaskLog({
      taskRunId,
      sequence: Math.floor(Math.random() * 1000000),
      timestamp: new Date().toISOString(),
      source: source ?? 'qa-tasks',
      message,
      details: details ?? undefined,
    });
  }

  private async createQaComment(params: {
    task: TaskRow;
    taskRunId?: string;
    jobId: string;
    message: string;
    category: 'qa_issue' | 'qa_result';
    status?: 'open' | 'resolved';
    metadata?: Record<string, unknown>;
    authorType?: 'agent' | 'human';
    authorAgentId?: string | null;
  }): Promise<void> {
    const status = params.status ?? (params.category === 'qa_result' ? 'resolved' : 'open');
    const slug = createTaskCommentSlug({ source: 'qa-tasks', message: params.message, category: params.category });
    const body = formatTaskCommentBody({
      slug,
      source: 'qa-tasks',
      message: params.message,
      status,
      category: params.category,
    });
    const createdAt = new Date().toISOString();
    await this.deps.workspaceRepo.createTaskComment({
      taskId: params.task.id,
      taskRunId: params.taskRunId,
      jobId: params.jobId,
      sourceCommand: 'qa-tasks',
      authorType: params.authorType ?? 'agent',
      authorAgentId: params.authorAgentId ?? null,
      category: params.category,
      slug,
      status,
      body,
      createdAt,
      resolvedAt: status === 'resolved' ? createdAt : null,
      resolvedBy: status === 'resolved' ? params.authorAgentId ?? null : null,
      metadata: params.metadata ?? undefined,
    });
  }

  private async applyStateTransition(
    task: TaskRow,
    outcome: 'pass' | 'fix_required' | 'infra_issue' | 'unclear',
    context?: TaskStatusEventContext,
    metadataPatch?: Record<string, unknown>,
  ): Promise<void> {
    const baseMetadata: Record<string, unknown> = {
      last_qa: new Date().toISOString(),
      last_qa_outcome: outcome,
    };
    if (outcome !== 'pass') {
      baseMetadata.qa_failure_reason = `qa_${outcome}`;
    }
    const mergedMetadata = metadataPatch ? { ...baseMetadata, ...metadataPatch } : baseMetadata;
    if (outcome === 'pass') {
      await this.stateService.markCompleted(task, mergedMetadata, context);
    } else {
      await this.stateService.markNotStarted(task, mergedMetadata, context);
    }
  }

  private buildFollowupSuggestion(task: TaskRow, result: QaRunResult, notes?: string): FollowupSuggestion {
    const summary = notes || result.stderr || result.stdout || 'QA failure detected';
    const components = Array.isArray((task.metadata as any)?.components) ? (task.metadata as any).components : [];
    const docLinks = Array.isArray((task.metadata as any)?.doc_links) ? (task.metadata as any).doc_links : [];
    const tests = Array.isArray((task.metadata as any)?.tests) ? (task.metadata as any).tests : [];
    return {
      title: `QA follow-up for ${task.key}`,
      description: `Follow-up created from QA run on ${task.key}.\n\nDetails:\n${summary}`.slice(0, 2000),
      type: 'bug',
      storyPoints: 1,
      priority: 90,
      tags: ['qa', 'qa-followup', ...components],
      components,
      docLinks,
      testName: tests[0],
    };
  }

  private buildManualQaFollowup(task: TaskRow, rawOutput?: string): FollowupSuggestion {
    const summary = rawOutput ? rawOutput.slice(0, 1000) : 'QA agent returned invalid JSON after retry.';
    const components = Array.isArray((task.metadata as any)?.components) ? (task.metadata as any).components : [];
    const docLinks = Array.isArray((task.metadata as any)?.doc_links) ? (task.metadata as any).doc_links : [];
    const tests = Array.isArray((task.metadata as any)?.tests) ? (task.metadata as any).tests : [];
    return {
      title: `Manual QA follow-up for ${task.key}`,
      description: `QA agent returned invalid JSON after retry. Manual QA required.\n\nRaw output:\n${summary}`.slice(0, 2000),
      type: 'qa_followup',
      storyPoints: 1,
      priority: 90,
      tags: ['qa', 'manual', ...components],
      components,
      docLinks,
      testName: tests[0],
    };
  }

  private buildFollowupSlug(task: TaskRow, suggestion: FollowupSuggestion): string {
    const seedParts = [
      task.key,
      suggestion.title ?? '',
      suggestion.description ?? '',
      suggestion.type ?? '',
      suggestion.testName ?? '',
      suggestion.evidenceUrl ?? '',
      ...(suggestion.tags ?? []),
      ...(suggestion.components ?? []),
    ];
    const seed = seedParts.join('|').toLowerCase();
    const digest = createHash('sha1').update(seed).digest('hex').slice(0, 12);
    return `qa-followup-${task.key}-${digest}`;
  }

  private toFollowupSuggestion(
    task: TaskRow & { storyKey?: string; epicKey?: string },
    agentFollow: AgentFollowUp,
    artifacts: string[],
  ): FollowupSuggestion {
    const taskComponents = Array.isArray((task.metadata as any)?.components) ? (task.metadata as any).components : [];
    const taskDocLinks = Array.isArray((task.metadata as any)?.doc_links) ? (task.metadata as any).doc_links : [];
    return {
      title: agentFollow.title ?? `QA follow-up for ${task.key}`,
      description: agentFollow.description,
      type: agentFollow.type ?? 'bug',
      priority: agentFollow.priority ?? 90,
      storyPoints: agentFollow.story_points ?? 1,
      tags: agentFollow.tags,
      relatedTaskKey: agentFollow.related_task_key,
      epicKeyHint: agentFollow.epic_key,
      storyKeyHint: agentFollow.story_key,
      components: agentFollow.components ?? taskComponents,
      docLinks: agentFollow.doc_links ?? taskDocLinks,
      evidenceUrl: agentFollow.evidence_url,
      artifacts: agentFollow.artifacts ?? artifacts,
    };
  }

  private async suggestFollowupsFromAgent(
    task: TaskSelectionPlan['ordered'][number],
    notes: string | undefined,
    evidenceUrl: string | undefined,
    mode: 'auto' | 'manual',
    jobId: string,
    commandRunId: string,
    taskRunId?: string,
    agentStream = true,
  ): Promise<FollowupSuggestion[]> {
    if (!this.agentService) return [];
    const agent = await this.resolveAgent(undefined);
    const prompts = await this.loadPrompts(agent.id);
    const projectGuidance = await loadProjectGuidance(this.workspace.workspaceRoot, this.workspace.mcodaDir);
    if (projectGuidance && taskRunId) {
      await this.logTask(taskRunId, `Loaded project guidance from ${projectGuidance.source}`, 'project_guidance');
    }
    const guidanceBlock = projectGuidance?.content ? `Project Guidance (read first):\n${projectGuidance.content}` : undefined;
    const systemPrompt = [guidanceBlock, prompts.jobPrompt, prompts.characterPrompt, prompts.commandPrompt].filter(Boolean).join('\n\n');
    const docLinks = Array.isArray((task.task.metadata as any)?.doc_links) ? (task.task.metadata as any).doc_links : [];
    const docCtx = await this.gatherDocContext(task.task, taskRunId, docLinks);
    const prompt = [
      systemPrompt,
      'You are the mcoda QA agent. Given QA notes/evidence, propose structured follow-up tasks as JSON.',
      `Task: ${task.task.key} ${task.task.title}`,
      task.task.description ? `Task description:\n${task.task.description}` : '',
      notes ? `QA notes:\n${notes}` : '',
      evidenceUrl ? `Evidence URL: ${evidenceUrl}` : '',
      docCtx ? `Relevant docs:\n${docCtx}` : '',
      [
        'Return JSON: { "follow_up_tasks": [ { "title": "...", "description": "...", "type": "bug|qa_followup|chore", "priority": number, "story_points": number, "tags": [], "related_task_key": string, "epic_key": string, "story_key": string, "doc_links": [], "evidence_url": string } ] }',
        'No prose outside JSON.',
      ].join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n');
    let output = '';
    let chunkCount = 0;
    const useStream = agentStream && Boolean(this.agentService?.invokeStream);
    try {
      if (useStream && this.agentService.invokeStream) {
        const gen = await this.agentService.invokeStream(agent.id, { input: prompt, metadata: { command: 'qa-tasks' } });
        for await (const chunk of gen) {
          output += chunk.output ?? '';
          chunkCount += 1;
        }
      } else {
        const res = await this.agentService.invoke(agent.id, { input: prompt, metadata: { command: 'qa-tasks' } });
        output = res.output ?? '';
      }
    } catch (error: any) {
      const message = error?.message ?? String(error);
      if (isAuthErrorMessage(message)) {
        throw error;
      }
      return [];
    }
    const tokensPrompt = this.estimateTokens(prompt);
    const tokensCompletion = this.estimateTokens(output);
    if (!this.dryRunGuard) {
      await this.jobService.recordTokenUsage({
        workspaceId: this.workspace.workspaceId,
        agentId: agent.id,
        modelName: agent.defaultModel,
        jobId,
        taskId: task.task.id,
        commandRunId,
        taskRunId,
        tokensPrompt,
        tokensCompletion,
        tokensTotal: tokensPrompt + tokensCompletion,
        timestamp: new Date().toISOString(),
        metadata: {
          commandName: 'qa-tasks',
          action: 'qa-manual-followups',
          taskKey: task.task.key,
          streaming: useStream || undefined,
          streamChunks: chunkCount || undefined,
        },
      });
    }
    const parsed = this.extractJsonCandidate(output);
    const followUps: AgentFollowUp[] = Array.isArray(parsed?.follow_up_tasks)
      ? parsed.follow_up_tasks
      : Array.isArray(parsed?.followUps)
        ? parsed.followUps
        : [];
    return followUps.map((f) => this.toFollowupSuggestion(task.task, f, []));
  }

  private async runAuto(
    task: TaskSelectionPlan['ordered'][number],
    ctx: {
      jobId: string;
      commandRunId: string;
      request: QaTasksRequest;
      warnings?: string[];
    },
  ): Promise<QaTaskResult> {
    const taskRun = await this.createTaskRun(task.task, ctx.jobId, ctx.commandRunId);
    const statusContextBase = {
      commandName: 'qa-tasks',
      jobId: ctx.jobId,
      taskRunId: taskRun.id,
      metadata: { lane: 'qa' },
    };
    await this.logTask(taskRun.id, 'Starting QA', 'qa-start');
    const allowedStatuses = new Set(ctx.request.statusFilter ?? ['ready_to_qa']);
    if (task.task.status && !allowedStatuses.has(task.task.status)) {
      const message = `Task status ${task.task.status} not allowed for QA`;
      await this.logTask(taskRun.id, message, 'status-gate');
      await this.finishTaskRun(taskRun, 'failed');
      if (!this.dryRunGuard) {
        await this.deps.workspaceRepo.createTaskQaRun({
          taskId: task.task.id,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          commandRunId: ctx.commandRunId,
          source: 'auto',
          mode: 'auto',
          rawOutcome: 'infra_issue',
          recommendation: 'infra_issue',
          profileName: undefined,
          runner: undefined,
          metadata: { reason: 'status_gating' },
        });
        await this.createQaComment({
          task: task.task,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          message,
          category: 'qa_issue',
          status: 'open',
          metadata: {
            reason: 'status_gating',
            taskStatus: task.task.status,
            allowedStatuses: Array.from(allowedStatuses),
          },
        });
      }
      return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'status_gating' };
    }

    const skipReview = await this.shouldSkipQaForNoChanges(task.task);
    if (skipReview.skip) {
      const message = 'QA skipped: code review reported no code changes to validate.';
      await this.logTask(taskRun.id, message, 'qa-skip', { reason: 'review_no_changes', decision: skipReview.decision });
      if (!this.dryRunGuard) {
        await this.applyStateTransition(task.task, 'pass', statusContextBase);
        await this.finishTaskRun(taskRun, 'succeeded');
        await this.deps.workspaceRepo.createTaskQaRun({
          taskId: task.task.id,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          commandRunId: ctx.commandRunId,
          source: 'auto',
          mode: 'auto',
          rawOutcome: 'pass',
          recommendation: 'pass',
          profileName: undefined,
          runner: undefined,
          metadata: { reason: 'review_no_changes', decision: skipReview.decision, reviewId: skipReview.reviewId },
        });
        const slug = createTaskCommentSlug({ source: 'qa-tasks', message, category: 'qa_result' });
        const body = formatTaskCommentBody({
          slug,
          source: 'qa-tasks',
          message,
          status: 'resolved',
          category: 'qa_result',
        });
        await this.deps.workspaceRepo.createTaskComment({
          taskId: task.task.id,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          sourceCommand: 'qa-tasks',
          authorType: 'agent',
          category: 'qa_result',
          slug,
          status: 'resolved',
          body,
          createdAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
        });
      }
      return { taskKey: task.task.key, outcome: 'pass', notes: 'review_no_changes' };
    }

    const branchCheck = await this.ensureTaskBranch(
      task,
      taskRun.id,
      ctx.jobId,
      ctx.request.allowDirty ?? false,
      ctx.request.cleanIgnorePaths,
    );
    if (!branchCheck.ok) {
      if (!this.dryRunGuard) {
        await this.applyStateTransition(task.task, 'infra_issue', statusContextBase);
        await this.finishTaskRun(taskRun, 'failed');
        await this.deps.workspaceRepo.createTaskQaRun({
          taskId: task.task.id,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          commandRunId: ctx.commandRunId,
          source: 'auto',
          mode: 'auto',
          rawOutcome: 'infra_issue',
          recommendation: 'infra_issue',
          metadata: { reason: 'vcs_branch_missing', detail: branchCheck.message },
        });
        const message = `VCS validation failed: ${branchCheck.message ?? 'unknown error'}`;
        const slug = createTaskCommentSlug({ source: 'qa-tasks', message, category: 'qa_issue' });
        const body = formatTaskCommentBody({
          slug,
          source: 'qa-tasks',
          message,
          status: 'open',
          category: 'qa_issue',
        });
        await this.deps.workspaceRepo.createTaskComment({
          taskId: task.task.id,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          sourceCommand: 'qa-tasks',
          authorType: 'agent',
          category: 'qa_issue',
          slug,
          status: 'open',
          body,
          createdAt: new Date().toISOString(),
        });
      }
      return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'vcs_branch_missing' };
    }
    const qaWorkspaceRoot = branchCheck.workspaceRoot ?? this.workspace.workspaceRoot;
    const cleanupWorktree = branchCheck.cleanup;
    let serverHandle: QaServerHandle | undefined;
    const baseBranch = this.workspace.config?.branch ?? 'mcoda-dev';
    const taskBranch = branchCheck.branch ?? baseBranch;
    let qaPrepared = false;
    const ensureQaPrepared = async (): Promise<{ ok: boolean; message?: string }> => {
      if (qaPrepared) return { ok: true };
      qaPrepared = true;
      return await this.prepareQaWorkspace({
        workspaceRoot: qaWorkspaceRoot,
        taskRunId: taskRun.id,
        baseBranch,
        taskBranch,
        taskKey: task.task.key,
      });
    };
    try {
      const prep = await ensureQaPrepared();
      if (!prep.ok) {
        const message = prep.message ?? 'QA dependency install failed.';
        await this.logTask(taskRun.id, message, 'qa-install');
        await this.finishTaskRun(taskRun, 'failed');
        if (!this.dryRunGuard) {
          await this.applyStateTransition(task.task, 'infra_issue', statusContextBase, {
            qa_failure_reason: 'qa_dependency_install_failed',
          });
          await this.deps.workspaceRepo.createTaskQaRun({
            taskId: task.task.id,
            taskRunId: taskRun.id,
            jobId: ctx.jobId,
            commandRunId: ctx.commandRunId,
            source: 'auto',
            mode: 'auto',
            rawOutcome: 'infra_issue',
            recommendation: 'infra_issue',
            metadata: { reason: 'qa_dependency_install_failed', message },
          });
          await this.createQaComment({
            task: task.task,
            taskRunId: taskRun.id,
            jobId: ctx.jobId,
            message,
            category: 'qa_issue',
            status: 'open',
            metadata: { reason: 'qa_dependency_install_failed' },
          });
        }
        return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'qa_dependency_install_failed' };
      }
      let profiles: QaProfile[] = [];
      try {
        profiles = await this.resolveProfilesForRequest(task.task, ctx.request);
      } catch (error: any) {
        await this.logTask(taskRun.id, `Profile resolution failed: ${error?.message ?? error}`, 'qa-profile');
        await this.finishTaskRun(taskRun, 'failed');
        if (!this.dryRunGuard) {
          await this.applyStateTransition(task.task, 'infra_issue', statusContextBase, {
            qa_failure_reason: 'qa_profile_resolution_failed',
          });
          await this.deps.workspaceRepo.createTaskQaRun({
            taskId: task.task.id,
            taskRunId: taskRun.id,
            jobId: ctx.jobId,
            commandRunId: ctx.commandRunId,
            source: 'auto',
            mode: 'auto',
            rawOutcome: 'infra_issue',
            recommendation: 'infra_issue',
            metadata: { reason: 'profile_resolution_failed', message: error?.message ?? String(error) },
          });
          await this.createQaComment({
            task: task.task,
            taskRunId: taskRun.id,
            jobId: ctx.jobId,
            message: `QA profile resolution failed: ${error?.message ?? String(error)}`,
            category: 'qa_issue',
            status: 'open',
            metadata: { reason: 'profile_resolution_failed' },
          });
        }
        return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'profile_resolution_failed' };
      }
    if (!profiles.length) {
      await this.logTask(taskRun.id, 'No QA profile available', 'qa-profile');
      await this.finishTaskRun(taskRun, 'failed');
      if (!this.dryRunGuard) {
        await this.applyStateTransition(task.task, 'infra_issue', statusContextBase, { qa_failure_reason: 'qa_no_profile' });
        await this.deps.workspaceRepo.createTaskQaRun({
          taskId: task.task.id,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          commandRunId: ctx.commandRunId,
          source: 'auto',
          mode: 'auto',
          rawOutcome: 'infra_issue',
          recommendation: 'infra_issue',
          metadata: { reason: 'no_profile' },
        });
        await this.createQaComment({
          task: task.task,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          message: 'QA profile selection returned no profiles. Add or configure QA profiles.',
          category: 'qa_issue',
          status: 'open',
          metadata: { reason: 'no_profile' },
        });
      }
      return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'no_profile' };
    }

    const taskPlan = this.qaTaskPlans?.get(task.task.key);
    const requestCommand = ctx.request.testCommand;
    const requestCommandIsUrl = this.isHttpUrl(requestCommand);
    const cliOverride = requestCommandIsUrl ? undefined : requestCommand;
    const browserOverride = requestCommandIsUrl ? normalizeQaUrl(requestCommand) : undefined;
    const qaEnv = applyQaHostDefaults(process.env);
    const apiRunner = new QaApiRunner(qaWorkspaceRoot);
    const explicitBaseUrl = normalizeQaUrl(
      qaEnv.MCODA_QA_API_BASE_URL ?? qaEnv.MCODA_API_BASE_URL ?? qaEnv.API_BASE_URL ?? qaEnv.BASE_URL,
    );
    if (explicitBaseUrl && !qaEnv.MCODA_QA_API_BASE_URL) {
      qaEnv.MCODA_QA_API_BASE_URL = explicitBaseUrl;
    }
    const hasOpenApiSpec = await apiRunner.hasOpenApiSpec();
    const browserActions = [...(taskPlan?.browser?.actions ?? [])];
    const browserStressEntries = taskPlan?.stress?.browser ?? [];
    const browserStressConfigured = browserStressEntries.length;
    if (browserStressConfigured) {
      for (const stress of browserStressEntries) {
        if (stress?.type !== 'repeat' || !stress.action) continue;
        const count = Math.max(1, Math.round(stress.count ?? 1));
        for (let index = 0; index < count; index += 1) {
          browserActions.push({ ...stress.action });
        }
      }
    }
    const wantsChromium =
      browserActions.length > 0 || profiles.some((profile) => (profile.runner ?? 'cli') === 'chromium');
    const wantsCli = profiles.some((profile) => (profile.runner ?? 'cli') === 'cli');
    const explicitProfileName = ctx.request.profileName?.toLowerCase();
    const explicitApi = explicitProfileName === 'api';
    const apiProbeEnabled = Boolean(taskPlan?.api || detectApiTask(task.task) || explicitApi);
    let apiProbeRequests: QaApiRequest[] | undefined;
    if (taskPlan?.api?.requests?.length) {
      apiProbeRequests = [...taskPlan.api.requests];
    } else if (apiProbeEnabled || hasOpenApiSpec) {
      apiProbeRequests = await apiRunner.suggestDefaultRequests();
    }
    let resolvedApiBaseUrl: string | undefined;
    const resolveApiBaseUrl = async (): Promise<string | undefined> => {
      if (resolvedApiBaseUrl !== undefined) return resolvedApiBaseUrl;
      if (explicitBaseUrl) {
        resolvedApiBaseUrl = explicitBaseUrl;
        return resolvedApiBaseUrl;
      }
      const inferred = await apiRunner.resolveBaseUrl({
        planBaseUrl: taskPlan?.api?.base_url,
        planBrowserBaseUrl: taskPlan?.browser?.base_url,
        env: qaEnv,
        probeRequests: apiProbeRequests,
      });
      const normalized = inferred ? normalizeQaUrl(inferred) : undefined;
      resolvedApiBaseUrl = normalized;
      return resolvedApiBaseUrl;
    };
    let allocatedBaseUrl: string | undefined;
    const allocateLocalBaseUrl = async (
      reason: 'browser' | 'api',
      options: { ignoreEnvPort?: boolean } = {},
    ): Promise<string> => {
      if (allocatedBaseUrl) return allocatedBaseUrl;
      const host = qaEnv.MCODA_QA_HOST ?? DEFAULT_QA_HOST;
      const envPort = options.ignoreEnvPort ? undefined : resolveEnvPort(qaEnv);
      const port = envPort ?? (await pickFreePort(host));
      applyQaPortDefaults(qaEnv, port);
      const baseUrl = `http://${host}:${port}`;
      qaEnv.MCODA_QA_API_BASE_URL = baseUrl;
      allocatedBaseUrl = baseUrl;
      await this.logTask(taskRun.id, `QA base URL set to ${baseUrl} (${reason}).`, 'qa-server', {
        baseUrl,
        reason,
      });
      return baseUrl;
    };
    let browserBaseUrl = normalizeQaUrl(
      browserOverride ?? taskPlan?.browser?.base_url ?? taskPlan?.api?.base_url,
    );
    if (wantsChromium && !browserBaseUrl) {
      browserBaseUrl = (await resolveApiBaseUrl()) ?? (await allocateLocalBaseUrl('browser'));
    }
    if (wantsCli) {
      const baseUrlCandidate = browserBaseUrl ?? (await resolveApiBaseUrl());
      if (baseUrlCandidate && isLocalBaseUrl(baseUrlCandidate)) {
        const parsed = resolveUrlPort(baseUrlCandidate);
        if (parsed) {
          const envPort = resolveEnvPort(qaEnv);
          let desiredPort = envPort ?? parsed.port;
          let adjusted = false;
          let adjustReason: 'in_use' | 'env' | undefined;
          if (envPort && envPort !== parsed.port) {
            adjusted = true;
            adjustReason = 'env';
          } else {
            const probeOk = apiProbeRequests?.length
              ? await apiRunner.probeBaseUrl(baseUrlCandidate, apiProbeRequests)
              : undefined;
            const open = await isPortOpen(parsed.url.hostname, parsed.port);
            if (open && (!apiProbeRequests?.length || !probeOk)) {
              desiredPort = await pickFreePort(parsed.url.hostname);
              adjusted = true;
              adjustReason = 'in_use';
            }
          }
          if (desiredPort !== parsed.port) {
            parsed.url.port = String(desiredPort);
            adjusted = true;
            adjustReason = adjustReason ?? 'env';
          }
          applyQaPortDefaults(qaEnv, desiredPort);
          if (adjusted) {
            const adjustedBaseUrl = parsed.url.toString().replace(/\/$/, '');
            if (browserBaseUrl) browserBaseUrl = adjustedBaseUrl;
            qaEnv.MCODA_QA_API_BASE_URL = adjustedBaseUrl;
            const reasonLabel = adjustReason === 'env' ? 'env override' : 'port in use';
            await this.logTask(taskRun.id, `QA port ${parsed.port} -> ${desiredPort} (${reasonLabel}).`, 'qa-server', {
              baseUrl: baseUrlCandidate,
              adjustedBaseUrl,
              reason: adjustReason ?? 'unknown',
            });
          }
        }
      }
    }
    const adjustBaseUrlForPortConflict = async (
      baseUrl: string | undefined,
      reason: 'browser' | 'api',
      probeRequests?: QaApiRequest[],
    ): Promise<string | undefined> => {
      if (!baseUrl) return baseUrl;
      if (explicitBaseUrl) return baseUrl;
      if (reason === 'browser' && !probeRequests?.length) return baseUrl;
      if (!isLocalBaseUrl(baseUrl)) return baseUrl;
      const parsed = resolveUrlPort(baseUrl);
      if (!parsed) return baseUrl;
      const open = await isPortOpen(parsed.url.hostname, parsed.port);
      if (!open) return baseUrl;
      if (probeRequests?.length) {
        const probeOk = await apiRunner.probeBaseUrl(baseUrl, probeRequests);
        if (probeOk) return baseUrl;
      }
      const adjustedBaseUrl = await allocateLocalBaseUrl(reason, { ignoreEnvPort: true });
      const reasonLabel = probeRequests?.length ? 'probe_mismatch' : 'port_in_use';
      await this.logTask(
        taskRun.id,
        `QA ${reason} base URL ${baseUrl} rejected (${reasonLabel}); using ${adjustedBaseUrl}.`,
        'qa-server',
        { baseUrl, adjustedBaseUrl, reason: reasonLabel },
      );
      return adjustedBaseUrl;
    };
    if (wantsChromium) {
      browserBaseUrl = await adjustBaseUrlForPortConflict(browserBaseUrl, 'browser', apiProbeRequests);
    }
    if (wantsChromium && browserActions.length === 0 && browserBaseUrl) {
      browserActions.push(
        { type: 'navigate', url: '/' },
        {
          type: 'script',
          expression:
            "document.body ? 'ok' : ''",
          expect: 'ok',
        },
        { type: 'snapshot', name: 'home' },
      );
    }
    if (wantsChromium && browserActions.length > 0 && !browserStressConfigured) {
      const stressSeed = browserActions[0];
      browserActions.push({ ...stressSeed }, { ...stressSeed });
    }
    const baseCtx: QaContext = {
      workspaceRoot: qaWorkspaceRoot,
      jobId: ctx.jobId,
      taskKey: task.task.key,
      env: qaEnv,
    };
    let serverBaseUrl: string | undefined;
    const serverTimeoutMs = resolveServerTimeoutMs();
      const ensureServerReady = async (
        baseUrl: string | undefined,
        reason: 'browser' | 'api',
        options: { allowFailure?: boolean } = {},
      ): Promise<{ ok: boolean; message?: string }> => {
      if (!baseUrl) return { ok: true };
      if (!isLocalBaseUrl(baseUrl)) return { ok: true };
      const reachable = await this.isUrlReachable(baseUrl, 1500);
      if (reachable) return { ok: true };
      if (!shouldAutoStartServer()) {
        const message = `QA ${reason} base URL ${baseUrl} is not reachable and auto-start is disabled.`;
        await this.logTask(taskRun.id, message, 'qa-server');
        return { ok: true, message };
      }
      if (serverHandle) {
        const message = `QA server already started for ${serverBaseUrl ?? 'unknown'}; ${baseUrl} is still unreachable.`;
        await this.logTask(taskRun.id, message, 'qa-server');
        return options.allowFailure ? { ok: true, message } : { ok: false, message };
      }
      const prep = await ensureQaPrepared();
      if (!prep.ok) {
        const message = prep.message ?? 'QA dependency install failed.';
        await this.logTask(taskRun.id, message, 'qa-install');
        return options.allowFailure ? { ok: true, message } : { ok: false, message };
      }
      const handle = await this.startQaServer({
        workspaceRoot: qaWorkspaceRoot,
        baseUrl,
        env: qaEnv,
        jobId: ctx.jobId,
        taskKey: task.task.key,
      });
      if (!handle) {
        const message = `QA ${reason} base URL ${baseUrl} is unreachable and no dev server script (dev/start/serve) was found.`;
        await this.logTask(taskRun.id, message, 'qa-server');
        return options.allowFailure ? { ok: true, message } : { ok: false, message };
      }
      serverHandle = handle;
      serverBaseUrl = baseUrl;
      await this.logTask(taskRun.id, `Starting QA server: ${handle.command}`, 'qa-server', {
        baseUrl,
        logPath: handle.logPath,
      });
      if (serverTimeoutMs <= 0) {
        const message = `QA server wait disabled; continuing without readiness check for ${baseUrl}.`;
        await this.logTask(taskRun.id, message, 'qa-server', { baseUrl, timeoutMs: serverTimeoutMs });
        console.info(`[qa-tasks] ${message}`);
        return { ok: true, message };
      }
      console.info(`[qa-tasks] waiting for QA server at ${baseUrl} (timeout ${serverTimeoutMs}ms).`);
      const ready = await this.waitForUrlReady(baseUrl, serverTimeoutMs);
      if (!ready) {
        const message = `QA server did not become ready at ${baseUrl} after ${serverTimeoutMs}ms.`;
        await this.logTask(taskRun.id, message, 'qa-server', { baseUrl, timeoutMs: serverTimeoutMs });
        return options.allowFailure ? { ok: true, message } : { ok: false, message };
      }
      return { ok: true };
    };
    const runs: Array<{
      profile: QaProfile;
      runner: string;
      command?: string;
      testCommand?: string;
      result: QaRunResult;
      markerStatus?: RunAllMarkerStatus;
    }> = [];
    const runSummaries: string[] = [];
    const artifactSet = new Set<string>();
    const buildInfraResult = (message: string): QaRunResult => {
      const now = new Date().toISOString();
      return {
        outcome: 'infra_issue',
        exitCode: null,
        stdout: '',
        stderr: message,
        artifacts: [],
        startedAt: now,
        finishedAt: now,
      };
    };

    for (const profile of profiles) {
      const runner = profile.runner ?? 'cli';
      await this.logTask(taskRun.id, `Running QA profile ${profile.name} (${runner})`, 'qa-profile');
      const adapter = this.adapterForProfile(profile);
      if (!adapter) {
        const message = `No QA adapter for profile ${profile.name} (${runner})`;
        await this.logTask(taskRun.id, message, 'qa-adapter');
        runs.push({ profile, runner, result: buildInfraResult(message) });
        runSummaries.push(`- ${profile.name} (${runner}) infra_issue (no_adapter)`);
        continue;
      }

      let testCommand: string | undefined = undefined;
      let cliCommands: string[] = [];
      if (runner === 'cli') {
        const planCommands = (taskPlan?.cli?.commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
        const commandBuilder = new QaTestCommandBuilder(qaWorkspaceRoot);
        const commandPlan = await commandBuilder.build({
          task: task.task,
          planCommands,
          cliOverride,
          profileCommand: profile.test_command,
        });
        const dedupedCommands = new Set<string>();
        cliCommands = commandPlan.commands.filter((cmd) => {
          const normalized = cmd.trim();
          if (!normalized) return false;
          if (dedupedCommands.has(normalized)) return false;
          dedupedCommands.add(normalized);
          return true;
        });
        if (!cliOverride) {
          const checklist = await this.resolveCliChecklistCommands({
            workspaceRoot: qaWorkspaceRoot,
            task: task.task,
            existing: cliCommands,
          });
          if (checklist.length) {
            cliCommands = [...cliCommands, ...checklist];
          }
        }
        cliCommands = this.softenOptionalNpmScripts(cliCommands);
        const chromiumPrep = await this.applyChromiumForCli(qaEnv, cliCommands);
        if (!chromiumPrep.ok) {
          const message = chromiumPrep.message ?? 'Chromium preflight failed.';
          await this.logTask(taskRun.id, message, 'qa-preflight');
          const failedCommand = cliCommands.length ? cliCommands.join(' && ') : undefined;
          runs.push({ profile, runner, testCommand: failedCommand, result: buildInfraResult(message) });
          runSummaries.push(`- ${profile.name} (${runner}) infra_issue (chromium_preflight)`);
          continue;
        }
        cliCommands = chromiumPrep.commands;
        testCommand = cliCommands.length ? cliCommands.join(' && ') : undefined;
        const preflight = await this.checkQaPreflight(testCommand, qaWorkspaceRoot);
        if (!preflight.ok) {
          const message = preflight.message ?? 'QA preflight failed.';
          await this.logTask(taskRun.id, message, 'qa-preflight', {
            missingDeps: preflight.missingDeps,
            missingEnv: preflight.missingEnv,
          });
          runs.push({ profile, runner, testCommand, result: buildInfraResult(message) });
          runSummaries.push(`- ${profile.name} (${runner}) infra_issue (preflight)`);
          continue;
        }
      }

      const runCtx: QaContext = {
        ...baseCtx,
        commands: runner === 'cli' && cliCommands.length > 1 ? cliCommands : undefined,
        testCommandOverride:
          runner === 'cli'
            ? cliCommands.length === 1
              ? cliCommands[0]
              : undefined
            : undefined,
        browserActions: runner === 'chromium' && browserActions.length ? browserActions : undefined,
        browserBaseUrl: runner === 'chromium' ? browserBaseUrl : undefined,
      };
      let ensure: { ok: boolean; message?: string };
      try {
        ensure = await adapter.ensureInstalled(profile, runCtx);
      } catch (error: any) {
        ensure = { ok: false, message: error?.message ?? String(error) };
      }
      if (!ensure.ok) {
        const installMessage = ensure.message ?? 'QA install failed';
        const guidance =
          profile.runner === 'chromium'
            ? 'Install Docdex Chromium (docdex setup or MCODA_QA_CHROMIUM_PATH).'
            : undefined;
        const installLower = installMessage.toLowerCase();
        const alreadyGuided =
          installLower.includes('chromium') ||
          installLower.includes('docdex') ||
          installLower.includes('test_command');
        const installMessageWithGuidance =
          guidance && !alreadyGuided ? `${installMessage} ${guidance}` : installMessage;
        await this.logTask(taskRun.id, installMessageWithGuidance, 'qa-install');
        runs.push({ profile, runner, testCommand, result: buildInfraResult(installMessageWithGuidance) });
        runSummaries.push(`- ${profile.name} (${runner}) infra_issue (install)`);
        continue;
      }
      if (runner === 'chromium') {
        const serverCheck = await ensureServerReady(browserBaseUrl, 'browser', { allowFailure: true });
        if (!serverCheck.ok) {
          const message = serverCheck.message ?? `QA server not ready for ${browserBaseUrl ?? 'browser QA'}.`;
          runs.push({ profile, runner, testCommand, result: buildInfraResult(message) });
          runSummaries.push(`- ${profile.name} (${runner}) infra_issue (server_unavailable)`);
          continue;
        }
      }

      const profileDir = profile.name.replace(/[\\/]/g, '_');
      const artifactDir = path.join(this.workspace.mcodaDir, 'jobs', ctx.jobId, 'qa', task.task.key, profileDir);
      await PathHelper.ensureDir(artifactDir);
      const runEnv: NodeJS.ProcessEnv = { ...runCtx.env };
      let result = await adapter.invoke(profile, { ...runCtx, env: runEnv, artifactDir });
      let markerStatus: RunAllMarkerStatus | undefined;
      if (runner === 'cli') {
        const adjusted = this.adjustOutcomeForSkippedTests(profile, result, testCommand);
        result = adjusted.result;
        markerStatus = adjusted.markerStatus;
        if (markerStatus) {
          const statusLabel = markerStatus.present ? 'present' : 'missing';
          await this.logTask(
            taskRun.id,
            `Run-all marker ${statusLabel} for ${profile.name} (policy=${markerStatus.policy}, action=${markerStatus.action}).`,
            'qa-marker',
            {
              policy: markerStatus.policy,
              status: statusLabel,
              action: markerStatus.action,
              marker: RUN_ALL_TESTS_MARKER,
              profile: profile.name,
            },
          );
        }
      }
      const command =
        runner === 'chromium'
          ? browserBaseUrl ?? profile.test_command
          : cliCommands.length > 1
            ? cliCommands.join(' && ')
            : cliCommands[0] ?? testCommand ?? profile.test_command;
      runs.push({
        profile,
        runner,
        testCommand,
        command,
        result,
        markerStatus,
      });
      for (const artifact of result.artifacts ?? []) {
        artifactSet.add(artifact);
      }
      runSummaries.push(
        `- ${profile.name} (${runner}) outcome=${result.outcome} exit=${result.exitCode ?? 'null'}${
          command ? ` cmd=${command}` : ''
        }`,
      );
    }

    let apiRequests = [...(taskPlan?.api?.requests ?? [])];
    if (taskPlan?.stress?.api?.length) {
      for (const stress of taskPlan.stress.api) {
        if (stress?.type !== 'burst' || !stress.request) continue;
        const count = Math.max(1, Math.round(stress.count ?? 1));
        for (let index = 0; index < count; index += 1) {
          apiRequests.push({
            ...stress.request,
            id: stress.request.id ? `${stress.request.id}-${index + 1}` : `stress-${index + 1}`,
          });
        }
      }
    }
    const allowApiRunner = !explicitProfileName || explicitApi;
    const apiPlanRequested = taskPlan?.api !== undefined;
    const apiTaskHint = detectApiTask(task.task);
    if (allowApiRunner) {
      const shouldRunApiFallback =
        apiRequests.length === 0 && (apiPlanRequested || apiTaskHint || explicitApi);
      if (shouldRunApiFallback) {
        if (hasOpenApiSpec || apiPlanRequested || apiTaskHint || explicitApi) {
          apiRequests = await apiRunner.suggestDefaultRequests();
        }
      }
    }
    if (allowApiRunner && apiRequests.length) {
      let baseUrl = await apiRunner.resolveBaseUrl({
        planBaseUrl: taskPlan?.api?.base_url,
        planBrowserBaseUrl: taskPlan?.browser?.base_url,
        env: baseCtx.env,
        probeRequests: apiRequests,
      });
      if (!baseUrl && shouldAutoStartServer()) {
        baseUrl = await allocateLocalBaseUrl('api');
      }
      if (baseUrl) {
        baseUrl = await adjustBaseUrlForPortConflict(baseUrl, 'api', apiRequests);
      }
      if (!baseUrl) {
        const message = shouldAutoStartServer()
          ? 'QA API base URL could not be resolved.'
          : 'QA API base URL is missing and auto-start is disabled.';
        const apiProfile: QaProfile = { name: 'api', runner: 'api' };
        runs.push({ profile: apiProfile, runner: 'api', command: 'unknown', result: buildInfraResult(message) });
        runSummaries.push(`- api (api) infra_issue (no_base_url)`);
        await this.logTask(taskRun.id, message, 'qa-server');
      } else {
        const apiProfile: QaProfile = { name: 'api', runner: 'api' };
        const serverCheck = await ensureServerReady(baseUrl, 'api');
        if (!serverCheck.ok) {
          const message = serverCheck.message ?? `QA server not ready for ${baseUrl}.`;
          const apiResult = buildInfraResult(message);
          runs.push({
            profile: apiProfile,
            runner: 'api',
            command: `${baseUrl} (${apiRequests.length} requests)`,
            result: apiResult,
          });
          runSummaries.push(`- api (api) infra_issue (server_unavailable) cmd=${baseUrl}`);
        } else {
          const apiArtifactDir = path.join(this.workspace.mcodaDir, 'jobs', ctx.jobId, 'qa', task.task.key, 'api');
          await PathHelper.ensureDir(apiArtifactDir);
          const apiResult = await apiRunner.run({
            baseUrl,
            requests: apiRequests,
            env: baseCtx.env,
            artifactDir: apiArtifactDir,
          });
          runs.push({
            profile: apiProfile,
            runner: 'api',
            command: `${baseUrl} (${apiRequests.length} requests)`,
            result: apiResult,
          });
          for (const artifact of apiResult.artifacts ?? []) {
            artifactSet.add(artifact);
          }
          runSummaries.push(
            `- api (api) outcome=${apiResult.outcome} exit=${apiResult.exitCode ?? 'null'} cmd=${baseUrl}`,
          );
        }
      }
    } else if (!allowApiRunner && (apiRequests.length || apiPlanRequested || apiTaskHint)) {
      await this.logTask(
        taskRun.id,
        `Skipping API checks because profile=${ctx.request.profileName} was explicitly requested.`,
        'qa-api',
        { profile: ctx.request.profileName },
      );
    }

    if (!runs.length) {
      await this.logTask(taskRun.id, 'No QA runs executed', 'qa-adapter');
      await this.finishTaskRun(taskRun, 'failed');
      if (!this.dryRunGuard) {
        await this.deps.workspaceRepo.createTaskQaRun({
          taskId: task.task.id,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          commandRunId: ctx.commandRunId,
          source: 'auto',
          mode: 'auto',
          rawOutcome: 'infra_issue',
          recommendation: 'infra_issue',
          metadata: { reason: 'no_runs' },
        });
      }
      return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'no_runs' };
    }

    const combinedOutcome = runs.some((run) => run.result.outcome === 'infra_issue')
      ? 'infra_issue'
      : runs.some((run) => run.result.outcome === 'fail')
        ? 'fail'
        : 'pass';
    const combinedExitCode =
      combinedOutcome === 'infra_issue'
        ? null
        : combinedOutcome === 'pass'
          ? 0
          : runs.find((run) => typeof run.result.exitCode === 'number' && run.result.exitCode !== 0)?.result.exitCode ?? 1;
    const combineOutput = (field: 'stdout' | 'stderr') =>
      runs
        .map((run) => {
          const header = `=== ${run.profile.name} (${run.runner}) outcome=${run.result.outcome} exit=${run.result.exitCode ?? 'null'}${
            run.command ? ` cmd=${run.command}` : ''
          } ===`;
          const body = field === 'stdout' ? run.result.stdout : run.result.stderr;
          return [header, body].filter(Boolean).join('\n');
        })
        .join('\n\n');
    const startedAt = runs.reduce(
      (min, run) => (run.result.startedAt < min ? run.result.startedAt : min),
      runs[0].result.startedAt,
    );
    const finishedAt = runs.reduce(
      (max, run) => (run.result.finishedAt > max ? run.result.finishedAt : max),
      runs[0].result.finishedAt,
    );
    const result: QaRunResult = {
      outcome: combinedOutcome,
      exitCode: combinedExitCode,
      stdout: combineOutput('stdout'),
      stderr: combineOutput('stderr'),
      artifacts: Array.from(artifactSet),
      startedAt,
      finishedAt,
    };
    const profile = runs.length === 1 ? runs[0].profile : { name: 'auto', runner: 'multi' };
    const runSummary = runSummaries.length ? runSummaries.join('\n') : undefined;
    await this.logTask(taskRun.id, `QA run completed with outcome ${result.outcome}`, 'qa-exec', {
      exitCode: result.exitCode,
      runs: runs.length,
    });
    const commentContext = await this.loadCommentContext(task.task.id);
    const commentBacklog = buildCommentBacklog(commentContext.unresolved);
    let interpretation: AgentInterpretation;
    try {
      if (this.shouldUseAgentInterpretation()) {
        interpretation = await this.interpretResult(
          task,
          profile,
          result,
          ctx.request.agentName,
          ctx.request.agentStream ?? true,
          ctx.jobId,
          ctx.commandRunId,
          taskRun.id,
          commentBacklog,
          ctx.request.abortSignal,
        );
      } else {
        interpretation = this.buildDeterministicInterpretation(task, profile, result);
        if (taskRun.id) {
          await this.logTask(taskRun.id, 'QA agent interpretation disabled; using runner outcome only.', 'qa-agent');
        }
      }
    } catch (error: any) {
      const message = error?.message ?? String(error);
      if (isAuthErrorMessage(message) && !this.dryRunGuard) {
        await this.stateService.markFailed(task.task, AUTH_ERROR_REASON, statusContextBase);
        await this.finishTaskRun(taskRun, 'failed');
      }
      throw error;
    }
    const invalidJson = interpretation.invalidJson === true;
    const outcome = invalidJson ? 'unclear' : this.combineOutcome(result, interpretation.recommendation);
    const artifacts = result.artifacts ?? [];
    const commentResolution = await this.applyCommentResolutions({
      task: task.task,
      taskRunId: taskRun.id,
      jobId: ctx.jobId,
      agentId: interpretation.agentId,
      failures: interpretation.failures ?? [],
      resolvedSlugs: interpretation.resolvedSlugs,
      unresolvedSlugs: interpretation.unresolvedSlugs,
      existingComments: commentContext.comments,
    });

    let qaRun: TaskQaRunRow | undefined;
    if (!this.dryRunGuard) {
      qaRun = await this.deps.workspaceRepo.createTaskQaRun({
        taskId: task.task.id,
        taskRunId: taskRun.id,
        jobId: ctx.jobId,
        commandRunId: ctx.commandRunId,
        agentId: interpretation.agentId,
        modelName: interpretation.modelName,
        source: 'auto',
        mode: 'auto',
        profileName: profile.name,
        runner: profile.runner,
        rawOutcome: result.outcome,
        recommendation: interpretation.recommendation,
        artifacts,
        rawResult: {
          adapter: result,
          adapterRuns: runs.map((run) => ({
            profile: run.profile.name,
            runner: run.runner,
            command: run.command,
            testCommand: run.testCommand,
            result: run.result,
          })),
          agent: interpretation.rawOutput,
        },
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        metadata: {
          tokensPrompt: interpretation.tokensPrompt,
          tokensCompletion: interpretation.tokensCompletion,
          testedScope: interpretation.testedScope,
          coverageSummary: interpretation.coverageSummary,
          failures: interpretation.failures,
          invalidJson: interpretation.invalidJson ?? false,
          runSummary,
          runProfiles: runs.map((run) => run.profile.name),
          runCount: runs.length,
        },
      });
    }

    if (!this.dryRunGuard) {
      const statusContext = {
        ...statusContextBase,
        agentId: interpretation.agentId ?? undefined,
      };
      await this.applyStateTransition(
        task.task,
        outcome,
        statusContext,
        invalidJson ? { qa_failure_reason: 'qa_invalid_output', qa_invalid_output: true } : undefined,
      );
      await this.finishTaskRun(taskRun, invalidJson ? 'failed' : outcome === 'pass' ? 'succeeded' : 'failed');
    }

    const existingSlugs = new Set(
      commentContext.comments.map((comment) => comment.slug).filter((slug): slug is string => Boolean(slug)),
    );
    const fallbackFailures =
      outcome !== 'pass' && (!interpretation.failures || interpretation.failures.length === 0);
    if (!this.dryRunGuard && fallbackFailures) {
      let created = 0;
      try {
        created = await this.createRunnerFailureComments({
          task: task.task,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          outcome,
          result,
          runs,
          workspaceRoot: qaWorkspaceRoot,
          runSummary,
          existingSlugs,
        });
      } catch {
        // fall through to summary comment
      }
      if (created === 0) {
        let message = `QA ${outcome} based on runner output. Review QA logs/artifacts for details.`;
        try {
          message = await this.buildRunnerFailureMessage({
            outcome,
            result,
            runs,
            runSummary,
            workspaceRoot: qaWorkspaceRoot,
          });
        } catch {
          // fallback to default message if summary build fails
        }
        await this.createQaComment({
          task: task.task,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          message,
          category: 'qa_issue',
          status: 'open',
          metadata: { reason: 'qa_runner_failure', outcome, runSummary },
        });
      }
    }

    const followups: string[] = [];
    const wantsFollowups = ctx.request.createFollowupTasks !== 'none';
    const needsManualFollowup = interpretation.invalidJson === true;
    if ((outcome === 'fix_required' || needsManualFollowup) && wantsFollowups) {
      const suggestions: FollowupSuggestion[] = interpretation.followUps?.map((f) => this.toFollowupSuggestion(task.task, f, artifacts)) ?? [];
      if (needsManualFollowup) {
        suggestions.unshift(this.buildManualQaFollowup(task.task, interpretation.rawOutput));
      } else if (suggestions.length === 0) {
        suggestions.push(this.buildFollowupSuggestion(task.task, result, ctx.request.notes));
      }
      const interactive = ctx.request.createFollowupTasks === 'prompt' && process.stdout.isTTY;
      for (const suggestion of suggestions) {
        const followupSlug = this.buildFollowupSlug(task.task, suggestion);
        const existing = await this.deps.workspaceRepo.listTasksByMetadataValue(
          task.task.projectId,
          'qa_followup_slug',
          followupSlug,
        );
        if (existing.length) {
          await this.logTask(
            taskRun.id,
            `Skipped follow-up ${followupSlug}; already exists: ${existing.map((item) => item.key).join(', ')}`,
            'qa-followup',
          );
          continue;
        }
        let proceed = ctx.request.createFollowupTasks !== 'prompt';
        if (interactive) {
          const rl = readline.createInterface({ input, output });
          const answer = await rl.question(`Create follow-up task "${suggestion.title}" for ${task.task.key}? [y/N]: `);
          rl.close();
          proceed = answer.trim().toLowerCase().startsWith('y');
        }
        if (!proceed) continue;
        try {
          if (!this.dryRunGuard) {
            const created = await this.followupService.createFollowupTask(
              { ...task.task, storyKey: task.task.storyKey, epicKey: task.task.epicKey },
              { ...suggestion, followupSlug },
            );
            followups.push(created.task.key);
            await this.logTask(taskRun.id, `Created follow-up ${created.task.key}`, 'qa-followup');
          }
        } catch (error: any) {
          await this.logTask(taskRun.id, `Failed to create follow-up task: ${error?.message ?? error}`, 'qa-followup');
        }
      }
    }

    const bodyLines = [
      `QA outcome: ${outcome}`,
      outcome === 'unclear'
        ? 'QA outcome unclear: provide missing acceptance criteria, reproduction steps, and expected behavior.'
        : '',
      profile ? `Profile: ${profile.name} (${profile.runner ?? 'cli'})` : '',
      runSummary ? `Runs:\n${runSummary}` : '',
      interpretation.coverageSummary ? `Coverage: ${interpretation.coverageSummary}` : '',
      interpretation.failures && interpretation.failures.length
        ? `Failures:\n${interpretation.failures.map((f) => `- [${f.kind ?? 'issue'}] ${f.message}${f.evidence ? ` (${f.evidence})` : ''}`).join('\n')}`
        : '',
      commentResolution
        ? `Comment slugs: resolved ${commentResolution.resolved.length}, reopened ${commentResolution.reopened.length}, open ${commentResolution.open.length}`
        : '',
      interpretation.invalidJson
        ? 'QA agent output invalid; task needs follow-up (qa_invalid_output).'
        : '',
      interpretation.invalidJson && interpretation.rawOutput
        ? `QA agent output (invalid JSON):\n${interpretation.rawOutput.slice(0, 4000)}`
        : '',
      result.stdout ? `Stdout:\n${result.stdout.slice(0, 4000)}` : '',
      result.stderr ? `Stderr:\n${result.stderr.slice(0, 4000)}` : '',
      artifacts.length ? `Artifacts:\n${artifacts.join('\n')}` : '',
      followups.length ? `Follow-ups: ${followups.join(', ')}` : '',
    ].filter(Boolean);
    if (!this.dryRunGuard) {
      const category = outcome === 'pass' ? 'qa_result' : 'qa_issue';
      const summaryMessage = bodyLines.join('\n\n');
      const summarySlug = createTaskCommentSlug({
        source: 'qa-tasks',
        message: summaryMessage,
        category,
      });
      const status = outcome === 'pass' ? 'resolved' : 'open';
      const summaryBody = formatTaskCommentBody({
        slug: summarySlug,
        source: 'qa-tasks',
        message: summaryMessage,
        status,
        category,
      });
      const createdAt = new Date().toISOString();
      await this.deps.workspaceRepo.createTaskComment({
        taskId: task.task.id,
        taskRunId: taskRun.id,
        jobId: ctx.jobId,
        sourceCommand: 'qa-tasks',
        authorType: 'agent',
        authorAgentId: interpretation.agentId ?? null,
        category,
        slug: summarySlug,
        status,
        body: summaryBody,
        createdAt,
        resolvedAt: status === 'resolved' ? createdAt : null,
        resolvedBy: status === 'resolved' ? interpretation.agentId ?? null : null,
        metadata: {
          ...(artifacts.length ? { artifacts } : {}),
          ...(qaRun?.id ? { qaRunId: qaRun.id } : {}),
        },
      });
    }

    const ratingTokens = (interpretation.tokensPrompt ?? 0) + (interpretation.tokensCompletion ?? 0);
    if (ctx.request.rateAgents && interpretation.agentId && ratingTokens > 0) {
      try {
        const ratingService = this.ensureRatingService();
        await ratingService.rate({
          workspace: this.workspace,
          agentId: interpretation.agentId,
          commandName: 'qa-tasks',
          jobId: ctx.jobId,
          commandRunId: ctx.commandRunId,
          taskId: task.task.id,
          taskKey: task.task.key,
          discipline: task.task.type ?? undefined,
          complexity: this.resolveTaskComplexity(task.task),
        });
      } catch (error) {
        const message = `Agent rating failed for ${task.task.key}: ${error instanceof Error ? error.message : String(error)}`;
        ctx.warnings?.push(message);
        try {
          await this.logTask(taskRun.id, message, 'rating');
        } catch {
          /* ignore rating log failures */
        }
      }
    }

    return {
      taskKey: task.task.key,
      outcome,
      profile: profile.name,
      runner: profile.runner,
      artifacts,
      followups,
    };
    } finally {
      if (serverHandle) {
        try {
          await serverHandle.stop();
          await this.logTask(taskRun.id, 'QA server stopped.', 'qa-server');
        } catch (error: any) {
          await this.logTask(taskRun.id, `QA server shutdown failed: ${error?.message ?? error}`, 'qa-server');
        }
      }
      if (cleanupWorktree) {
        try {
          await cleanupWorktree();
        } catch (error: any) {
          await this.logTask(taskRun.id, `QA cleanup failed: ${error?.message ?? error}`, 'qa-cleanup');
        }
      }
    }
  }

  private async runManual(
    task: TaskSelectionPlan['ordered'][number],
    ctx: {
      jobId: string;
      commandRunId: string;
      request: QaTasksRequest;
    },
  ): Promise<QaTaskResult> {
    const taskRun = await this.createTaskRun(task.task, ctx.jobId, ctx.commandRunId);
    const statusContext: TaskStatusEventContext = {
      commandName: 'qa-tasks',
      jobId: ctx.jobId,
      taskRunId: taskRun.id,
      metadata: { lane: 'qa' },
    };
    const result = ctx.request.result ?? 'pass';
    const notes = ctx.request.notes;
    const outcome: 'pass' | 'fix_required' | 'infra_issue' = result === 'pass' ? 'pass' : 'fix_required';
    const allowedStatuses = new Set(ctx.request.statusFilter ?? ['ready_to_qa']);
    if (task.task.status && !allowedStatuses.has(task.task.status)) {
      const message = `Task status ${task.task.status} not allowed for manual QA`;
      await this.logTask(taskRun.id, message, 'status-gate');
      await this.finishTaskRun(taskRun, 'failed');
      return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'status_gating' };
    }

    if (!ctx.request.dryRun) {
      await this.applyStateTransition(task.task, outcome, statusContext);
      await this.finishTaskRun(taskRun, outcome === 'pass' ? 'succeeded' : 'failed');
    }
    const followups: string[] = [];
    const artifacts: string[] = [];
    if (!ctx.request.dryRun) {
      await this.deps.workspaceRepo.createTaskQaRun({
        taskId: task.task.id,
        taskRunId: taskRun.id,
        jobId: ctx.jobId,
        commandRunId: ctx.commandRunId,
        source: 'manual',
        mode: 'manual',
        rawOutcome: result,
        recommendation: outcome,
        evidenceUrl: ctx.request.evidenceUrl,
        artifacts,
        rawResult: { notes },
        metadata: { notes, evidenceUrl: ctx.request.evidenceUrl },
      });
    }
    if (!ctx.request.dryRun && ctx.request.createFollowupTasks !== 'none' && outcome === 'fix_required') {
      const suggestions: FollowupSuggestion[] = [
        {
          title: `Manual QA follow-up for ${task.task.key}`,
          description: notes ?? 'Manual QA reported failure. Please investigate.',
          type: 'bug',
          storyPoints: 1,
          priority: 90,
          tags: ['qa', 'manual'],
          evidenceUrl: ctx.request.evidenceUrl,
        },
      ];
      const agentSuggestions = this.shouldUseAgentInterpretation()
        ? await this.suggestFollowupsFromAgent(
            task,
            notes,
            ctx.request.evidenceUrl,
            'manual',
            ctx.jobId,
            ctx.commandRunId,
            taskRun.id,
          )
        : [];
      if (agentSuggestions.length) {
        suggestions.unshift(...agentSuggestions);
      }
      const interactive = ctx.request.createFollowupTasks === 'prompt' && process.stdout.isTTY;
      for (const suggestion of suggestions) {
        const followupSlug = this.buildFollowupSlug(task.task, suggestion);
        const existing = await this.deps.workspaceRepo.listTasksByMetadataValue(
          task.task.projectId,
          'qa_followup_slug',
          followupSlug,
        );
        if (existing.length) {
          await this.logTask(
            taskRun.id,
            `Skipped follow-up ${followupSlug}; already exists: ${existing.map((item) => item.key).join(', ')}`,
            'qa-followup',
          );
          continue;
        }
        let proceed = ctx.request.createFollowupTasks === 'auto' || ctx.request.createFollowupTasks === undefined;
        if (interactive) {
          const rl = readline.createInterface({ input, output });
          const answer = await rl.question(`Create follow-up task "${suggestion.title}" for ${task.task.key}? [y/N]: `);
          rl.close();
          proceed = answer.trim().toLowerCase().startsWith('y');
        }
        if (!proceed) continue;
        try {
          const created = await this.followupService.createFollowupTask(
            { ...task.task, storyKey: task.task.storyKey, epicKey: task.task.epicKey },
            { ...suggestion, followupSlug },
          );
          followups.push(created.task.key);
        } catch (error: any) {
          await this.logTask(taskRun.id, `Follow-up creation failed: ${error?.message ?? error}`, 'qa-followup');
        }
      }
    }

    const body = [
      `Manual QA outcome: ${result}`,
      notes ? `Notes: ${notes}` : '',
      ctx.request.evidenceUrl ? `Evidence: ${ctx.request.evidenceUrl}` : '',
      artifacts.length ? `Artifacts:\n${artifacts.join('\n')}` : '',
      followups.length ? `Follow-ups: ${followups.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (!ctx.request.dryRun) {
      const category = result === 'pass' ? 'qa_result' : 'qa_issue';
      const status = result === 'pass' ? 'resolved' : 'open';
      const slug = createTaskCommentSlug({ source: 'qa-tasks', message: body, category });
      const formattedBody = formatTaskCommentBody({
        slug,
        source: 'qa-tasks',
        message: body,
        status,
        category,
      });
      const createdAt = new Date().toISOString();
      await this.deps.workspaceRepo.createTaskComment({
        taskId: task.task.id,
        taskRunId: taskRun.id,
        jobId: ctx.jobId,
        sourceCommand: 'qa-tasks',
        authorType: 'human',
        category,
        slug,
        status,
        body: formattedBody,
        createdAt,
        resolvedAt: status === 'resolved' ? createdAt : null,
        resolvedBy: status === 'resolved' ? 'human' : null,
        metadata: {
          ...(ctx.request.evidenceUrl ? { evidence: ctx.request.evidenceUrl } : {}),
          ...(artifacts.length ? { artifacts } : {}),
        },
      });
    }

    return {
      taskKey: task.task.key,
      outcome,
      artifacts,
      followups,
      notes,
    };
  }

  async run(request: QaTasksRequest): Promise<QaTasksResponse> {
    this.qaProfilePlan = undefined;
    this.qaTaskPlans = undefined;
    const resume = request.resumeJobId ? await this.deps.jobService.getJob(request.resumeJobId) : undefined;
    if (request.resumeJobId && !resume) {
      throw new Error(`Resume requested but job ${request.resumeJobId} not found`);
    }
    const effectiveProject = request.projectKey ?? (resume?.payload as any)?.projectKey;
    const effectiveEpic = request.epicKey ?? (resume?.payload as any)?.epicKey;
    const effectiveStory = request.storyKey ?? (resume?.payload as any)?.storyKey;
    const effectiveTasks = request.taskKeys?.length ? request.taskKeys : (resume?.payload as any)?.tasks;
    const effectiveStatus = request.statusFilter ?? (resume?.payload as any)?.statusFilter ?? ['ready_to_qa'];
    const effectiveLimit = request.limit ?? (resume?.payload as any)?.limit;
    const ignoreStatusFilter = Boolean(effectiveTasks?.length) || request.ignoreStatusFilter === true;
    const { filtered: statusFilter, rejected } = filterTaskStatuses(
      ignoreStatusFilter ? [] : effectiveStatus,
      QA_ALLOWED_STATUSES,
      QA_ALLOWED_STATUSES,
    );

    const selection = await this.selectionService.selectTasks({
      projectKey: effectiveProject,
      epicKey: effectiveEpic,
      storyKey: effectiveStory,
      taskKeys: effectiveTasks,
      statusFilter,
      limit: effectiveLimit,
      ignoreDependencies: true,
      ignoreStatusFilter,
    });
    if (rejected.length > 0 && !ignoreStatusFilter) {
      selection.warnings.push(
        `qa-tasks ignores unsupported statuses: ${rejected.join(", ")}. Allowed: ${QA_ALLOWED_STATUSES.join(", ")}.`,
      );
    }
    const abortSignal = request.abortSignal;
    const resolveAbortReason = () => {
      const reason = abortSignal?.reason;
      if (typeof reason === "string" && reason.trim().length > 0) return reason;
      if (reason instanceof Error && reason.message) return reason.message;
      return "qa_tasks_aborted";
    };
    const abortIfSignaled = () => {
      if (abortSignal?.aborted) {
        throw new Error(resolveAbortReason());
      }
    };

    const mode = request.mode ?? 'auto';
    this.dryRunGuard = request.dryRun ?? false;
    if (request.dryRun) {
      const dryResults: QaTaskResult[] = [];
      if (mode !== 'manual') {
        this.qaProfilePlan = await this.planProfilesWithAgent(selection.ordered, request, {
          warnings: selection.warnings,
        });
      } else {
        this.qaProfilePlan = new Map();
      }
      for (const task of selection.ordered) {
        abortIfSignaled();
        let profiles: QaProfile[] = [];
        try {
          profiles = await this.resolveProfilesForRequest(task.task, request);
        } catch {
          profiles = [];
        }
        const profile = profiles[0];
        const profileNames = profiles.map((entry) => entry.name);
        dryResults.push({
          taskKey: task.task.key,
          outcome: profile ? 'unclear' : 'infra_issue',
          profile: profileNames.length > 1 ? 'auto' : profile?.name,
          runner: profileNames.length > 1 ? 'multi' : profile?.runner,
          notes: profile
            ? `Dry-run: QA planned${profileNames.length > 1 ? ` (${profileNames.join(', ')})` : ''}`
            : 'Dry-run: no profile available',
        });
      }
      return {
        jobId: 'dry-run',
        commandRunId: 'dry-run',
        selection,
        results: dryResults,
        warnings: selection.warnings,
      };
    }

    await this.ensureMcoda();

    const completedKeys = new Set<string>();
    const checkpoints = request.resumeJobId ? await this.deps.jobService.readCheckpoints(request.resumeJobId) : [];
    const priorResults = new Map<string, QaTaskResult>();
    for (const ckpt of checkpoints) {
      if (ckpt.stage?.startsWith('task:')) {
        const parts = ckpt.stage.split(':');
        if (parts[1]) completedKeys.add(parts[1]);
      }
      if (Array.isArray(ckpt.details?.completedTaskKeys)) {
        for (const key of ckpt.details.completedTaskKeys as string[]) {
          completedKeys.add(key);
        }
      }
      if (ckpt.details?.taskResult && (ckpt.details as any).taskResult.taskKey) {
        priorResults.set((ckpt.details as any).taskResult.taskKey, (ckpt.details as any).taskResult as QaTaskResult);
      }
    }
    const commandRun = await this.deps.jobService.startCommandRun('qa-tasks', effectiveProject, {
      taskIds: selection.ordered.map((t) => t.task.key),
      jobId: resume?.id,
    });
    const agentStream = request.agentStream !== false;
    const job =
      resume && resume.id
        ? resume
        : await this.deps.jobService.startJob('qa', commandRun.id, effectiveProject, {
            commandName: 'qa-tasks',
            payload: {
              projectKey: effectiveProject,
              epicKey: effectiveEpic,
              storyKey: effectiveStory,
              tasks: effectiveTasks,
              statusFilter,
              limit: effectiveLimit,
              mode,
              profile: request.profileName,
              level: request.level,
              agent: request.agentName,
              agentStream,
              createFollowups: request.createFollowupTasks ?? 'auto',
              dryRun: request.dryRun ?? false,
            },
            totalItems: selection.ordered.length,
            processedItems: completedKeys.size,
          });
    if (mode !== 'manual') {
      this.qaProfilePlan = await this.planProfilesWithAgent(selection.ordered, request, {
        jobId: job.id,
        commandRunId: commandRun.id,
        warnings: selection.warnings,
      });
    } else {
      this.qaProfilePlan = new Map();
    }
    if (resume?.id) {
      try {
        const qaRuns = await this.deps.workspaceRepo.listTaskQaRunsForJob(
          selection.ordered.map((t) => t.task.id),
          resume.id,
        );
        for (const run of qaRuns) {
          const task = selection.ordered.find((t) => t.task.id === run.taskId);
          if (task && run.recommendation) {
            completedKeys.add(task.task.key);
          }
        }
      } catch {
        // ignore resume enrichment failures
      }
    }
    const remaining = selection.ordered.filter((t) => !completedKeys.has(t.task.key));

    // Skip tasks that are already in a terminal QA state for this job (ready_to_qa -> completed/in_progress/failed)
    const terminalStatuses = new Set(['completed', 'in_progress', 'failed']);
    const skippedTerminal: QaTaskResult[] = [];
    for (const t of remaining) {
      if (terminalStatuses.has(t.task.status?.toLowerCase?.() ?? '')) {
        completedKeys.add(t.task.key);
        skippedTerminal.push({
          taskKey: t.task.key,
          outcome: 'pass',
          notes: `skipped (terminal status ${t.task.status})`,
        });
      }
    }
    const filteredRemaining = remaining.filter((t) => !terminalStatuses.has(t.task.status?.toLowerCase?.() ?? ''));

    await this.deps.jobService.updateJobStatus(job.id, 'running', {
      totalItems: selection.ordered.length,
      processedItems: completedKeys.size,
    });

    await this.checkpoint(job.id, 'selection', {
      ordered: selection.ordered.map((t) => t.task.key),
      completedTaskKeys: Array.from(completedKeys),
    });

    const warnings = [...selection.warnings];
    const results: QaTaskResult[] = [];
    let abortRemainingReason: string | null = null;
    const formatSessionId = (iso: string): string => {
      const date = new Date(iso);
      const pad = (value: number) => String(value).padStart(2, '0');
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
    const emitLine = (line: string): void => {
      console.info(line);
    };
    const emitBlank = (): void => emitLine('');
    const emitQaStart = (details: {
      taskKey: string;
      alias: string;
      summary: string;
      agent: string;
      provider: string;
      mode: string;
      workdir: string;
      sessionId: string;
      startedAt: string;
    }): void => {
      emitLine('╭──────────────────────────────────────────────────────────╮');
      emitLine('│                   START OF QA TASK                       │');
      emitLine('╰──────────────────────────────────────────────────────────╯');
      emitLine(`  [🪪] QA Task ID:     ${details.taskKey}`);
      emitLine(`  [👹] Alias:          ${details.alias}`);
      emitLine(`  [ℹ️] Summary:        ${details.summary}`);
      emitLine(`  [🤖] Agent:          ${details.agent}`);
      emitLine(`  [🕹️] Provider:       ${details.provider}`);
      emitLine(`  [🧩] Step:           qa`);
      emitLine(`  [🧪] Mode:           ${details.mode}`);
      emitLine(`  [📁] Workdir:        ${details.workdir}`);
      emitLine(`  [🔑] Session:        ${details.sessionId}`);
      emitLine(`  [🕒] Started:        ${details.startedAt}`);
      emitBlank();
      emitLine('    ░░░░░ START OF QA TASK ░░░░░');
      emitBlank();
    };
    const emitQaEnd = (details: {
      taskKey: string;
      statusLabel: string;
      outcome: string;
      profile?: string;
      runner?: string;
      elapsedMs: number;
      startedAt: string;
      endedAt: string;
    }): void => {
      emitLine('╭──────────────────────────────────────────────────────────╮');
      emitLine('│                    END OF QA TASK                        │');
      emitLine('╰──────────────────────────────────────────────────────────╯');
      emitLine(
        `  🧪 QA TASK ${details.taskKey} | 📜 STATUS ${details.statusLabel} | 🧭 OUTCOME ${details.outcome} | ⌛ TIME ${formatDuration(details.elapsedMs)}`,
      );
      emitLine(`  [🕒] Started:        ${details.startedAt}`);
      emitLine(`  [🕒] Ended:          ${details.endedAt}`);
      emitLine(`  [🧰] Profile:        ${details.profile ?? 'n/a'} (${details.runner ?? 'n/a'})`);
      emitBlank();
      emitLine('    ░░░░░ END OF QA TASK ░░░░░');
      emitBlank();
    };
    for (const task of selection.ordered) {
      if (completedKeys.has(task.task.key)) {
        results.push(
          priorResults.get(task.task.key) ?? { taskKey: task.task.key, outcome: 'pass', notes: 'skipped (resume)' },
        );
      }
    }
    results.push(...skippedTerminal);
    try {
      let processedCount = completedKeys.size;
      for (const [index, task] of filteredRemaining.entries()) {
        if (abortRemainingReason) break;
        abortIfSignaled();
        const mode = request.mode ?? 'auto';
        const startedAt = new Date().toISOString();
        const taskStartMs = Date.now();
        const sessionId = formatSessionId(startedAt);
        const qaAgentLabel = request.agentName ?? '(auto)';
        emitQaStart({
          taskKey: task.task.key,
          alias: `QA task ${task.task.key}`,
          summary: task.task.title ?? task.task.description ?? '(none)',
          agent: qaAgentLabel,
          provider: qaAgentLabel === '(auto)' ? 'routing' : 'qa',
          mode,
          workdir: this.workspace.workspaceRoot,
          sessionId,
          startedAt,
        });
        let result: QaTaskResult;
        try {
          if (mode === 'manual') {
            result = await this.runManual(task, { jobId: job.id, commandRunId: commandRun.id, request });
          } else {
            result = await this.runAuto(task, { jobId: job.id, commandRunId: commandRun.id, request, warnings });
          }
        } catch (error: any) {
          const message = error instanceof Error ? error.message : String(error);
          emitQaEnd({
            taskKey: task.task.key,
            statusLabel: 'FAILED',
            outcome: message,
            profile: undefined,
            runner: undefined,
            elapsedMs: Date.now() - taskStartMs,
            startedAt,
            endedAt: new Date().toISOString(),
          });
          if (isAuthErrorMessage(message)) {
            abortRemainingReason = message;
            warnings.push(`Auth/rate limit error detected; stopping after ${task.task.key}. ${message}`);
            results.push({ taskKey: task.task.key, outcome: 'infra_issue', notes: AUTH_ERROR_REASON });
            completedKeys.add(task.task.key);
            processedCount = completedKeys.size;
            await this.deps.jobService.updateJobStatus(job.id, 'running', { processedItems: processedCount });
            await this.checkpoint(job.id, `task:${task.task.key}:aborted`, {
              processed: processedCount,
              completedTaskKeys: Array.from(completedKeys),
              taskResult: results[results.length - 1],
            });
            break;
          }
          throw error;
        }
        results.push(result);
        const statusLabel =
          result.outcome === 'pass' ? 'COMPLETED' : result.outcome === 'infra_issue' ? 'BLOCKED' : 'FAILED';
        emitQaEnd({
          taskKey: task.task.key,
          statusLabel,
          outcome: result.outcome,
          profile: result.profile,
          runner: result.runner,
          elapsedMs: Date.now() - taskStartMs,
          startedAt,
          endedAt: new Date().toISOString(),
        });
        completedKeys.add(task.task.key);
        processedCount = completedKeys.size;
        await this.deps.jobService.updateJobStatus(job.id, 'running', { processedItems: processedCount });
        await this.checkpoint(job.id, `task:${task.task.key}:completed`, {
          processed: processedCount,
          completedTaskKeys: Array.from(completedKeys),
          taskResult: results[results.length - 1],
        });
      }
      if (abortRemainingReason) {
        warnings.push(`Stopped remaining tasks due to auth/rate limit: ${abortRemainingReason}`);
      }
      const failureCount = results.filter((r) => r.outcome !== 'pass').length;
      const state: JobState = abortRemainingReason
        ? 'failed'
        : failureCount === 0
          ? 'completed'
          : failureCount === results.length
            ? 'failed'
            : ('partial' as JobState);
      const errorSummary = abortRemainingReason ?? (failureCount ? `${failureCount} task(s) not passed QA` : undefined);
      await this.deps.jobService.updateJobStatus(job.id, state, { errorSummary });
      await this.deps.jobService.finishCommandRun(commandRun.id, state === 'completed' ? 'succeeded' : 'failed', errorSummary);
      await this.checkpoint(job.id, 'completed', {
        state,
        processed: results.length,
        failures: failureCount,
        taskResults: results,
      });
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.jobService.updateJobStatus(job.id, 'failed', { errorSummary: message });
      await this.deps.jobService.finishCommandRun(commandRun.id, 'failed', message);
      throw error;
    }

    return {
      jobId: job.id,
      commandRunId: commandRun.id,
      selection,
      results,
      warnings,
    };
  }
}
