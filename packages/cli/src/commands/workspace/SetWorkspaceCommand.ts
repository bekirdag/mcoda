import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { createRequire } from "node:module";
import { WorkspaceResolver, ensureProjectGuidance } from "@mcoda/core";
import { WorkspaceRepository } from "@mcoda/db";

const USAGE =
  "Usage: mcoda set-workspace [--workspace-root <path>] [--no-git] [--no-docdex] [--codex-no-sandbox[=true|false]]";
const DOCDEX_ENV_URLS = ["MCODA_DOCDEX_URL", "DOCDEX_URL"];

const parseBooleanFlag = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return defaultValue;
};

export const parseSetWorkspaceArgs = (
  argv: string[],
): { workspaceRoot?: string; git: boolean; docdex: boolean; codexNoSandbox?: boolean } => {
  let workspaceRoot: string | undefined;
  let git = true;
  let docdex = true;
  let codexNoSandbox: boolean | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--codex-no-sandbox": {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          codexNoSandbox = parseBooleanFlag(next, true);
          i += 1;
        } else {
          codexNoSandbox = true;
        }
        break;
      }
      case "--workspace-root":
        workspaceRoot = argv[i + 1];
        i += 1;
        break;
      case "--no-git":
        git = false;
        break;
      case "--no-docdex":
        docdex = false;
        break;
      case "--help":
      case "-h":
        throw new Error(USAGE);
      default:
        if (arg.startsWith("--codex-no-sandbox=")) {
          const [, raw] = arg.split("=", 2);
          codexNoSandbox = parseBooleanFlag(raw, true);
        }
        break;
    }
  }
  return { workspaceRoot, git, docdex, codexNoSandbox };
};

type StackId =
  | "node"
  | "python"
  | "dotnet"
  | "java"
  | "go"
  | "php"
  | "ruby"
  | "flutter"
  | "react-native"
  | "ios"
  | "android";

type StackInstallResult = {
  stack: StackId;
  installed: string[];
  skipped: string[];
  error?: string;
};
type ProjectKeyCandidate = { key: string; createdAt?: string | null };

type JavaBuildKind = "maven" | "gradle" | "gradle-kts";
type JavaDependency = {
  groupId: string;
  artifactId: string;
  version: string;
  scope?: "test";
};

const AST_STACK_TEST_PACKAGES: Record<
  StackId,
  { label: string; packages: string[]; tsPackages?: string[] }
> = {
  node: {
    label: "Node.js/TypeScript",
    packages: [
      "supertest",
      "nock",
      "axios-mock-adapter",
      "mocha",
      "chai",
      "ava",
      "cypress",
      "puppeteer",
      "@jest/globals",
    ],
    tsPackages: ["@types/supertest"],
  },
  python: {
    label: "Python",
    packages: ["pytest", "requests", "httpx", "pytest-httpx", "nose2", "selenium"],
  },
  dotnet: {
    label: "C#/.NET",
    packages: [
      "xunit",
      "NUnit",
      "MSTest.TestFramework",
      "MSTest.TestAdapter",
      "Moq",
      "NSubstitute",
      "FakeItEasy",
      "RestSharp",
      "WireMock.Net",
      "Selenium.WebDriver",
    ],
  },
  java: {
    label: "Java",
    packages: [],
  },
  go: {
    label: "Go",
    packages: [],
  },
  php: {
    label: "PHP",
    packages: [],
  },
  ruby: {
    label: "Ruby",
    packages: [],
  },
  flutter: {
    label: "Flutter",
    packages: [],
  },
  "react-native": {
    label: "React Native",
    packages: [],
  },
  ios: {
    label: "iOS",
    packages: [],
  },
  android: {
    label: "Android",
    packages: [],
  },
};

const DOTNET_SCAN_EXCLUDES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bin",
  "obj",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
]);

const DOTNET_SCAN_DEPTH = 4;

const JAVA_TEST_DEPENDENCIES: JavaDependency[] = [
  {
    groupId: "org.junit.jupiter",
    artifactId: "junit-jupiter",
    version: "5.10.2",
    scope: "test",
  },
  {
    groupId: "org.testng",
    artifactId: "testng",
    version: "7.10.2",
    scope: "test",
  },
  {
    groupId: "org.mockito",
    artifactId: "mockito-core",
    version: "5.11.0",
    scope: "test",
  },
  {
    groupId: "io.mockk",
    artifactId: "mockk",
    version: "1.13.10",
    scope: "test",
  },
  {
    groupId: "org.springframework",
    artifactId: "spring-test",
    version: "6.1.6",
    scope: "test",
  },
  {
    groupId: "io.rest-assured",
    artifactId: "rest-assured",
    version: "5.4.0",
    scope: "test",
  },
  {
    groupId: "com.github.tomakehurst",
    artifactId: "wiremock-jre8",
    version: "2.35.0",
    scope: "test",
  },
  {
    groupId: "org.seleniumhq.selenium",
    artifactId: "selenium-java",
    version: "4.17.0",
    scope: "test",
  },
];

const javaDependencyId = (dep: JavaDependency): string =>
  `${dep.groupId}:${dep.artifactId}`;

const GO_TEST_PACKAGES = [
  "github.com/stretchr/testify",
  "github.com/golang/mock/gomock",
  "github.com/onsi/ginkgo/v2",
  "github.com/onsi/gomega",
  "github.com/go-resty/resty/v2",
];

const PHP_TEST_PACKAGES = [
  "phpunit/phpunit",
  "pestphp/pest",
  "laravel/dusk",
  "symfony/browser-kit",
  "symfony/css-selector",
];

const RUBY_TEST_GEMS = ["rspec", "minitest", "rack-test", "capybara"];

const FLUTTER_TEST_PACKAGES = ["flutter_test", "integration_test", "mockito"];

const REACT_NATIVE_TEST_PACKAGES = [
  "jest",
  "@testing-library/react-native",
  "detox",
];

const IOS_TEST_PODS = ["Quick", "Nimble"];

type AndroidDependency = { configuration: string; coordinate: string };

const ANDROID_TEST_DEPENDENCIES: AndroidDependency[] = [
  { configuration: "testImplementation", coordinate: "junit:junit:4.13.2" },
  {
    configuration: "androidTestImplementation",
    coordinate: "androidx.test.espresso:espresso-core:3.5.1",
  },
  { configuration: "testImplementation", coordinate: "io.mockk:mockk:1.13.10" },
];

const fileExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const readTextFile = async (targetPath: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return undefined;
  }
};

