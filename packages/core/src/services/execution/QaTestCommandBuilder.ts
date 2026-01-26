import fs from 'node:fs';
import path from 'node:path';
import { TaskRow } from '@mcoda/db';
import {
  QA_TEST_CATEGORY_ORDER,
  type QaTestCategory,
  type QaTechStackId,
} from '@mcoda/shared';

type TestRequirements = {
  unit: string[];
  component: string[];
  integration: string[];
  api: string[];
};

export type QaTestCommandPlan = {
  commands: string[];
  source: 'override' | 'plan' | 'metadata' | 'profile' | 'stack' | 'fallback' | 'none';
  categories: QaTestCategory[];
  stack?: QaTechStackId;
};

export type QaTestCommandBuildInput = {
  task: TaskRow & { metadata?: any };
  planCommands?: string[];
  cliOverride?: string;
  profileCommand?: string;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeTestRequirements = (value: unknown): TestRequirements => {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    unit: normalizeStringArray(raw.unit),
    component: normalizeStringArray(raw.component),
    integration: normalizeStringArray(raw.integration),
    api: normalizeStringArray(raw.api),
  };
};

const normalizeTestCommands = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return normalizeStringArray(value);
};

const hasRequirements = (requirements: TestRequirements): boolean =>
  requirements.unit.length > 0 ||
  requirements.component.length > 0 ||
  requirements.integration.length > 0 ||
  requirements.api.length > 0;

const normalizeCommands = (commands: string[] | undefined): string[] =>
  (commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);

export class QaTestCommandBuilder {
  constructor(private workspaceRoot: string) {}

  async build(input: QaTestCommandBuildInput): Promise<QaTestCommandPlan> {
    if (input.cliOverride) {
      return {
        commands: [input.cliOverride],
        source: 'override',
        categories: [],
      };
    }

    const planCommands = normalizeCommands(input.planCommands);
    if (planCommands.length) {
      return {
        commands: planCommands,
        source: 'plan',
        categories: [],
      };
    }

    const metadata = (input.task.metadata as any) ?? {};
    const metadataCommands = normalizeTestCommands(metadata.tests ?? metadata.testCommands);
    if (metadataCommands.length) {
      return {
        commands: metadataCommands,
        source: 'metadata',
        categories: [],
      };
    }

    const profileCommand = input.profileCommand?.trim();
    if (profileCommand) {
      return {
        commands: [profileCommand],
        source: 'profile',
        categories: [],
      };
    }

    const requirements = normalizeTestRequirements(
      metadata.test_requirements ?? metadata.testRequirements,
    );
    const categories = QA_TEST_CATEGORY_ORDER.filter(
      (category) => requirements[category].length > 0,
    );
    const stack = await this.detectPrimaryStack(input.task);

    const commands = await this.buildStackCommands(stack, categories);
    if (commands.length) {
      return { commands, source: 'stack', categories, stack };
    }

    const fallback = await this.resolveFallbackCommand(stack);
    if (fallback) {
      return {
        commands: [fallback],
        source: 'fallback',
        categories,
        stack,
      };
    }

    return { commands: [], source: 'none', categories, stack };
  }

  private async buildStackCommands(
    stack: QaTechStackId | undefined,
    categories: QaTestCategory[],
  ): Promise<string[]> {
    if (!stack || categories.length === 0) return [];
    if (stack === 'node' || stack === 'react-native') {
      return this.buildNodeCategoryCommands(categories);
    }
    if (stack === 'python') return this.buildPythonCategoryCommands(categories);
    if (stack === 'dotnet') return this.buildDotnetCategoryCommands(categories);
    if (stack === 'java') return this.buildJavaCategoryCommands(categories);
    if (stack === 'go') return this.buildGoCategoryCommands(categories);
    if (stack === 'php') return this.buildPhpCategoryCommands(categories);
    if (stack === 'ruby') return this.buildRubyCategoryCommands(categories);
    if (stack === 'flutter') return this.buildFlutterCategoryCommands(categories);
    return [];
  }

  private async buildNodeCategoryCommands(categories: QaTestCategory[]): Promise<string[]> {
    const pkg = await this.readPackageJson();
    if (!pkg) return [];
    const pm = (await this.detectPackageManager()) ?? 'npm';
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const deps = this.collectPackageDeps(pkg);
    const runner = await this.resolveNodeRunner(deps);
    const scriptMap: Record<QaTestCategory, string[]> = {
      unit: ['test:unit', 'unit'],
      component: ['test:component', 'component', 'test:ui'],
      integration: ['test:integration', 'integration', 'test:int'],
      api: ['test:api', 'api'],
    };
    const commands: string[] = [];
    for (const category of categories) {
      const candidate = scriptMap[category].find((script) => typeof scripts[script] === 'string');
      if (candidate) {
        commands.push(this.buildScriptCommand(pm, candidate));
        continue;
      }
      if (runner) {
        const dir = await this.findCategoryDir(category, ['tests', 'test']);
        if (dir) {
          commands.push(this.buildNodeRunnerCommand(pm, runner, dir));
        }
      }
    }
    return commands;
  }

