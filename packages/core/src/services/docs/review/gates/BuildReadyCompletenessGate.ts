import { promises as fs } from "node:fs";
import YAML from "yaml";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue, ReviewSeverity } from "../ReviewTypes.js";

export interface BuildReadyCompletenessGateInput {
  artifacts: DocgenArtifactInventory;
  buildReady?: boolean;
}

const REQUIRED_PDR_HEADINGS = ["scope", "interfaces"];
const REQUIRED_SDS_HEADINGS = ["architecture", "operations"];

const normalizeHeading = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const extractHeadings = (content: string): { text: string; line: number }[] => {
  const lines = content.split(/\r?\n/);
  const headings: { text: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(/^#{1,6}\s+(.*)$/);
    if (match) {
      headings.push({ text: match[1]?.trim() ?? "", line: i + 1 });
    }
  }
  return headings;
};

const hasRequiredHeadings = (
  content: string,
  required: string[],
): { missing: string[]; lineMap: Record<string, number> } => {
  const headings = extractHeadings(content);
  const normalized = headings.map((h) => normalizeHeading(h.text));
  const lineMap: Record<string, number> = {};
  for (const heading of headings) {
    lineMap[normalizeHeading(heading.text)] = heading.line;
  }
  const missing = required.filter((req) => !normalized.includes(req));
  return { missing, lineMap };
};

const buildIssue = (input: {
  id: string;
  artifact: DocArtifactRecord | undefined;
  artifactKind: DocArtifactRecord["kind"] | "openapi" | "sql" | "deployment" | "pdr" | "sds";
  message: string;
  remediation: string;
  severity?: ReviewSeverity;
  location?: ReviewIssue["location"];
  metadata?: Record<string, unknown>;
}): ReviewIssue => {
  return {
    id: input.id,
    gateId: "gate-build-ready-completeness",
    severity: input.severity ?? "high",
    category: "completeness",
    artifact: input.artifactKind as any,
    message: input.message,
    remediation: input.remediation,
    location:
      input.location ??
      ({ kind: "heading", heading: "Artifacts", path: input.artifact?.path } as const),
    metadata: input.metadata,
  };
};

const checkOpenApi = async (
  record: DocArtifactRecord,
): Promise<{ issues: ReviewIssue[]; notes: string[] }> => {
  const issues: ReviewIssue[] = [];
  const notes: string[] = [];
  try {
    const content = await fs.readFile(record.path, "utf8");
    let parsed: any;
    try {
      parsed = YAML.parse(content);
    } catch (error) {
      issues.push(
        buildIssue({
          id: `gate-build-ready-completeness-openapi-parse`,
          artifact: record,
          artifactKind: "openapi",
          message: `OpenAPI spec is not valid YAML: ${(error as Error).message}`,
          remediation: "Regenerate or fix the OpenAPI spec so it parses cleanly.",
          location: { kind: "line_range", path: record.path, lineStart: 1, lineEnd: 1 },
          metadata: { issueType: "openapi_parse" },
        }),
      );
      return { issues, notes };
    }
    if (!parsed?.openapi) {
      issues.push(
        buildIssue({
          id: `gate-build-ready-completeness-openapi-missing-version`,
          artifact: record,
          artifactKind: "openapi",
          message: "OpenAPI spec missing openapi version field.",
          remediation: "Add the openapi version (e.g., 3.1.0) to the spec.",
          metadata: { issueType: "openapi_missing_version" },
        }),
      );
    }
    if (!parsed?.paths || Object.keys(parsed.paths ?? {}).length === 0) {
      issues.push(
        buildIssue({
          id: `gate-build-ready-completeness-openapi-missing-paths`,
          artifact: record,
          artifactKind: "openapi",
          message: "OpenAPI spec is missing paths definitions.",
          remediation: "Ensure the OpenAPI spec includes a paths section with endpoints.",
          metadata: { issueType: "openapi_missing_paths" },
        }),
      );
    }
  } catch (error) {
    notes.push(`Unable to read OpenAPI spec ${record.path}: ${(error as Error).message ?? String(error)}`);
  }
  return { issues, notes };
};

const checkSql = async (
  record: DocArtifactRecord,
): Promise<{ issues: ReviewIssue[]; notes: string[] }> => {
  const issues: ReviewIssue[] = [];
  const notes: string[] = [];
  try {
    const content = await fs.readFile(record.path, "utf8");
    if (!/\bcreate\s+table\b/i.test(content)) {
      issues.push(
        buildIssue({
          id: `gate-build-ready-completeness-sql-missing-tables`,
          artifact: record,
          artifactKind: "sql",
          message: "SQL schema does not contain any CREATE TABLE statements.",
          remediation: "Define the required schema tables in the SQL output.",
          metadata: { issueType: "sql_missing_tables" },
        }),
      );
    }
  } catch (error) {
    notes.push(`Unable to read SQL schema ${record.path}: ${(error as Error).message ?? String(error)}`);
  }
  return { issues, notes };
};

const checkMarkdownHeadings = async (
  record: DocArtifactRecord,
  required: string[],
  label: string,
): Promise<{ issues: ReviewIssue[]; notes: string[] }> => {
  const issues: ReviewIssue[] = [];
  const notes: string[] = [];
  try {
    const content = await fs.readFile(record.path, "utf8");
    const { missing, lineMap } = hasRequiredHeadings(content, required);
    if (missing.length > 0) {
      for (const heading of missing) {
        issues.push(
          buildIssue({
            id: `gate-build-ready-completeness-${record.kind}-${heading}`,
            artifact: record,
            artifactKind: record.kind,
            message: `${label} is missing the "${heading}" section.`,
            remediation: `Add a ${heading} section to the ${label}.`,
            location: {
              kind: "heading",
              heading: heading,
              path: record.path,
            },
            metadata: { issueType: "missing_heading", heading, line: lineMap[heading] },
          }),
        );
      }
    }
  } catch (error) {
    notes.push(`Unable to read ${label} ${record.path}: ${(error as Error).message ?? String(error)}`);
  }
  return { issues, notes };
};

const hasAnyArtifacts = (artifacts: DocgenArtifactInventory): boolean =>
  Boolean(artifacts.pdr || artifacts.sds || artifacts.sql || artifacts.openapi.length > 0 || artifacts.blueprints.length > 0);

const deploymentHasEnvExample = (records: DocArtifactRecord[]): boolean =>
  records.some((record) => record.path.toLowerCase().endsWith(".env.example"));

const deploymentHasManifest = (records: DocArtifactRecord[]): boolean =>
  records.some((record) => {
    const lower = record.path.toLowerCase();
    return (
      lower.includes("docker-compose") ||
      lower.endsWith("kustomization.yaml") ||
      lower.endsWith("kustomization.yml") ||
      lower.includes("/k8s/") ||
      lower.includes("/deploy/") ||
      lower.includes("/deployment/")
    );
  });

export const runBuildReadyCompletenessGate = async (
  input: BuildReadyCompletenessGateInput,
): Promise<ReviewGateResult> => {
  const { artifacts, buildReady } = input;
  if (!hasAnyArtifacts(artifacts)) {
    return {
      gateId: "gate-build-ready-completeness",
      gateName: "Build-Ready Completeness",
      status: "skipped",
      issues: [],
      notes: ["No artifacts available for build-ready completeness checks."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];
  const missingArtifacts: string[] = [];

  if (!artifacts.pdr) {
    missingArtifacts.push("pdr");
    issues.push(
      buildIssue({
        id: "gate-build-ready-completeness-missing-pdr",
        artifact: undefined,
        artifactKind: "pdr",
        message: "PDR artifact is missing.",
        remediation: "Generate or provide a PDR document.",
        metadata: { issueType: "missing_artifact", required: "pdr" },
      }),
    );
  }

  if (!artifacts.sds) {
    missingArtifacts.push("sds");
    issues.push(
      buildIssue({
        id: "gate-build-ready-completeness-missing-sds",
        artifact: undefined,
        artifactKind: "sds",
        message: "SDS artifact is missing.",
        remediation: "Generate or provide an SDS document.",
        metadata: { issueType: "missing_artifact", required: "sds" },
      }),
    );
  }

  if (!artifacts.openapi || artifacts.openapi.length === 0) {
    missingArtifacts.push("openapi");
    issues.push(
      buildIssue({
        id: "gate-build-ready-completeness-missing-openapi",
        artifact: undefined,
        artifactKind: "openapi",
        message: "OpenAPI spec is missing.",
        remediation: "Generate or provide an OpenAPI spec.",
        metadata: { issueType: "missing_artifact", required: "openapi" },
      }),
    );
  }

  if (!artifacts.sql) {
    missingArtifacts.push("sql");
    issues.push(
      buildIssue({
        id: "gate-build-ready-completeness-missing-sql",
        artifact: undefined,
        artifactKind: "sql",
        message: "SQL schema output is missing.",
        remediation: "Generate or provide the SQL schema output.",
        metadata: { issueType: "missing_artifact", required: "sql" },
      }),
    );
  }

  if (!artifacts.blueprints || artifacts.blueprints.length === 0) {
    missingArtifacts.push("deployment");
    issues.push(
      buildIssue({
        id: "gate-build-ready-completeness-missing-deployment",
        artifact: undefined,
        artifactKind: "deployment",
        message: "Deployment blueprint artifacts are missing.",
        remediation: "Generate deployment blueprint files (docker-compose, k8s, env example).",
        metadata: { issueType: "missing_artifact", required: "deployment" },
      }),
    );
  }

  if (artifacts.pdr) {
    const result = await checkMarkdownHeadings(artifacts.pdr, REQUIRED_PDR_HEADINGS, "PDR");
    issues.push(...result.issues);
    notes.push(...result.notes);
  }

  if (artifacts.sds) {
    const result = await checkMarkdownHeadings(artifacts.sds, REQUIRED_SDS_HEADINGS, "SDS");
    issues.push(...result.issues);
    notes.push(...result.notes);
  }

  if (artifacts.openapi.length > 0) {
    for (const record of artifacts.openapi) {
      const result = await checkOpenApi(record);
      issues.push(...result.issues);
      notes.push(...result.notes);
    }
  }

  if (artifacts.sql) {
    const result = await checkSql(artifacts.sql);
    issues.push(...result.issues);
    notes.push(...result.notes);
  }

  if (artifacts.blueprints.length > 0) {
    if (!deploymentHasEnvExample(artifacts.blueprints)) {
      issues.push(
        buildIssue({
          id: "gate-build-ready-completeness-missing-env-example",
          artifact: artifacts.blueprints[0],
          artifactKind: "deployment",
          message: "Deployment blueprint missing .env.example.",
          remediation: "Include a .env.example mapping for required environment variables.",
          metadata: { issueType: "deployment_missing_env" },
        }),
      );
    }
    if (!deploymentHasManifest(artifacts.blueprints)) {
      issues.push(
        buildIssue({
          id: "gate-build-ready-completeness-missing-manifest",
          artifact: artifacts.blueprints[0],
          artifactKind: "deployment",
          message: "Deployment blueprint missing compose or k8s manifests.",
          remediation: "Provide docker-compose or Kubernetes manifests for deployment.",
          metadata: { issueType: "deployment_missing_manifest" },
        }),
      );
    }
  }

  const status = issues.length === 0 ? "pass" : buildReady ? "fail" : "warn";

  return {
    gateId: "gate-build-ready-completeness",
    gateName: "Build-Ready Completeness",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: {
      missingArtifacts,
      issueCount: issues.length,
      buildReady: Boolean(buildReady),
    },
  };
};