const readPackageJson = async (
  workspaceRoot: string,
): Promise<Record<string, unknown> | undefined> => {
  const pkgPath = path.join(workspaceRoot, "package.json");
  const raw = await readTextFile(pkgPath);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const detectJavaStack = async (workspaceRoot: string): Promise<boolean> => {
  return (
    (await fileExists(path.join(workspaceRoot, "pom.xml"))) ||
    (await fileExists(path.join(workspaceRoot, "build.gradle"))) ||
    (await fileExists(path.join(workspaceRoot, "build.gradle.kts")))
  );
};

const detectGoStack = async (workspaceRoot: string): Promise<boolean> => {
  return await fileExists(path.join(workspaceRoot, "go.mod"));
};

const detectPhpStack = async (workspaceRoot: string): Promise<boolean> => {
  return await fileExists(path.join(workspaceRoot, "composer.json"));
};

const detectRubyStack = async (workspaceRoot: string): Promise<boolean> => {
  return await fileExists(path.join(workspaceRoot, "Gemfile"));
};

const detectFlutterStack = async (workspaceRoot: string): Promise<boolean> => {
  const pubspec = await readTextFile(path.join(workspaceRoot, "pubspec.yaml"));
  if (!pubspec) return false;
  return /(^|\n)\s*flutter\s*:/i.test(pubspec);
};

const detectReactNativeStack = async (
  workspaceRoot: string,
  pkg?: Record<string, unknown>,
): Promise<boolean> => {
  const resolved = pkg ?? (await readPackageJson(workspaceRoot));
  if (!resolved) return false;
  const deps = {
    ...(resolved.dependencies as Record<string, unknown> | undefined),
    ...(resolved.devDependencies as Record<string, unknown> | undefined),
    ...(resolved.peerDependencies as Record<string, unknown> | undefined),
  };
  return (
    typeof deps["react-native"] === "string" ||
    typeof deps.expo === "string"
  );
};

const detectIosStack = async (workspaceRoot: string): Promise<boolean> => {
  if (await fileExists(path.join(workspaceRoot, "Package.swift"))) return true;
  if (await fileExists(path.join(workspaceRoot, "ios", "Podfile"))) return true;
  const candidates = [workspaceRoot, path.join(workspaceRoot, "ios")];
  for (const base of candidates) {
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      if (
        entries.some(
          (entry) =>
            entry.isDirectory() &&
            (entry.name.endsWith(".xcodeproj") ||
              entry.name.endsWith(".xcworkspace")),
        )
      ) {
        return true;
      }
    } catch {
      // ignore missing directories
    }
  }
  return false;
};

const detectAndroidStack = async (workspaceRoot: string): Promise<boolean> => {
  const androidRoot = path.join(workspaceRoot, "android");
  return (
    (await fileExists(path.join(androidRoot, "build.gradle"))) ||
    (await fileExists(path.join(androidRoot, "build.gradle.kts"))) ||
    (await fileExists(path.join(androidRoot, "app", "build.gradle"))) ||
    (await fileExists(path.join(androidRoot, "app", "build.gradle.kts")))
  );
};

const hasDependency = (pkg: Record<string, unknown> | undefined, dep: string): boolean => {
  if (!pkg) return false;
  const collect = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const dependencies = {
    ...collect(pkg.dependencies),
    ...collect(pkg.devDependencies),
    ...collect(pkg.peerDependencies),
  };
  return typeof dependencies[dep] === "string";
};

const detectNodePackageManager = async (
  workspaceRoot: string,
): Promise<"pnpm" | "yarn" | "npm" | undefined> => {
  if (await fileExists(path.join(workspaceRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(workspaceRoot, "pnpm-workspace.yaml"))) return "pnpm";
  if (await fileExists(path.join(workspaceRoot, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(workspaceRoot, "package-lock.json"))) return "npm";
  if (await fileExists(path.join(workspaceRoot, "npm-shrinkwrap.json"))) return "npm";
  if (await fileExists(path.join(workspaceRoot, "package.json"))) return "npm";
  return undefined;
};

const detectTypescriptUsage = async (
  workspaceRoot: string,
  pkg?: Record<string, unknown>,
): Promise<boolean> => {
  if (await fileExists(path.join(workspaceRoot, "tsconfig.json"))) return true;
  if (await fileExists(path.join(workspaceRoot, "tsconfig.base.json"))) return true;
  return (
    hasDependency(pkg, "typescript") ||
    hasDependency(pkg, "ts-node") ||
    hasDependency(pkg, "@types/node")
  );
};

const detectViteUsage = async (
  workspaceRoot: string,
  pkg?: Record<string, unknown>,
): Promise<boolean> => {
  if (await fileExists(path.join(workspaceRoot, "vite.config.ts"))) return true;
  if (await fileExists(path.join(workspaceRoot, "vite.config.js"))) return true;
  if (await fileExists(path.join(workspaceRoot, "vite.config.mjs"))) return true;
  return hasDependency(pkg, "vite");
};

const detectUiFramework = (
  pkg?: Record<string, unknown>,
): { react: boolean; vue: boolean; svelte: boolean } => {
  const react =
    hasDependency(pkg, "react") ||
    hasDependency(pkg, "react-dom") ||
    hasDependency(pkg, "next") ||
    hasDependency(pkg, "@remix-run/react");
  const vue = hasDependency(pkg, "vue") || hasDependency(pkg, "nuxt");
  const svelte = hasDependency(pkg, "svelte");
  return { react, vue, svelte };
};

export const resolveNodeTestPackages = async (
  workspaceRoot: string,
  pkg: Record<string, unknown>,
): Promise<{ packages: string[]; tsPackages: string[]; runner?: string }> => {
  const base = new Set(AST_STACK_TEST_PACKAGES.node.packages);
  if (hasDependency(pkg, "axios")) {
    base.add("axios-mock-adapter");
  }
  const runners = ["vitest", "jest", "mocha", "ava"];
  const existingRunner = runners.find((runner) => hasDependency(pkg, runner));
  let runner = existingRunner;
  if (!runner) {
    runner = (await detectViteUsage(workspaceRoot, pkg)) ? "vitest" : "jest";
    base.add(runner);
  }
  const ui = detectUiFramework(pkg);
  if (ui.react) base.add("@testing-library/react");
  if (ui.vue) base.add("@testing-library/vue");
  if (ui.svelte) base.add("@testing-library/svelte");
  const tsPackages = (await detectTypescriptUsage(workspaceRoot, pkg))
    ? AST_STACK_TEST_PACKAGES.node.tsPackages ?? []
    : [];
  return { packages: Array.from(base), tsPackages, runner };
};

const runCommand = (
  command: string,
  cwd: string,
): { ok: boolean; error?: string } => {
  try {
    execSync(command, { cwd, stdio: "inherit" });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
};

const installNodeTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const pkg = await readPackageJson(workspaceRoot);
  if (!pkg) return null;
  const resolved = await resolveNodeTestPackages(workspaceRoot, pkg);
  const packages = [...resolved.packages, ...resolved.tsPackages];
  const missing = packages.filter((dep) => !hasDependency(pkg, dep));
  if (missing.length === 0) {
    return { stack: "node", installed: [], skipped: packages };
  }
  const managerField =
    typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  const managerFromField =
    managerField === "pnpm" || managerField === "yarn" || managerField === "npm"
      ? managerField
      : undefined;
  const manager = managerFromField ?? (await detectNodePackageManager(workspaceRoot));
  if (!manager) {
    return {
      stack: "node",
      installed: [],
      skipped: [],
      error: "No Node package manager detected for workspace.",
    };
  }
  const installCommand =
    manager === "pnpm"
      ? `pnpm add -D ${missing.join(" ")}`
      : manager === "yarn"
        ? `yarn add -D ${missing.join(" ")}`
        : `npm install -D ${missing.join(" ")}`;
  const result = runCommand(installCommand, workspaceRoot);
  if (!result.ok) {
    return {
      stack: "node",
      installed: [],
      skipped: [],
      error: result.error ?? "Failed to install Node test packages.",
    };
  }
  return {
    stack: "node",
    installed: missing,
    skipped: packages.filter((dep) => !missing.includes(dep)),
  };
};

type PythonTool = "poetry" | "pipenv" | "requirements" | "pip";

const detectPythonTool = async (
  workspaceRoot: string,
): Promise<{ kind: PythonTool; requirementsPath?: string } | null> => {
  const pyprojectPath = path.join(workspaceRoot, "pyproject.toml");
  const pyproject = await readTextFile(pyprojectPath);
  const hasPoetryLock = await fileExists(path.join(workspaceRoot, "poetry.lock"));
  if (hasPoetryLock || (pyproject && pyproject.includes("[tool.poetry]"))) {
    return { kind: "poetry" };
  }
  if (await fileExists(path.join(workspaceRoot, "Pipfile"))) return { kind: "pipenv" };
  if (await fileExists(path.join(workspaceRoot, "Pipfile.lock"))) return { kind: "pipenv" };
  const requirementsDev = path.join(workspaceRoot, "requirements-dev.txt");
  if (await fileExists(requirementsDev)) {
    return { kind: "requirements", requirementsPath: requirementsDev };
  }
  const requirements = path.join(workspaceRoot, "requirements.txt");
  if (await fileExists(requirements)) {
    return { kind: "requirements", requirementsPath: requirements };
  }
  if (pyproject) return { kind: "pip" };
  if (await fileExists(path.join(workspaceRoot, "setup.py"))) return { kind: "pip" };
  if (await fileExists(path.join(workspaceRoot, "setup.cfg"))) return { kind: "pip" };
  return null;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const requirementsHasPackage = (content: string, name: string): boolean => {
  const matcher = new RegExp(`^\\s*${escapeRegExp(name)}(\\s|[=<>!~]|$)`, "i");
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("#")) return false;
    if (trimmed.startsWith("-")) return false;
    return matcher.test(trimmed);
  });
};