  private async buildPythonCategoryCommands(categories: QaTestCategory[]): Promise<string[]> {
    const runner = await this.resolvePythonRunner();
    return this.buildPathCategoryCommands(categories, ['tests', 'test'], (dir) => {
      if (runner === 'nose2') return `nose2 -s ${dir}`;
      return `pytest ${dir}`;
    });
  }

  private async buildDotnetCategoryCommands(categories: QaTestCategory[]): Promise<string[]> {
    const commands: string[] = [];
    for (const category of categories) {
      const dir = await this.findCategoryDir(category, ['tests', 'test']);
      if (!dir) continue;
      const absDir = path.join(this.workspaceRoot, dir);
      const csproj = await this.findFileByExtensionInDir(absDir, '.csproj');
      const target = csproj ? this.toRelativePath(csproj) : dir;
      commands.push(`dotnet test ${target}`);
    }
    return commands;
  }

  private async buildJavaCategoryCommands(categories: QaTestCategory[]): Promise<string[]> {
    const buildTool = await this.resolveJavaBuildTool();
    if (!buildTool) return [];
    const commands: string[] = [];
    for (const category of categories) {
      const dir = await this.findCategoryDir(category, ['src/test/java', 'src/test/kotlin']);
      if (!dir) continue;
      const filter = `*${category}*`;
      if (buildTool === 'maven') {
        commands.push(`mvn -Dtest=${filter} test`);
        continue;
      }
      const gradleBin = (await this.pathExists(path.join(this.workspaceRoot, 'gradlew')))
        ? './gradlew'
        : 'gradle';
      commands.push(`${gradleBin} test --tests "${filter}"`);
    }
    return commands;
  }

  private async buildFlutterCategoryCommands(categories: QaTestCategory[]): Promise<string[]> {
    const commands: string[] = [];
    for (const category of categories) {
      if (category === 'integration') {
        if (await this.pathExists(path.join(this.workspaceRoot, 'integration_test'))) {
          commands.push('flutter test integration_test');
        }
      } else if (category === 'unit') {
        commands.push('flutter test');
      }
    }
    return commands;
  }

  private async buildGoCategoryCommands(categories: QaTestCategory[]): Promise<string[]> {
    return this.buildPathCategoryCommands(categories, ['tests', 'test'], (dir) => `go test ./${dir}`);
  }

  private async buildPhpCategoryCommands(categories: QaTestCategory[]): Promise<string[]> {
    const vendorDir = path.join(this.workspaceRoot, 'vendor', 'bin');
    const pestBin = path.join(vendorDir, 'pest');
    const phpunitBin = path.join(vendorDir, 'phpunit');
    const runner = (await this.pathExists(pestBin))
      ? 'vendor/bin/pest'
      : (await this.pathExists(phpunitBin))
        ? 'vendor/bin/phpunit'
        : 'phpunit';
    return this.buildPathCategoryCommands(categories, ['tests', 'test'], (dir) => `${runner} ${dir}`);
  }

  private async buildRubyCategoryCommands(categories: QaTestCategory[]): Promise<string[]> {
    const commands: string[] = [];
    const hasRakefile = await this.pathExists(path.join(this.workspaceRoot, 'Rakefile'));
    for (const category of categories) {
      const specDir = await this.findCategoryDir(category, ['spec']);
      if (specDir) {
        commands.push(`bundle exec rspec ${specDir}`);
        continue;
      }
      const testDir = await this.findCategoryDir(category, ['test']);
      if (testDir && hasRakefile) {
        commands.push(`bundle exec rake test TEST=${testDir}`);
      } else if (testDir) {
        commands.push(this.buildMinitestCommand(testDir));
      }
    }
    return commands;
  }

  private collectPackageDeps(pkg: Record<string, any>): Record<string, unknown> {
    return {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    };
  }

  private hasPackageDep(deps: Record<string, unknown>, name: string): boolean {
    return typeof deps[name] === 'string';
  }

  private async detectViteUsage(deps: Record<string, unknown>): Promise<boolean> {
    if (this.hasPackageDep(deps, 'vite')) return true;
    return (
      (await this.pathExists(path.join(this.workspaceRoot, 'vite.config.ts'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'vite.config.js'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'vite.config.mjs')))
    );
  }

