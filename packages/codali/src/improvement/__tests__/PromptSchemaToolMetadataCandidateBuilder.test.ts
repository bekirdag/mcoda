import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../../cli.js";
import { ImprovementCommand } from "../../cli/ImprovementCommand.js";
import {
  createGatewayDatasetLocalOnlyObjectPrivacyFlags,
  createGatewayDatasetLocalOnlyPrivacy,
  createLocalJsonlGatewayDatasetObjectStore,
  type GatewayDatasetObjectStore,
  type GatewayDatasetStorageScope,
} from "../../storage/GatewayDatasetStore.js";
import {
  runCodaliDatasetExportJob,
} from "../../storage/DatasetExportJob.js";
import type {
  CodaliStorageDatasetRecord,
} from "../../storage/CodaliStorageContracts.js";
import {
  DatasetExportManifestReader,
} from "../DatasetExportManifestReader.js";
import {
  buildCodaliPatchCandidateBundle,
  type CodaliPatchProposalArtifact,
} from "../PromptSchemaToolMetadataCandidateBuilder.js";

const fixedNow = () => new Date("2026-07-08T12:00:00.000Z");

const scope = (): GatewayDatasetStorageScope => ({
  tenantId: "tenant-phase-25",
  productId: "product-neutral",
  deploymentId: "phase-25",
  runId: "dataset-export-phase-25",
});

const putRef = (
  objectStore: GatewayDatasetObjectStore,
  input: {
    ownerId: string;
    part: string;
    payload: unknown;
  },
) =>
  objectStore.putObject({
    scope: scope(),
    ownerType: "dataset_record",
    ownerId: input.ownerId,
    kind: input.part === "evidence" ? "evidence" : "dataset",
    payload: input.payload,
    retentionClass: "dataset",
    privacyFlags: createGatewayDatasetLocalOnlyObjectPrivacyFlags({
      containsTenantPrivateData: false,
      containsCustomerData: false,
      exportAllowed: true,
      trainingAllowed: false,
      evalAllowed: true,
      replayAllowed: true,
    }),
    metadata: {
      part: input.part,
    },
  });

const buildRecord = async (input: {
  objectStore: GatewayDatasetObjectStore;
  recordId: string;
  artifactType: string;
  failureClass: string;
  reasonCode: string;
  schemaHash?: string;
  toolContractHash?: string;
}): Promise<CodaliStorageDatasetRecord> => {
  const inputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "input",
    payload: {
      request: `request for ${input.recordId}`,
    },
  });
  const outputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "output",
    payload: {
      previousResult: `failed result for ${input.recordId}`,
    },
  });
  const evidenceRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "evidence",
    payload: {
      failureClass: input.failureClass,
      reasonCode: input.reasonCode,
    },
  });
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId: input.recordId,
    datasetKind: "gateway_answer",
    createdAt: fixedNow().toISOString(),
    sourceGatewayRecordId: `gateway-${input.recordId}`,
    inputRef,
    outputRef,
    evidenceRefs: [evidenceRef],
    quality: {
      score: 0.91,
      labels: ["human_reviewed", "accepted_correction"],
      reviewed: true,
    },
    privacy: createGatewayDatasetLocalOnlyPrivacy({
      containsPersonalData: false,
      exportAllowed: true,
      trainingAllowed: false,
      policyTags: ["local_only"],
    }),
    metadata: {
      artifactType: input.artifactType,
      failureClasses: [input.failureClass],
      reasonCodes: [input.reasonCode],
      failureEvidence: [{
        failureClass: input.failureClass,
        reasonCode: input.reasonCode,
        source: "pre_change_eval",
      }],
      taskHash: `task-hash-${input.recordId}`,
      promptHash: `prompt-hash-${input.recordId}`,
      expectedTargetHash: input.schemaHash ?? `target-hash-${input.recordId}`,
      ...(input.schemaHash ? {
        schemaContract: {
          hash: input.schemaHash,
          version: "contract.v1",
        },
      } : {}),
      ...(input.toolContractHash ? {
        toolContractHash: input.toolContractHash,
        toolMetadata: {
          hash: input.toolContractHash,
          contractVersion: "tool.contract.v1",
          requiredFields: ["description", "input_schema", "safety"],
        },
      } : {}),
    },
  };
};

const buildExportFixture = async (directory: string) => {
  const objectDirectory = path.join(directory, "objects");
  const objectStore = createLocalJsonlGatewayDatasetObjectStore({
    directory: objectDirectory,
    now: fixedNow,
  });
  const prompt = await buildRecord({
    objectStore,
    recordId: "phase-25-prompt",
    artifactType: "prompt",
    failureClass: "missing_source_grounding",
    reasonCode: "answer_ignored_evidence",
  });
  const schema = await buildRecord({
    objectStore,
    recordId: "phase-25-schema",
    artifactType: "schema",
    failureClass: "schema_required_field_missing",
    reasonCode: "schema_rejected_valid_payload",
    schemaHash: "schema-contract-hash-phase-25",
  });
  const toolMetadata = await buildRecord({
    objectStore,
    recordId: "phase-25-tool-metadata",
    artifactType: "tool_metadata",
    failureClass: "tool_contract_argument_missing",
    reasonCode: "tool_contract_missing_required_argument",
    toolContractHash: "tool-contract-hash-phase-25",
  });
  const result = await runCodaliDatasetExportJob({
    exportKind: "prompt-regression",
    records: [prompt, schema, toolMetadata],
    objectStore,
    scope: scope(),
    generatedBy: "phase-25-candidate-builder-test",
    now: fixedNow,
  });
  assert.ok(result.accepted);
  assert.ok(result.manifest);
  assert.ok(result.jsonlRef);
  return {
    objectDirectory,
    manifest: result.manifest,
  };
};

