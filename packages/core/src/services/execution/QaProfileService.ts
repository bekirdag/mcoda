import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskRow } from '@mcoda/db';
import { PathHelper } from '@mcoda/shared';
import { QaProfile } from '@mcoda/shared/qa/QaProfile.js';

export interface QaProfileResolutionOptions {
  profileName?: string;
  level?: string;
}

export class QaProfileService {
  private cache?: QaProfile[];

  constructor(private workspaceRoot: string) {}

  private get profilePath(): string {
    return path.join(this.workspaceRoot, '.mcoda', 'qa-profiles.json');
  }

  async loadProfiles(): Promise<QaProfile[]> {
    if (this.cache) return this.cache;
    await PathHelper.ensureDir(path.join(this.workspaceRoot, '.mcoda'));
    try {
      const raw = await fs.readFile(this.profilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.cache = parsed as QaProfile[];
        return this.cache;
      }
      if (Array.isArray((parsed as any)?.profiles)) {
        this.cache = (parsed as any).profiles as QaProfile[];
        return this.cache;
      }
      this.cache = [];
      return this.cache;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        this.cache = [];
        return this.cache;
      }
      throw error;
    }
  }

  async resolveProfileForTask(task: TaskRow & { metadata?: any }, options: QaProfileResolutionOptions = {}): Promise<QaProfile | undefined> {
    const profiles = await this.loadProfiles();
    if (!profiles.length) return undefined;
    if (options.profileName) {
      const match = profiles.find((p) => p.name === options.profileName);
      if (!match) {
        throw new Error(`QA profile not found: ${options.profileName}`);
      }
      return match;
    }
    const taskTags: string[] = Array.isArray((task.metadata as any)?.tags)
      ? ((task.metadata as any).tags as string[]).map((t) => t.toLowerCase())
      : [];
    const candidates = profiles.filter((profile) => {
      const typeMatch =
        !profile.matcher?.task_types ||
        profile.matcher.task_types.length === 0 ||
        (task.type ? profile.matcher.task_types.includes(task.type) : false);
      const tagMatch =
        !profile.matcher?.tags ||
        profile.matcher.tags.length === 0 ||
        profile.matcher.tags.some((tag) => taskTags.includes(tag.toLowerCase()));
      return typeMatch && tagMatch;
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      if (options.level) {
        const levelMatches = candidates.filter((p) => (p as any).level === options.level);
        if (levelMatches.length === 1) return levelMatches[0];
      }
      const defaults = candidates.filter((p) => p.default);
      if (defaults.length === 1) return defaults[0];
      return candidates[0];
    }
    const defaults = profiles.filter((p) => p.default);
    if (defaults.length === 1) return defaults[0];
    if (defaults.length > 1) {
      throw new Error('Multiple default QA profiles configured; please specify --profile.');
    }
    return undefined;
  }
}