type PythonFrameworks = { django: boolean; flask: boolean };

const readPythonDependencySources = async (
  workspaceRoot: string,
  tool: { kind: PythonTool; requirementsPath?: string },
): Promise<string[]> => {
  const sources: string[] = [];
  const pushIfExists = async (targetPath: string): Promise<void> => {
    const content = await readTextFile(targetPath);
    if (content) sources.push(content);
  };

  if (tool.kind === "poetry" || tool.kind === "pip") {
    await pushIfExists(path.join(workspaceRoot, "pyproject.toml"));
  }
  if (tool.kind === "pipenv") {
    await pushIfExists(path.join(workspaceRoot, "Pipfile"));
  }
  if (tool.kind === "requirements" && tool.requirementsPath) {
    await pushIfExists(tool.requirementsPath);
  }

  return sources;
};

const pythonSourcesHavePackage = (sources: string[], name: string): boolean => {
  const quotedMatcher = new RegExp(`["']${escapeRegExp(name)}["']`, "i");
  return sources.some(
    (content) => requirementsHasPackage(content, name) || quotedMatcher.test(content),
  );
};

const detectPythonFrameworks = (sources: string[]): PythonFrameworks => ({
  django: pythonSourcesHavePackage(sources, "django"),
  flask: pythonSourcesHavePackage(sources, "flask"),
});

const resolvePythonTestPackagesForTool = async (
  workspaceRoot: string,
  tool: { kind: PythonTool; requirementsPath?: string },
): Promise<{ packages: string[]; missing: string[]; frameworks: PythonFrameworks }> => {
  const base = new Set(AST_STACK_TEST_PACKAGES.python.packages);
  const sources = await readPythonDependencySources(workspaceRoot, tool);
  const frameworks = detectPythonFrameworks(sources);
  if (frameworks.django) base.add("pytest-django");
  if (frameworks.flask) base.add("pytest-flask");

  const packages = Array.from(base);
  if (sources.length === 0) {
    return { packages, missing: packages, frameworks };
  }
  const missing = packages.filter((pkg) => !pythonSourcesHavePackage(sources, pkg));
  return { packages, missing, frameworks };
};

export const resolvePythonTestPackages = async (
  workspaceRoot: string,
): Promise<{ packages: string[]; missing: string[]; frameworks: PythonFrameworks } | null> => {
  const tool = await detectPythonTool(workspaceRoot);
  if (!tool) return null;
  return resolvePythonTestPackagesForTool(workspaceRoot, tool);
};

const appendRequirementsPackages = async (
  requirementsPath: string,
  packages: string[],
): Promise<string[]> => {
  const content = (await readTextFile(requirementsPath)) ?? "";
  const missing = packages.filter((pkg) => !requirementsHasPackage(content, pkg));
  if (missing.length === 0) return [];
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  const updated = `${content}${needsNewline ? "\n" : ""}${missing.join("\n")}\n`;
  await fs.writeFile(requirementsPath, updated, "utf8");
  return missing;
};

const resolvePythonBin = (): string | undefined => {
  const candidates = [
    process.env.PYTHON,
    process.env.PYTHON_BIN,
    "python3",
    "python",
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));
  for (const candidate of candidates) {
    const quoted = candidate.includes(" ") ? `"${candidate}"` : candidate;
    try {
      execSync(`${quoted} --version`, { stdio: "ignore" });
      return quoted;
    } catch {
      // try next candidate
    }
  }
  return undefined;
};

const installPythonTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const tool = await detectPythonTool(workspaceRoot);
  if (!tool) return null;
  const resolved = await resolvePythonTestPackagesForTool(workspaceRoot, tool);
  const packages = resolved.packages;
  const missing = resolved.missing;
  if (tool.kind === "poetry") {
    if (missing.length === 0) {
      return { stack: "python", installed: [], skipped: packages };
    }
    const primary = runCommand(
      `poetry add --group dev ${missing.join(" ")}`,
      workspaceRoot,
    );
    if (!primary.ok) {
      const fallback = runCommand(
        `poetry add --dev ${missing.join(" ")}`,
        workspaceRoot,
      );
      if (!fallback.ok) {
        return {
          stack: "python",
          installed: [],
          skipped: [],
          error: fallback.error ?? primary.error ?? "Poetry install failed.",
        };
      }
    }
    return {
      stack: "python",
      installed: missing,
      skipped: packages.filter((pkg) => !missing.includes(pkg)),
    };
  }
  if (tool.kind === "pipenv") {
    if (missing.length === 0) {
      return { stack: "python", installed: [], skipped: packages };
    }
    const result = runCommand(
      `pipenv install --dev ${missing.join(" ")}`,
      workspaceRoot,
    );
    if (!result.ok) {
      return {
        stack: "python",
        installed: [],
        skipped: [],
        error: result.error ?? "Pipenv install failed.",
      };
    }
    return {
      stack: "python",
      installed: missing,
      skipped: packages.filter((pkg) => !missing.includes(pkg)),
    };
  }
  const pythonBin = resolvePythonBin();
  if (!pythonBin) {
    return {
      stack: "python",
      installed: [],
      skipped: [],
      error: "Python interpreter not found.",
    };
  }
  if (tool.kind === "requirements" && tool.requirementsPath) {
    if (missing.length === 0) {
      return { stack: "python", installed: [], skipped: packages };
    }
    const appended = await appendRequirementsPackages(
      tool.requirementsPath,
      missing,
    );
    if (appended.length === 0) {
      return { stack: "python", installed: [], skipped: packages };
    }
    const result = runCommand(
      `${pythonBin} -m pip install ${appended.join(" ")}`,
      workspaceRoot,
    );
    if (!result.ok) {
      return {
        stack: "python",
        installed: [],
        skipped: [],
        error: result.error ?? "Pip install failed.",
      };
    }
    return {
      stack: "python",
      installed: appended,
      skipped: packages.filter((pkg) => !appended.includes(pkg)),
    };
  }
  if (missing.length === 0) {
    return { stack: "python", installed: [], skipped: packages };
  }
  const result = runCommand(
    `${pythonBin} -m pip install ${missing.join(" ")}`,
    workspaceRoot,
  );
  if (!result.ok) {
    return {
      stack: "python",
      installed: [],
      skipped: [],
      error: result.error ?? "Pip install failed.",
    };
  }
  return {
    stack: "python",
    installed: missing,
    skipped: packages.filter((pkg) => !missing.includes(pkg)),
  };
};

