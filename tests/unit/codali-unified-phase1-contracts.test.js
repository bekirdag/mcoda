import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const storageServiceRoot = process.env.CODALI_STORAGE_SERVICE_TEST_ROOT
  ? path.resolve(process.env.CODALI_STORAGE_SERVICE_TEST_ROOT)
  : path.resolve(repoRoot, "..", "codali-storage-service");
const fixturePath = path.join(
  repoRoot,
  "docs/contracts/codali-storage/v1/contract-fixtures.json",
);
const storageServiceBaselinePath = path.join(
  repoRoot,
  "docs/baselines/codali-unified-phase0/codali-storage-service-baseline.json",
);
const unifiedPlanPath = path.join(
  repoRoot,
  "docs/planning/codali-unified-data-storage-improvement-build-plan.md",
);

test("Phase 1 shared contract fixtures validate through @mcoda/codali exports", async () => {
  const codali = await import("../../packages/codali/dist/index.js");
  const fixtureText = readFileSync(fixturePath, "utf8");
  const fixturePayload = JSON.parse(fixtureText);

  const result = codali.validateCodaliStorageContractFixtureSet(fixturePayload);

  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  assert.equal(result.value.contractSchemaVersion, codali.CODALI_STORAGE_CONTRACT_SCHEMA_VERSION);
  assert.equal(
    codali.CODALI_STORAGE_CONTRACT_SCHEMA_COMPATIBILITY.current,
    codali.CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  );
  assert.deepEqual(
    codali.CODALI_STORAGE_CONTRACT_SCHEMA_COMPATIBILITY.supported,
    codali.CODALI_STORAGE_CONTRACT_SCHEMA_VERSIONS,
  );
  assert.equal(
    codali.CODALI_STORAGE_CONTRACT_JSON_SCHEMAS.gatewayRecord.required.includes(
      "schema_version",
    ),
    true,
  );
  assert.equal(/OKACAM|Suku/.test(fixtureText), false);
});

test("Phase 1 storage-service package validates the same shared fixture contract", () => {
  if (!existsSync(storageServiceRoot)) {
    const baseline = JSON.parse(readFileSync(storageServiceBaselinePath, "utf8"));
    assert.equal(baseline.repo.label, "codali-storage-service");
    assert.equal(baseline.repo.git_status_at_audit.state, "clean");
    assert.equal(baseline.repo.git_status_at_audit.remote, "https://github.com/bekirdag/codali-storage-service.git");
    assert.equal(baseline.repo_readiness.package_manager.status, "implemented");
    assert.deepEqual(baseline.repo_readiness.package_manager.implemented_files, ["package.json", "pnpm-lock.yaml"]);
    assert.equal(baseline.repo_readiness.application_scaffold.implemented_paths.includes("src/"), true);
    return;
  }

  const packageJson = JSON.parse(
    readFileSync(path.join(storageServiceRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.name, "codali-storage-service");
  assert.match(packageJson.scripts.build, /tsc -p tsconfig\.json$/);
  assert.match(packageJson.scripts.test, /^pnpm run build && node /);
  assert.match(packageJson.scripts["test:integration"], /^pnpm run build && node /);
  assert.equal(existsSync(path.join(storageServiceRoot, "scripts/run-tests.mjs")), true);
  assert.equal(
    existsSync(path.join(storageServiceRoot, "src/contracts/SharedContractValidation.ts")),
    true,
  );
  assert.equal(
    existsSync(path.join(storageServiceRoot, "src/__tests__/SharedContractValidation.test.ts")),
    true,
  );
});

test("unified plan uses workspace-safe Codali validation commands", () => {
  const planText = readFileSync(unifiedPlanPath, "utf8").replace(/\r\n/g, "\n");
  const commandBlocks = Array.from(
    planText.matchAll(/```text\n([\s\S]*?)\n```/g),
    (match) => match[1],
  );
  const validationBlocks = Array.from(
    planText.matchAll(/Validation:\n\n```text\n([\s\S]*?)\n```/g),
    (match) => match[1],
  );
  const commandText = commandBlocks.join("\n");
  const validationText = validationBlocks.join("\n");
  const bareCodaliCommands = commandText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("codali ") || line.startsWith("dataset export"));

  assert.equal(validationBlocks.length >= 36, true);
  assert.deepEqual(bareCodaliCommands, []);
  assert.equal(
    validationText.includes(
      "pnpm --filter @mcoda/codali exec codali dataset export --dry-run smoke",
    ),
    true,
  );
  assert.equal(
    validationText.includes(
      "pnpm --filter @mcoda/codali exec codali improve eval --candidate <candidate-id> --output json",
    ),
    true,
  );
});
