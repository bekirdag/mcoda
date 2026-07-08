import { readFile } from "node:fs/promises";
import {
  CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
  CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS,
  DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS,
  buildCodaliImprovementCliJsonOutput,
  createCodaliImprovementPolicy,
  evaluateCodaliImprovementPolicy,
  validateCodaliImprovementCliJsonOutput,
  validateCodaliImprovementPolicy,
  type CodaliImprovementArtifactType,
  type CodaliImprovementPolicyAction,
  type CodaliImprovementReleaseLevel,
  type CodaliImprovementScorecard,
  type CodaliImprovementStorageMode,
} from "../improvement/ImprovementPolicy.js";
import {
  DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS,
  buildCodaliCandidateRelease,
  buildCodaliCandidateReleasePlan,
  type CodaliCandidateReleaseBuild,
} from "../improvement/CandidateReleaseBuilder.js";
import {
  DEFAULT_CODALI_PUBLISH_NPM_REGISTRY,
  runCodaliPublishOrchestrator,
  writeCodaliPublishToStorageService,
  type CodaliPublishMode,
  type CodaliPublishNpmVersion,
  type CodaliPublishResult,
  type CodaliPublishWorkflowConclusion,
  type CodaliPublishWorkflowRunStatus,
  type CodaliPublishWorkflowStatus,
} from "../improvement/PublishOrchestrator.js";
import {
  CODALI_RELEASE_RUNTIME_PACKAGE_KINDS,
  runCodaliReleaseOutcomeReporter,
  writeCodaliReleaseOutcomeReportToStorageService,
  type CodaliReleaseMonitorThresholds,
  type CodaliReleaseObservedMetrics,
  type CodaliReleaseOutcomeReport,
  type CodaliReleaseRuntimePackageKind,
} from "../improvement/ReleaseOutcomeReporter.js";
import {
  buildCodaliImprovementEvalScorecard,
  type CodaliImprovementEvalRunnerResult,
} from "../improvement/ImprovementEvalRunner.js";
import {
  inspectDatasetExportManifestForImprovement,
  type DatasetExportManifestReaderResult,
} from "../improvement/DatasetExportManifestReader.js";
import {
  formatCodaliReleaseOperatorInspectionText,
  inspectCodaliReleaseForOperators,
} from "../improvement/OperatorInspector.js";
import {
  buildCodaliEvalReplayCandidateBundle,
  type CodaliEvalReplayCandidateBundle,
  type CodaliEvalReplayProposalArtifact,
} from "../improvement/EvalReplayCandidateBuilder.js";
import {
  CODALI_PATCH_PROPOSAL_ARTIFACTS,
  buildCodaliPatchCandidateBundle,
  type CodaliPatchCandidateBundle,
  type CodaliPatchProposalArtifact,
} from "../improvement/PromptSchemaToolMetadataCandidateBuilder.js";
import {
  CODALI_DOCDEX_RETRIEVAL_SOURCE_ARTIFACT_TYPES,
  buildCodaliDocdexRetrievalCandidateBundle,
  type CodaliDocdexRetrievalCandidateBundle,
  type CodaliDocdexRetrievalProposalArtifact,
} from "../improvement/DocdexRetrievalCandidateBuilder.js";
import {
  CODALI_FINE_TUNE_PROPOSAL_ARTIFACT,
  buildCodaliFineTuneJobPlannerBundle,
  fineTuneArtifactTypesForRole,
  normalizeCodaliFineTuneWorkerRole,
  type CodaliFineTuneInventorySource,
  type CodaliFineTuneInventoryWarning,
  type CodaliFineTuneJobPlannerBundle,
  type CodaliFineTuneProposalArtifact,
  type CodaliFineTuneWorkerRole,
} from "../improvement/FineTuneJobPlanner.js";
import {
  CODALI_MODEL_ROUTER_PROPOSAL_ARTIFACT,
  CODALI_MODEL_ROUTER_SOURCE_ARTIFACT_TYPES,
  buildCodaliModelRouterCandidateBundle,
  type CodaliModelRouterCandidateBundle,
  type CodaliModelRouterProposalArtifact,
} from "../improvement/ModelRouterCandidateBuilder.js";
import {
  StorageServiceImprovementClient,
  type StorageServiceImprovementWriteResult,
} from "../improvement/StorageServiceImprovementClient.js";
import {
  createCodaliProductionGovernanceImprovementOverrides,
  evaluateCodaliProductionGovernanceAction,
  resolveCodaliProductionGovernance,
  type CodaliProductionGovernanceAction,
  type CodaliProductionGovernanceState,
} from "../improvement/ProductionGovernance.js";
import {
  defaultCodaliGatewayLiveCommandRunner,
  parseCodaliGatewayLiveInventory,
} from "../eval/CodaliGatewayLiveHarness.js";
import type { GatewayDatasetStorageScope } from "../storage/GatewayDatasetStore.js";

export const IMPROVEMENT_EXIT_CODES = {
  usage_error: 64,
  validation_error: 65,
} as const;

export class ImprovementCommandError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = IMPROVEMENT_EXIT_CODES.usage_error) {
    super(message);
    this.name = "ImprovementCommandError";
    this.exitCode = exitCode;
  }
}

export interface ParsedImprovementArgs {
  command:
    | "policy"
    | "levels"
    | "inspect"
    | "propose"
    | "build-release"
    | "eval"
    | "publish"
    | "monitor";
  help: boolean;
  output: "text" | "json";
  releaseLevel: CodaliImprovementReleaseLevel;
  tenantHash: string;
  tenantId?: string;
  productId: string;
  deploymentId?: string;
  runId?: string;
  artifactTypes: CodaliImprovementArtifactType[];
  maxExamples: number;
  maxObjectBytes: number;
  storageMode: CodaliImprovementStorageMode;
  exportEnabled: boolean;
  trainingEnabled: boolean;
  autoTagEnabled: boolean;
  autoPublishEnabled: boolean;
  productionGovernance: CodaliProductionGovernanceState;
  checkAction?: CodaliImprovementPolicyAction;
  checkArtifactType?: CodaliImprovementArtifactType;
  checkExamples?: number;
  checkObjectBytes?: number;
  candidateId?: string;
  candidatePath?: string;
  exportId?: string;
  manifestPath?: string;
  directory?: string;
  proposalArtifact?: CodaliImprovementProposalArtifact;
  role?: CodaliFineTuneWorkerRole;
  exampleArtifactTypes: string[];
  revokedDeletionGroupIds: string[];
  dryRun: boolean;
  inventoryJson?: string;
  inventoryPath?: string;
  inventoryRefresh: boolean;
  inventoryTimeoutMs: number;
  storageServiceUrl?: string;
  storageServiceToken?: string;
  hmacSecret?: string;
  repoRoot?: string;
  candidateDate?: string;
  candidateOutputPath?: string;
  approvedWritePaths: string[];
  publishMode: CodaliPublishMode;
  workflowRunId?: string;
  workflowStatus?: CodaliPublishWorkflowStatus;
  workflowConclusion?: CodaliPublishWorkflowConclusion;
  workflowUrl?: string;
  commitSha?: string;
  pollActions: boolean;
  verifyNpm?: boolean;
  npmRegistry: string;
  npmPackages: string[];
  npmVersionResults: Array<{ packageName: string; version: string }>;
  releaseId?: string;
  monitorWindowMinutes: number;
  monitorWindowStartedAt?: string;
  monitorWindowEndedAt?: string;
  monitorThresholds: Partial<CodaliReleaseMonitorThresholds>;
  monitorMetrics: Partial<CodaliReleaseObservedMetrics>;
  runtimeVersions: Partial<Record<CodaliReleaseRuntimePackageKind, string>>;
  disabledRuntimePackages: CodaliReleaseRuntimePackageKind[];
  rollbackApplied: boolean;
  published: boolean;
  tagged: boolean;
  trainingUsed: boolean;
  exportUsed: boolean;
}

type CodaliImprovementProposalArtifact =
  | CodaliEvalReplayProposalArtifact
  | CodaliPatchProposalArtifact
  | CodaliDocdexRetrievalProposalArtifact
  | CodaliModelRouterProposalArtifact
  | CodaliFineTuneProposalArtifact;

type CodaliImprovementProposalBundle =
  | CodaliEvalReplayCandidateBundle
  | CodaliPatchCandidateBundle
  | CodaliDocdexRetrievalCandidateBundle
  | CodaliModelRouterCandidateBundle
  | CodaliFineTuneJobPlannerBundle;