const findDotnetProjectFile = async (
  workspaceRoot: string,
): Promise<string | undefined> => {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: workspaceRoot, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.toLowerCase().endsWith(".csproj")) {
        return path.join(current.dir, entry.name);
      }
    }
    if (current.depth >= DOTNET_SCAN_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (DOTNET_SCAN_EXCLUDES.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return undefined;
};

const dotnetHasPackage = (content: string, name: string): boolean => {
  const matcher = new RegExp(
    `<PackageReference\\s+[^>]*Include=["']${escapeRegExp(name)}["']`,
    "i",
  );
  return matcher.test(content);
};

const dotnetIsAspNetProject = (content: string): boolean =>
  /<Project[^>]*Sdk=["']Microsoft\.NET\.Sdk\.Web["']/i.test(content) ||
  /<FrameworkReference\s+[^>]*Include=["']Microsoft\.AspNetCore\.App["']/i.test(
    content,
  ) ||
  /<PackageReference\s+[^>]*Include=["']Microsoft\.AspNetCore\.[^"']+["']/i.test(
    content,
  );

export const resolveDotnetTestPackages = (
  projectContent: string,
): { packages: string[]; missing: string[]; isAspNet: boolean } => {
  const packages = [...AST_STACK_TEST_PACKAGES.dotnet.packages];
  const isAspNet = dotnetIsAspNetProject(projectContent);
  if (isAspNet) packages.push("Microsoft.AspNetCore.Mvc.Testing");
  const missing = packages.filter((pkg) => !dotnetHasPackage(projectContent, pkg));
  return { packages, missing, isAspNet };
};

const installDotnetTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const projectPath = await findDotnetProjectFile(workspaceRoot);
  if (!projectPath) return null;
  const content = (await readTextFile(projectPath)) ?? "";
  const resolved = resolveDotnetTestPackages(content);
  const packages = resolved.packages;
  const missing = resolved.missing;
  if (missing.length === 0) {
    return { stack: "dotnet", installed: [], skipped: packages };
  }
  const installed: string[] = [];
  for (const pkg of missing) {
    const result = runCommand(
      `dotnet add "${projectPath}" package ${pkg}`,
      workspaceRoot,
    );
    if (!result.ok) {
      return {
        stack: "dotnet",
        installed,
        skipped: packages.filter((item) => !installed.includes(item)),
        error: result.error ?? `dotnet add failed for ${pkg}.`,
      };
    }
    installed.push(pkg);
  }
  return {
    stack: "dotnet",
    installed,
    skipped: packages.filter((item) => !installed.includes(item)),
  };
};

const findJavaBuildFile = async (
  workspaceRoot: string,
): Promise<{ path: string; kind: JavaBuildKind } | null> => {
  const pomPath = path.join(workspaceRoot, "pom.xml");
  if (await fileExists(pomPath)) return { path: pomPath, kind: "maven" };
  const gradleKtsPath = path.join(workspaceRoot, "build.gradle.kts");
  if (await fileExists(gradleKtsPath)) {
    return { path: gradleKtsPath, kind: "gradle-kts" };
  }
  const gradlePath = path.join(workspaceRoot, "build.gradle");
  if (await fileExists(gradlePath)) return { path: gradlePath, kind: "gradle" };
  return null;
};

const javaPomHasDependency = (content: string, dep: JavaDependency): boolean => {
  const matcher = new RegExp(
    `<dependency>[\\s\\S]*?<groupId>${escapeRegExp(dep.groupId)}</groupId>` +
      `[\\s\\S]*?<artifactId>${escapeRegExp(dep.artifactId)}</artifactId>[\\s\\S]*?</dependency>`,
    "i",
  );
  return matcher.test(content);
};

const javaGradleHasDependency = (content: string, dep: JavaDependency): boolean => {
  const matcher = new RegExp(
    `${escapeRegExp(dep.groupId)}:${escapeRegExp(dep.artifactId)}`,
    "i",
  );
  return matcher.test(content);
};

const buildPomDependency = (dep: JavaDependency, indent: string): string => {
  const scopeLine = dep.scope ? `\n${indent}  <scope>${dep.scope}</scope>` : "";
  return (
    `${indent}<dependency>\n` +
    `${indent}  <groupId>${dep.groupId}</groupId>\n` +
    `${indent}  <artifactId>${dep.artifactId}</artifactId>\n` +
    `${indent}  <version>${dep.version}</version>` +
    `${scopeLine}\n` +
    `${indent}</dependency>`
  );
};

const applyJavaPomDependencies = (
  content: string,
  deps: JavaDependency[],
): { updated: string; added: string[] } => {
  const missing = deps.filter((dep) => !javaPomHasDependency(content, dep));
  if (missing.length === 0) return { updated: content, added: [] };

  const indentMatch = content.match(/(\s*)<dependency>\s*<groupId>/i);
  const indent = indentMatch ? indentMatch[1] : "  ";
  const block = missing.map((dep) => buildPomDependency(dep, indent)).join("\n");

  if (/<dependencies>/i.test(content)) {
    const updated = content.replace(
      /(\s*)<\/dependencies>/i,
      `\n${block}\n$1</dependencies>`,
    );
    return { updated, added: missing.map(javaDependencyId) };
  }

  const dependenciesBlock = `<dependencies>\n${block}\n</dependencies>`;
  const updated = content.replace(
    /(\s*)<\/project>/i,
    `${dependenciesBlock}\n$1</project>`,
  );
  return { updated, added: missing.map(javaDependencyId) };
};

const buildGradleDependency = (dep: JavaDependency, kotlin: boolean): string => {
  const coordinate = `${dep.groupId}:${dep.artifactId}:${dep.version}`;
  return kotlin
    ? `testImplementation("${coordinate}")`
    : `testImplementation "${coordinate}"`;
};

const applyJavaGradleDependencies = (
  content: string,
  deps: JavaDependency[],
  kotlin: boolean,
): { updated: string; added: string[] } => {
  const missing = deps.filter((dep) => !javaGradleHasDependency(content, dep));
  if (missing.length === 0) return { updated: content, added: [] };
  const lines = missing.map((dep) => `  ${buildGradleDependency(dep, kotlin)}`).join("\n");

  if (/^\s*dependencies\s*\{/m.test(content)) {
    const updated = content.replace(/^\s*dependencies\s*\{/m, (match) =>
      `${match}\n${lines}`,
    );
    return { updated, added: missing.map(javaDependencyId) };
  }

  const updated = `${content}\n\ndependencies {\n${lines}\n}\n`;
  return { updated, added: missing.map(javaDependencyId) };
};

export const resolveJavaTestPackages = (
  content: string,
  kind: JavaBuildKind,
): { updated: string; added: string[] } => {
  if (kind === "maven") {
    return applyJavaPomDependencies(content, JAVA_TEST_DEPENDENCIES);
  }
  const kotlin = kind === "gradle-kts";
  return applyJavaGradleDependencies(content, JAVA_TEST_DEPENDENCIES, kotlin);
};

const installJavaTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const buildFile = await findJavaBuildFile(workspaceRoot);
  if (!buildFile) return null;
  const content = (await readTextFile(buildFile.path)) ?? "";
  const resolved = resolveJavaTestPackages(content, buildFile.kind);
  if (resolved.added.length === 0) {
    return {
      stack: "java",
      installed: [],
      skipped: JAVA_TEST_DEPENDENCIES.map(javaDependencyId),
    };
  }
  try {
    await fs.writeFile(buildFile.path, resolved.updated, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stack: "java",
      installed: [],
      skipped: JAVA_TEST_DEPENDENCIES.map(javaDependencyId),
      error: message,
    };
  }
  const installed = resolved.added;
  return {
    stack: "java",
    installed,
    skipped: JAVA_TEST_DEPENDENCIES.map(javaDependencyId).filter(
      (item) => !installed.includes(item),
    ),
  };
};

const goHasPackage = (content: string, modulePath: string): boolean => {
  const matcher = new RegExp(escapeRegExp(modulePath), "i");
  return matcher.test(content);
};

export const resolveGoTestPackages = (
  content: string,
): { packages: string[]; missing: string[] } => {
  const packages = [...GO_TEST_PACKAGES];
  const missing = packages.filter((pkg) => !goHasPackage(content, pkg));
  return { packages, missing };
};

const installGoTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const goModPath = path.join(workspaceRoot, "go.mod");
  if (!(await fileExists(goModPath))) return null;
  const content = (await readTextFile(goModPath)) ?? "";
  const resolved = resolveGoTestPackages(content);
  if (resolved.missing.length === 0) {
    return { stack: "go", installed: [], skipped: resolved.packages };
  }
  const installed: string[] = [];
  for (const pkg of resolved.missing) {
    const result = runCommand(`go get ${pkg}`, workspaceRoot);
    if (!result.ok) {
      return {
        stack: "go",
        installed,
        skipped: resolved.packages.filter((item) => !installed.includes(item)),
        error: result.error ?? `go get failed for ${pkg}.`,
      };
    }
    installed.push(pkg);
  }
  return {
    stack: "go",
    installed,
    skipped: resolved.packages.filter((item) => !installed.includes(item)),
  };
};

type PhpFrameworks = { laravel: boolean; symfony: boolean };

const composerHasPackage = (
  manifest: Record<string, unknown>,
  name: string,
): boolean => {
  const requireDeps =
    (manifest.require as Record<string, unknown> | undefined) ?? {};
  const devDeps =
    (manifest["require-dev"] as Record<string, unknown> | undefined) ?? {};
  return typeof requireDeps[name] === "string" || typeof devDeps[name] === "string";
};

const detectPhpFrameworks = (
  manifest: Record<string, unknown>,
): PhpFrameworks => ({
  laravel:
    typeof (manifest.require as Record<string, unknown> | undefined)?.[
      "laravel/framework"
    ] === "string",
  symfony:
    typeof (manifest.require as Record<string, unknown> | undefined)?.[
      "symfony/framework-bundle"
    ] === "string" ||
    typeof (manifest.require as Record<string, unknown> | undefined)?.[
      "symfony/symfony"
    ] === "string",
});

export const resolvePhpTestPackages = (
  manifest: Record<string, unknown>,
): { packages: string[]; missing: string[]; frameworks: PhpFrameworks } => {
  const frameworks = detectPhpFrameworks(manifest);
  const packages = ["phpunit/phpunit", "pestphp/pest"];
  if (frameworks.laravel) {
    packages.push("laravel/dusk");
  }
  if (frameworks.symfony) {
    packages.push("symfony/browser-kit", "symfony/css-selector");
  }
  const missing = packages.filter((pkg) => !composerHasPackage(manifest, pkg));
  return { packages, missing, frameworks };
};

const installPhpTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const composerPath = path.join(workspaceRoot, "composer.json");
  const raw = await readTextFile(composerPath);
  if (!raw) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stack: "php",
      installed: [],
      skipped: [],
      error: message,
    };
  }
  const resolved = resolvePhpTestPackages(manifest);
  if (resolved.missing.length === 0) {
    return { stack: "php", installed: [], skipped: resolved.packages };
  }
  const requireDev =
    (manifest["require-dev"] as Record<string, string> | undefined) ?? {};
  const updatedRequireDev = { ...requireDev };
  for (const pkg of resolved.missing) {
    updatedRequireDev[pkg] = updatedRequireDev[pkg] ?? "*";
  }
  const updatedManifest = { ...manifest, "require-dev": updatedRequireDev };
  try {
    await fs.writeFile(
      composerPath,
      `${JSON.stringify(updatedManifest, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stack: "php",
      installed: [],
      skipped: resolved.packages,
      error: message,
    };
  }
  return {
    stack: "php",
    installed: resolved.missing,
    skipped: resolved.packages.filter((pkg) => !resolved.missing.includes(pkg)),
  };
};

const gemfileHasGem = (content: string, name: string): boolean => {
  const matcher = new RegExp(`^\\s*gem\\s+["']${escapeRegExp(name)}["']`, "i");
  return content.split(/\r?\n/).some((line) => matcher.test(line));
};

export const resolveRubyTestPackages = (
  content: string,
): { packages: string[]; missing: string[] } => {
  const packages = [...RUBY_TEST_GEMS];
  const missing = packages.filter((gem) => !gemfileHasGem(content, gem));
  return { packages, missing };
};

const installRubyTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const gemfilePath = path.join(workspaceRoot, "Gemfile");
  const content = await readTextFile(gemfilePath);
  if (content === undefined) return null;
  const resolved = resolveRubyTestPackages(content);
  if (resolved.missing.length === 0) {
    return { stack: "ruby", installed: [], skipped: resolved.packages };
  }
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  const additions = resolved.missing.map((gem) => `gem "${gem}"`).join("\n");
  const updated = `${content}${needsNewline ? "\n" : ""}${additions}\n`;
  try {
    await fs.writeFile(gemfilePath, updated, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stack: "ruby",
      installed: [],
      skipped: resolved.packages,
      error: message,
    };
  }
  const install = runCommand("bundle install", workspaceRoot);
  if (!install.ok) {
    return {
      stack: "ruby",
      installed: [],
      skipped: resolved.packages,
      error: install.error ?? "bundle install failed.",
    };
  }
  return {
    stack: "ruby",
    installed: resolved.missing,
    skipped: resolved.packages.filter((gem) => !resolved.missing.includes(gem)),
  };
};

const pubspecHasDependency = (content: string, name: string): boolean => {
  const matcher = new RegExp(`^\\s*${escapeRegExp(name)}\\s*:`, "m");
  return matcher.test(content);
};

const buildFlutterDependencyBlock = (name: string): string => {
  if (name === "flutter_test" || name === "integration_test") {
    return `  ${name}:\n    sdk: flutter`;
  }
  if (name === "mockito") {
    return "  mockito: ^5.4.4";
  }
  return `  ${name}: any`;
};

const applyFlutterDevDependencies = (
  content: string,
): { updated: string; added: string[] } => {
  const missing = FLUTTER_TEST_PACKAGES.filter(
    (pkg) => !pubspecHasDependency(content, pkg),
  );
  if (missing.length === 0) return { updated: content, added: [] };
  const entries = missing.map(buildFlutterDependencyBlock).join("\n");
  if (/^\s*dev_dependencies\s*:/m.test(content)) {
    const updated = content.replace(
      /^\s*dev_dependencies\s*:/m,
      (match) => `${match}\n${entries}`,
    );
    return { updated, added: missing };
  }
  const trimmed = content.replace(/\s*$/, "");
  const updated = `${trimmed}\n\ndev_dependencies:\n${entries}\n`;
  return { updated, added: missing };
};

export const resolveFlutterTestPackages = (
  content: string,
): { packages: string[]; missing: string[]; updated: string } => {
  const result = applyFlutterDevDependencies(content);
  return {
    packages: [...FLUTTER_TEST_PACKAGES],
    missing: result.added,
    updated: result.updated,
  };
};

const installFlutterTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const pubspecPath = path.join(workspaceRoot, "pubspec.yaml");
  const content = await readTextFile(pubspecPath);
  if (content === undefined) return null;
  const resolved = resolveFlutterTestPackages(content);
  if (resolved.missing.length === 0) {
    return { stack: "flutter", installed: [], skipped: resolved.packages };
  }
  try {
    await fs.writeFile(pubspecPath, resolved.updated, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stack: "flutter",
      installed: [],
      skipped: resolved.packages,
      error: message,
    };
  }
  return {
    stack: "flutter",
    installed: resolved.missing,
    skipped: resolved.packages.filter((pkg) => !resolved.missing.includes(pkg)),
  };
};

