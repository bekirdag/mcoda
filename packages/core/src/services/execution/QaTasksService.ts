import path from 'node:path';
import { TaskRow, WorkspaceRepository, TaskRunRow, TaskRunStatus, TaskQaRunRow } from '@mcoda/db';
import { PathHelper } from '@mcoda/shared';
import { QaProfile } from '@mcoda/shared/qa/QaProfile.js';
import { WorkspaceResolution } from '../../workspace/WorkspaceManager.js';
import { JobService, JobState } from '../jobs/JobService.js';
import { TaskSelectionFilters, TaskSelectionPlan, TaskSelectionService } from './TaskSelectionService.js';
import { TaskStateService } from './TaskStateService.js';
import { QaProfileService } from './QaProfileService.js';
import { QaFollowupService, FollowupSuggestion } from './QaFollowupService.js';
import { QaAdapter } from '@mcoda/integrations/qa/QaAdapter.js';
import { CliQaAdapter } from '@mcoda/integrations/qa/CliQaAdapter.js';
import { ChromiumQaAdapter } from '@mcoda/integrations/qa/ChromiumQaAdapter.js';
import { MaestroQaAdapter } from '@mcoda/integrations/qa/MaestroQaAdapter.js';
import { QaContext, QaRunResult } from '@mcoda/integrations/qa/QaTypes.js';
import { VcsClient } from '@mcoda/integrations';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AgentService } from '@mcoda/agents';
import { GlobalRepository } from '@mcoda/db';
import { DocdexClient } from '@mcoda/integrations';
import { RoutingService } from '../agents/RoutingService.js';

