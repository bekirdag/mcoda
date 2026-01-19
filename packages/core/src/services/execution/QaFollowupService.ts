import {
  EpicInsert,
  StoryInsert,
  TaskCommentInsert,
  TaskDependencyInsert,
  TaskInsert,
  TaskRow,
  WorkspaceRepository,
} from '@mcoda/db';
import { createTaskKeyGenerator } from '../planning/KeyHelpers.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { PathHelper } from '@mcoda/shared';

export interface FollowupSuggestion {
  title: string;
  description?: string;
  type?: string;
  priority?: number;
  storyPoints?: number;
  tags?: string[];
  epicKeyHint?: string;
  storyKeyHint?: string;
  relatedTaskKey?: string;
  components?: string[];
  docLinks?: string[];
  testName?: string;
  evidenceUrl?: string;
  artifacts?: string[];
  followupSlug?: string;
}

const BUG_EPIC_KEY = 'EPIC-BUGS';
const BUG_STORY_KEY = 'US-BUGS';
const FOLLOWUP_DESCRIPTION_TEMPLATE = (
  summary: string,
  actual: string,
  expected: string,
  envLines: string[],
  steps?: string[],
): string => {
  const lines = [
    '# Summary',
    summary || 'Summarize the problem discovered during QA.',
    '',
    '# Steps to Reproduce',
    ...(steps && steps.length
      ? steps.map((step, idx) => `${idx + 1}. ${step}`)
      : ['1. Provide minimal reproducible steps based on failing test or QA notes.']),
    '',
    '# Expected',
    expected || 'Describe the expected behavior per acceptance criteria / OpenAPI.',
    '',
    '# Actual',
    actual || 'Describe the observed behavior.',
    '',
    '# Environment',
    ...envLines.map((line) => `- ${line}`),
  ];
  return lines.join('\n');
};

export class QaFollowupService {
  constructor(private workspaceRepo: WorkspaceRepository, private workspaceRoot: string) {}

  private get mcodaDir(): string {
    return PathHelper.getWorkspaceDir(this.workspaceRoot);
  }

  private get cachePath(): string {
    return path.join(this.mcodaDir, 'qa-containers.json');
  }