export const resolveReactNativeTestPackages = (
  pkg: Record<string, unknown>,
): { packages: string[]; missing: string[] } => {
  const packages = [...REACT_NATIVE_TEST_PACKAGES];
  const missing = packages.filter((dep) => !hasDependency(pkg, dep));
  return { packages, missing };
};

const installReactNativeTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const pkg = await readPackageJson(workspaceRoot);
  if (!pkg) return null;
  if (!(await detectReactNativeStack(workspaceRoot, pkg))) return null;
  const resolved = resolveReactNativeTestPackages(pkg);
  if (resolved.missing.length === 0) {
    return { stack: "react-native", installed: [], skipped: resolved.packages };
  }
  const managerField =
    typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  const managerFromField =
    managerField === "pnpm" || managerField === "yarn" || managerField === "npm"
      ? managerField
      : undefined;
  const manager = managerFromField ?? (await detectNodePackageManager(workspaceRoot));
  if (!manager) {
    return {
      stack: "react-native",
      installed: [],
      skipped: [],
      error: "No Node package manager detected for React Native workspace.",
    };
  }
  const installCommand =
    manager === "pnpm"
      ? `pnpm add -D ${resolved.missing.join(" ")}`
      : manager === "yarn"
        ? `yarn add -D ${resolved.missing.join(" ")}`
        : `npm install -D ${resolved.missing.join(" ")}`;
  const result = runCommand(installCommand, workspaceRoot);
  if (!result.ok) {
    return {
      stack: "react-native",
      installed: [],
      skipped: [],
      error: result.error ?? "Failed to install React Native test packages.",
    };
  }
  return {
    stack: "react-native",
    installed: resolved.missing,
    skipped: resolved.packages.filter((pkgName) => !resolved.missing.includes(pkgName)),
  };
};

const podfileHasPod = (content: string, name: string): boolean => {
  const matcher = new RegExp(`^\\s*pod\\s+["']${escapeRegExp(name)}["']`, "m");
  return matcher.test(content);
};

const applyIosPodDependencies = (
  content: string,
): { updated: string; added: string[] } => {
  const missing = IOS_TEST_PODS.filter((pod) => !podfileHasPod(content, pod));
  if (missing.length === 0) return { updated: content, added: [] };
  const targetMatch = content.match(/^(\s*target\s+['"][^'"]+['"]\s+do)/m);
  const additions = missing.map((pod) => `  pod '${pod}'`).join("\n");
  if (targetMatch) {
    const updated = content.replace(targetMatch[1], `${targetMatch[1]}\n${additions}`);
    return { updated, added: missing };
  }
  const updated = `${content}\n\n${additions}\n`;
  return { updated, added: missing };
};

export const resolveIosTestPackages = (
  content: string,
): { packages: string[]; missing: string[]; updated: string } => {
  const result = applyIosPodDependencies(content);
  return {
    packages: [...IOS_TEST_PODS],
    missing: result.added,
    updated: result.updated,
  };
};

const installIosTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const detected = await detectIosStack(workspaceRoot);
  if (!detected) return null;
  const podfilePath = path.join(workspaceRoot, "ios", "Podfile");
  const content = await readTextFile(podfilePath);
  if (content === undefined) {
    return {
      stack: "ios",
      installed: [],
      skipped: IOS_TEST_PODS,
      error: "Podfile not found for iOS workspace.",
    };
  }
  const resolved = resolveIosTestPackages(content);
  if (resolved.missing.length === 0) {
    return { stack: "ios", installed: [], skipped: resolved.packages };
  }
  try {
    await fs.writeFile(podfilePath, resolved.updated, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stack: "ios",
      installed: [],
      skipped: resolved.packages,
      error: message,
    };
  }
  return {
    stack: "ios",
    installed: resolved.missing,
    skipped: resolved.packages.filter((pkg) => !resolved.missing.includes(pkg)),
  };
};

const androidGradleHasDependency = (
  content: string,
  dep: AndroidDependency,
): boolean => {
  const matcher = new RegExp(escapeRegExp(dep.coordinate), "i");
  return matcher.test(content);
};