const HELP_TEXT =
  "Usage: codali improvement <policy|levels|inspect|propose|build-release|eval|publish|monitor> [options]\n" +
  "   or: codali improve inspect --export-id <id> --dry-run [options]\n" +
  "   or: codali improve inspect --release <release-id> --output json [options]\n" +
  "   or: codali improve propose --artifact <eval|prompt|schema|tool-metadata|docdex-retrieval|fine-tune|model-router> --export-id <id> --dry-run [options]\n" +
  "   or: codali improve build-release --candidate <id> --dry-run [options]\n" +
  "   or: codali improve eval --candidate <candidate-id> --output json [options]\n" +
  "   or: codali improve publish --candidate <candidate-id> --mode <branch_only|auto_tag> --dry-run [options]\n" +
  "   or: codali improve monitor --release <release-id> --output json [options]\n" +
  "\n" +
  "Commands:\n" +
  "  policy   Build and validate an improvement policy contract.\n" +
  "  levels   Print the explicit improvement release levels.\n" +
  "  inspect  Verify a dataset export manifest or inspect release lineage for operators.\n" +
  "  propose  Build deterministic improvement candidates from an export.\n" +
  "  build-release Build a guarded candidate branch workspace and release plan.\n" +
  "  eval     Build release scorecards and security-gate approval decisions.\n" +
  "  publish  Orchestrate branch-only or policy-gated auto-tag release publishing.\n" +
  "  monitor  Report canary, shadow rollout, rollback, and runtime flag outcomes.\n" +
  "\n" +
  "Options:\n" +
  "  --output <text|json>          Output mode (default: text).\n" +
  "  --level <0|1|2|3|4>           Maximum release level (default: 0).\n" +
  "  --tenant-hash <hash>          Tenant scope hash.\n" +
  "  --tenant-id <id>              Storage-service tenant scope id.\n" +
  "  --product-id <id>             Product scope id.\n" +
  "  --deployment-id <id>          Optional deployment scope id.\n" +
  "  --run-id <id>                 Optional storage-service run scope id.\n" +
  "  --artifact-type <type>        Allowed artifact type; can repeat.\n" +
  "  --max-examples <count>        Maximum examples for a run.\n" +
  "  --max-object-bytes <bytes>    Maximum artifact/object bytes.\n" +
  "  --storage-mode <mode>         local_only|storage_service|hybrid.\n" +
  "  --artifact <type>             Proposal artifact: eval|prompt|schema|tool-metadata|docdex-retrieval|fine-tune|model-router.\n" +
  "  --role <role>                 Fine-tune worker role (default: extractor).\n" +
  "  --export-id <id>              Dataset export manifest id to inspect.\n" +
  "  --manifest <path>             Dataset export manifest file path.\n" +
  "  --directory <path>            Directory to search for export manifests or release artifacts.\n" +
  "  --repo-root <path>            Repository root for candidate workspace checks.\n" +
  "  --candidate-date <yyyy-mm-dd> Candidate branch date (default: manifest date).\n" +
  "  --candidate-output <path>     Candidate release artifact path.\n" +
  "  --candidate <id>              Candidate id, manifest id, or candidate JSON path for eval.\n" +
  "  --candidate-path <path>       Candidate JSON or manifest file path for eval.\n" +
  "  --mode <branch_only|auto_tag> Publish orchestration mode (default: branch_only).\n" +
  "  --commit-sha <sha>            Candidate commit sha for publish status ingestion.\n" +
  "  --workflow-run-id <id>        Ingest GitHub Actions release workflow run id.\n" +
  "  --workflow-status <status>    Ingest GitHub Actions run status.\n" +
  "  --workflow-conclusion <c>     Ingest GitHub Actions run conclusion.\n" +
  "  --workflow-url <url>          Ingest GitHub Actions run URL.\n" +
  "  --poll-actions               Poll GitHub Actions release workflow status with gh.\n" +
  "  --verify-npm                 Verify published versions with npm view.\n" +
  "  --npm-package <name>          Package to verify with npm view; can repeat.\n" +
  "  --npm-version <name=version>  Ingest observed npm version; can repeat.\n" +
  "  --npm-registry <url>          npm registry for version verification.\n" +
  "  --release <id>                Release id for post-release monitoring.\n" +
  "  --monitor-window-minutes <m>  Monitor window duration (default: 60).\n" +
  "  --monitor-started-at <iso>    Monitor window start timestamp.\n" +
  "  --monitor-ended-at <iso>      Monitor window end timestamp.\n" +
  "  --prompt-package-version <v>  Runtime prompt package version.\n" +
  "  --router-policy-version <v>   Runtime router policy version.\n" +
  "  --retrieval-policy-version <v> Runtime retrieval policy version.\n" +
  "  --schema-version <v>          Runtime schema package version.\n" +
  "  --fine-tune-adapter-version <v> Runtime fine-tune adapter version.\n" +
  "  --disable-runtime-package <k> Runtime package kind to disable; can repeat.\n" +
  "  --eligible-requests <n>       Eligible request count for shadow monitoring.\n" +
  "  --shadow-requests <n>         Shadow request count; shadow remains non-blocking.\n" +
  "  --schema-failures <n>         Observed schema failure count.\n" +
  "  --accepted-answer-rate <r>    Current accepted-answer rate from 0 to 1.\n" +
  "  --baseline-accepted-answer-rate <r> Baseline accepted-answer rate.\n" +
  "  --verifier-contradictions <n> Observed verifier contradiction count.\n" +
  "  --tool-failures <n>           Observed tool failure count.\n" +
  "  --p95-latency-ms <n>          Current p95 latency in milliseconds.\n" +
  "  --baseline-p95-latency-ms <n> Baseline p95 latency in milliseconds.\n" +
  "  --cost-usd <n>                Current monitor-window cost.\n" +
  "  --baseline-cost-usd <n>       Baseline monitor-window cost.\n" +
  "  --privacy-security-warnings <n> Observed privacy/security warning count.\n" +
  "  --rollback-applied           Mark runtime-package rollback as applied.\n" +
  "  --approved-path <path>        Approved write file/directory; can repeat.\n" +
  "  --inventory-json <json>       Use a provided mcoda agent inventory JSON payload.\n" +
  "  --inventory-file <path>       Use a provided mcoda agent inventory JSON file.\n" +
  "  --no-inventory-refresh        Do not run mcoda agent list for fine-tune targets.\n" +
  "  --inventory-timeout-ms <ms>   Timeout for mcoda agent inventory refresh.\n" +
  "  --example-artifact-type <t>   Restrict curated examples by artifact type; can repeat.\n" +
  "  --revoked-deletion-group <id> Treat a deletion group as revoked during inspection.\n" +
  "  --dry-run                    Verify locally without storage-service writes.\n" +
  "  --no-dry-run, --write         Send inspected runs/candidates to storage service.\n" +
  "  --storage-service-url <url>   Storage service base URL for writes.\n" +
  "  --storage-service-token <tok> Storage service bearer token for writes.\n" +
  "  --hmac-secret <secret>        Optional signing secret; defaults to service token.\n" +
  "  --enable-export              Allow export actions.\n" +
  "  --enable-training            Allow training actions.\n" +
  "  --auto-tag                   Allow automatic tag actions.\n" +
  "  --auto-publish               Allow automatic publish actions.\n" +
  "  --check-action <action>       Evaluate an action against the policy.\n" +
  "  --check-artifact-type <type>  Evaluate an artifact type.\n" +
  "  --check-examples <count>      Evaluate an example count.\n" +
  "  --check-object-bytes <bytes>  Evaluate an object byte count.\n" +
  "  --help, -h                   Show help.\n";

const DEFAULT_TENANT_HASH = "local_tenant";
const DEFAULT_PRODUCT_ID = "local_product";
const DEFAULT_STORAGE_TENANT_ID = "local";
const DEFAULT_STORAGE_DEPLOYMENT_ID = "local";
const DEFAULT_FINE_TUNE_INVENTORY_TIMEOUT_MS = 120_000;
const DEFAULT_FINE_TUNE_INVENTORY_MAX_BUFFER = 4 * 1024 * 1024;

