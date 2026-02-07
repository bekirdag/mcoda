import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { DocArtifactRecord, DocgenArtifactInventory } from "../../DocgenRunContext.js";
import { ReviewGateResult, ReviewIssue, ReviewSeverity } from "../ReviewTypes.js";

export interface DeploymentBlueprintGateInput {
  artifacts: DocgenArtifactInventory;
  buildReady?: boolean;
}

type DependencyKey = "mysql" | "redis" | "nats" | "minio" | "clickhouse";

interface DependencyDefinition {
  key: DependencyKey;
  label: string;
  keywords: string[];
}

const DEPENDENCY_DEFINITIONS: DependencyDefinition[] = [
  { key: "mysql", label: "MySQL", keywords: ["mysql", "mariadb"] },
  { key: "redis", label: "Redis", keywords: ["redis"] },
  { key: "nats", label: "NATS", keywords: ["nats"] },
  { key: "minio", label: "MinIO", keywords: ["minio", "object storage", "s3"] },
  { key: "clickhouse", label: "ClickHouse", keywords: ["clickhouse"] },
];

const ENV_REF_PATTERN = /\${([A-Z][A-Z0-9_]+)}/g;
const ENV_SECTION_PATTERN = /^\s*(environment|data|stringData)\s*:\s*$/i;
const ENV_KEY_PATTERN = /^\s*([A-Z][A-Z0-9_]+)\s*:/;
const SERVICE_PORT_NAME = "SERVICE_PORT";

const isFenceLine = (line: string): boolean => /^```|^~~~/.test(line.trim());

const extractDependencies = (
  content: string,
): Map<DependencyKey, { line: number; keyword: string }> => {
  const matches = new Map<DependencyKey, { line: number; keyword: string }>();
  const lines = content.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed) continue;
    const normalized = trimmed.toLowerCase();
    for (const dependency of DEPENDENCY_DEFINITIONS) {
      if (matches.has(dependency.key)) continue;
      const keyword = dependency.keywords.find((entry) => normalized.includes(entry));
      if (keyword) {
        matches.set(dependency.key, { line: i + 1, keyword });
      }
    }
  }
  return matches;
};

const parseEnvExample = (content: string): {
  names: Set<string>;
  port?: number;
  lineMap: Map<string, number>;
} => {
  const names = new Set<string>();
  const lineMap = new Map<string, number>();
  let port: number | undefined;
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [rawName, rawValue] = trimmed.split("=", 2);
    const name = rawName?.trim();
    if (!name || !/^[A-Z][A-Z0-9_]+$/.test(name)) return;
    names.add(name);
    if (!lineMap.has(name)) {
      lineMap.set(name, index + 1);
    }
    if (name === SERVICE_PORT_NAME && rawValue) {
      const parsed = Number.parseInt(rawValue.trim(), 10);
      if (Number.isFinite(parsed)) port = parsed;
    }
  });
  return { names, port, lineMap };
};

const parseEnvDoc = (content: string): Set<string> => {
  const names = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const columns = line.split("|").map((entry) => entry.trim());
    if (columns.length < 3) continue;
    const name = columns[1];
    if (!name || name.toLowerCase() === "name") continue;
    if (/^[A-Z][A-Z0-9_]+$/.test(name)) {
      names.add(name);
    }
  }
  return names;
};

const collectEnvReferences = async (
  record: DocArtifactRecord,
): Promise<Map<string, { path: string; line: number }>> => {
  const refs = new Map<string, { path: string; line: number }>();
  try {
    const content = await fs.readFile(record.path, "utf8");
    const lines = content.split(/\r?\n/);
    let inSection = false;
    let sectionIndent = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      const sectionMatch = line.match(ENV_SECTION_PATTERN);
      if (sectionMatch) {
        inSection = true;
        sectionIndent = line.match(/^\s*/)?.[0]?.length ?? 0;
        continue;
      }
      const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
      if (inSection && indent <= sectionIndent && trimmed.length > 0) {
        inSection = false;
      }
      if (inSection) {
        const keyMatch = line.match(ENV_KEY_PATTERN);
        if (keyMatch?.[1]) {
          if (!refs.has(keyMatch[1])) {
            refs.set(keyMatch[1], { path: record.path, line: i + 1 });
          }
        }
      }
      const envRegex = new RegExp(ENV_REF_PATTERN);
      let match: RegExpExecArray | null;
      while ((match = envRegex.exec(line)) !== null) {
        const name = match[1];
        if (name && !refs.has(name)) {
          refs.set(name, { path: record.path, line: i + 1 });
        }
      }
    }
  } catch {
    return refs;
  }
  return refs;
};

const extractComposeServices = (content: string): Map<string, number> => {
  const services = new Map<string, number>();
  const lines = content.split(/\r?\n/);
  let inServices = false;
  let baseIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!inServices && /^services\s*:/i.test(trimmed)) {
      inServices = true;
      baseIndent = line.match(/^\s*/)?.[0]?.length ?? 0;
      continue;
    }
    if (inServices) {
      const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
      if (indent <= baseIndent) {
        inServices = false;
        continue;
      }
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*$/);
      if (match?.[1]) {
        services.set(match[1], i + 1);
      }
    }
  }
  return services;
};

const extractServicesFromBlueprints = async (
  records: DocArtifactRecord[],
): Promise<Map<string, { path: string; line: number }>> => {
  const services = new Map<string, { path: string; line: number }>();
  const compose = records.find((record) =>
    path.basename(record.path).toLowerCase().includes("docker-compose"),
  );
  if (compose) {
    try {
      const content = await fs.readFile(compose.path, "utf8");
      const extracted = extractComposeServices(content);
      extracted.forEach((line, name) => {
        services.set(name, { path: compose.path, line });
      });
      return services;
    } catch {
      // fall through to filename-based detection
    }
  }
  for (const record of records) {
    const base = path.basename(record.path).toLowerCase();
    if (!base.endsWith("-deployment.yaml") && !base.endsWith("-deployment.yml")) {
      continue;
    }
    const name = base.replace(/-deployment\.ya?ml$/i, "");
    if (!services.has(name)) {
      services.set(name, { path: record.path, line: 1 });
    }
  }
  return services;
};

const parseOpenApi = (raw?: string): any | undefined => {
  if (!raw || !raw.trim()) return undefined;
  try {
    return YAML.parse(raw);
  } catch {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
};

const extractPortFromUrl = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  try {
    const parsed = new URL(hasScheme ? trimmed : `http://${trimmed}`);
    if (parsed.port) return Number(parsed.port);
    if (hasScheme) {
      if (parsed.protocol === "https:") return 443;
      if (parsed.protocol === "http:") return 80;
    }
  } catch {
    const portMatch = trimmed.match(/:(\d{2,5})(?:\/|$)/);
    if (portMatch) return Number(portMatch[1]);
  }
  return undefined;
};