const applyAndroidGradleDependencies = (
  content: string,
  kotlin: boolean,
): { updated: string; added: string[] } => {
  const missing = ANDROID_TEST_DEPENDENCIES.filter(
    (dep) => !androidGradleHasDependency(content, dep),
  );
  if (missing.length === 0) return { updated: content, added: [] };
  const lines = missing
    .map((dep) => {
      const statement = kotlin
        ? `${dep.configuration}("${dep.coordinate}")`
        : `${dep.configuration} "${dep.coordinate}"`;
      return `  ${statement}`;
    })
    .join("\n");
  if (/^\s*dependencies\s*\{/m.test(content)) {
    const updated = content.replace(/^\s*dependencies\s*\{/m, (match) =>
      `${match}\n${lines}`,
    );
    return { updated, added: missing.map((dep) => dep.coordinate) };
  }
  const updated = `${content}\n\ndependencies {\n${lines}\n}\n`;
  return { updated, added: missing.map((dep) => dep.coordinate) };
};

export const resolveAndroidTestPackages = (
  content: string,
  kotlin: boolean,
): { packages: string[]; missing: string[]; updated: string } => {
  const result = applyAndroidGradleDependencies(content, kotlin);
  return {
    packages: ANDROID_TEST_DEPENDENCIES.map((dep) => dep.coordinate),
    missing: result.added,
    updated: result.updated,
  };
};

const findAndroidBuildFile = async (
  workspaceRoot: string,
): Promise<{ path: string; kotlin: boolean } | null> => {
  const candidates = [
    { path: path.join(workspaceRoot, "android", "app", "build.gradle.kts"), kotlin: true },
    { path: path.join(workspaceRoot, "android", "app", "build.gradle"), kotlin: false },
    { path: path.join(workspaceRoot, "android", "build.gradle.kts"), kotlin: true },
    { path: path.join(workspaceRoot, "android", "build.gradle"), kotlin: false },
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate.path)) return candidate;
  }
  return null;
};

const installAndroidTestPackages = async (
  workspaceRoot: string,
): Promise<StackInstallResult | null> => {
  const buildFile = await findAndroidBuildFile(workspaceRoot);
  if (!buildFile) return null;
  const content = (await readTextFile(buildFile.path)) ?? "";
  const resolved = resolveAndroidTestPackages(content, buildFile.kotlin);
  if (resolved.missing.length === 0) {
    return { stack: "android", installed: [], skipped: resolved.packages };
  }
  try {
    await fs.writeFile(buildFile.path, resolved.updated, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stack: "android",
      installed: [],
      skipped: resolved.packages,
      error: message,
    };
  }
  return {
    stack: "android",
    installed: resolved.missing,
    skipped: resolved.packages.filter((pkg) => !resolved.missing.includes(pkg)),
  };
};

export const detectWorkspaceStacks = async (
  workspaceRoot: string,
): Promise<StackId[]> => {
  const stacks: StackId[] = [];
  const push = (stack: StackId, detected: boolean) => {
    if (!detected || stacks.includes(stack)) return;
    stacks.push(stack);
  };
  const pkg = await readPackageJson(workspaceRoot);
  push("node", Boolean(pkg));
  push("python", Boolean(await detectPythonTool(workspaceRoot)));
  push("dotnet", Boolean(await findDotnetProjectFile(workspaceRoot)));
  push("java", await detectJavaStack(workspaceRoot));
  push("go", await detectGoStack(workspaceRoot));
  push("php", await detectPhpStack(workspaceRoot));
  push("ruby", await detectRubyStack(workspaceRoot));
  push("flutter", await detectFlutterStack(workspaceRoot));
  push("react-native", await detectReactNativeStack(workspaceRoot, pkg));
  push("ios", await detectIosStack(workspaceRoot));
  push("android", await detectAndroidStack(workspaceRoot));
  return stacks;
};

const installStackTestPackages = async (workspaceRoot: string): Promise<StackInstallResult[]> => {
  const results: StackInstallResult[] = [];
  const nodeResult = await installNodeTestPackages(workspaceRoot);
  if (nodeResult) results.push(nodeResult);
  const pythonResult = await installPythonTestPackages(workspaceRoot);
  if (pythonResult) results.push(pythonResult);
  const dotnetResult = await installDotnetTestPackages(workspaceRoot);
  if (dotnetResult) results.push(dotnetResult);
  const javaResult = await installJavaTestPackages(workspaceRoot);
  if (javaResult) results.push(javaResult);
  const goResult = await installGoTestPackages(workspaceRoot);
  if (goResult) results.push(goResult);
  const phpResult = await installPhpTestPackages(workspaceRoot);
  if (phpResult) results.push(phpResult);
  const rubyResult = await installRubyTestPackages(workspaceRoot);
  if (rubyResult) results.push(rubyResult);
  const flutterResult = await installFlutterTestPackages(workspaceRoot);
  if (flutterResult) results.push(flutterResult);
  const reactNativeResult = await installReactNativeTestPackages(workspaceRoot);
  if (reactNativeResult) results.push(reactNativeResult);
  const iosResult = await installIosTestPackages(workspaceRoot);
  if (iosResult) results.push(iosResult);
  const androidResult = await installAndroidTestPackages(workspaceRoot);
  if (androidResult) results.push(androidResult);
  return results;
};

const ensureConfigFile = async (mcodaDir: string): Promise<void> => {
  const configPath = path.join(mcodaDir, "config.json");
  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(configPath, "{}", "utf8");
  }
};

const readWorkspaceConfig = async (mcodaDir: string): Promise<Record<string, unknown>> => {
  const configPath = path.join(mcodaDir, "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const writeWorkspaceConfig = async (mcodaDir: string, config: Record<string, unknown>): Promise<void> => {
  const configPath = path.join(mcodaDir, "config.json");
  await fs.mkdir(mcodaDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
};

const normalizeDocdexUrl = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const extractDocdexUrlFromCheck = (output: string): string | undefined => {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed];
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(trimmed.slice(braceStart, braceEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, any>;
      const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
      const bind = checks.find((check: any) => check?.name === "bind");
      const bindAddr = bind?.details?.bind_addr ?? bind?.details?.bindAddr;
      if (typeof bindAddr === "string" && bindAddr.trim().length > 0) {
        return bindAddr.startsWith("http://") || bindAddr.startsWith("https://")
          ? bindAddr
          : `http://${bindAddr}`;
      }
    } catch {
      // ignore parse errors
    }
  }
  const urlMatch = trimmed.match(/https?:\/\/[^\s]+/);
  if (urlMatch) return urlMatch[0];
  const onMatch = trimmed.match(/\bon\s+([^\s;]+:\d+)\b/i);
  if (onMatch) {
    return `http://${onMatch[1].replace(/[;,]$/, "")}`;
  }
  const hostPortMatch = trimmed.match(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[a-zA-Z0-9.-]+):\d{2,5}\b/);
  if (hostPortMatch) return `http://${hostPortMatch[0]}`;
  const bindMatch = trimmed.match(/bind_addr[:=]\s*([0-9.:]+(?:\:\d+)?)/i);
  if (bindMatch) return `http://${bindMatch[1]}`;
  return undefined;
};