export const parseImprovementArgs = (argv: string[]): ParsedImprovementArgs => {
  const parsed: ParsedImprovementArgs = {
    command: "policy",
    help: false,
    output: "text",
    releaseLevel: 0,
    tenantHash: DEFAULT_TENANT_HASH,
    productId: DEFAULT_PRODUCT_ID,
    dryRun: true,
    inventoryRefresh: true,
    inventoryTimeoutMs: DEFAULT_FINE_TUNE_INVENTORY_TIMEOUT_MS,
    artifactTypes: [...DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.allowedArtifactTypes],
    exampleArtifactTypes: [],
    revokedDeletionGroupIds: [],
    approvedWritePaths: [],
    publishMode: "branch_only",
    pollActions: false,
    npmRegistry: DEFAULT_CODALI_PUBLISH_NPM_REGISTRY,
    npmPackages: [],
    npmVersionResults: [],
    monitorWindowMinutes: 60,
    monitorThresholds: {},
    monitorMetrics: {},
    runtimeVersions: {},
    disabledRuntimePackages: [],
    rollbackApplied: false,
    published: false,
    tagged: false,
    trainingUsed: false,
    exportUsed: false,
    maxExamples: DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.maxExamples,
    maxObjectBytes: DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.maxObjectBytes,
    storageMode: DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.storageMode,
    exportEnabled: DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.exportEnabled,
    trainingEnabled: DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.trainingEnabled,
    autoTagEnabled: DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.autoTagEnabled,
    autoPublishEnabled: DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.autoPublishEnabled,
    productionGovernance: resolveCodaliProductionGovernance(),
  };

  const args = [...argv];
  const first = args[0];
  if (
    first === "policy" ||
    first === "levels" ||
    first === "inspect" ||
    first === "propose" ||
    first === "build-release" ||
    first === "eval" ||
    first === "publish" ||
    first === "monitor"
  ) {
    parsed.command = first;
    args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--output" && next) {
      if (next !== "text" && next !== "json") {
        throw new ImprovementCommandError("Invalid --output value. Expected text|json.");
      }
      parsed.output = next;
      index += 1;
      continue;
    }
    if (arg === "--level" && next) {
      parsed.releaseLevel = parseReleaseLevel(next, "--level");
      parsed.artifactTypes = [
        ...CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[parsed.releaseLevel]
          .allowedArtifactTypes,
      ];
      index += 1;
      continue;
    }
    if (arg === "--tenant-hash" && next) {
      parsed.tenantHash = next;
      index += 1;
      continue;
    }
    if ((arg === "--tenant-id" || arg === "--tenant") && next) {
      parsed.tenantId = next;
      index += 1;
      continue;
    }
    if (arg === "--product-id" && next) {
      parsed.productId = next;
      index += 1;
      continue;
    }
    if (arg === "--deployment-id" && next) {
      parsed.deploymentId = next;
      index += 1;
      continue;
    }
    if (arg === "--run-id" && next) {
      parsed.runId = next;
      index += 1;
      continue;
    }
    if (arg === "--export-id" && next) {
      parsed.exportId = next;
      index += 1;
      continue;
    }
    if ((arg === "--candidate" || arg === "--candidate-id") && next) {
      parsed.candidateId = next;
      index += 1;
      continue;
    }
    if ((arg === "--candidate-path" || arg === "--candidate-file") && next) {
      parsed.candidatePath = next;
      index += 1;
      continue;
    }
    if (arg === "--artifact" && next) {
      parsed.proposalArtifact = parseProposalArtifact(next, "--artifact");
      index += 1;
      continue;
    }
    if (arg === "--role" && next) {
      parsed.role = parseFineTuneRole(next, "--role");
      index += 1;
      continue;
    }
    if (arg === "--inventory-json" && next) {
      parsed.inventoryJson = next;
      index += 1;
      continue;
    }
    if ((arg === "--inventory-file" || arg === "--inventory") && next) {
      parsed.inventoryPath = next;
      index += 1;
      continue;
    }
    if (arg === "--no-inventory-refresh") {
      parsed.inventoryRefresh = false;
      continue;
    }
    if (arg === "--inventory-timeout-ms" && next) {
      parsed.inventoryTimeoutMs = parsePositiveInteger(next, "--inventory-timeout-ms");
      index += 1;
      continue;
    }
    if ((arg === "--manifest" || arg === "--manifest-path") && next) {
      parsed.manifestPath = next;
      index += 1;
      continue;
    }
    if (arg === "--directory" && next) {
      parsed.directory = next;
      index += 1;
      continue;
    }
    if (arg === "--repo-root" && next) {
      parsed.repoRoot = next;
      index += 1;
      continue;
    }
    if (arg === "--candidate-date" && next) {
      parsed.candidateDate = next;
      index += 1;
      continue;
    }
    if ((arg === "--candidate-output" || arg === "--candidate-output-path") && next) {
      parsed.candidateOutputPath = next;
      index += 1;
      continue;
    }
    if (arg === "--mode" && next) {
      parsed.publishMode = parsePublishMode(next, "--mode");
      index += 1;
      continue;
    }
    if (arg === "--commit-sha" && next) {
      parsed.commitSha = next;
      index += 1;
      continue;
    }
    if (arg === "--workflow-run-id" && next) {
      parsed.workflowRunId = next;
      index += 1;
      continue;
    }
    if (arg === "--workflow-status" && next) {
      parsed.workflowStatus = parseWorkflowStatus(next, "--workflow-status");
      index += 1;
      continue;
    }
    if (arg === "--workflow-conclusion" && next) {
      parsed.workflowConclusion = parseWorkflowConclusion(next, "--workflow-conclusion");
      index += 1;
      continue;
    }
    if (arg === "--workflow-url" && next) {
      parsed.workflowUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--poll-actions") {
      parsed.pollActions = true;
      continue;
    }
    if (arg === "--verify-npm") {
      parsed.verifyNpm = true;
      continue;
    }
    if (arg === "--no-npm-verify") {
      parsed.verifyNpm = false;
      continue;
    }
    if (arg === "--npm-registry" && next) {
      parsed.npmRegistry = next;
      index += 1;
      continue;
    }
    if (arg === "--npm-package" && next) {
      parsed.npmPackages.push(next);
      index += 1;
      continue;
    }
    if (arg === "--npm-version" && next) {
      parsed.npmVersionResults.push(parseNpmVersionResult(next, "--npm-version"));
      index += 1;
      continue;
    }
    if ((arg === "--release" || arg === "--release-id") && next) {
      parsed.releaseId = next;
      index += 1;
      continue;
    }
    if (arg === "--monitor-window-minutes" && next) {
      parsed.monitorWindowMinutes = parsePositiveInteger(next, "--monitor-window-minutes");
      index += 1;
      continue;
    }
    if (arg === "--monitor-started-at" && next) {
      parsed.monitorWindowStartedAt = parseIsoTimestamp(next, "--monitor-started-at");
      index += 1;
      continue;
    }
    if (arg === "--monitor-ended-at" && next) {
      parsed.monitorWindowEndedAt = parseIsoTimestamp(next, "--monitor-ended-at");
      index += 1;
      continue;
    }
    if (arg === "--prompt-package-version" && next) {
      parsed.runtimeVersions.prompt_package = next;
      index += 1;
      continue;
    }
    if (arg === "--router-policy-version" && next) {
      parsed.runtimeVersions.router_policy = next;
      index += 1;
      continue;
    }
    if (arg === "--retrieval-policy-version" && next) {
      parsed.runtimeVersions.retrieval_policy = next;
      index += 1;
      continue;
    }
    if (arg === "--schema-version" && next) {
      parsed.runtimeVersions.schema = next;
      index += 1;
      continue;
    }
    if (arg === "--fine-tune-adapter-version" && next) {
      parsed.runtimeVersions.fine_tune_adapter = next;
      index += 1;
      continue;
    }
    if (arg === "--disable-runtime-package" && next) {
      const packageKind = parseRuntimePackageKind(next, "--disable-runtime-package");
      if (!parsed.disabledRuntimePackages.includes(packageKind)) {
        parsed.disabledRuntimePackages.push(packageKind);
      }
      index += 1;
      continue;
    }
    if (arg === "--eligible-requests" && next) {
      parsed.monitorMetrics.eligibleRequestCount =
        parseNonNegativeInteger(next, "--eligible-requests");
      index += 1;
      continue;
    }
    if (arg === "--shadow-requests" && next) {
      parsed.monitorMetrics.shadowRequestCount =
        parseNonNegativeInteger(next, "--shadow-requests");
      index += 1;
      continue;
    }
    if (arg === "--schema-failures" && next) {
      parsed.monitorMetrics.schemaFailures =
        parseNonNegativeInteger(next, "--schema-failures");
      index += 1;
      continue;
    }
    if (arg === "--accepted-answer-rate" && next) {
      parsed.monitorMetrics.acceptedAnswerRate = parseRate(next, "--accepted-answer-rate");
      index += 1;
      continue;
    }
    if (arg === "--baseline-accepted-answer-rate" && next) {
      parsed.monitorMetrics.baselineAcceptedAnswerRate =
        parseRate(next, "--baseline-accepted-answer-rate");
      index += 1;
      continue;
    }
    if (arg === "--verifier-contradictions" && next) {
      parsed.monitorMetrics.verifierContradictions =
        parseNonNegativeInteger(next, "--verifier-contradictions");
      index += 1;
      continue;
    }
    if (arg === "--tool-failures" && next) {
      parsed.monitorMetrics.toolFailures = parseNonNegativeInteger(next, "--tool-failures");
      index += 1;
      continue;
    }
    if (arg === "--p95-latency-ms" && next) {
      parsed.monitorMetrics.p95LatencyMs =
        parseNonNegativeNumber(next, "--p95-latency-ms");
      index += 1;
      continue;
    }
    if (arg === "--baseline-p95-latency-ms" && next) {
      parsed.monitorMetrics.baselineP95LatencyMs =
        parseNonNegativeNumber(next, "--baseline-p95-latency-ms");
      index += 1;
      continue;
    }
    if (arg === "--cost-usd" && next) {
      parsed.monitorMetrics.costUsd = parseNonNegativeNumber(next, "--cost-usd");
      index += 1;
      continue;
    }
    if (arg === "--baseline-cost-usd" && next) {
      parsed.monitorMetrics.baselineCostUsd =
        parseNonNegativeNumber(next, "--baseline-cost-usd");
      index += 1;
      continue;
    }
    if (arg === "--privacy-security-warnings" && next) {
      parsed.monitorMetrics.privacySecurityWarnings =
        parseNonNegativeInteger(next, "--privacy-security-warnings");
      index += 1;
      continue;
    }
    if (arg === "--threshold-schema-failures" && next) {
      parsed.monitorThresholds.maxSchemaFailures =
        parseNonNegativeInteger(next, "--threshold-schema-failures");
      index += 1;
      continue;
    }
    if (arg === "--min-accepted-answer-rate" && next) {
      parsed.monitorThresholds.minAcceptedAnswerRate =
        parseRate(next, "--min-accepted-answer-rate");
      index += 1;
      continue;
    }
    if (arg === "--threshold-accepted-answer-rate-drop" && next) {
      parsed.monitorThresholds.maxAcceptedAnswerRateDrop =
        parseRate(next, "--threshold-accepted-answer-rate-drop");
      index += 1;
      continue;
    }
    if (arg === "--threshold-verifier-contradictions" && next) {
      parsed.monitorThresholds.maxVerifierContradictions =
        parseNonNegativeInteger(next, "--threshold-verifier-contradictions");
      index += 1;
      continue;
    }
    if (arg === "--threshold-tool-failures" && next) {
      parsed.monitorThresholds.maxToolFailures =
        parseNonNegativeInteger(next, "--threshold-tool-failures");
      index += 1;
      continue;
    }
    if (arg === "--threshold-latency-increase-ratio" && next) {
      parsed.monitorThresholds.maxP95LatencyIncreaseRatio =
        parseNonNegativeNumber(next, "--threshold-latency-increase-ratio");
      index += 1;
      continue;
    }
    if (arg === "--threshold-cost-increase-ratio" && next) {
      parsed.monitorThresholds.maxCostIncreaseRatio =
        parseNonNegativeNumber(next, "--threshold-cost-increase-ratio");
      index += 1;
      continue;
    }
    if (arg === "--threshold-privacy-security-warnings" && next) {
      parsed.monitorThresholds.maxPrivacySecurityWarnings =
        parseNonNegativeInteger(next, "--threshold-privacy-security-warnings");
      index += 1;
      continue;
    }
    if (arg === "--rollback-applied") {
      parsed.rollbackApplied = true;
      continue;
    }
    if (arg === "--published") {
      parsed.published = true;
      continue;
    }
    if (arg === "--tagged") {
      parsed.tagged = true;
      continue;
    }
    if (arg === "--training-used") {
      parsed.trainingUsed = true;
      continue;
    }
    if (arg === "--export-used") {
      parsed.exportUsed = true;
      continue;
    }
    if ((arg === "--approved-path" || arg === "--allow-write-path") && next) {
      parsed.approvedWritePaths.push(next);
      index += 1;
      continue;
    }
    if (arg === "--example-artifact-type" && next) {
      parsed.exampleArtifactTypes.push(next);
      index += 1;
      continue;
    }
    if (arg === "--revoked-deletion-group" && next) {
      parsed.revokedDeletionGroupIds.push(next);
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--no-dry-run" || arg === "--write") {
      parsed.dryRun = false;
      continue;
    }
    if ((arg === "--storage-service-url" || arg === "--service-url") && next) {
      parsed.storageServiceUrl = next;
      index += 1;
      continue;
    }
    if ((arg === "--storage-service-token" || arg === "--service-token") && next) {
      parsed.storageServiceToken = next;
      index += 1;
      continue;
    }
    if (arg === "--hmac-secret" && next) {
      parsed.hmacSecret = next;
      index += 1;
      continue;
    }
    if (arg === "--artifact-type" && next) {
      const artifactType = parseArtifactType(next, "--artifact-type");
      if (!parsed.artifactTypes.includes(artifactType)) {
        parsed.artifactTypes.push(artifactType);
      }
      index += 1;
      continue;
    }
    if (arg === "--max-examples" && next) {
      parsed.maxExamples = parseNonNegativeInteger(next, "--max-examples");
      index += 1;
      continue;
    }
    if (arg === "--max-object-bytes" && next) {
      parsed.maxObjectBytes = parsePositiveInteger(next, "--max-object-bytes");
      index += 1;
      continue;
    }
    if (arg === "--storage-mode" && next) {
      parsed.storageMode = parseStorageMode(next, "--storage-mode");
      index += 1;
      continue;
    }
    if (arg === "--enable-export") {
      parsed.exportEnabled = true;
      continue;
    }
    if (arg === "--enable-training") {
      parsed.trainingEnabled = true;
      continue;
    }
    if (arg === "--auto-tag") {
      parsed.autoTagEnabled = true;
      continue;
    }
    if (arg === "--auto-publish") {
      parsed.autoPublishEnabled = true;
      continue;
    }
    if (arg === "--check-action" && next) {
      parsed.checkAction = parseAction(next, "--check-action");
      index += 1;
      continue;
    }
    if (arg === "--check-artifact-type" && next) {
      parsed.checkArtifactType = parseArtifactType(next, "--check-artifact-type");
      index += 1;
      continue;
    }
    if (arg === "--check-examples" && next) {
      parsed.checkExamples = parseNonNegativeInteger(next, "--check-examples");
      index += 1;
      continue;
    }
    if (arg === "--check-object-bytes" && next) {
      parsed.checkObjectBytes = parseNonNegativeInteger(next, "--check-object-bytes");
      index += 1;
      continue;
    }
    throw new ImprovementCommandError(`Unknown improvement option: ${arg ?? ""}`);
  }

  parsed.productionGovernance = resolveCodaliProductionGovernance({
    releaseLevel: parsed.releaseLevel,
  });
  const governanceOverrides =
    createCodaliProductionGovernanceImprovementOverrides(parsed.productionGovernance);
  if (governanceOverrides.storageMode) {
    parsed.storageMode = governanceOverrides.storageMode;
  }
  if (governanceOverrides.exportEnabled !== undefined) {
    parsed.exportEnabled = governanceOverrides.exportEnabled;
  }
  if (governanceOverrides.trainingEnabled !== undefined) {
    parsed.trainingEnabled = governanceOverrides.trainingEnabled;
  }
  if (governanceOverrides.autoTagEnabled !== undefined) {
    parsed.autoTagEnabled = governanceOverrides.autoTagEnabled;
  }
  if (governanceOverrides.autoPublishEnabled !== undefined) {
    parsed.autoPublishEnabled = governanceOverrides.autoPublishEnabled;
  }
  if (governanceOverrides.dryRun) {
    parsed.dryRun = true;
  }

  return parsed;
};