const extractOpenApiPorts = (content: string): number[] => {
  const doc = parseOpenApi(content);
  const ports: number[] = [];
  const servers = Array.isArray(doc?.servers) ? doc.servers : [];
  for (const server of servers) {
    if (!server || typeof server.url !== "string") continue;
    const port = extractPortFromUrl(server.url);
    if (port) ports.push(port);
  }
  return ports;
};

const buildIssue = (input: {
  id: string;
  message: string;
  remediation: string;
  severity: ReviewSeverity;
  location: ReviewIssue["location"];
  metadata?: Record<string, unknown>;
}): ReviewIssue => ({
  id: input.id,
  gateId: "gate-deployment-blueprint-validator",
  severity: input.severity,
  category: "deployment",
  artifact: "deployment",
  message: input.message,
  remediation: input.remediation,
  location: input.location,
  metadata: input.metadata,
});

export const runDeploymentBlueprintGate = async (
  input: DeploymentBlueprintGateInput,
): Promise<ReviewGateResult> => {
  const { artifacts, buildReady } = input;
  const blueprintRecords = artifacts.blueprints ?? [];
  if (blueprintRecords.length === 0) {
    return {
      gateId: "gate-deployment-blueprint-validator",
      gateName: "Deployment Blueprint Validator",
      status: "skipped",
      issues: [],
      notes: ["No deployment blueprint artifacts available for validation."],
    };
  }

  if (!artifacts.sds) {
    return {
      gateId: "gate-deployment-blueprint-validator",
      gateName: "Deployment Blueprint Validator",
      status: "skipped",
      issues: [],
      notes: ["No SDS artifact available for deployment blueprint validation."],
    };
  }

  const issues: ReviewIssue[] = [];
  const notes: string[] = [];

  const envExampleRecord = blueprintRecords.find((record) =>
    path.basename(record.path).toLowerCase().endsWith(".env.example"),
  );
  const envDocRecord = blueprintRecords.find((record) =>
    path.basename(record.path).toLowerCase().includes("env-secrets"),
  );
  const manifestRecords = blueprintRecords.filter(
    (record) => record !== envExampleRecord && record !== envDocRecord,
  );

  let envExample: ReturnType<typeof parseEnvExample> | undefined;
  if (envExampleRecord) {
    try {
      envExample = parseEnvExample(await fs.readFile(envExampleRecord.path, "utf8"));
    } catch (error) {
      notes.push(
        `Unable to read env example ${envExampleRecord.path}: ${
          (error as Error).message ?? String(error)
        }`,
      );
    }
  }

  let envDocNames: Set<string> | undefined;
  if (envDocRecord) {
    try {
      envDocNames = parseEnvDoc(await fs.readFile(envDocRecord.path, "utf8"));
    } catch (error) {
      notes.push(
        `Unable to read env mapping doc ${envDocRecord.path}: ${
          (error as Error).message ?? String(error)
        }`,
      );
    }
  }

  const manifestEnvRefs = new Map<string, { path: string; line: number }>();
  for (const record of manifestRecords) {
    const refs = await collectEnvReferences(record);
    refs.forEach((value, key) => {
      if (!manifestEnvRefs.has(key)) manifestEnvRefs.set(key, value);
    });
  }

  if (manifestEnvRefs.size > 0) {
    if (!envExampleRecord) {
      issues.push(
        buildIssue({
          id: "gate-deployment-blueprint-missing-env-example",
          severity: "high",
          message: "Deployment blueprint is missing .env.example for manifest env vars.",
          remediation: "Provide a .env.example file listing all manifest environment variables.",
          location: {
            kind: "heading",
            heading: "Deployment",
            path: manifestRecords[0]?.path,
          },
          metadata: { issueType: "missing_env_example_file" },
        }),
      );
    }
    if (!envDocRecord) {
      issues.push(
        buildIssue({
          id: "gate-deployment-blueprint-missing-env-doc",
          severity: "medium",
          message: "Deployment blueprint is missing env-secrets documentation.",
          remediation: "Document deployment environment variables in env-secrets.md.",
          location: {
            kind: "heading",
            heading: "Deployment",
            path: manifestRecords[0]?.path,
          },
          metadata: { issueType: "missing_env_doc_file" },
        }),
      );
    }
  }

  if (envExample) {
    for (const [name, reference] of manifestEnvRefs.entries()) {
      if (!envExample.names.has(name)) {
        issues.push(
          buildIssue({
            id: `gate-deployment-blueprint-missing-env-example-${name.toLowerCase()}`,
            severity: "high",
            message: `Environment variable ${name} is referenced in manifests but missing from .env.example.`,
            remediation: `Add ${name} to .env.example and document its usage.`,
            location: {
              kind: "line_range",
              path: reference.path,
              lineStart: reference.line,
              lineEnd: reference.line,
              excerpt: name,
            },
            metadata: { issueType: "missing_env_example", name },
          }),
        );
      }
    }
  }

  if (envDocNames) {
    for (const [name, reference] of manifestEnvRefs.entries()) {
      if (!envDocNames.has(name)) {
        issues.push(
          buildIssue({
            id: `gate-deployment-blueprint-missing-env-doc-${name.toLowerCase()}`,
            severity: "medium",
            message: `Environment variable ${name} is referenced in manifests but missing from env-secrets.md.`,
            remediation: `Document ${name} in env-secrets.md with usage details.`,
            location: {
              kind: "line_range",
              path: reference.path,
              lineStart: reference.line,
              lineEnd: reference.line,
              excerpt: name,
            },
            metadata: { issueType: "missing_env_documentation", name },
          }),
        );
      }
    }
  }

  let expectedDependencies = new Map<DependencyKey, { line: number; keyword: string }>();
  try {
    const sdsContent = await fs.readFile(artifacts.sds.path, "utf8");
    expectedDependencies = extractDependencies(sdsContent);
  } catch (error) {
    notes.push(
      `Unable to read SDS ${artifacts.sds.path}: ${(error as Error).message ?? String(error)}`,
    );
  }

  const detectedServices = await extractServicesFromBlueprints(blueprintRecords);
  const detectedDependencyKeys = new Set<DependencyKey>();
  detectedServices.forEach((_value, name) => {
    const key = DEPENDENCY_DEFINITIONS.find((entry) => entry.key === name)?.key;
    if (key) detectedDependencyKeys.add(key);
  });

  for (const dependency of DEPENDENCY_DEFINITIONS) {
    const expected = expectedDependencies.has(dependency.key);
    const actual = detectedDependencyKeys.has(dependency.key);
    if (expected && !actual) {
      const match = expectedDependencies.get(dependency.key);
      issues.push(
        buildIssue({
          id: `gate-deployment-blueprint-missing-dependency-${dependency.key}`,
          severity: "high",
          message: `Deployment blueprint is missing ${dependency.label} even though SDS references it.`,
          remediation: `Add ${dependency.label} services/manifests to the deployment blueprint.`,
          location: {
            kind: "line_range",
            path: artifacts.sds.path,
            lineStart: match?.line ?? 1,
            lineEnd: match?.line ?? 1,
            excerpt: match?.keyword ?? dependency.label,
          },
          metadata: { issueType: "missing_dependency", dependency: dependency.key },
        }),
      );
    }
    if (!expected && actual) {
      const serviceInfo = detectedServices.get(dependency.key);
      issues.push(
        buildIssue({
          id: `gate-deployment-blueprint-unexpected-dependency-${dependency.key}`,
          severity: "medium",
          message: `Deployment blueprint includes ${dependency.label} but SDS does not select it.`,
          remediation: `Remove ${dependency.label} from manifests or update SDS decisions.`,
          location: {
            kind: "line_range",
            path: serviceInfo?.path ?? envExampleRecord?.path ?? artifacts.sds.path,
            lineStart: serviceInfo?.line ?? 1,
            lineEnd: serviceInfo?.line ?? 1,
            excerpt: dependency.label,
          },
          metadata: { issueType: "unexpected_dependency", dependency: dependency.key },
        }),
      );
    }
  }

  const openapiPorts: number[] = [];
  if (artifacts.openapi?.length) {
    for (const record of artifacts.openapi) {
      try {
        const content = await fs.readFile(record.path, "utf8");
        const ports = extractOpenApiPorts(content);
        if (ports.length > 0) {
          openapiPorts.push(...ports);
        }
      } catch (error) {
        notes.push(
          `Unable to read OpenAPI spec ${record.path}: ${(error as Error).message ?? String(error)}`,
        );
      }
    }
  }

  if (openapiPorts.length > 0) {
    const expectedPort = envExample?.port;
    if (!expectedPort) {
      issues.push(
        buildIssue({
          id: "gate-deployment-blueprint-missing-service-port",
          severity: "medium",
          message: "Deployment blueprint is missing SERVICE_PORT for OpenAPI server alignment.",
          remediation: "Include SERVICE_PORT in .env.example and ensure manifests reference it.",
          location: {
            kind: "heading",
            heading: "Deployment",
            path: envExampleRecord?.path ?? artifacts.sds.path,
          },
          metadata: { issueType: "missing_service_port" },
        }),
      );
    } else if (!openapiPorts.includes(expectedPort)) {
      issues.push(
        buildIssue({
          id: "gate-deployment-blueprint-port-mismatch",
          severity: "high",
          message: `Deployment blueprint uses port ${expectedPort} but OpenAPI servers use ${openapiPorts.join(
            ", ",
          )}.`,
          remediation: "Align SERVICE_PORT and manifests with the OpenAPI server port.",
          location: {
            kind: "line_range",
            path: envExampleRecord?.path ?? artifacts.sds.path,
            lineStart: envExample?.lineMap.get(SERVICE_PORT_NAME) ?? 1,
            lineEnd: envExample?.lineMap.get(SERVICE_PORT_NAME) ?? 1,
            excerpt: SERVICE_PORT_NAME,
          },
          metadata: {
            issueType: "port_mismatch",
            servicePort: expectedPort,
            openapiPorts,
          },
        }),
      );
    }
  }

  const status = issues.length === 0 ? "pass" : buildReady ? "fail" : "warn";

  return {
    gateId: "gate-deployment-blueprint-validator",
    gateName: "Deployment Blueprint Validator",
    status,
    issues,
    notes: notes.length ? notes : undefined,
    metadata: {
      envVarsReferenced: Array.from(manifestEnvRefs.keys()),
      serviceDependenciesExpected: Array.from(expectedDependencies.keys()),
      serviceDependenciesDetected: Array.from(detectedDependencyKeys),
      openapiPorts,
    },
  };
};
