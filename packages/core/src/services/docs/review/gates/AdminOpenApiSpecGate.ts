import { promises as fs } from "node:fs";
import path from "node:path";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue } from "../ReviewTypes.js";
import { findAdminSurfaceMentions } from "../../../openapi/OpenApiService.js";

export interface AdminOpenApiSpecGateInput {
  artifacts: DocgenArtifactInventory;
}

const buildIssue = (input: {
  record: DocArtifactRecord;
  line: number;
  excerpt: string;
  heading?: string;
  index: number;
}): ReviewIssue => {
  return {
    id: `gate-admin-openapi-spec-${input.index + 1}`,
    gateId: "gate-admin-openapi-spec",
    severity: "high",
    category: "api",
    artifact: input.record.kind,
    message: "Admin surface referenced without a matching admin OpenAPI spec.",
    remediation: "Generate or provide an admin OpenAPI spec for the referenced admin surface.",
    location: {
      kind: "line_range",
      path: input.record.path,
      lineStart: input.line,
      lineEnd: input.line,
      excerpt: input.excerpt,
    },
    metadata: {
      heading: input.heading,
      recordPath: input.record.path,
    },
  };
};

export const runAdminOpenApiSpecGate = async (
  input: AdminOpenApiSpecGateInput,
): Promise<ReviewGateResult> => {
  const records = [input.artifacts.pdr, input.artifacts.sds].filter(
    (record): record is DocArtifactRecord => Boolean(record),
  );

  if (records.length === 0) {
    return {
      gateId: "gate-admin-openapi-spec",
      gateName: "Admin OpenAPI Spec",
      status: "skipped",
      issues: [],
      notes: ["No PDR/SDS artifacts available for admin surface checks."],
    };
  }

  const notes: string[] = [];
  const mentions: Array<{
    record: DocArtifactRecord;
    line: number;
    excerpt: string;
    heading?: string;
  }> = [];

  for (const record of records) {
    try {
      const content = await fs.readFile(record.path, "utf8");
      const found = findAdminSurfaceMentions(content);
      for (const mention of found) {
        mentions.push({
          record,
          line: mention.line,
          excerpt: mention.excerpt,
          heading: mention.heading,
        });
      }
    } catch (error) {
      notes.push(
        `Unable to scan ${record.path} for admin surfaces: ${(error as Error).message ?? String(error)}`,
      );
    }
  }

  if (mentions.length === 0) {
    return {
      gateId: "gate-admin-openapi-spec",
      gateName: "Admin OpenAPI Spec",
      status: "pass",
      issues: [],
      notes: notes.length > 0 ? notes : undefined,
      metadata: { mentionCount: 0 },
    };
  }

  const openapiRecords = input.artifacts.openapi ?? [];
  const hasAdminSpec = openapiRecords.some(
    (record) => record.variant === "admin" || /admin/i.test(path.basename(record.path)),
  );

  if (hasAdminSpec) {
    return {
      gateId: "gate-admin-openapi-spec",
      gateName: "Admin OpenAPI Spec",
      status: "pass",
      issues: [],
      notes: notes.length > 0 ? notes : undefined,
      metadata: { mentionCount: mentions.length, hasAdminSpec: true },
    };
  }

  const issues = mentions.map((mention, index) =>
    buildIssue({
      record: mention.record,
      line: mention.line,
      excerpt: mention.excerpt,
      heading: mention.heading,
      index,
    }),
  );

  return {
    gateId: "gate-admin-openapi-spec",
    gateName: "Admin OpenAPI Spec",
    status: "fail",
    issues,
    notes: notes.length > 0 ? notes : undefined,
    metadata: { mentionCount: mentions.length, hasAdminSpec: false },
  };
};