export class ImprovementCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseImprovementArgs(argv);
    if (parsed.help) {
      // eslint-disable-next-line no-console
      console.log(HELP_TEXT);
      return;
    }

    if (parsed.command === "inspect") {
      await runInspect(parsed);
      return;
    }

    if (parsed.command === "propose") {
      await runPropose(parsed);
      return;
    }

    if (parsed.command === "build-release") {
      await runBuildRelease(parsed);
      return;
    }

    if (parsed.command === "eval") {
      await runEval(parsed);
      return;
    }

    if (parsed.command === "publish") {
      await runPublish(parsed);
      return;
    }

    if (parsed.command === "monitor") {
      await runMonitor(parsed);
      return;
    }

    if (parsed.command === "levels") {
      const data = Object.values(CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS);
      // eslint-disable-next-line no-console
      console.log(
        parsed.output === "json"
          ? JSON.stringify(
            buildCodaliImprovementCliJsonOutput({
              outputType: "improvement.release_levels",
              status: "ok",
              data,
            }),
            null,
            2,
          )
          : data
            .map((level) => `level ${level.level}: ${level.description}`)
            .join("\n"),
      );
      return;
    }

    const scope = parsed.deploymentId
      ? {
        tenantHash: parsed.tenantHash,
        productId: parsed.productId,
        deploymentId: parsed.deploymentId,
      }
      : {
        tenantHash: parsed.tenantHash,
        productId: parsed.productId,
      };

    const policy = createCodaliImprovementPolicy({
      policyId: `policy-level-${parsed.releaseLevel}`,
      releaseLevel: parsed.releaseLevel,
      scope,
      allowedArtifactTypes: parsed.artifactTypes,
      maxExamples: parsed.maxExamples,
      maxObjectBytes: parsed.maxObjectBytes,
      storageMode: parsed.storageMode,
      exportEnabled: parsed.exportEnabled,
      trainingEnabled: parsed.trainingEnabled,
      autoTagEnabled: parsed.autoTagEnabled,
      autoPublishEnabled: parsed.autoPublishEnabled,
      metadata: {
        source: "codali improvement policy cli",
        productionGovernance: parsed.productionGovernance,
      },
    });

    const validation = validateCodaliImprovementPolicy(policy);
    const decision = parsed.checkAction
      ? evaluateCodaliImprovementPolicy(policy, {
        action: parsed.checkAction,
        scope: policy.scope,
        releaseLevel: parsed.releaseLevel,
        artifactType: parsed.checkArtifactType,
        exampleCount: parsed.checkExamples,
        objectBytes: parsed.checkObjectBytes,
      })
      : undefined;
    const status = !validation.ok
      ? "error"
      : decision && !decision.allowed
        ? "blocked"
        : "ok";
    const output = buildCodaliImprovementCliJsonOutput({
      outputType: decision ? "improvement.policy_decision" : "improvement.policy",
      status,
      policy,
      decision,
      issues: validation.ok ? [] : validation.issues,
    });
    const outputValidation = validateCodaliImprovementCliJsonOutput(output);

    if (parsed.output === "json") {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(output, null, 2));
    } else {
      // eslint-disable-next-line no-console
      console.log(formatPolicyText(output));
    }

    if (!validation.ok || !outputValidation.ok) {
      throw new ImprovementCommandError(
        "Improvement policy JSON contract validation failed.",
        IMPROVEMENT_EXIT_CODES.validation_error,
      );
    }
  }
}