  private async readCache(): Promise<Record<string, { epicId: string; storyId: string; epicKey: string; storyKey: string }>> {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      return JSON.parse(raw) as Record<string, { epicId: string; storyId: string; epicKey: string; storyKey: string }>;
    } catch {
      return {};
    }
  }

  private async writeCache(data: Record<string, { epicId: string; storyId: string; epicKey: string; storyKey: string }>): Promise<void> {
    await PathHelper.ensureDir(path.dirname(this.cachePath));
    await fs.writeFile(this.cachePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private async ensureBugContainer(projectId: string): Promise<{
    epicId: string;
    storyId: string;
    epicKey: string;
    storyKey: string;
  }> {
    const cache = await this.readCache();
    if (cache[projectId]) {
      return cache[projectId];
    }

    let epic = await this.workspaceRepo.getEpicByKey(projectId, BUG_EPIC_KEY);
    if (!epic) {
      const epicInsert: EpicInsert = {
        projectId,
        key: BUG_EPIC_KEY,
        title: 'Generic Bugs / Issues',
        description: 'Container epic for QA-found bugs and follow-up items.',
        storyPointsTotal: null,
        priority: 999,
        metadata: { tags: ['generic', 'qa-intake'] },
      };
      const [created] = await this.workspaceRepo.insertEpics([epicInsert], true);
      epic = created;
    }
    let story = await this.workspaceRepo.getStoryByKey(epic.id, BUG_STORY_KEY);
    if (!story) {
      const storyInsert: StoryInsert = {
        projectId,
        epicId: epic.id,
        key: BUG_STORY_KEY,
        title: 'Generic Bugs / Issues',
        description: 'Default story container for unmapped QA follow-ups.',
        acceptanceCriteria: undefined,
        storyPointsTotal: null,
        priority: 999,
        metadata: { tags: ['generic', 'qa-intake'] },
      };
      const [created] = await this.workspaceRepo.insertStories([storyInsert], true);
      story = created;
    }
    const resolved = { epicId: epic.id, storyId: story.id, epicKey: epic.key, storyKey: story.key };
    cache[projectId] = resolved;
    await this.writeCache(cache);
    return resolved;
  }

  async createFollowupTask(
    sourceTask: TaskRow & { storyKey?: string; epicKey?: string },
    suggestion: FollowupSuggestion,
  ): Promise<{ task: TaskInsert & { id: string }; dependency?: TaskDependencyInsert; comment?: TaskCommentInsert }> {
    const projectId = sourceTask.projectId;
    const resolved = await this.resolveTargetContainer(sourceTask, suggestion);
    const storyKeyBase =
      suggestion.storyKeyHint ?? resolved.storyKey ?? sourceTask.storyKey ?? sourceTask.key.split('-t')[0] ?? 'task';
    const existingKeys = await this.workspaceRepo.listTaskKeys(resolved.storyId);
    const keyGen = createTaskKeyGenerator(storyKeyBase, existingKeys);
    const followupKey = keyGen();
    const now = new Date().toISOString();
    const storyPoints = suggestion.storyPoints ?? 1;
    const boundedPoints = Math.min(10, Math.max(1, Math.round(storyPoints)));
    const metadata: Record<string, unknown> = {
      tags: ['qa-found', 'auto-created', 'ready-for-ai-dev', 'source=qa', ...(suggestion.tags ?? [])],
      source_task: sourceTask.key,
      complexity: boundedPoints,
      ...(suggestion.followupSlug ? { qa_followup_slug: suggestion.followupSlug } : {}),
      ...(suggestion.components ? { components: suggestion.components } : {}),
      ...(suggestion.docLinks ? { doc_links: suggestion.docLinks } : {}),
      ...(suggestion.testName ? { failing_test: suggestion.testName } : {}),
      ...(suggestion.evidenceUrl ? { evidence_url: suggestion.evidenceUrl } : {}),
    };
    const envInfo = [
      `Task: ${sourceTask.key}`,
      `Epic: ${sourceTask.epicKey ?? resolved.epicKey ?? sourceTask.epicId}`,
      `Story: ${sourceTask.storyKey ?? resolved.storyKey ?? sourceTask.userStoryId}`,
      `Branch/Commit: ${sourceTask.vcsBranch ?? 'n/a'} / ${sourceTask.vcsLastCommitSha ?? 'n/a'}`,
      `Components: ${Array.isArray(suggestion.components) && suggestion.components.length ? suggestion.components.join(', ') : Array.isArray((sourceTask.metadata as any)?.components) ? (sourceTask.metadata as any).components.join(', ') : 'n/a'}`,
      `Tests: ${suggestion.testName ?? (Array.isArray((sourceTask.metadata as any)?.tests) ? (sourceTask.metadata as any).tests.join(', ') : 'n/a')}`,
      `Docs: ${suggestion.docLinks?.join(', ') ?? (Array.isArray((sourceTask.metadata as any)?.doc_links) ? (sourceTask.metadata as any).doc_links.join(', ') : 'n/a')}`,
      suggestion.evidenceUrl ? `Evidence: ${suggestion.evidenceUrl}` : '',
      suggestion.artifacts && suggestion.artifacts.length ? `Artifacts: ${suggestion.artifacts.join(', ')}` : '',
    ].filter(Boolean);
    const description = FOLLOWUP_DESCRIPTION_TEMPLATE(
      suggestion.title ?? `Follow-up for ${sourceTask.key}`,
      suggestion.description ?? 'Actual behavior not provided.',
      'Expected behavior per acceptance criteria/OpenAPI.',
      envInfo,
    );
    const taskInsert: TaskInsert = {
      projectId,
      epicId: resolved.epicId,
      userStoryId: resolved.storyId,
      key: followupKey,
      title: suggestion.title || `Follow-up for ${sourceTask.key}`,
      description,
      type: suggestion.type ?? 'bug',
      status: 'not_started',
      storyPoints: boundedPoints,
      priority: suggestion.priority ?? 99,
      metadata,
    };
    const [createdTask] = await this.workspaceRepo.insertTasks([taskInsert], true);
    const dependency: TaskDependencyInsert = {
      taskId: sourceTask.id,
      dependsOnTaskId: createdTask.id,
      relationType: 'blocks',
    };
    await this.workspaceRepo.insertTaskDependencies([dependency], true);
    const sourceComment: TaskCommentInsert = {
      taskId: sourceTask.id,
      sourceCommand: 'qa-tasks',
      authorType: 'agent',
      category: 'qa_followup',
      body: `Created follow-up task ${createdTask.key} for QA findings.`,
      metadata: { followupTaskKey: createdTask.key },
      createdAt: now,
    };
    await this.workspaceRepo.createTaskComment(sourceComment);
    const followupComment: TaskCommentInsert = {
      taskId: createdTask.id,
      sourceCommand: 'qa-tasks',
      authorType: 'agent',
      category: 'qa_origin',
      body: `Created automatically from QA of ${sourceTask.key}.`,
      metadata: { sourceTaskKey: sourceTask.key },
      createdAt: now,
    };
    await this.workspaceRepo.createTaskComment(followupComment);
    return { task: { ...taskInsert, id: createdTask.id }, dependency, comment: sourceComment };
  }

  private async resolveTargetContainer(
    sourceTask: TaskRow & { storyKey?: string; epicKey?: string },
    suggestion: FollowupSuggestion,
  ): Promise<{ epicId: string; storyId: string; storyKey?: string; epicKey?: string }> {
    const projectId = sourceTask.projectId;
    if (suggestion.relatedTaskKey) {
      const related = await this.workspaceRepo.getTaskByKey(suggestion.relatedTaskKey);
      if (related) {
        return {
          epicId: related.epicId,
          storyId: related.userStoryId,
          storyKey: related.key.split('-t')[0] ?? related.key,
        };
      }
    }
    if (suggestion.storyKeyHint) {
      const story = await this.workspaceRepo.getStoryByProjectAndKey(projectId, suggestion.storyKeyHint);
      if (story) {
        return { epicId: story.epicId, storyId: story.id, storyKey: story.key };
      }
    }
    if (Array.isArray(suggestion.docLinks)) {
      for (const link of suggestion.docLinks) {
        const storyKeyCandidate = link.match(/US-[A-Za-z0-9]+/i)?.[0];
        if (storyKeyCandidate) {
          const story = await this.workspaceRepo.getStoryByProjectAndKey(projectId, storyKeyCandidate.toUpperCase());
          if (story) return { epicId: story.epicId, storyId: story.id, storyKey: story.key };
        }
        const epicKeyCandidate = link.match(/EPIC-[A-Za-z0-9]+/i)?.[0];
        if (epicKeyCandidate) {
          const epic = await this.workspaceRepo.getEpicByKey(projectId, epicKeyCandidate.toUpperCase());
          if (epic) {
            return {
              epicId: epic.id,
              epicKey: epic.key,
              storyId: sourceTask.userStoryId ?? epic.id,
              storyKey: sourceTask.storyKey ?? epic.key,
            };
          }
        }
      }
    }
    const branch = sourceTask.vcsBranch ?? '';
    const storyMatch = branch.match(/US-[A-Za-z0-9]+/i);
    if (storyMatch) {
      const story = await this.workspaceRepo.getStoryByProjectAndKey(projectId, storyMatch[0].toUpperCase());
      if (story) {
        return { epicId: story.epicId, storyId: story.id, storyKey: story.key };
      }
    }
    const epicMatch = branch.match(/EPIC-[A-Za-z0-9]+/i);
    if (epicMatch) {
      const epic = await this.workspaceRepo.getEpicByKey(projectId, epicMatch[0].toUpperCase());
      if (epic) {
        return {
          epicId: epic.id,
          epicKey: epic.key,
          storyId: sourceTask.userStoryId ?? epic.id,
          storyKey: sourceTask.storyKey ?? suggestion.storyKeyHint ?? epic.key,
        };
      }
    }
    if (suggestion.epicKeyHint) {
      const epic = await this.workspaceRepo.getEpicByKey(projectId, suggestion.epicKeyHint);
      if (epic) {
        return {
          epicId: epic.id,
          epicKey: epic.key,
          storyId: sourceTask.userStoryId ?? epic.id,
          storyKey: sourceTask.storyKey ?? suggestion.storyKeyHint ?? epic.key,
        };
      }
    }
    if (sourceTask.epicId && sourceTask.userStoryId) {
      return { epicId: sourceTask.epicId, storyId: sourceTask.userStoryId, storyKey: sourceTask.storyKey, epicKey: sourceTask.epicKey };
    }
    const container = await this.ensureBugContainer(projectId);
    return { epicId: container.epicId, storyId: container.storyId, storyKey: container.storyKey, epicKey: container.epicKey };
  }
}
