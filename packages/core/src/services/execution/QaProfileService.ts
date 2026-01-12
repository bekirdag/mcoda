import path from 'node:path';
import { TaskRow } from '@mcoda/db';
import { PathHelper } from '@mcoda/shared';
import { QaProfile } from '@mcoda/shared/qa/QaProfile.js';
import fs from 'node:fs/promises';

export interface QaProfileResolutionOptions {
  profileName?: string;
  level?: string;
  defaultLevel?: string;
}

const DEFAULT_QA_PROFILES: QaProfile[] = [
  {
    name: 'cli',
    runner: 'cli',
    default: true,
  },
  {
    name: 'chromium',
    runner: 'chromium',
  },
];

export class QaProfileService {
  private cache?: QaProfile[];
  private webInterfaceCache?: boolean;
  private routingCache?: {
    defaultProfile?: string;
    levels?: Record<string, string>;
    taskTypes?: Record<string, string>;
    tags?: Record<string, string>;
  };

  constructor(private workspaceRoot: string) {}

  private async fileExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async readPackageJson(): Promise<Record<string, any> | undefined> {
    const pkgPath = path.join(this.workspaceRoot, 'package.json');
    try {
      const raw = await fs.readFile(pkgPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private async detectWebInterface(): Promise<boolean> {
    if (this.webInterfaceCache !== undefined) return this.webInterfaceCache;
    const markers = [
      'client',
      'frontend',
      'web',
      'ui',
      'apps/web',
      'apps/client',
      'packages/web',
      'packages/client',
      'public/index.html',
      'index.html',
      'src/App.tsx',
      'src/main.tsx',
      'src/App.jsx',
      'src/main.jsx',
      'next.config.js',
      'next.config.mjs',
      'vite.config.ts',
      'vite.config.js',
      'svelte.config.js',
      'angular.json',
      'nuxt.config.js',
      'astro.config.mjs',
      'remix.config.js',
    ];
    for (const marker of markers) {
      if (await this.fileExists(path.join(this.workspaceRoot, marker))) {
        this.webInterfaceCache = true;
        return true;
      }
    }
    const pkg = await this.readPackageJson();
    const deps = {
      ...(pkg?.dependencies ?? {}),
      ...(pkg?.devDependencies ?? {}),
      ...(pkg?.peerDependencies ?? {}),
    };
    const uiDeps = [
      'react',
      'next',
      'vue',
      'nuxt',
      'svelte',
      'astro',
      '@angular/core',
      '@remix-run/react',
      'solid-js',
    ];
    const hasUiDep = uiDeps.some((dep) => typeof deps?.[dep] === 'string');
    this.webInterfaceCache = hasUiDep;
    return hasUiDep;
  }

  private detectUiTask(task: TaskRow & { metadata?: any }): boolean {
    const metadata = (task.metadata as any) ?? {};
    const tags: string[] = Array.isArray(metadata.tags) ? metadata.tags.map((t: string) => t.toLowerCase()) : [];
    const uiTags = new Set([
      'ui',
      'frontend',
      'front-end',
      'client',
      'web',
      'react',
      'vue',
      'svelte',
      'angular',
      'next',
      'nuxt',
      'astro',
    ]);
    if (tags.some((tag) => uiTags.has(tag))) return true;
    const files: string[] = Array.isArray(metadata.files) ? metadata.files : [];
    const uiHints = [
      '/ui/',
      '/frontend/',
      '/client/',
      '/web/',
      '/components/',
      '/pages/',
      '/app/',
      '/public/',
      '/styles/',
    ];
    const uiExtensions = ['.tsx', '.jsx', '.vue', '.svelte', '.astro', '.html', '.css', '.scss', '.less'];
    for (const file of files) {
      const normalized = String(file).toLowerCase();
      if (uiExtensions.some((ext) => normalized.endsWith(ext))) return true;
      if (uiHints.some((hint) => normalized.includes(hint))) return true;
    }
    return false;
  }

  private async resolveRunnerPreference(task?: TaskRow & { metadata?: any }): Promise<'chromium' | 'cli'> {
    if (task && this.detectUiTask(task)) return 'chromium';
    const hasUi = await this.detectWebInterface();
    return hasUi ? 'chromium' : 'cli';
  }

  private get profilePath(): string {
    return path.join(this.workspaceRoot, '.mcoda', 'qa-profiles.json');
  }

  private get workspaceConfigPath(): string {
    return path.join(this.workspaceRoot, '.mcoda', 'config.json');
  }

  private async getConfiguredDefaultProfileName(): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(this.workspaceConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed?.qa?.defaultProfile ?? parsed?.qa?.default_profile ?? parsed?.qaDefaultProfile;
    } catch {
      return undefined;
    }
  }

  private async getRoutingConfig(): Promise<{
    defaultProfile?: string;
    levels?: Record<string, string>;
    taskTypes?: Record<string, string>;
    tags?: Record<string, string>;
  }> {
    if (this.routingCache) return this.routingCache;
    try {
      const raw = await fs.readFile(this.workspaceConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      const qa = parsed?.qa ?? {};
      this.routingCache = {
        defaultProfile: qa.defaultProfile ?? qa.default_profile ?? qa.default,
        levels: qa.routing?.levels ?? qa.routing?.level ?? qa.levelRouting ?? undefined,
        taskTypes: qa.routing?.taskTypes ?? qa.routing?.types ?? qa.typeRouting ?? undefined,
        tags: qa.routing?.tags ?? undefined,
      };
      return this.routingCache;
    } catch {
      this.routingCache = {};
      return this.routingCache;
    }
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
      this.cache = DEFAULT_QA_PROFILES;
      return this.cache;
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        this.cache = DEFAULT_QA_PROFILES;
        return this.cache;
      }
      throw error;
    }
  }

  async resolveProfileForTask(task: TaskRow & { metadata?: any }, options: QaProfileResolutionOptions = {}): Promise<QaProfile | undefined> {
    const profiles = await this.loadProfiles();
    if (!profiles.length) return undefined;
    const envProfile = process.env.MCODA_QA_PROFILE;
    const routing = await this.getRoutingConfig();
    const runnerPreference = await this.resolveRunnerPreference(task);
    const normalizeRunner = (profile: QaProfile): string => profile.runner ?? 'cli';
    const matchRunner = (profile: QaProfile): boolean =>
      normalizeRunner(profile) === runnerPreference || profile.name === runnerPreference;
    const pickByRunner = (): QaProfile | undefined => {
      const matches = profiles.filter(matchRunner);
      if (!matches.length) return undefined;
      const defaults = matches.filter((p) => p.default);
      if (defaults.length === 1) return defaults[0];
      return matches[0];
    };
    const configuredDefault = options.profileName ?? envProfile ?? (await this.getConfiguredDefaultProfileName()) ?? routing.defaultProfile;
    const pickByName = (name: string | undefined): QaProfile | undefined => {
      if (!name) return undefined;
      const match = profiles.find((p) => p.name === name);
      if (!match) {
        throw new Error(`QA profile not found: ${name}`);
      }
      return match;
    };
    const explicit = pickByName(configuredDefault);
    if (explicit) {
      if (normalizeRunner(explicit) !== runnerPreference) {
        const fallback = pickByRunner();
        if (fallback) return fallback;
      }
      return explicit;
    }
    const taskTags: string[] = Array.isArray((task.metadata as any)?.tags)
      ? ((task.metadata as any).tags as string[]).map((t) => t.toLowerCase())
      : [];
    let candidates = profiles.filter((profile) => {
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
    if (routing) {
      const levelRoute = options.level && routing.levels ? routing.levels[options.level] : undefined;
      const typeRoute = task.type && routing.taskTypes ? routing.taskTypes[task.type] : undefined;
      const tagRoute =
        routing.tags && taskTags.length
          ? taskTags.map((tag) => routing.tags?.[tag]).find((name): name is string => Boolean(name))
          : undefined;
      const routedName = levelRoute ?? typeRoute ?? tagRoute;
      const routed = pickByName(routedName);
      if (routed) {
        if (normalizeRunner(routed) !== runnerPreference) {
          const fallback = pickByRunner();
          if (fallback) return fallback;
        }
        return routed;
      }
    }
    const runnerCandidates = candidates.filter(matchRunner);
    if (runnerCandidates.length) {
      candidates = runnerCandidates;
    }
    const targetLevel = options.level ?? options.defaultLevel;
    if (targetLevel) {
      const levelMatches = candidates.filter((p) => (p.level ?? (p as any).qa_level) === targetLevel);
      if (levelMatches.length === 1) return levelMatches[0];
      if (levelMatches.length > 1) candidates = levelMatches;
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      const defaults = candidates.filter((p) => p.default);
      if (defaults.length === 1) return defaults[0];
      if (defaults.length > 1) {
        throw new Error('Multiple default QA profiles configured; specify --profile.');
      }
      throw new Error(
        `Multiple QA profiles match task (${task.key}); please specify --profile. Candidates: ${candidates
          .map((p) => p.name)
          .join(', ')}`,
      );
    }
    const runnerDefault = pickByRunner();
    if (runnerDefault) return runnerDefault;
    const defaults = profiles.filter((p) => p.default);
    if (defaults.length === 1) return defaults[0];
    if (defaults.length > 1) {
      throw new Error('Multiple default QA profiles configured; please specify --profile.');
    }
    return undefined;
  }
}