const resolveDocdexUrl = (workspaceRoot: string): string | undefined => {
  for (const key of DOCDEX_ENV_URLS) {
    const value = process.env[key];
    if (value && value.trim().length > 0) return normalizeDocdexUrl(value);
  }
  try {
    const stdout = execFileSync("docdexd", ["check"], {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = stdout ? stdout.toString() : "";
    const parsed = extractDocdexUrlFromCheck(output);
    if (parsed) return normalizeDocdexUrl(parsed);
  } catch (error: any) {
    const stdout = error?.stdout ? error.stdout.toString() : "";
    const stderr = error?.stderr ? error.stderr.toString() : "";
    const parsed = extractDocdexUrlFromCheck(stdout) ?? extractDocdexUrlFromCheck(stderr);
    if (parsed) return normalizeDocdexUrl(parsed);
  }
  return undefined;
};

const ensureDocdexUrl = async (mcodaDir: string, workspaceRoot: string): Promise<string | undefined> => {
  const config = await readWorkspaceConfig(mcodaDir);
  const existing = typeof config.docdexUrl === "string" ? config.docdexUrl.trim() : "";
  if (existing) return existing;
  const resolved = resolveDocdexUrl(workspaceRoot);
  if (!resolved) return undefined;
  await writeWorkspaceConfig(mcodaDir, { ...config, docdexUrl: resolved });
  return resolved;
};

const ensureDocsDirs = async (mcodaDir: string): Promise<void> => {
  await fs.mkdir(path.join(mcodaDir, "docs", "pdr"), { recursive: true });
  await fs.mkdir(path.join(mcodaDir, "docs", "sds"), { recursive: true });
  await fs.mkdir(path.join(mcodaDir, "jobs"), { recursive: true });
};

const listWorkspaceProjects = async (workspaceRoot: string): Promise<ProjectKeyCandidate[]> => {
  const repo = await WorkspaceRepository.create(workspaceRoot);
  try {
    const rows = await repo
      .getDb()
      .all<{ key: string; created_at?: string | null }[]>(`SELECT key, created_at FROM projects ORDER BY created_at ASC, key ASC`);
    return rows
      .map((row) => ({ key: String(row.key), createdAt: row.created_at ?? null }))
      .filter((row) => row.key.trim().length > 0);
  } catch {
    return [];
  } finally {
    await repo.close();
  }
};

const ensureGitRepo = async (workspaceRoot: string): Promise<boolean> => {
  try {
    await fs.access(path.join(workspaceRoot, ".git"));
    return false;
  } catch {
    try {
      execSync("git init", { cwd: workspaceRoot, stdio: "ignore" });
      return true;
    } catch {
      // ignore git init failures; user can init later
      return false;
    }
  }
};

const ensureCodexTrust = async (workspaceRoot: string): Promise<boolean> => {
  try {
    execSync("codex --version", { stdio: "ignore" });
  } catch {
    return false;
  }
  try {
    execSync(`codex trust add "${workspaceRoot}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const ensureDocdexIndex = async (workspaceRoot: string): Promise<boolean> => {
  const resolveDocdexBin = (): string | undefined => {
    try {
      const require = createRequire(import.meta.url);
      const pkgPath = require.resolve("docdex/package.json");
      return path.join(path.dirname(pkgPath), "bin", "docdex.js");
    } catch {
      return undefined;
    }
  };

  const buildDocdexEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    if (!env.DOCDEX_STATE_DIR) {
      env.DOCDEX_STATE_DIR = path.join(os.homedir(), ".docdex", "state");
    }
    return env;
  };

  const runDocdex = (args: string[], cwd: string): boolean => {
    const bin = resolveDocdexBin();
    const env = buildDocdexEnv();
    try {
      if (bin) {
        execFileSync(process.execPath, [bin, ...args], { cwd, stdio: "ignore", env });
      } else {
        execSync(`docdex ${args.join(" ")}`, { cwd, stdio: "ignore", env });
      }
      return true;
    } catch {
      return false;
    }
  };

  if (!runDocdex(["--version"], workspaceRoot)) return false;
  return runDocdex(["index", "--repo", workspaceRoot], workspaceRoot);
};

export class SetWorkspaceCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseSetWorkspaceArgs(argv);
    const resolution = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });

    const installResults = await installStackTestPackages(resolution.workspaceRoot);
    for (const result of installResults) {
      const label = AST_STACK_TEST_PACKAGES[result.stack].label;
      if (result.error) {
        // eslint-disable-next-line no-console
        console.error(`Test package install for ${label} failed: ${result.error}`);
        continue;
      }
      if (result.installed.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`Installed test packages for ${label}: ${result.installed.join(", ")}`);
      }
    }

    await ensureConfigFile(resolution.mcodaDir);
    if (parsed.codexNoSandbox !== undefined) {
      const config = await readWorkspaceConfig(resolution.mcodaDir);
      await writeWorkspaceConfig(resolution.mcodaDir, { ...config, codexNoSandbox: parsed.codexNoSandbox });
    }
    const configuredProjectKey =
      typeof resolution.config?.projectKey === "string" && resolution.config.projectKey.trim().length > 0
        ? resolution.config.projectKey.trim()
        : undefined;
    const existingProjects = configuredProjectKey ? [] : await listWorkspaceProjects(resolution.workspaceRoot);
    const bootstrapProjectKey = configuredProjectKey ?? existingProjects[0]?.key;
    await ensureDocsDirs(resolution.mcodaDir);
    await (await WorkspaceRepository.create(resolution.workspaceRoot)).close();
    try {
      const guidance = await ensureProjectGuidance(resolution.workspaceRoot, {
        mcodaDir: resolution.mcodaDir,
        projectKey: bootstrapProjectKey,
      });
      if (guidance.status !== "existing") {
        // eslint-disable-next-line no-console
        console.log(`Project guidance ${guidance.status}: ${guidance.path}`);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `Project guidance bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await ensureDocdexUrl(resolution.mcodaDir, resolution.workspaceRoot);

    let gitInited = false;
    if (parsed.git) {
      gitInited = await ensureGitRepo(resolution.workspaceRoot);
    }
    const codexTrusted = await ensureCodexTrust(resolution.workspaceRoot);
    const docdexIndexed = parsed.docdex ? await ensureDocdexIndex(resolution.workspaceRoot) : false;

    // eslint-disable-next-line no-console
    console.log(`Workspace ready at ${resolution.workspaceRoot}`);
    if (gitInited) {
      // eslint-disable-next-line no-console
      console.log("Initialized new git repository.");
    }
    if (codexTrusted) {
      // eslint-disable-next-line no-console
      console.log("Granted codex CLI trust for this workspace.");
    }
    if (docdexIndexed) {
      // eslint-disable-next-line no-console
      console.log("Docdex index initialized for this workspace.");
    }
    // eslint-disable-next-line no-console
    console.log(`Workspace data directory: ${resolution.mcodaDir}`);
    // eslint-disable-next-line no-console
    console.log("You can now run mcoda commands here.");
  }
}
