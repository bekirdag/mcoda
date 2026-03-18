#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRoot = path.resolve(__dirname, "..");

export const parseInstallArgs = (argv) => ({
  binsOnly: argv.includes("--bins-only"),
  dryRun: argv.includes("--dry-run"),
});

export const collectWorkspacePackages = (rootDir) => {
  const packagesDir = path.join(rootDir, "packages");
  const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDir, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const packages = [];
  for (const packageDir of packageDirs) {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (packageJson.private) {
      continue;
    }
    const deps = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.optionalDependencies ?? {}),
      ...(packageJson.peerDependencies ?? {}),
    };
    packages.push({
      dir: packageDir,
      relDir: path.relative(rootDir, packageDir),
      name: packageJson.name,
      hasBin: typeof packageJson.bin === "string" || Object.keys(packageJson.bin ?? {}).length > 0,
      localDependencyNames: Object.entries(deps)
        .filter(([, version]) => String(version).includes("workspace:"))
        .map(([name]) => name),
    });
  }
  return packages;
};

export const orderWorkspacePackages = (packages) => {
  const packageMap = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const indegree = new Map(packages.map((pkg) => [pkg.name, 0]));
  const edges = new Map(packages.map((pkg) => [pkg.name, []]));

  for (const pkg of packages) {
    for (const depName of pkg.localDependencyNames) {
      if (!packageMap.has(depName)) {
        continue;
      }
      indegree.set(pkg.name, (indegree.get(pkg.name) ?? 0) + 1);
      edges.get(depName)?.push(pkg.name);
    }
  }

  const ready = packages
    .filter((pkg) => (indegree.get(pkg.name) ?? 0) === 0)
    .map((pkg) => pkg.name)
    .sort((left, right) => left.localeCompare(right));
  const ordered = [];

  while (ready.length > 0) {
    const currentName = ready.shift();
    if (!currentName) {
      continue;
    }
    const current = packageMap.get(currentName);
    if (!current) {
      continue;
    }
    ordered.push(current);
    for (const nextName of edges.get(currentName) ?? []) {
      const nextDegree = (indegree.get(nextName) ?? 0) - 1;
      indegree.set(nextName, nextDegree);
      if (nextDegree === 0) {
        ready.push(nextName);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  if (ordered.length !== packages.length) {
    throw new Error("Cannot determine a stable local-install order for workspace packages.");
  }

  return ordered;
};

const resolvePnpmCommand = () => {
  const candidates =
    process.platform === "win32"
      ? [process.env.PNPM_BIN, "pnpm.cmd", "pnpm.exe", "pnpm"]
      : [process.env.PNPM_BIN, "pnpm"];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (result.status === 0) {
      return candidate;
    }
  }
  throw new Error("pnpm not found. Install it first or set PNPM_BIN.");
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: defaultRoot,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${[command, ...args].join(" ")}`);
  }
};

const readCommandOutput = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: defaultRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
};

export const installLocalPackages = (rootDir, { binsOnly = false, dryRun = false } = {}) => {
  const pnpm = resolvePnpmCommand();
  const packages = orderWorkspacePackages(collectWorkspacePackages(rootDir)).filter(
    (pkg) => !binsOnly || pkg.hasBin,
  );

  if (packages.length === 0) {
    throw new Error("No installable workspace packages were found.");
  }

  if (dryRun) {
    console.log("Dry run: no commands executed.");
    console.log(`Packages to link: ${packages.map((pkg) => `${pkg.name} (${pkg.relDir})`).join(", ")}`);
    return;
  }

  console.log("Installing workspace dependencies...");
  run(pnpm, ["install"], { cwd: rootDir });

  console.log("Building workspace packages...");
  run(pnpm, ["-r", "run", "build"], { cwd: rootDir });

  console.log(`Linking ${packages.length} workspace package(s) globally...`);
  for (const pkg of packages) {
    console.log(`- ${pkg.name} (${pkg.relDir})`);
    run(pnpm, ["-C", pkg.relDir, "link", "--global"], { cwd: rootDir });
  }

  const consentBootstrapScript = path.join(
    rootDir,
    "packages",
    "cli",
    "scripts",
    "postinstall.js",
  );
  if (existsSync(consentBootstrapScript)) {
    console.log("Checking mandatory mcoda telemetry consent...");
    run(process.execPath, [consentBootstrapScript, "--install-local"], {
      cwd: rootDir,
    });
  }

  const globalBinDir = readCommandOutput(pnpm, ["bin", "--global"])
    || `${readCommandOutput(pnpm, ["root", "--global"])}/.bin`;
  const linkedBins = packages.filter((pkg) => pkg.hasBin).map((pkg) => pkg.name);

  console.log("");
  console.log(`Linked packages: ${packages.map((pkg) => pkg.name).join(", ")}`);
  if (globalBinDir) {
    console.log(`Global bin dir: ${globalBinDir}`);
  }
  if (linkedBins.length > 0) {
    console.log(`Linked binaries: ${linkedBins.join(", ")}`);
  }
};

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === __filename : false;

if (isMain) {
  try {
    const options = parseInstallArgs(process.argv.slice(2));
    installLocalPackages(defaultRoot, options);
  } catch (error) {
    console.error((error && error.message) || String(error));
    process.exit(1);
  }
}
