import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const baselineDir = path.join(repoRoot, "docs", "baselines", "codali-unified-phase0");

const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));

const existsInRepo = (relativePath) => fs.existsSync(path.join(repoRoot, relativePath));

const existsInRoot = (root, relativePath) => fs.existsSync(path.join(root, relativePath));

const filesFromSurface = (surface) => surface.evidence?.files ?? [];

const readRepoFile = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

test("phase 0 mcoda baseline matches implemented Codali and release surfaces", () => {
  const report = readJson("docs/baselines/codali-unified-phase0/mcoda-baseline.json");
  assert.equal(report.schema_version, "codali.unified.phase0.baseline.v1");
  assert.equal(report.repo.label, "mcoda");

  for (const file of report.repo.package_manager_evidence) {
    assert.ok(existsInRepo(file), `expected package-manager evidence to exist: ${file}`);
  }

  for (const surface of report.implemented_surfaces) {
    assert.equal(surface.status, "implemented", `surface ${surface.id} should be implemented`);
    for (const file of filesFromSurface(surface)) {
      assert.ok(existsInRepo(file), `implemented surface ${surface.id} references missing file ${file}`);
    }
  }

  assert.ok(report.missing_or_planned_surfaces.length > 0, "missing or planned mcoda surfaces must be listed");
  assert.ok(report.missing_commands.length > 0, "missing mcoda commands must be listed");
  assert.ok(report.missing_endpoints.length > 0, "missing external endpoints must be listed");
});

test("phase 0 release baseline documents tag trigger and package version guard", () => {
  const report = readJson("docs/baselines/codali-unified-phase0/mcoda-baseline.json");
  const workflow = fs.readFileSync(path.join(repoRoot, report.release_path.workflow_file), "utf8");

  assert.match(workflow, /push:\s*\n\s*tags:\s*\n\s*-\s+"v\*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /Verify tag matches package versions/);
  assert.match(workflow, /TAG:\s+\$\{\{\s*github\.ref_name\s*\}\}/);
  assert.match(workflow, /pnpm run release:publish:npm/);
  assert.match(workflow, /NPM_CONFIG_PROVENANCE:\s+"true"/);

  const packageBlock = workflow.match(/const packages = \[([\s\S]*?)\];/);
  assert.ok(packageBlock, "release workflow should define guarded package directories");
  const guardedPackages = Array.from(packageBlock[1].matchAll(/'([^']+)'/g), (match) => match[1]);
  assert.deepEqual(report.release_path.version_match_packages, guardedPackages);
});

test("phase 0 Codali and mswarm policy surfaces remain product-neutral", () => {
  const corePolicyFiles = [
    "packages/codali/src/runtime/CodaliRuntime.ts",
    "packages/codali/src/gateway/CodaliGatewaySchemas.ts",
    "packages/mswarm/src/codali-executor.ts",
    "packages/mswarm/src/runtime.ts",
  ];

  for (const file of corePolicyFiles) {
    const content = readRepoFile(file);
    assert.doesNotMatch(content, /okacam|sukunahikona|suku/i, `${file} should not contain product-specific policy aliases`);
  }
});

test("phase 0 storage-service baseline captures current repo readiness and remaining gaps", () => {
  const reportPath = "docs/baselines/codali-unified-phase0/codali-storage-service-baseline.json";
  const report = readJson(reportPath);
  assert.equal(report.schema_version, "codali.unified.phase0.baseline.v1");
  assert.equal(report.repo.label, "codali-storage-service");
  assert.ok(
    ["not_git_repository", "clean"].includes(report.repo.git_status_at_audit.state),
    "storage-service Git readiness should be captured explicitly",
  );

  const storageRoot = report.repo.root;
  const storageRootExists = fs.existsSync(storageRoot);
  if (storageRootExists) {
    assert.equal(
      fs.existsSync(path.join(storageRoot, ".git")),
      report.repo.git_status_at_audit.state !== "not_git_repository",
      "storage-service Git metadata should match the recorded baseline state",
    );
  }
  assert.equal(report.repo_readiness.package_manager.status, "implemented");
  assert.equal(report.repo_readiness.docker.status, "implemented");
  assert.equal(report.repo_readiness.application_scaffold.status, "partial");

  if (storageRootExists) {
    for (const surface of report.implemented_surfaces) {
      for (const file of filesFromSurface(surface)) {
        assert.ok(existsInRoot(storageRoot, file), `storage implemented surface ${surface.id} references missing file ${file}`);
      }
    }

    for (const file of report.repo_readiness.package_manager.missing_files) {
      assert.equal(existsInRoot(storageRoot, file), false, `storage package-manager gap should still be missing: ${file}`);
    }
    for (const file of report.repo_readiness.docker.missing_files) {
      assert.equal(existsInRoot(storageRoot, file), false, `storage Docker gap should still be missing: ${file}`);
    }
  }

  assert.deepEqual(
    report.implemented_endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort(),
    ["GET /healthz", "GET /readyz", "GET /version"],
  );
  assert.ok(report.missing_endpoints.length >= 10, "storage-service missing endpoints must be enumerated");
  assert.deepEqual(
    report.implemented_commands.map((command) => command.command).sort(),
    [
      "docker build .",
      "docker compose up",
      "pnpm install",
      "pnpm run build",
      "pnpm test",
    ],
  );
  assert.deepEqual(
    report.missing_commands.map((command) => command.command),
    ["pnpm run migrate:up"],
  );
  assert.ok(report.planned_surfaces.includes("local_only default storage mode"));
  assert.ok(report.non_negotiable_invariants.includes("Upload is disabled by default."));
});

test("phase 0 baseline directory contains one report per target repo", () => {
  const reportFiles = fs
    .readdirSync(baselineDir)
    .filter((entry) => entry.endsWith("-baseline.json"))
    .sort();
  assert.deepEqual(reportFiles, ["codali-storage-service-baseline.json", "mcoda-baseline.json"]);
});
