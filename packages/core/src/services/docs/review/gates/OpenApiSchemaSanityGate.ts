import { promises as fs } from "node:fs";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";
import { validateOpenApiSchemaContent } from "../../../openapi/OpenApiService.js";

export interface OpenApiSchemaSanityGateInput {
  artifacts: DocgenArtifactInventory;
}

const buildIssue = (input: {
  record: DocArtifactRecord;
  error: string;
  index: number;
}): ReviewIssue => {
  const excerpt = input.error.length > 120 ? `${input.error.slice(0, 117)}...` : input.error;
  return {
    id: `gate-openapi-schema-sanity-${input.index + 1}`,
    gateId: "gate-openapi-schema-sanity",
    severity: "high",
    category: "api",
    artifact: "openapi",
    message: input.error,
    remediation: "Fix OpenAPI schema errors and regenerate the spec.",
    location: {
      kind: "line_range",
      path: input.record.path,
      lineStart: 1,
      lineEnd: 1,
      excerpt,
    },
    metadata: { recordPath: input.record.path },
  };
};

export const runOpenApiSchemaSanityGate = async (
  input: OpenApiSchemaSanityGateInput,
): Promise<ReviewGateResult> => {
  const records = input.artifacts.openapi ?? [];
  if (records.length === 0) {
    return {
      gateId: "gate-openapi-schema-sanity",
      gateName: "OpenAPI Schema Sanity",
      status: "skipped",
      issues: [],
      notes: ["No OpenAPI artifacts available for schema sanity checks."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  for (const record of records) {
    try {
      const content = await fs.readFile(record.path, "utf8");
      const result = validateOpenApiSchemaContent(content);
      if (result.errors.length > 0) {
        result.errors.forEach((error, index) => {
          issues.push(buildIssue({ record, error, index }));
        });
      }
    } catch (error) {
      notes.push(
        `Unable to read OpenAPI spec ${record.path}: ${(error as Error).message ?? String(error)}`,
      );
    }
  }

  const status = issues.length === 0 ? "pass" : "fail";
  return {
    gateId: "gate-openapi-schema-sanity",
    gateName: "OpenAPI Schema Sanity",
    status,
    issues,
    notes: notes.length > 0 ? notes : undefined,
    metadata: { issueCount: issues.length, artifactCount: records.length },
  };
};