export interface QaTasksRequest extends TaskSelectionFilters {
  workspace: WorkspaceResolution;
  mode?: 'auto' | 'manual';
  resumeJobId?: string;
  profileName?: string;
  level?: string;
  testCommand?: string;
  agentName?: string;
  agentStream?: boolean;
  createFollowupTasks?: 'auto' | 'none' | 'prompt';
  dryRun?: boolean;
  result?: 'pass' | 'fail' | 'blocked';
  notes?: string;
  evidenceUrl?: string;
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

const MCODA_GITIGNORE_ENTRY = '.mcoda/\n';

type AgentFailure = { kind?: string; message: string; evidence?: string };
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

interface AgentInterpretation {
  recommendation: 'pass' | 'fix_required' | 'infra_issue' | 'unclear';
  testedScope?: string;
  coverageSummary?: string;
  failures?: AgentFailure[];
  followUps?: AgentFollowUp[];
  rawOutput?: string;
  tokensPrompt?: number;
  tokensCompletion?: number;
  agentId?: string;
  modelName?: string;
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
  private dryRunGuard = false;

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
    },
  ) {
    this.selectionService = deps.selectionService ?? new TaskSelectionService(workspace, deps.workspaceRepo);
    this.stateService = deps.stateService ?? new TaskStateService(deps.workspaceRepo);
    this.profileService = deps.profileService ?? new QaProfileService(workspace.workspaceRoot);
    this.followupService = deps.followupService ?? new QaFollowupService(deps.workspaceRepo, workspace.workspaceRoot);
    this.jobService = deps.jobService;
    this.vcs = deps.vcsClient ?? new VcsClient();
    this.agentService = deps.agentService;
    this.docdex = deps.docdex;
    this.repo = deps.repo;
    this.routingService = deps.routingService;
  }

  static async create(workspace: WorkspaceResolution, options: { noTelemetry?: boolean } = {}): Promise<QaTasksService> {
    const repo = await GlobalRepository.create();
    const agentService = new AgentService(repo);
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
    });
    const routingService = await RoutingService.create();
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    const jobService = new JobService(workspace, workspaceRepo, {
      noTelemetry: options.noTelemetry ?? false,
    });
    const selectionService = new TaskSelectionService(workspace, workspaceRepo);
    const stateService = new TaskStateService(workspaceRepo);
    const profileService = new QaProfileService(workspace.workspaceRoot);
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

  private async checkpoint(jobId: string, stage: string, details?: Record<string, unknown>): Promise<void> {
    await this.jobService.writeCheckpoint(jobId, {
      stage,
      timestamp: new Date().toISOString(),
      details,
    });
  }

  private async ensureTaskBranch(task: TaskSelectionPlan['ordered'][number], taskRunId: string): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.vcs.ensureRepo(this.workspace.workspaceRoot);
      await this.vcs.ensureClean(this.workspace.workspaceRoot, true);
      if (task.task.vcsBranch) {
        const exists = await this.vcs.branchExists(this.workspace.workspaceRoot, task.task.vcsBranch);
        if (!exists) {
          return { ok: false, message: `Task branch ${task.task.vcsBranch} not found` };
        }
        await this.vcs.checkoutBranch(this.workspace.workspaceRoot, task.task.vcsBranch);
      } else {
        const base = this.workspace.config?.branch ?? 'mcoda-dev';
        await this.vcs.ensureBaseBranch(this.workspace.workspaceRoot, base);
      }
      return { ok: true };
    } catch (error: any) {
      await this.logTask(taskRunId, `VCS check failed: ${error?.message ?? error}`, 'vcs');
      return { ok: false, message: error?.message ?? String(error) };
    }
  }

  private async ensureMcoda(): Promise<void> {
    await PathHelper.ensureDir(this.workspace.mcodaDir);
    const gitignorePath = `${this.workspace.workspaceRoot}/.gitignore`;
    try {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(gitignorePath, 'utf8');
      if (!content.includes('.mcoda/')) {
        await fs.writeFile(gitignorePath, `${content.trimEnd()}\n${MCODA_GITIGNORE_ENTRY}`, 'utf8');
      }
    } catch {
      const fs = await import('node:fs/promises');
      await fs.writeFile(gitignorePath, MCODA_GITIGNORE_ENTRY, 'utf8');
    }
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
  ): Promise<string> {
    if (!this.docdex) return '';
    try {
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
      for (const doc of docs.slice(0, 5)) {
        const segments = (doc.segments ?? []).slice(0, 2);
        const body = segments.length
          ? segments
              .map((seg, idx) => `  (${idx + 1}) ${seg.heading ? `${seg.heading}: ` : ''}${seg.content.slice(0, 400)}`)
              .join('\n')
          : doc.content
            ? doc.content.slice(0, 600)
            : '';
        snippets.push(`- [${doc.docType}] ${doc.title ?? doc.path ?? doc.id}\n${body}`.trim());
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

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil((text?.length ?? 0) / 4));
  }

  private extractJsonCandidate(raw: string): any | undefined {
    const fenced = raw.match(/```json([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : raw;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return undefined;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }

  private normalizeAgentOutput(parsed: any): AgentInterpretation | undefined {
    if (!parsed || typeof parsed !== 'object') return undefined;
    const recommendation = parsed.recommendation as AgentInterpretation['recommendation'];
    if (!recommendation || !['pass', 'fix_required', 'infra_issue', 'unclear'].includes(recommendation)) return undefined;
    const followUps: AgentFollowUp[] | undefined = Array.isArray(parsed.follow_up_tasks)
      ? parsed.follow_up_tasks
      : Array.isArray(parsed.follow_ups)
        ? parsed.follow_ups
        : undefined;
    const failures: AgentFailure[] | undefined = Array.isArray(parsed.failures)
      ? parsed.failures.map((f: any) => ({ kind: f.kind, message: f.message ?? String(f), evidence: f.evidence }))
      : undefined;
    return {
      recommendation,
      testedScope: parsed.tested_scope ?? parsed.scope,
      coverageSummary: parsed.coverage_summary ?? parsed.coverage,
      failures,
      followUps,
    };
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
  ): Promise<AgentInterpretation> {
    if (!this.agentService) {
      return { recommendation: this.mapOutcome(result) };
    }
    try {
      const agent = await this.resolveAgent(agentName);
      const docCtx = await this.gatherDocContext(task.task, taskRunId);
      const acceptance = (task.task.acceptanceCriteria ?? []).map((line) => `- ${line}`).join('\n');
      const prompt = [
        'You are the mcoda QA agent. Interpret the QA execution results and return structured JSON.',
        `Task: ${task.task.key} ${task.task.title}`,
        `Task type: ${task.task.type ?? 'n/a'}, status: ${task.task.status}`,
        task.task.description ? `Task description:\n${task.task.description}` : '',
        `Epic/Story: ${task.task.epicKey ?? task.task.epicId} / ${task.task.storyKey ?? task.task.userStoryId}`,
        acceptance ? `Acceptance criteria:\n${acceptance}` : 'Acceptance criteria: (not provided)',
        `QA profile: ${profile.name} (${profile.runner ?? 'cli'})`,
        `Test command / runner outcome: exit=${result.exitCode} outcome=${result.outcome}`,
        result.stdout ? `Stdout (truncated):\n${result.stdout.slice(0, 3000)}` : '',
        result.stderr ? `Stderr (truncated):\n${result.stderr.slice(0, 3000)}` : '',
        result.artifacts?.length ? `Artifacts:\n${result.artifacts.join('\n')}` : '',
        docCtx ? `Relevant docs (SDS/RFP/OpenAPI):\n${docCtx}` : '',
        [
          'Return strict JSON with keys:',
          '{',
          '  "tested_scope": string,',
          '  "coverage_summary": string,',
          '  "failures": [{ "kind": "functional|contract|perf|security|infra", "message": string, "evidence": string }],',
          '  "recommendation": "pass|fix_required|infra_issue|unclear",',
          '  "follow_up_tasks": [{ "title": string, "description": string, "type": "bug|qa_followup|chore", "priority": number, "story_points": number, "tags": string[], "related_task_key": string, "epic_key": string, "story_key": string, "doc_links": string[], "evidence_url": string, "artifacts": string[] }]',
          '}',
          'Do not include prose outside the JSON.',
        ].join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n');
      let output = '';
      let chunkCount = 0;
      if (stream && this.agentService.invokeStream) {
        const gen = await this.agentService.invokeStream(agent.id, { input: prompt, metadata: { command: 'qa-tasks' } });
        for await (const chunk of gen) {
          output += chunk.output ?? '';
          chunkCount += 1;
        }
      } else {
        const res = await this.agentService.invoke(agent.id, { input: prompt, metadata: { command: 'qa-tasks' } });
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
            taskKey: task.task.key,
            streaming: stream,
            streamChunks: chunkCount || undefined,
          },
        });
      }
      const parsed = this.extractJsonCandidate(output);
      const normalized = this.normalizeAgentOutput(parsed);
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
      return { recommendation: this.mapOutcome(result), rawOutput: output, tokensPrompt, tokensCompletion, agentId: agent.id, modelName: agent.defaultModel };
    } catch (error: any) {
      if (taskRunId) {
        await this.logTask(taskRunId, `QA agent failed: ${error?.message ?? error}`, 'qa-agent');
      }
      return { recommendation: this.mapOutcome(result) };
    }
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

  private async applyStateTransition(
    task: TaskRow,
    outcome: 'pass' | 'fix_required' | 'infra_issue' | 'unclear',
  ): Promise<void> {
    const timestamp = { last_qa: new Date().toISOString() };
    if (outcome === 'pass') {
      await this.stateService.markCompleted(task, timestamp);
    } else if (outcome === 'fix_required') {
      await this.stateService.returnToInProgress(task, timestamp);
    } else if (outcome === 'infra_issue') {
      await this.stateService.markBlocked(task, 'qa_infra_issue');
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
    const docCtx = await this.gatherDocContext(task.task, taskRunId);
    const prompt = [
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
    } catch {
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
    },
  ): Promise<QaTaskResult> {
    const taskRun = await this.createTaskRun(task.task, ctx.jobId, ctx.commandRunId);
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
      }
      return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'status_gating' };
    }

    const branchCheck = await this.ensureTaskBranch(task, taskRun.id);
    if (!branchCheck.ok) {
      if (!this.dryRunGuard) {
        await this.applyStateTransition(task.task, 'infra_issue');
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
        await this.deps.workspaceRepo.createTaskComment({
          taskId: task.task.id,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          sourceCommand: 'qa-tasks',
          authorType: 'agent',
          category: 'qa_issue',
          body: `VCS validation failed: ${branchCheck.message ?? 'unknown error'}`,
          createdAt: new Date().toISOString(),
        });
      }
      return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'vcs_branch_missing' };
    }
    let profile: QaProfile | undefined;
    try {
      profile = await this.profileService.resolveProfileForTask(task.task, {
        profileName: ctx.request.profileName,
        level: ctx.request.level,
      });
    } catch (error: any) {
      await this.logTask(taskRun.id, `Profile resolution failed: ${error?.message ?? error}`, 'qa-profile');
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
          metadata: { reason: 'profile_resolution_failed', message: error?.message ?? String(error) },
        });
      }
      return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'profile_resolution_failed' };
    }
    if (!profile) {
      await this.logTask(taskRun.id, 'No QA profile available', 'qa-profile');
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
          metadata: { reason: 'no_profile' },
        });
      }
      return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'no_profile' };
    }
    const adapter = this.adapterForProfile(profile);
    if (!adapter) {
      await this.logTask(taskRun.id, 'No QA adapter for profile', 'qa-adapter');
      await this.finishTaskRun(taskRun, 'failed');
      if (!this.dryRunGuard) {
        await this.deps.workspaceRepo.createTaskQaRun({
          taskId: task.task.id,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          commandRunId: ctx.commandRunId,
          source: 'auto',
          mode: 'auto',
          profileName: profile.name,
          runner: profile.runner,
          rawOutcome: 'infra_issue',
          recommendation: 'infra_issue',
          metadata: { reason: 'no_adapter' },
        });
      }
      return { taskKey: task.task.key, outcome: 'infra_issue', profile: profile.name, runner: profile.runner, notes: 'no_adapter' };
    }

    const qaCtx: QaContext = {
      workspaceRoot: this.workspace.workspaceRoot,
      jobId: ctx.jobId,
      taskKey: task.task.key,
      env: process.env,
      testCommandOverride: ctx.request.testCommand,
    };

    const ensure = await adapter.ensureInstalled(profile, qaCtx);
    if (!ensure.ok) {
      await this.logTask(taskRun.id, ensure.message ?? 'QA install failed', 'qa-install');
      if (!this.dryRunGuard) {
        await this.applyStateTransition(task.task, 'infra_issue');
        await this.finishTaskRun(taskRun, 'failed');
        await this.deps.workspaceRepo.createTaskQaRun({
          taskId: task.task.id,
          taskRunId: taskRun.id,
          jobId: ctx.jobId,
          commandRunId: ctx.commandRunId,
          source: 'auto',
          mode: 'auto',
          profileName: profile.name,
          runner: profile.runner,
          rawOutcome: 'infra_issue',
          recommendation: 'infra_issue',
          metadata: { install: ensure.message, adapter: profile.runner },
        });
      }
      return {
        taskKey: task.task.key,
        outcome: 'infra_issue',
        profile: profile.name,
        runner: profile.runner,
        notes: ensure.message,
      };
    }

    const artifactDir = path.join(this.workspace.workspaceRoot, '.mcoda', 'jobs', ctx.jobId, 'qa', task.task.key);
    await PathHelper.ensureDir(artifactDir);
    const result = await adapter.invoke(profile, { ...qaCtx, artifactDir });
    await this.logTask(taskRun.id, `QA run completed with outcome ${result.outcome}`, 'qa-exec', {
      exitCode: result.exitCode,
    });
    const interpretation = await this.interpretResult(
      task,
      profile,
      result,
      ctx.request.agentName,
      ctx.request.agentStream ?? true,
      ctx.jobId,
      ctx.commandRunId,
      taskRun.id,
    );
    const outcome = this.combineOutcome(result, interpretation.recommendation);
    const artifacts = result.artifacts ?? [];

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
        },
      });
    }

    if (!this.dryRunGuard) {
      await this.applyStateTransition(task.task, outcome);
      await this.finishTaskRun(taskRun, outcome === 'pass' ? 'succeeded' : 'failed');
    }

    const followups: string[] = [];
    if (outcome === 'fix_required' && ctx.request.createFollowupTasks !== 'none') {
      const suggestions: FollowupSuggestion[] = interpretation.followUps?.map((f) => this.toFollowupSuggestion(task.task, f, artifacts)) ?? [];
      if (suggestions.length === 0) {
        suggestions.push(this.buildFollowupSuggestion(task.task, result, ctx.request.notes));
      }
      const interactive = ctx.request.createFollowupTasks === 'prompt' && process.stdout.isTTY;
      for (const suggestion of suggestions) {
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
            const created = await this.followupService.createFollowupTask({ ...task.task, storyKey: task.task.storyKey, epicKey: task.task.epicKey }, suggestion);
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
      profile ? `Profile: ${profile.name} (${profile.runner ?? 'cli'})` : '',
      interpretation.coverageSummary ? `Coverage: ${interpretation.coverageSummary}` : '',
      interpretation.failures && interpretation.failures.length
        ? `Failures:\n${interpretation.failures.map((f) => `- [${f.kind ?? 'issue'}] ${f.message}${f.evidence ? ` (${f.evidence})` : ''}`).join('\n')}`
        : '',
      result.stdout ? `Stdout:\n${result.stdout.slice(0, 4000)}` : '',
      result.stderr ? `Stderr:\n${result.stderr.slice(0, 4000)}` : '',
      artifacts.length ? `Artifacts:\n${artifacts.join('\n')}` : '',
      followups.length ? `Follow-ups: ${followups.join(', ')}` : '',
    ].filter(Boolean);
    if (!this.dryRunGuard) {
      await this.deps.workspaceRepo.createTaskComment({
        taskId: task.task.id,
        taskRunId: taskRun.id,
        jobId: ctx.jobId,
        sourceCommand: 'qa-tasks',
        authorType: 'agent',
        category: outcome === 'pass' ? 'qa_result' : 'qa_issue',
        body: bodyLines.join('\n\n'),
        createdAt: new Date().toISOString(),
        metadata: {
          ...(artifacts.length ? { artifacts } : {}),
          ...(qaRun?.id ? { qaRunId: qaRun.id } : {}),
        },
      });
    }

    return {
      taskKey: task.task.key,
      outcome,
      profile: profile.name,
      runner: profile.runner,
      artifacts,
      followups,
    };
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
    const result = ctx.request.result ?? 'pass';
    const notes = ctx.request.notes;
    const outcome: 'pass' | 'fix_required' | 'infra_issue' =
      result === 'pass' ? 'pass' : result === 'blocked' ? 'infra_issue' : 'fix_required';
    const allowedStatuses = new Set(ctx.request.statusFilter ?? ['ready_to_qa']);
    if (task.task.status && !allowedStatuses.has(task.task.status)) {
      const message = `Task status ${task.task.status} not allowed for manual QA`;
      await this.logTask(taskRun.id, message, 'status-gate');
      await this.finishTaskRun(taskRun, 'failed');
      return { taskKey: task.task.key, outcome: 'infra_issue', notes: 'status_gating' };
    }

    if (!ctx.request.dryRun) {
      await this.applyStateTransition(task.task, outcome);
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
      const agentSuggestions = await this.suggestFollowupsFromAgent(
        task,
        notes,
        ctx.request.evidenceUrl,
        'manual',
        ctx.jobId,
        ctx.commandRunId,
        taskRun.id,
      );
      if (agentSuggestions.length) {
        suggestions.unshift(...agentSuggestions);
      }
      const interactive = ctx.request.createFollowupTasks === 'prompt' && process.stdout.isTTY;
      for (const suggestion of suggestions) {
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
            suggestion,
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
      await this.deps.workspaceRepo.createTaskComment({
        taskId: task.task.id,
        taskRunId: taskRun.id,
        jobId: ctx.jobId,
        sourceCommand: 'qa-tasks',
        authorType: 'human',
        category: result === 'pass' ? 'qa_result' : 'qa_issue',
        body,
        createdAt: new Date().toISOString(),
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
    const resume = request.resumeJobId ? await this.deps.jobService.getJob(request.resumeJobId) : undefined;
    if (request.resumeJobId && !resume) {
      throw new Error(`Resume requested but job ${request.resumeJobId} not found`);
    }
    const effectiveProject = request.projectKey ?? (resume?.payload as any)?.projectKey;
    const effectiveEpic = request.epicKey ?? (resume?.payload as any)?.epicKey;
    const effectiveStory = request.storyKey ?? (resume?.payload as any)?.storyKey;
    const effectiveTasks = request.taskKeys?.length ? request.taskKeys : (resume?.payload as any)?.tasks;
    const effectiveStatus = request.statusFilter ?? (resume?.payload as any)?.statusFilter ?? ['ready_to_qa'];

    const selection = await this.selectionService.selectTasks({
      projectKey: effectiveProject,
      epicKey: effectiveEpic,
      storyKey: effectiveStory,
      taskKeys: effectiveTasks,
      statusFilter: effectiveStatus,
    });

    this.dryRunGuard = request.dryRun ?? false;
    if (request.dryRun) {
      const dryResults: QaTaskResult[] = [];
      for (const task of selection.ordered) {
        let profile: QaProfile | undefined;
        try {
          profile = await this.profileService.resolveProfileForTask(task.task, {
            profileName: request.profileName,
            level: request.level,
          });
        } catch {
          profile = undefined;
        }
        dryResults.push({
          taskKey: task.task.key,
          outcome: profile ? 'unclear' : 'infra_issue',
          profile: profile?.name,
          runner: profile?.runner,
          notes: profile ? 'Dry-run: QA planned' : 'Dry-run: no profile available',
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
              statusFilter: effectiveStatus,
              mode: request.mode ?? 'auto',
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

    // Skip tasks that are already in a terminal QA state for this job (ready_to_qa -> completed/in_progress/blocked)
    const terminalStatuses = new Set(['completed', 'in_progress', 'blocked']);
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
      blocked: selection.blocked.map((t) => t.task.key),
      completedTaskKeys: Array.from(completedKeys),
    });

    const results: QaTaskResult[] = [];
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
        const mode = request.mode ?? 'auto';
        if (mode === 'manual') {
          results.push(await this.runManual(task, { jobId: job.id, commandRunId: commandRun.id, request }));
        } else {
          results.push(await this.runAuto(task, { jobId: job.id, commandRunId: commandRun.id, request }));
        }
        completedKeys.add(task.task.key);
        processedCount = completedKeys.size;
        await this.deps.jobService.updateJobStatus(job.id, 'running', { processedItems: processedCount });
        await this.checkpoint(job.id, `task:${task.task.key}:completed`, {
          processed: processedCount,
          completedTaskKeys: Array.from(completedKeys),
          taskResult: results[results.length - 1],
        });
      }
      const failureCount = results.filter((r) => r.outcome !== 'pass').length;
      const state: JobState =
        failureCount === 0 ? 'completed' : failureCount === results.length ? 'failed' : ('partial' as JobState);
      const errorSummary = failureCount ? `${failureCount} task(s) not passed QA` : undefined;
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
      warnings: selection.warnings,
    };
  }
}