  private async resolveNodeRunner(
    deps: Record<string, unknown>,
  ): Promise<'vitest' | 'jest' | 'mocha' | 'ava'> {
    const runners = ['vitest', 'jest', 'mocha', 'ava'] as const;
    const existing = runners.find((runner) => this.hasPackageDep(deps, runner));
    if (existing) return existing;
    if (await this.detectViteUsage(deps)) return 'vitest';
    return 'jest';
  }

  private buildNodeRunnerCommand(
    pm: 'pnpm' | 'yarn' | 'npm',
    runner: 'vitest' | 'jest' | 'mocha' | 'ava',
    dir: string,
  ): string {
    const args = runner === 'vitest' ? `run ${dir}` : dir;
    if (pm === 'pnpm') return `pnpm ${runner} ${args}`;
    if (pm === 'yarn') return `yarn ${runner} ${args}`;
    return `npx ${runner} ${args}`;
  }

  private async resolvePythonRunner(): Promise<'pytest' | 'nose2'> {
    if (
      (await this.pathExists(path.join(this.workspaceRoot, 'nose2.cfg'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'nose2.conf')))
    ) {
      return 'nose2';
    }
    return 'pytest';
  }

  private async resolveJavaBuildTool(): Promise<'maven' | 'gradle' | undefined> {
    if (await this.pathExists(path.join(this.workspaceRoot, 'pom.xml'))) return 'maven';
    if (
      (await this.pathExists(path.join(this.workspaceRoot, 'gradlew'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'build.gradle'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'build.gradle.kts')))
    ) {
      return 'gradle';
    }
    return undefined;
  }