const storageScopeFromParsed = (
  parsed: ParsedImprovementArgs,
  inspection: DatasetExportManifestReaderResult,
): GatewayDatasetStorageScope => ({
  tenantId: parsed.tenantId ?? DEFAULT_STORAGE_TENANT_ID,
  productId: parsed.productId,
  deploymentId: parsed.deploymentId ?? DEFAULT_STORAGE_DEPLOYMENT_ID,
  runId: parsed.runId ?? `improvement-inspect-${inspection.manifest.manifestId}`,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const storageScopeFromEval = (
  parsed: ParsedImprovementArgs,
  result: CodaliImprovementEvalRunnerResult,
): GatewayDatasetStorageScope => {
  const releaseScope = isRecord(result.storagePayload.releaseScope)
    ? result.storagePayload.releaseScope
    : {};
  const releaseTenantHash = typeof releaseScope.tenantHash === "string"
    ? releaseScope.tenantHash
    : undefined;
  const releaseProductId = typeof releaseScope.productId === "string"
    ? releaseScope.productId
    : undefined;
  const releaseDeploymentId = typeof releaseScope.deploymentId === "string"
    ? releaseScope.deploymentId
    : undefined;
  return {
    tenantId: parsed.tenantId ?? releaseTenantHash ?? DEFAULT_STORAGE_TENANT_ID,
    productId: parsed.productId === DEFAULT_PRODUCT_ID && releaseProductId
      ? releaseProductId
      : parsed.productId,
    deploymentId: parsed.deploymentId ?? releaseDeploymentId ?? DEFAULT_STORAGE_DEPLOYMENT_ID,
    runId: parsed.runId ?? `improvement-eval-${result.candidateId}`,
  };
};

const storageScopeFromPublish = (
  parsed: ParsedImprovementArgs,
  result: CodaliPublishResult,
): GatewayDatasetStorageScope => ({
  tenantId: parsed.tenantId ?? result.outcome.scope.tenantHash ?? DEFAULT_STORAGE_TENANT_ID,
  productId: parsed.productId === DEFAULT_PRODUCT_ID && result.outcome.scope.productId
    ? result.outcome.scope.productId
    : parsed.productId,
  deploymentId:
    parsed.deploymentId ?? result.outcome.scope.deploymentId ?? DEFAULT_STORAGE_DEPLOYMENT_ID,
  runId: parsed.runId ?? `improvement-publish-${result.candidateId}`,
});

const storageScopeFromMonitor = (
  parsed: ParsedImprovementArgs,
  report: CodaliReleaseOutcomeReport,
): GatewayDatasetStorageScope => ({
  tenantId: parsed.tenantId ?? report.outcome.scope.tenantHash ?? DEFAULT_STORAGE_TENANT_ID,
  productId: parsed.productId === DEFAULT_PRODUCT_ID && report.outcome.scope.productId
    ? report.outcome.scope.productId
    : parsed.productId,
  deploymentId:
    parsed.deploymentId ?? report.outcome.scope.deploymentId ?? DEFAULT_STORAGE_DEPLOYMENT_ID,
  runId: parsed.runId ?? `improvement-monitor-${report.releaseId}`,
});

const hasHardEvalBlocks = (result: CodaliImprovementEvalRunnerResult): boolean =>
  result.releaseApproval.failedHardGateIds.length > 0 ||
  result.releaseApproval.skippedHardGateIds.length > 0;

const assertProductionGovernanceAllows = (
  parsed: ParsedImprovementArgs,
  action: CodaliProductionGovernanceAction,
): void => {
  const decision = evaluateCodaliProductionGovernanceAction(
    parsed.productionGovernance,
    action,
  );
  if (!decision.allowed) {
    throw new ImprovementCommandError(
      `Production governance blocked ${action}: ${decision.reasons.join(", ")}.`,
    );
  }
};

const buildEvalOutputScorecard = (
  result: CodaliImprovementEvalRunnerResult,
  storageWrites: Array<StorageServiceImprovementWriteResult<unknown>>,
): CodaliImprovementScorecard => ({
  ...result.scorecard,
  metadata: {
    ...(result.scorecard.metadata ?? {}),
    storageWrites: storageWrites.map((write) => ({
      accepted: write.accepted,
      status: write.status,
      scope: write.scope,
    })),
  },
});

const buildInspectData = (
  parsed: ParsedImprovementArgs,
  inspection: DatasetExportManifestReaderResult,
  storageWrites: Array<StorageServiceImprovementWriteResult<unknown>>,
) => ({
  dryRun: parsed.dryRun,
  exportId: inspection.exportId,
  manifest: {
    manifestId: inspection.manifest.manifestId,
    manifestPath: inspection.manifestPath,
    exportKind: inspection.manifest.exportKind,
    exportFormat: inspection.manifest.exportFormat,
    recordCount: inspection.manifest.recordCount,
    checksum: inspection.manifest.checksum,
    createdAt: inspection.manifest.createdAt,
  },
  primaryArtifact: inspection.primaryArtifact
    ? {
        refId: inspection.primaryArtifact.ref.refId,
        path: inspection.primaryArtifact.path,
        contentHash: inspection.primaryArtifact.contentHash,
        byteSize: inspection.primaryArtifact.byteSize,
        payloadSummary: inspection.primaryArtifact.payloadSummary,
      }
    : undefined,
  provenance: inspection.provenance,
  candidates: inspection.candidates,
  warnings: inspection.warnings,
  curationReport: inspection.curationReport,
  storageWrites: storageWrites.map((write) => ({
    accepted: write.accepted,
    status: write.status,
    scope: write.scope,
  })),
});

const proposalArtifactTypesFor = (
  artifact: CodaliImprovementProposalArtifact,
  role: CodaliFineTuneWorkerRole = "extractor",
): string[] => {
  if (artifact === "eval") return ["eval", "eval_replay", "replay"];
  if (artifact === "prompt") return ["prompt", "prompt_patch", "prompt_regression"];
  if (artifact === "schema") return ["schema", "schema_patch"];
  if (artifact === "tool-metadata") {
    return ["tool_metadata", "tool_metadata_patch", "tool_contract"];
  }
  if (artifact === "docdex-retrieval") {
    return [...CODALI_DOCDEX_RETRIEVAL_SOURCE_ARTIFACT_TYPES];
  }
  if (artifact === CODALI_MODEL_ROUTER_PROPOSAL_ARTIFACT) {
    return [...CODALI_MODEL_ROUTER_SOURCE_ARTIFACT_TYPES];
  }
  if (artifact === CODALI_FINE_TUNE_PROPOSAL_ARTIFACT) {
    return fineTuneArtifactTypesForRole(role);
  }
  return [artifact];
};

const buildProposeData = (
  parsed: ParsedImprovementArgs,
  proposal: CodaliImprovementProposalBundle,
) => ({
  dryRun: parsed.dryRun,
  artifact: proposal.artifact,
  exportId: proposal.source.exportId,
  manifestId: proposal.source.manifestId,
  proposal,
});

const improvementScopeFromParsed = (
  parsed: ParsedImprovementArgs,
) => parsed.deploymentId
  ? {
      tenantHash: parsed.tenantHash,
      productId: parsed.productId,
      deploymentId: parsed.deploymentId,
    }
  : {
      tenantHash: parsed.tenantHash,
      productId: parsed.productId,
    };

const isPatchProposalArtifact = (
  artifact: CodaliImprovementProposalArtifact | undefined,
): artifact is CodaliPatchProposalArtifact =>
  artifact === "prompt" || artifact === "schema" || artifact === "tool-metadata";

const runInspect = async (parsed: ParsedImprovementArgs): Promise<void> => {
  if (parsed.releaseId) {
    const inspection = await inspectCodaliReleaseForOperators({
      releaseId: parsed.releaseId,
      directory: parsed.directory,
    });
    const output = buildCodaliImprovementCliJsonOutput({
      outputType: "improvement.inspect",
      status: "ok",
      data: inspection,
    });
    const outputValidation = validateCodaliImprovementCliJsonOutput(output);
    if (!outputValidation.ok) {
      throw new ImprovementCommandError(
        "Improvement release inspect JSON contract validation failed.",
        IMPROVEMENT_EXIT_CODES.validation_error,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      parsed.output === "json"
        ? JSON.stringify(output, null, 2)
        : formatCodaliReleaseOperatorInspectionText(inspection),
    );
    return;
  }
  if (!parsed.exportId && !parsed.manifestPath) {
    throw new ImprovementCommandError(
      "improvement inspect requires --export-id <id>, --manifest <path>, or --release <id>.",
    );
  }
  const inspection = await inspectDatasetExportManifestForImprovement({
    exportId: parsed.exportId,
    manifestPath: parsed.manifestPath,
    directory: parsed.directory,
    allowedExampleArtifactTypes: parsed.exampleArtifactTypes,
    revokedDeletionGroupIds: parsed.revokedDeletionGroupIds,
  });
  const storageWrites = parsed.dryRun
    ? []
    : await writeInspectionToStorageService(parsed, inspection);
  const output = buildCodaliImprovementCliJsonOutput({
    outputType: "improvement.inspect",
    status: "ok",
    data: buildInspectData(parsed, inspection, storageWrites),
  });
  const outputValidation = validateCodaliImprovementCliJsonOutput(output);
  if (!outputValidation.ok) {
    throw new ImprovementCommandError(
      "Improvement inspect JSON contract validation failed.",
      IMPROVEMENT_EXIT_CODES.validation_error,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    parsed.output === "json"
      ? JSON.stringify(output, null, 2)
      : formatInspectText(output.data as ReturnType<typeof buildInspectData>),
  );
};

const runBuildRelease = async (parsed: ParsedImprovementArgs): Promise<void> => {
  assertProductionGovernanceAllows(
    parsed,
    parsed.dryRun ? "improvement_analyze" : "candidate_branch",
  );
  const buildFromCandidate = parsed.candidateId || parsed.candidatePath;
  if (!buildFromCandidate && !parsed.exportId && !parsed.manifestPath) {
    throw new ImprovementCommandError(
      "improvement build-release requires --candidate <id>, --export-id <id>, or --manifest <path>.",
    );
  }
  if (parsed.proposalArtifact && !isPatchProposalArtifact(parsed.proposalArtifact)) {
    throw new ImprovementCommandError(
      "improvement build-release supports --artifact prompt|schema|tool-metadata.",
    );
  }
  if (buildFromCandidate) {
    const candidateId = parsed.candidateId ?? parsed.candidatePath;
    if (!candidateId) {
      throw new ImprovementCommandError(
        "improvement build-release requires --candidate <id> when using candidate mode.",
      );
    }
    const build = await buildCodaliCandidateReleasePlan({
      candidateId,
      candidatePath: parsed.candidatePath,
      candidateDirectories: parsed.directory ? [parsed.directory] : undefined,
      repoRoot: parsed.repoRoot,
      scope: improvementScopeFromParsed(parsed),
      releaseLevel: parsed.releaseLevel || 2,
      dryRun: parsed.dryRun,
      runId: parsed.runId,
      candidateDate: parsed.candidateDate,
    });
    const output = buildCodaliImprovementCliJsonOutput({
      outputType: "improvement.release",
      status: build.release.status === "blocked" ? "blocked" : "ok",
      data: build.release,
    });
    const outputValidation = validateCodaliImprovementCliJsonOutput(output);
    if (!outputValidation.ok) {
      throw new ImprovementCommandError(
        "Improvement build-release JSON contract validation failed.",
        IMPROVEMENT_EXIT_CODES.validation_error,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      parsed.output === "json"
        ? JSON.stringify(output, null, 2)
        : formatBuildReleaseText(build),
    );
    return;
  }
  const artifacts = parsed.proposalArtifact
    ? [parsed.proposalArtifact]
    : [...CODALI_PATCH_PROPOSAL_ARTIFACTS];
  const allowedExampleArtifactTypes = parsed.exampleArtifactTypes.length
    ? parsed.exampleArtifactTypes
    : Array.from(new Set(artifacts.flatMap((artifact) => proposalArtifactTypesFor(artifact))));
  const inspection = await inspectDatasetExportManifestForImprovement({
    exportId: parsed.exportId,
    manifestPath: parsed.manifestPath,
    directory: parsed.directory,
    allowedExampleArtifactTypes,
    revokedDeletionGroupIds: parsed.revokedDeletionGroupIds,
  });
  const build = await buildCodaliCandidateRelease({
    inspection,
    artifacts,
    repoRoot: parsed.repoRoot,
    scope: improvementScopeFromParsed(parsed),
    releaseLevel: parsed.releaseLevel || 2,
    dryRun: parsed.dryRun,
    runId: parsed.runId,
    candidateDate: parsed.candidateDate,
    outputPath: parsed.candidateOutputPath,
    approvedPaths: parsed.approvedWritePaths.length
      ? parsed.approvedWritePaths
      : DEFAULT_CODALI_CANDIDATE_RELEASE_APPROVED_PATHS,
  });
  const output = buildCodaliImprovementCliJsonOutput({
    outputType: "improvement.release",
    status: "ok",
    data: build.release,
  });
  const outputValidation = validateCodaliImprovementCliJsonOutput(output);
  if (!outputValidation.ok) {
    throw new ImprovementCommandError(
      "Improvement build-release JSON contract validation failed.",
      IMPROVEMENT_EXIT_CODES.validation_error,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    parsed.output === "json"
      ? JSON.stringify(output, null, 2)
      : formatBuildReleaseText(build),
  );
};

const runEval = async (parsed: ParsedImprovementArgs): Promise<void> => {
  assertProductionGovernanceAllows(parsed, "improvement_analyze");
  const candidateId = parsed.candidateId ?? parsed.candidatePath ?? parsed.manifestPath;
  if (!candidateId) {
    throw new ImprovementCommandError(
      "improvement eval requires --candidate <candidate-id> or --candidate-path <path>.",
    );
  }
  const result = await buildCodaliImprovementEvalScorecard({
    candidateId,
    candidatePath: parsed.candidatePath ?? parsed.manifestPath,
    candidateDirectories: parsed.directory ? [parsed.directory] : undefined,
    approvedPaths: parsed.approvedWritePaths.length ? parsed.approvedWritePaths : undefined,
  });
  const storageWrites = parsed.dryRun
    ? []
    : await writeEvalToStorageService(parsed, result);
  const output = buildCodaliImprovementCliJsonOutput({
    outputType: "improvement.scorecard",
    status: hasHardEvalBlocks(result) ? "blocked" : "ok",
    data: buildEvalOutputScorecard(result, storageWrites),
  });
  const outputValidation = validateCodaliImprovementCliJsonOutput(output);
  if (!outputValidation.ok) {
    throw new ImprovementCommandError(
      "Improvement eval JSON contract validation failed.",
      IMPROVEMENT_EXIT_CODES.validation_error,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    parsed.output === "json"
      ? JSON.stringify(output, null, 2)
      : formatEvalText(result, storageWrites),
  );
};

const runPublish = async (parsed: ParsedImprovementArgs): Promise<void> => {
  assertProductionGovernanceAllows(parsed, "improvement_analyze");
  if (!parsed.dryRun && parsed.publishMode === "auto_tag") {
    assertProductionGovernanceAllows(parsed, "stable_publish");
  }
  const candidateId = parsed.candidateId ?? parsed.candidatePath ?? parsed.manifestPath;
  if (!candidateId) {
    throw new ImprovementCommandError(
      "improvement publish requires --candidate <candidate-id> or --candidate-path <path>.",
    );
  }
  const workflowRun = parsed.workflowRunId ||
    parsed.workflowStatus ||
    parsed.workflowConclusion ||
    parsed.workflowUrl
    ? {
        runId: parsed.workflowRunId,
        status: parsed.workflowStatus,
        conclusion: parsed.workflowConclusion,
        url: parsed.workflowUrl,
        headSha: parsed.commitSha,
      } satisfies Partial<CodaliPublishWorkflowRunStatus>
    : undefined;
  const result = await runCodaliPublishOrchestrator({
    candidateId,
    candidatePath: parsed.candidatePath ?? parsed.manifestPath,
    candidateDirectories: parsed.directory ? [parsed.directory] : undefined,
    repoRoot: parsed.repoRoot,
    mode: parsed.publishMode,
    dryRun: parsed.dryRun,
    releaseLevel: parsed.releaseLevel === 0 ? undefined : parsed.releaseLevel,
    scope: improvementScopeFromParsed(parsed),
    autoTagEnabled: parsed.autoTagEnabled,
    autoPublishEnabled: parsed.autoPublishEnabled,
    runId: parsed.runId,
    candidateDate: parsed.candidateDate,
    commitSha: parsed.commitSha,
    workflowRun,
    pollActions: parsed.pollActions,
    verifyNpm: parsed.verifyNpm,
    npmRegistry: parsed.npmRegistry,
    npmPackages: parsed.npmPackages,
    npmVersions: parsed.npmVersionResults,
  });
  const storageWrites = parsed.dryRun
    ? []
    : await writePublishToStorageService(parsed, result);
  const outcome = {
    ...result.outcome,
    metadata: {
      ...(result.outcome.metadata ?? {}),
      storageWrites: storageWrites.map((write) => ({
        accepted: write.accepted,
        status: write.status,
        scope: write.scope,
      })),
    },
  };
  const output = buildCodaliImprovementCliJsonOutput({
    outputType: "improvement.outcome",
    status: publishCliStatus(result),
    data: outcome,
  });
  const outputValidation = validateCodaliImprovementCliJsonOutput(output);
  if (!outputValidation.ok) {
    throw new ImprovementCommandError(
      "Improvement publish JSON contract validation failed.",
      IMPROVEMENT_EXIT_CODES.validation_error,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    parsed.output === "json"
      ? JSON.stringify(output, null, 2)
      : formatPublishText(result, storageWrites),
  );
};

const runMonitor = async (parsed: ParsedImprovementArgs): Promise<void> => {
  assertProductionGovernanceAllows(parsed, "improvement_analyze");
  if (!parsed.releaseId) {
    throw new ImprovementCommandError(
      "improvement monitor requires --release <release-id>.",
    );
  }
  const report = runCodaliReleaseOutcomeReporter({
    releaseId: parsed.releaseId,
    scope: improvementScopeFromParsed(parsed),
    monitorWindowMinutes: parsed.monitorWindowMinutes,
    monitorWindowStartedAt: parsed.monitorWindowStartedAt,
    monitorWindowEndedAt: parsed.monitorWindowEndedAt,
    thresholds: parsed.monitorThresholds,
    metrics: parsed.monitorMetrics,
    runtimeVersions: parsed.runtimeVersions,
    disabledRuntimePackages: parsed.disabledRuntimePackages,
    rollbackApplied: parsed.rollbackApplied,
    published: parsed.published,
    tagged: parsed.tagged,
    trainingUsed: parsed.trainingUsed,
    exportUsed: parsed.exportUsed,
  });
  const storageWrites = parsed.dryRun
    ? []
    : await writeMonitorToStorageService(parsed, report);
  const data: CodaliReleaseOutcomeReport = {
    ...report,
    storageWrites: storageWrites.map((write) => ({
      accepted: write.accepted,
      status: write.status,
      scope: write.scope,
    })),
  };
  const output = buildCodaliImprovementCliJsonOutput({
    outputType: "improvement.monitor",
    status: report.status === "healthy" || report.status === "watch" ? "ok" : "blocked",
    data,
  });
  const outputValidation = validateCodaliImprovementCliJsonOutput(output);
  if (!outputValidation.ok) {
    throw new ImprovementCommandError(
      "Improvement monitor JSON contract validation failed.",
      IMPROVEMENT_EXIT_CODES.validation_error,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    parsed.output === "json"
      ? JSON.stringify(output, null, 2)
      : formatMonitorText(data),
  );
};

const runPropose = async (parsed: ParsedImprovementArgs): Promise<void> => {
  assertProductionGovernanceAllows(parsed, "improvement_analyze");
  if (!parsed.proposalArtifact) {
    throw new ImprovementCommandError(
      "improvement propose requires --artifact <eval|prompt|schema|tool-metadata|docdex-retrieval|fine-tune|model-router>.",
    );
  }
  if (!parsed.exportId && !parsed.manifestPath) {
    throw new ImprovementCommandError(
      "improvement propose requires --export-id <id> or --manifest <path>.",
    );
  }
  if (!parsed.dryRun) {
    throw new ImprovementCommandError(
      "improvement propose is dry-run only in this phase; pass --dry-run.",
    );
  }
  const fineTuneRole = parsed.role ?? "extractor";
  const allowedExampleArtifactTypes = parsed.exampleArtifactTypes.length
    ? parsed.exampleArtifactTypes
    : proposalArtifactTypesFor(parsed.proposalArtifact, fineTuneRole);
  const inspection = await inspectDatasetExportManifestForImprovement({
    exportId: parsed.exportId,
    manifestPath: parsed.manifestPath,
    directory: parsed.directory,
    allowedExampleArtifactTypes,
    revokedDeletionGroupIds: parsed.revokedDeletionGroupIds,
  });
  const fineTuneInventory = parsed.proposalArtifact === CODALI_FINE_TUNE_PROPOSAL_ARTIFACT
    ? await resolveFineTuneInventoryForPropose(parsed)
    : undefined;
  const proposal = parsed.proposalArtifact === "eval"
    ? buildCodaliEvalReplayCandidateBundle({
        inspection,
        artifact: parsed.proposalArtifact,
      })
    : parsed.proposalArtifact === "docdex-retrieval"
      ? buildCodaliDocdexRetrievalCandidateBundle({
          inspection,
          artifact: parsed.proposalArtifact,
        })
      : parsed.proposalArtifact === CODALI_MODEL_ROUTER_PROPOSAL_ARTIFACT
        ? buildCodaliModelRouterCandidateBundle({
            inspection,
            artifact: parsed.proposalArtifact,
          })
        : parsed.proposalArtifact === CODALI_FINE_TUNE_PROPOSAL_ARTIFACT
          ? buildCodaliFineTuneJobPlannerBundle({
              inspection,
              artifact: parsed.proposalArtifact,
              role: fineTuneRole,
              inventory: fineTuneInventory?.inventory,
              inventorySource: fineTuneInventory?.source,
              inventoryWarnings: fineTuneInventory?.warnings,
            })
          : buildCodaliPatchCandidateBundle({
              inspection,
              artifact: parsed.proposalArtifact,
            });
  const output = buildCodaliImprovementCliJsonOutput({
    outputType: "improvement.propose",
    status: "ok",
    data: buildProposeData(parsed, proposal),
  });
  const outputValidation = validateCodaliImprovementCliJsonOutput(output);
  if (!outputValidation.ok) {
    throw new ImprovementCommandError(
      "Improvement propose JSON contract validation failed.",
      IMPROVEMENT_EXIT_CODES.validation_error,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    parsed.output === "json"
      ? JSON.stringify(output, null, 2)
      : formatProposeText(output.data as ReturnType<typeof buildProposeData>),
  );
};

const resolveFineTuneInventoryForPropose = async (
  parsed: ParsedImprovementArgs,
): Promise<{
  inventory: unknown[];
  source: CodaliFineTuneInventorySource;
  warnings: CodaliFineTuneInventoryWarning[];
}> => {
  if (parsed.inventoryJson) {
    return parseFineTuneInventoryPayload(parsed.inventoryJson, {
      source: "provided",
      status: "succeeded",
    });
  }
  if (parsed.inventoryPath) {
    try {
      const payload = await readFile(parsed.inventoryPath, "utf8");
      return parseFineTuneInventoryPayload(payload, {
        source: "provided",
        status: "succeeded",
      });
    } catch (error) {
      return {
        inventory: [],
        source: {
          source: "provided",
          status: "failed",
          inventoryCount: 0,
          errors: ["inventory_file_read_failed"],
        },
        warnings: [{
          code: "inventory_file_read_failed",
          message: error instanceof Error ? error.message : String(error),
          details: {
            path: parsed.inventoryPath,
          },
        }],
      };
    }
  }
  const command = "mcoda";
  const args = ["agent", "list", "--json", "--refresh-health"];
  if (!parsed.inventoryRefresh) {
    return {
      inventory: [],
      source: {
        source: "not_provided",
        command,
        args,
        status: "not_run",
        inventoryCount: 0,
      },
      warnings: [{
        code: "inventory_refresh_disabled",
        message: "Fine-tune target resolution requires mcoda inventory data.",
      }],
    };
  }
  try {
    const result = await defaultCodaliGatewayLiveCommandRunner(command, args, {
      timeoutMs: parsed.inventoryTimeoutMs,
      maxBuffer: DEFAULT_FINE_TUNE_INVENTORY_MAX_BUFFER,
    });
    if (result.exitCode !== 0) {
      return {
        inventory: [],
        source: {
          source: "command",
          command,
          args,
          status: "failed",
          latencyMs: result.latencyMs,
          inventoryCount: 0,
          errors: [`inventory_command_exit_${result.exitCode}`],
        },
        warnings: [{
          code: "inventory_command_failed",
          message: "mcoda agent inventory refresh failed.",
          details: {
            exitCode: result.exitCode,
            timedOut: result.timedOut === true,
          },
        }],
      };
    }
    return parseFineTuneInventoryPayload(result.stdout, {
      source: "command",
      command,
      args,
      status: "succeeded",
      latencyMs: result.latencyMs,
    });
  } catch (error) {
    return {
      inventory: [],
      source: {
        source: "command",
        command,
        args,
        status: "failed",
        inventoryCount: 0,
        errors: ["inventory_command_error"],
      },
      warnings: [{
        code: "inventory_command_error",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
};

const parseFineTuneInventoryPayload = (
  payload: unknown,
  source: Omit<CodaliFineTuneInventorySource, "inventoryCount">,
): {
  inventory: unknown[];
  source: CodaliFineTuneInventorySource;
  warnings: CodaliFineTuneInventoryWarning[];
} => {
  try {
    const inventory = parseCodaliGatewayLiveInventory(payload);
    return {
      inventory,
      source: {
        ...source,
        inventoryCount: inventory.length,
      },
      warnings: inventory.length === 0
        ? [{
            code: "inventory_empty",
            message: "No mcoda agent candidates were found in the inventory payload.",
          }]
        : [],
    };
  } catch (error) {
    return {
      inventory: [],
      source: {
        ...source,
        status: "failed",
        inventoryCount: 0,
        errors: ["inventory_parse_failed"],
      },
      warnings: [{
        code: "inventory_parse_failed",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
};

const writeInspectionToStorageService = async (
  parsed: ParsedImprovementArgs,
  inspection: DatasetExportManifestReaderResult,
): Promise<Array<StorageServiceImprovementWriteResult<unknown>>> => {
  assertProductionGovernanceAllows(parsed, "service_gateway_write");
  if (!parsed.storageServiceUrl || !parsed.storageServiceToken) {
    throw new ImprovementCommandError(
      "Non-dry-run improvement inspect requires --storage-service-url and --storage-service-token.",
    );
  }
  const scope = storageScopeFromParsed(parsed, inspection);
  const client = new StorageServiceImprovementClient({
    baseUrl: parsed.storageServiceUrl,
    serviceToken: parsed.storageServiceToken,
    hmacSecret: parsed.hmacSecret,
  });
  const runWrite = await client.recordRun({
    scope,
    idempotencyKey: `improvement-run:${inspection.manifest.manifestId}`,
    body: {
      improvement_run_id: scope.runId,
      run_kind: "candidate_generation",
      status: "completed",
      source_export_id: inspection.manifest.manifestId,
      metadata: {
        source: "codali improvement inspect",
        exportId: inspection.exportId,
        exportKind: inspection.manifest.exportKind,
        manifestPath: inspection.manifestPath,
        warningCodes: inspection.warnings.map((warning) => warning.code),
        curation: {
          acceptedCount: inspection.curationReport.acceptedCount,
          rejectedCount: inspection.curationReport.rejectedCount,
          warningCount: inspection.curationReport.warningCount,
          reasonCounts: inspection.curationReport.reasonCounts,
          lineageValid: inspection.curationReport.lineageValid,
        },
      },
    },
  });
  const candidateWrites = [];
  for (const candidate of inspection.candidates) {
    candidateWrites.push(await client.recordCandidate({
      scope,
      idempotencyKey: `improvement-candidate:${candidate.candidateId}`,
      body: {
        candidate_id: candidate.candidateId,
        improvement_run_id: scope.runId,
        source_export_id: inspection.manifest.manifestId,
        source_record_ids: candidate.sourceRecordIds,
        candidate_kind: candidate.candidateKind,
        candidate_ref:
          inspection.primaryArtifact?.ref.uri ??
          inspection.primaryArtifact?.ref.refId ??
          inspection.manifest.checksum,
        status: candidate.status,
        metadata: {
          artifactIds: candidate.artifactIds,
          exampleCount: candidate.exampleCount,
          objectBytes: candidate.objectBytes,
          provenance: candidate.provenance,
        },
      },
    }));
  }
  return [runWrite, ...candidateWrites];
};

const writeEvalToStorageService = async (
  parsed: ParsedImprovementArgs,
  result: CodaliImprovementEvalRunnerResult,
): Promise<Array<StorageServiceImprovementWriteResult<unknown>>> => {
  assertProductionGovernanceAllows(parsed, "service_gateway_write");
  if (!parsed.storageServiceUrl || !parsed.storageServiceToken) {
    throw new ImprovementCommandError(
      "Non-dry-run improvement eval requires --storage-service-url and --storage-service-token.",
    );
  }
  const scope = storageScopeFromEval(parsed, result);
  const client = new StorageServiceImprovementClient({
    baseUrl: parsed.storageServiceUrl,
    serviceToken: parsed.storageServiceToken,
    hmacSecret: parsed.hmacSecret,
  });
  const manifestId = isRecord(result.scorecard.metadata) &&
    typeof result.scorecard.metadata.manifestId === "string"
    ? result.scorecard.metadata.manifestId
    : undefined;
  const gateStatuses = Object.fromEntries(
    result.gates.map((gateResult) => [gateResult.gateId, gateResult.status]),
  );
  const runWrite = await client.recordRun({
    scope,
    idempotencyKey: `improvement-eval-run:${result.scorecard.scorecardId}`,
    body: {
      scope,
      improvement_run_id: scope.runId,
      run_kind: "release_approval_eval",
      status: hasHardEvalBlocks(result) ? "blocked" : "completed",
      source_export_id: manifestId ?? result.candidateId,
      metadata: {
        source: "codali improvement eval",
        candidateId: result.candidateId,
        scorecardId: result.scorecard.scorecardId,
        scorecardStatus: result.scorecard.status,
        releaseApproval: result.releaseApproval,
        blockedReasons: result.blockedReasons,
        warnings: result.warnings,
        gateStatuses,
      },
    },
  });
  const candidateWrite = await client.recordCandidate({
    scope,
    idempotencyKey: `improvement-scorecard:${result.scorecard.scorecardId}`,
    body: {
      scope,
      candidate_id: result.candidateId,
      improvement_run_id: scope.runId,
      source_export_id: manifestId ?? result.candidateId,
      source_record_ids: [],
      candidate_kind: "release",
      candidate_ref: result.scorecard.scorecardId,
      status: result.scorecard.status,
      metadata: {
        source: "codali improvement eval",
        scorecard: result.scorecard,
        releaseApproval: result.releaseApproval,
        blockedReasons: result.blockedReasons,
        warnings: result.warnings,
        storagePayload: result.storagePayload,
      },
    },
  });
  return [runWrite, candidateWrite];
};

const writePublishToStorageService = async (
  parsed: ParsedImprovementArgs,
  result: CodaliPublishResult,
): Promise<Array<StorageServiceImprovementWriteResult<unknown>>> => {
  assertProductionGovernanceAllows(parsed, "service_gateway_write");
  if (!parsed.storageServiceUrl || !parsed.storageServiceToken) {
    throw new ImprovementCommandError(
      "Non-dry-run improvement publish requires --storage-service-url and --storage-service-token.",
    );
  }
  const scope = storageScopeFromPublish(parsed, result);
  const client = new StorageServiceImprovementClient({
    baseUrl: parsed.storageServiceUrl,
    serviceToken: parsed.storageServiceToken,
    hmacSecret: parsed.hmacSecret,
  });
  return writeCodaliPublishToStorageService({
    result,
    scope,
    client,
  });
};

const writeMonitorToStorageService = async (
  parsed: ParsedImprovementArgs,
  report: CodaliReleaseOutcomeReport,
): Promise<Array<StorageServiceImprovementWriteResult<unknown>>> => {
  assertProductionGovernanceAllows(parsed, "service_gateway_write");
  if (!parsed.storageServiceUrl || !parsed.storageServiceToken) {
    throw new ImprovementCommandError(
      "Non-dry-run improvement monitor requires --storage-service-url and --storage-service-token.",
    );
  }
  const scope = storageScopeFromMonitor(parsed, report);
  const client = new StorageServiceImprovementClient({
    baseUrl: parsed.storageServiceUrl,
    serviceToken: parsed.storageServiceToken,
    hmacSecret: parsed.hmacSecret,
  });
  return writeCodaliReleaseOutcomeReportToStorageService({
    report,
    scope,
    client,
  });
};

const formatInspectText = (
  data: ReturnType<typeof buildInspectData>,
): string => {
  const lines = [
    `improvement inspect: ${data.dryRun ? "dry_run" : "written"}`,
    `manifest: ${data.manifest.manifestId}`,
    `kind: ${data.manifest.exportKind}`,
    `checksum: ${data.manifest.checksum}`,
    `candidates: ${data.candidates.length}`,
    `curation: accepted=${data.curationReport.acceptedCount} rejected=${data.curationReport.rejectedCount} warnings=${data.curationReport.warningCount}`,
  ];
  if (data.warnings.length) {
    lines.push(`warnings: ${data.warnings.map((warning) => warning.code).join(", ")}`);
  }
  return lines.join("\n");
};

const formatProposeText = (
  data: ReturnType<typeof buildProposeData>,
): string => {
  const candidate = data.proposal.candidates[0];
  const lines = [
    `improvement propose: ${data.dryRun ? "dry_run" : "written"}`,
    `artifact: ${data.artifact}`,
    `manifest: ${data.manifestId}`,
    `candidates: ${data.proposal.candidates.length}`,
    `status: ${candidate?.status ?? "blocked"}`,
  ];
  if ("fixtureIds" in data.proposal) {
    lines.splice(3, 0, `eval fixture: ${data.proposal.fixtureIds.evalFixtureId}`);
    lines.splice(4, 0, `replay fixture: ${data.proposal.fixtureIds.replayFixtureId}`);
  }
  if ("patchPlan" in data.proposal) {
    lines.splice(3, 0, `patch plan: ${data.proposal.patchPlan.planId}`);
    lines.push(`operations: ${data.proposal.patchPlan.operations.length}`);
  }
  if ("jobSpecs" in data.proposal) {
    lines.splice(3, 0, `job specs: ${data.proposal.jobSpecs.length}`);
    if (data.proposal.jobSpecs[0]) {
      lines.push(`job plan: ${data.proposal.jobSpecs[0].jobPlanId}`);
      lines.push(`target: ${data.proposal.jobSpecs[0].targetResolution.status}`);
    }
  }
  if ("routerPlan" in data.proposal) {
    lines.splice(3, 0, `router plan: ${data.proposal.routerPlan.planId}`);
    lines.push(`router action: ${data.proposal.routerPlan.action}`);
    lines.push(`routes proposed: ${data.proposal.routerPlan.proposedRouteCount}`);
  }
  if ("failureLabels" in data.proposal && data.proposal.failureLabels.length) {
    lines.push(`failure labels: ${data.proposal.failureLabels.join(", ")}`);
  }
  if ("failureClasses" in data.proposal && data.proposal.failureClasses.length) {
    lines.push(`failure classes: ${data.proposal.failureClasses.join(", ")}`);
  }
  return lines.join("\n");
};

const formatBuildReleaseText = (build: CodaliCandidateReleaseBuild): string => {
  const lines = [
    `improvement build-release: ${build.dryRun ? "dry_run" : build.release.status}`,
    `branch: ${build.candidateWorkspace.branchName}`,
    `manifest: ${build.release.metadata?.sourceExportIds instanceof Array
      ? build.release.metadata.sourceExportIds.join(",")
      : "unavailable"}`,
    `write plan: ${build.writePlan.status}`,
    `artifacts: ${build.generatedArtifacts.length}`,
    `patch lines: ${build.patchOutput.split("\n").filter(Boolean).length}`,
  ];
  if (build.blockedReasons.length) {
    lines.push(`blocked: ${build.blockedReasons.join(", ")}`);
  }
  if (build.dirtyWorktree.status === "dirty") {
    lines.push(`dirty unrelated files: ${build.dirtyWorktree.unrelatedDirtyFileCount}`);
  }
  return lines.join("\n");
};

const formatEvalText = (
  result: CodaliImprovementEvalRunnerResult,
  storageWrites: Array<StorageServiceImprovementWriteResult<unknown>>,
): string => {
  const counts = {
    passed: result.gates.filter((item) => item.status === "passed").length,
    failed: result.gates.filter((item) => item.status === "failed").length,
    skipped: result.gates.filter((item) => item.status === "skipped").length,
    warning: result.gates.filter((item) => item.status === "warning").length,
  };
  const lines = [
    `improvement eval: ${result.scorecard.status}`,
    `candidate: ${result.candidateId}`,
    `scorecard: ${result.scorecard.scorecardId}`,
    `gates: passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped} warning=${counts.warning}`,
    `tag allowed: ${result.releaseApproval.tagAllowed ? "yes" : "no"}`,
    `publish allowed: ${result.releaseApproval.publishAllowed ? "yes" : "no"}`,
  ];
  if (result.blockedReasons.length) {
    lines.push(`blocked: ${result.blockedReasons.join(", ")}`);
  }
  if (result.warnings.length) {
    lines.push(`warnings: ${result.warnings.join(", ")}`);
  }
  if (storageWrites.length) {
    lines.push(`storage writes: ${storageWrites.length}`);
  }
  return lines.join("\n");
};

const publishCliStatus = (result: CodaliPublishResult): "ok" | "blocked" | "error" => {
  if (result.status === "blocked") return "blocked";
  if (result.status === "failed" || result.status === "workflow_failed") return "error";
  return "ok";
};

const formatNpmVersionSummary = (
  versions: readonly CodaliPublishNpmVersion[],
): string => {
  if (!versions.length) return "none";
  return versions
    .map((version) => `${version.packageName}:${version.status}`)
    .join(", ");
};

const formatPublishText = (
  result: CodaliPublishResult,
  storageWrites: Array<StorageServiceImprovementWriteResult<unknown>>,
): string => {
  const lines = [
    `improvement publish: ${result.status}`,
    `mode: ${result.mode}`,
    `candidate: ${result.candidateId}`,
    `tag: ${result.releaseBuild.releasePlan.futureTag}`,
    `commit: ${result.commitGuard.commitSha ?? "unavailable"}`,
    `publisher: ${result.publisher.workflowFile}`,
    `workflow: ${result.workflowRun.status}${result.workflowRun.runId ? `#${result.workflowRun.runId}` : ""}`,
    `npm versions: ${formatNpmVersionSummary(result.npmVersions)}`,
  ];
  if (result.blockedReasons.length) {
    lines.push(`blocked: ${result.blockedReasons.join(", ")}`);
  }
  if (storageWrites.length) {
    lines.push(`storage writes: ${storageWrites.length}`);
  }
  return lines.join("\n");
};

const formatMonitorText = (report: CodaliReleaseOutcomeReport): string => {
  const triggered = report.rollbackTriggers
    .filter((trigger) => trigger.triggered)
    .map((trigger) => trigger.code);
  const disabledRuntimePackages = report.runtimeFlags
    .filter((flag) => !flag.enabled)
    .map((flag) => `${flag.packageKind}:${flag.version}`);
  const lines = [
    `improvement monitor: ${report.status}`,
    `release: ${report.releaseId}`,
    `window: ${report.monitorWindow.startedAt}..${report.monitorWindow.endedAt}`,
    `shadow: ${report.shadowTraffic.status} ${report.shadowTraffic.shadowRequestCount}/${report.shadowTraffic.eligibleRequestCount}`,
    `rollback triggers: ${triggered.length ? triggered.join(", ") : "none"}`,
    `runtime disabled: ${disabledRuntimePackages.length ? disabledRuntimePackages.join(", ") : "none"}`,
  ];
  if (report.storageWrites.length) {
    lines.push(`storage writes: ${report.storageWrites.length}`);
  }
  return lines.join("\n");
};

const formatPolicyText = (
  output: ReturnType<typeof buildCodaliImprovementCliJsonOutput>,
): string => {
  const policy = output.policy;
  const lines = [
    `improvement policy: ${output.status}`,
    policy
      ? `level ${policy.releaseLevel}: ${
        CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[policy.releaseLevel].description
      }`
      : "level: unavailable",
  ];
  if (output.decision) {
    lines.push(
      `action ${output.decision.action}: ${
        output.decision.allowed ? "allowed" : "blocked"
      }`,
    );
    if (output.decision.reasons.length) {
      lines.push(`reasons: ${output.decision.reasons.join(", ")}`);
    }
  }
  if (output.issues.length) {
    lines.push(`issues: ${output.issues.map((issue) => issue.code).join(", ")}`);
  }
  return lines.join("\n");
};

const parseReleaseLevel = (
  value: string,
  flag: string,
): CodaliImprovementReleaseLevel => {
  const numberValue = Number(value);
  if (
    !Number.isInteger(numberValue) ||
    !(numberValue in CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS)
  ) {
    throw new ImprovementCommandError(`${flag} must be one of 0, 1, 2, 3, 4.`);
  }
  return numberValue as CodaliImprovementReleaseLevel;
};

const parseNonNegativeInteger = (value: string, flag: string): number => {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new ImprovementCommandError(`${flag} must be a non-negative integer.`);
  }
  return numberValue;
};

const parsePositiveInteger = (value: string, flag: string): number => {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new ImprovementCommandError(`${flag} must be a positive integer.`);
  }
  return numberValue;
};

const parseNonNegativeNumber = (value: string, flag: string): number => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw new ImprovementCommandError(`${flag} must be a non-negative number.`);
  }
  return numberValue;
};

const parseRate = (value: string, flag: string): number => {
  const numberValue = parseNonNegativeNumber(value, flag);
  if (numberValue > 1) {
    throw new ImprovementCommandError(`${flag} must be a rate from 0 to 1.`);
  }
  return numberValue;
};

const parseIsoTimestamp = (value: string, flag: string): string => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ImprovementCommandError(`${flag} must be an ISO timestamp.`);
  }
  return value;
};

const parseRuntimePackageKind = (
  value: string,
  flag: string,
): CodaliReleaseRuntimePackageKind => {
  if (CODALI_RELEASE_RUNTIME_PACKAGE_KINDS.includes(value as CodaliReleaseRuntimePackageKind)) {
    return value as CodaliReleaseRuntimePackageKind;
  }
  throw new ImprovementCommandError(
    `${flag} must be prompt_package|router_policy|retrieval_policy|schema|fine_tune_adapter.`,
  );
};

const parseStorageMode = (
  value: string,
  flag: string,
): CodaliImprovementStorageMode => {
  if (value === "local_only" || value === "storage_service" || value === "hybrid") {
    return value;
  }
  throw new ImprovementCommandError(`${flag} must be local_only|storage_service|hybrid.`);
};

const parsePublishMode = (value: string, flag: string): CodaliPublishMode => {
  if (value === "branch_only" || value === "auto_tag") return value;
  throw new ImprovementCommandError(`${flag} must be branch_only|auto_tag.`);
};

const parseWorkflowStatus = (
  value: string,
  flag: string,
): CodaliPublishWorkflowStatus => {
  if (
    value === "not_requested" ||
    value === "queued" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new ImprovementCommandError(
    `${flag} must be not_requested|queued|in_progress|completed|unknown.`,
  );
};

const parseWorkflowConclusion = (
  value: string,
  flag: string,
): CodaliPublishWorkflowConclusion => {
  if (
    value === "success" ||
    value === "failure" ||
    value === "cancelled" ||
    value === "skipped" ||
    value === "timed_out" ||
    value === "action_required" ||
    value === "neutral" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new ImprovementCommandError(
    `${flag} must be success|failure|cancelled|skipped|timed_out|action_required|neutral|unknown.`,
  );
};

const parseNpmVersionResult = (
  value: string,
  flag: string,
): { packageName: string; version: string } => {
  const separator = value.indexOf("=");
  const packageName = separator > 0 ? value.slice(0, separator).trim() : "";
  const version = separator > 0 ? value.slice(separator + 1).trim() : "";
  if (!packageName || !version) {
    throw new ImprovementCommandError(`${flag} must use <package=version>.`);
  }
  return { packageName, version };
};

const parseArtifactType = (
  value: string,
  flag: string,
): CodaliImprovementArtifactType => {
  const allTypes = Object.values(CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[4]
    .allowedArtifactTypes);
  if (allTypes.includes(value as CodaliImprovementArtifactType)) {
    return value as CodaliImprovementArtifactType;
  }
  throw new ImprovementCommandError(`${flag} contains an unsupported artifact type.`);
};

const parseProposalArtifact = (
  value: string,
  flag: string,
): CodaliImprovementProposalArtifact => {
  if (value === "eval") return value;
  if (value === "prompt" || value === "schema" || value === "tool-metadata") {
    return value;
  }
  if (value === "docdex-retrieval") return value;
  if (value === CODALI_FINE_TUNE_PROPOSAL_ARTIFACT) return value;
  if (value === CODALI_MODEL_ROUTER_PROPOSAL_ARTIFACT) return value;
  throw new ImprovementCommandError(`${flag} must be eval|prompt|schema|tool-metadata|docdex-retrieval|fine-tune|model-router.`);
};

const parseFineTuneRole = (
  value: string,
  flag: string,
): CodaliFineTuneWorkerRole => {
  const role = normalizeCodaliFineTuneWorkerRole(value);
  if (role) return role;
  throw new ImprovementCommandError(
    `${flag} must be extractor|tool-router|planner|verifier|query-expander|repair|context-refiner|final-synthesizer.`,
  );
};

const parseAction = (
  value: string,
  flag: string,
): CodaliImprovementPolicyAction => {
  const actions: CodaliImprovementPolicyAction[] = [
    "analyze",
    "add_eval_replay",
    "branch_metadata",
    "create_prerelease_tag",
    "publish_stable",
    "export",
    "training",
    "auto_tag",
    "auto_publish",
  ];
  if (actions.includes(value as CodaliImprovementPolicyAction)) {
    return value as CodaliImprovementPolicyAction;
  }
  throw new ImprovementCommandError(`${flag} contains an unsupported action.`);
};

export const createDefaultImprovementPolicyJson = (): string =>
  JSON.stringify(
    buildCodaliImprovementCliJsonOutput({
      outputType: "improvement.policy",
      status: "ok",
      policy: createCodaliImprovementPolicy({
        policyId: "default-local-policy",
        releaseLevel: 0,
        scope: {
          tenantHash: DEFAULT_TENANT_HASH,
          productId: DEFAULT_PRODUCT_ID,
        },
        allowedArtifactTypes: [
          ...CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[0].allowedArtifactTypes,
        ],
        maxExamples: DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.maxExamples,
        maxObjectBytes: DEFAULT_CODALI_IMPROVEMENT_POLICY_LIMITS.maxObjectBytes,
        storageMode: "local_only",
        exportEnabled: false,
        trainingEnabled: false,
        autoTagEnabled: false,
        autoPublishEnabled: false,
        metadata: {
          schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
          productionGovernance: resolveCodaliProductionGovernance(),
        },
      }),
    }),
    null,
    2,
  );