const captureLog = async (run: () => Promise<void>): Promise<string> => {
  const originalLog = console.log;
  let output = "";
  console.log = (value?: unknown) => {
    output += `${String(value ?? "")}\n`;
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return output;
};

test("PromptSchemaToolMetadataCandidateBuilder builds deterministic evidence-backed patch plans", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-25-builder-"));
  try {
    const fixture = await buildExportFixture(directory);
    const inspection = await new DatasetExportManifestReader().inspect({
      exportId: fixture.manifest.manifestId,
      directory: fixture.objectDirectory,
      allowedExampleArtifactTypes: ["prompt", "schema", "tool_metadata"],
    });

    const prompt = buildCodaliPatchCandidateBundle({ inspection, artifact: "prompt" });
    const repeatedPrompt = buildCodaliPatchCandidateBundle({ inspection, artifact: "prompt" });
    const schema = buildCodaliPatchCandidateBundle({ inspection, artifact: "schema" });
    const toolMetadata = buildCodaliPatchCandidateBundle({
      inspection,
      artifact: "tool-metadata",
    });

    assert.equal(prompt.patchPlan.planId, repeatedPrompt.patchPlan.planId);
    assert.equal(prompt.candidates[0]?.candidateId, repeatedPrompt.candidates[0]?.candidateId);
    assert.equal(prompt.generationPolicy.deterministic, true);
    assert.equal(prompt.generationPolicy.modifiesRuntimePrompts, false);
    assert.equal(prompt.generationPolicy.modifiesRuntimeCode, false);
    assert.equal(prompt.generationPolicy.failureEvidenceRequired, true);
    assert.equal(prompt.sourceExamples.length, 1);
    assert.deepEqual(prompt.sourceExamples[0]?.failureClasses, ["missing_source_grounding"]);
    assert.equal(prompt.patchPlan.operations[0]?.operationType, "add_prompt_failure_guardrail");
    assert.deepEqual(prompt.patchPlan.operations[0]?.requiredEvidence, [
      "source_examples",
      "failure_classes",
    ]);
    assert.equal(prompt.promptEval?.wouldFailBeforeChange, true);
    assert.equal(prompt.promptEval?.cases[0]?.preChangeExpectedStatus, "fail");
    assert.equal(prompt.promptEval?.cases[0]?.postChangeExpectedStatus, "pass");

    assert.equal(schema.candidates[0]?.status, "proposed");
    assert.equal(schema.patchPlan.operations[0]?.operationType, "tighten_schema_contract");
    assert.deepEqual(schema.patchPlan.operations[0]?.target.schemaHashes, [
      "schema-contract-hash-phase-25",
    ]);

    assert.equal(toolMetadata.candidates[0]?.status, "proposed");
    assert.equal(toolMetadata.patchPlan.operations[0]?.operationType, "update_tool_metadata_contract");
    assert.equal(toolMetadata.patchPlan.operations[0]?.productNeutral, true);
    assert.equal(toolMetadata.patchPlan.operations[0]?.contractDriven, true);
    assert.deepEqual(toolMetadata.patchPlan.operations[0]?.target.toolContractHashes, [
      "tool-contract-hash-phase-25",
    ]);
    assert.equal(
      JSON.stringify(toolMetadata).includes("OKACAM") ||
        JSON.stringify(toolMetadata).includes("Suku"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("codali improve propose emits prompt, schema, and tool metadata dry-run JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-25-cli-"));
  try {
    const fixture = await buildExportFixture(directory);
    for (const artifact of ["prompt", "schema", "tool-metadata"] as CodaliPatchProposalArtifact[]) {
      const output = await captureLog(() =>
        ImprovementCommand.run([
          "propose",
          "--artifact",
          artifact,
          "--export-id",
          fixture.manifest.manifestId,
          "--directory",
          fixture.objectDirectory,
          "--dry-run",
          "--output",
          "json",
        ]));
      const parsed = JSON.parse(output) as Record<string, unknown>;
      assert.equal(parsed.outputType, "improvement.propose");
      assert.equal(parsed.status, "ok");
      const data = parsed.data as {
        dryRun?: boolean;
        artifact?: string;
        proposal?: {
          patchPlan?: { operations?: unknown[]; failureClasses?: string[] };
          sourceExamples?: unknown[];
          failureClasses?: unknown[];
          candidates?: Array<{ status?: string }>;
          promptEval?: { wouldFailBeforeChange?: boolean };
        };
      };
      assert.equal(data.dryRun, true);
      assert.equal(data.artifact, artifact);
      assert.equal(data.proposal?.candidates?.[0]?.status, "proposed");
      assert.equal(data.proposal?.sourceExamples?.length, 1);
      assert.equal(data.proposal?.patchPlan?.operations?.length, 1);
      assert.ok((data.proposal?.failureClasses?.length ?? 0) > 0);
      if (artifact === "prompt") {
        assert.equal(data.proposal?.promptEval?.wouldFailBeforeChange, true);
      }
    }

    const aliasOutput = await captureLog(() =>
      runCli([
        "improve",
        "propose",
        "--artifact",
        "tool-metadata",
        "--export-id",
        fixture.manifest.manifestId,
        "--directory",
        fixture.objectDirectory,
        "--dry-run",
        "--output",
        "json",
      ]));
    const aliasParsed = JSON.parse(aliasOutput) as Record<string, unknown>;
    assert.equal(aliasParsed.outputType, "improvement.propose");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