  private async findFileByExtensionInDir(
    dir: string,
    extension: string,
  ): Promise<string | undefined> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.toLowerCase().endsWith(extension)) {
          return path.join(dir, entry.name);
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private buildMinitestCommand(dir: string): string {
    const pattern = `${dir.replace(/\/$/, '')}/**/*_test.rb`;
    return `bundle exec ruby -I test -e "Dir['${pattern}'].each { |f| require f }"`;
  }

  private async resolveFallbackCommand(
    stack: QaTechStackId | undefined,
  ): Promise<string | undefined> {
    if (await this.pathExists(path.join(this.workspaceRoot, 'tests', 'all.js'))) {
      return 'node tests/all.js';
    }
    if (stack === 'node' || stack === 'react-native') {
      const pkg = await this.readPackageJson();
      if (pkg?.scripts?.test) {
        const pm = (await this.detectPackageManager()) ?? 'npm';
        return `${pm} test`;
      }
    }
    if (stack === 'python') return 'pytest';
    if (stack === 'dotnet') return 'dotnet test';
    if (stack === 'java') {
      if (await this.pathExists(path.join(this.workspaceRoot, 'pom.xml'))) return 'mvn test';
      const gradlew = path.join(this.workspaceRoot, 'gradlew');
      return (await this.pathExists(gradlew)) ? './gradlew test' : 'gradle test';
    }
    if (stack === 'go') return 'go test ./...';
    if (stack === 'php') {
      const vendorBin = path.join(this.workspaceRoot, 'vendor', 'bin', 'phpunit');
      return (await this.pathExists(vendorBin)) ? 'vendor/bin/phpunit' : 'phpunit';
    }
    if (stack === 'ruby') return 'bundle exec rspec';
    if (stack === 'flutter') return 'flutter test';
    if (stack === 'ios') return 'xcodebuild test';
    if (stack === 'android') return './gradlew test';
    return undefined;
  }

  private async detectPrimaryStack(
    task: TaskRow & { metadata?: any },
  ): Promise<QaTechStackId | undefined> {
    const metadata = (task.metadata as any) ?? {};
    const files = normalizeStringArray(metadata.files);
    const reviewFiles = normalizeStringArray(metadata.last_review_changed_paths);
    const combined = [...files, ...reviewFiles];
    const fromFiles = this.detectStackFromPaths(combined);
    if (fromFiles) return fromFiles;

    if (await this.pathExists(path.join(this.workspaceRoot, 'package.json'))) {
      const pkg = await this.readPackageJson();
      const deps = {
        ...(pkg?.dependencies ?? {}),
        ...(pkg?.devDependencies ?? {}),
        ...(pkg?.peerDependencies ?? {}),
      } as Record<string, unknown>;
      if (typeof deps['react-native'] === 'string' || typeof deps.expo === 'string') {
        return 'react-native';
      }
      return 'node';
    }
    if (
      (await this.pathExists(path.join(this.workspaceRoot, 'pyproject.toml'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'requirements.txt'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'Pipfile')))
    ) {
      return 'python';
    }
    if (await this.findFileByExtension('.csproj')) return 'dotnet';
    if (
      (await this.pathExists(path.join(this.workspaceRoot, 'pom.xml'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'build.gradle'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'build.gradle.kts')))
    ) {
      return 'java';
    }
    if (await this.pathExists(path.join(this.workspaceRoot, 'go.mod'))) return 'go';
    if (await this.pathExists(path.join(this.workspaceRoot, 'composer.json'))) return 'php';
    if (await this.pathExists(path.join(this.workspaceRoot, 'Gemfile'))) return 'ruby';
    if (await this.pathExists(path.join(this.workspaceRoot, 'pubspec.yaml'))) return 'flutter';
    if (
      (await this.pathExists(path.join(this.workspaceRoot, 'ios', 'Podfile'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'Package.swift')))
    ) {
      return 'ios';
    }
    if (
      (await this.pathExists(path.join(this.workspaceRoot, 'android', 'build.gradle'))) ||
      (await this.pathExists(path.join(this.workspaceRoot, 'android', 'build.gradle.kts')))
    ) {
      return 'android';
    }
    return undefined;
  }

  private detectStackFromPaths(paths: string[]): QaTechStackId | undefined {
    for (const raw of paths) {
      const value = raw.toLowerCase();
      if (value.includes('/android/')) return 'android';
      if (value.includes('/ios/')) return 'ios';
      if (value.endsWith('.dart')) return 'flutter';
      if (value.endsWith('.swift')) return 'ios';
      if (value.endsWith('.kt') || value.endsWith('.kts')) return 'android';
      if (value.endsWith('.java') || value.endsWith('.gradle')) return 'java';
      if (value.endsWith('.cs') || value.endsWith('.csproj')) return 'dotnet';
      if (value.endsWith('.go')) return 'go';
      if (value.endsWith('.php')) return 'php';
      if (value.endsWith('.rb')) return 'ruby';
      if (
        value.endsWith('.ts') ||
        value.endsWith('.tsx') ||
        value.endsWith('.js') ||
        value.endsWith('.jsx') ||
        value.endsWith('.mjs') ||
        value.endsWith('.cjs')
      ) {
        return 'node';
      }
      if (value.endsWith('.py')) return 'python';
    }
    return undefined;
  }

  private async readPackageJson(): Promise<Record<string, any> | undefined> {
    const pkgPath = path.join(this.workspaceRoot, 'package.json');
    try {
      const raw = await fs.promises.readFile(pkgPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private async detectPackageManager(): Promise<'pnpm' | 'yarn' | 'npm' | undefined> {
    if (await this.pathExists(path.join(this.workspaceRoot, 'pnpm-lock.yaml'))) return 'pnpm';
    if (await this.pathExists(path.join(this.workspaceRoot, 'pnpm-workspace.yaml'))) return 'pnpm';
    if (await this.pathExists(path.join(this.workspaceRoot, 'yarn.lock'))) return 'yarn';
    if (await this.pathExists(path.join(this.workspaceRoot, 'package-lock.json'))) return 'npm';
    if (await this.pathExists(path.join(this.workspaceRoot, 'npm-shrinkwrap.json'))) return 'npm';
    if (await this.pathExists(path.join(this.workspaceRoot, 'package.json'))) return 'npm';
    return undefined;
  }

  private buildScriptCommand(pm: 'pnpm' | 'yarn' | 'npm', script: string): string {
    if (pm === 'yarn') return `yarn ${script}`;
    if (pm === 'pnpm') return `pnpm ${script}`;
    return `npm run ${script}`;
  }

  private async buildPathCategoryCommands(
    categories: QaTestCategory[],
    roots: string[],
    build: (dir: string) => string,
  ): Promise<string[]> {
    const commands: string[] = [];
    for (const category of categories) {
      const dir = await this.findCategoryDir(category, roots);
      if (dir) commands.push(build(dir));
    }
    return commands;
  }

  private async findCategoryDir(
    category: QaTestCategory,
    roots: string[],
  ): Promise<string | undefined> {
    for (const root of roots) {
      const candidate = path.join(this.workspaceRoot, root, category);
      if (await this.pathExists(candidate)) {
        return this.toRelativePath(candidate);
      }
    }
    return undefined;
  }

  private toRelativePath(targetPath: string): string {
    return path.relative(this.workspaceRoot, targetPath).split(path.sep).join('/');
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.promises.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async findFileByExtension(extension: string): Promise<boolean> {
    try {
      const entries = await fs.promises.readdir(this.workspaceRoot);
      return entries.some((entry) => entry.toLowerCase().endsWith(extension));
    } catch {
      return false;
    }
  }
}
