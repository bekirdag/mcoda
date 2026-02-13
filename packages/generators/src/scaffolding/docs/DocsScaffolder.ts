import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";

export interface DeploymentEnvVar {
  name: string;
  value: string;
  secret: boolean;
  description: string;
  usedBy: string[];
}

export interface DeploymentBlueprintFile {
  path: string;
  content: string;
}

export interface DeploymentBlueprintInput {
  sdsContent: string;
  openapiContent?: string;
  outputDir: string;
  serviceName?: string;
}

export interface DeploymentBlueprintOutput {
  baseDir: string;
  files: DeploymentBlueprintFile[];
  env: DeploymentEnvVar[];
  services: string[];
  port: number;
}

type DependencyDefinition = {
  key: string;
  name: string;
  keywords: string[];
  image: string;
  port: number;
  appEnv: DeploymentEnvVar[];
  serviceEnv: DeploymentEnvVar[];
  command?: string;
};

const DEPENDENCY_DEFINITIONS: DependencyDefinition[] = [
  {
    key: "mysql",
    name: "mysql",
    keywords: ["mysql", "mariadb"],
    image: "mysql:8",
    port: 3306,
    appEnv: [
      {
        name: "DATABASE_URL",
        value: "mysql://app:${MYSQL_PASSWORD}@mysql:3306/app",
        secret: true,
        description: "MySQL connection string for the application.",
        usedBy: ["app"],
      },
    ],
    serviceEnv: [
      {
        name: "MYSQL_DATABASE",
        value: "app",
        secret: false,
        description: "MySQL database name.",
        usedBy: ["mysql"],
      },
      {
        name: "MYSQL_USER",
        value: "app",
        secret: false,
        description: "MySQL user name.",
        usedBy: ["mysql"],
      },
      {
        name: "MYSQL_PASSWORD",
        value: "change-me",
        secret: true,
        description: "MySQL user password.",
        usedBy: ["mysql"],
      },
      {
        name: "MYSQL_ROOT_PASSWORD",
        value: "change-me",
        secret: true,
        description: "MySQL root password.",
        usedBy: ["mysql"],
      },
    ],
  },
  {
    key: "redis",
    name: "redis",
    keywords: ["redis"],
    image: "redis:7",
    port: 6379,
    appEnv: [
      {
        name: "REDIS_URL",
        value: "redis://redis:6379",
        secret: false,
        description: "Redis connection URL.",
        usedBy: ["app"],
      },
    ],
    serviceEnv: [],
  },
  {
    key: "nats",
    name: "nats",
    keywords: ["nats"],
    image: "nats:2",
    port: 4222,
    appEnv: [
      {
        name: "NATS_URL",
        value: "nats://nats:4222",
        secret: false,
        description: "NATS connection URL.",
        usedBy: ["app"],
      },
    ],
    serviceEnv: [],
  },
  {
    key: "minio",
    name: "minio",
    keywords: ["minio", "object storage", "s3"],
    image: "minio/minio",
    port: 9000,
    command: "server /data",
    appEnv: [
      {
        name: "S3_ENDPOINT",
        value: "http://minio:9000",
        secret: false,
        description: "Object storage endpoint.",
        usedBy: ["app"],
      },
      {
        name: "S3_ACCESS_KEY",
        value: "minio",
        secret: false,
        description: "Object storage access key.",
        usedBy: ["app"],
      },
      {
        name: "S3_SECRET_KEY",
        value: "change-me",
        secret: true,
        description: "Object storage secret key.",
        usedBy: ["app"],
      },
    ],
    serviceEnv: [
      {
        name: "MINIO_ROOT_USER",
        value: "minio",
        secret: false,
        description: "MinIO root user.",
        usedBy: ["minio"],
      },
      {
        name: "MINIO_ROOT_PASSWORD",
        value: "change-me",
        secret: true,
        description: "MinIO root password.",
        usedBy: ["minio"],
      },
    ],
  },
  {
    key: "clickhouse",
    name: "clickhouse",
    keywords: ["clickhouse"],
    image: "clickhouse/clickhouse-server:23",
    port: 8123,
    appEnv: [
      {
        name: "CLICKHOUSE_URL",
        value: "http://clickhouse:8123",
        secret: false,
        description: "ClickHouse HTTP endpoint.",
        usedBy: ["app"],
      },
    ],
    serviceEnv: [],
  },
];

const normalizeServiceName = (value?: string): string => {
  const raw = value?.trim().toLowerCase() ?? "";
  const normalized = raw.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "app";
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

const extractPortFromUrl = (url: string): number | undefined => {
  const trimmed = url.trim();
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

const resolveServicePort = (openapiContent?: string): number => {
  const doc = parseOpenApi(openapiContent);
  const servers = Array.isArray(doc?.servers) ? doc.servers : [];
  for (const server of servers) {
    if (!server || typeof server.url !== "string") continue;
    const port = extractPortFromUrl(server.url);
    if (port) return port;
  }
  return 3000;
};

const detectDependencies = (sdsContent: string): DependencyDefinition[] => {
  const normalized = sdsContent.toLowerCase();
  return DEPENDENCY_DEFINITIONS.filter((dependency) =>
    dependency.keywords.some((keyword) => normalized.includes(keyword)),
  );
};

const remapUsedBy = (env: DeploymentEnvVar, appName: string): DeploymentEnvVar => ({
  ...env,
  usedBy: env.usedBy.map((entry) => (entry === "app" ? appName : entry)),
});

const mergeEnvVars = (env: DeploymentEnvVar[]): DeploymentEnvVar[] => {
  const map = new Map<string, DeploymentEnvVar>();
  for (const item of env) {
    const existing = map.get(item.name);
    if (!existing) {
      map.set(item.name, { ...item, usedBy: Array.from(new Set(item.usedBy)) });
      continue;
    }
    existing.secret = existing.secret || item.secret;
    existing.description = existing.description || item.description;
    existing.value = existing.value || item.value;
    existing.usedBy = Array.from(new Set([...existing.usedBy, ...item.usedBy]));
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const envRef = (name: string): string => "${" + name + "}";

const buildEnvExample = (env: DeploymentEnvVar[]): string => {
  const lines = env
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => `${item.name}=${item.value}`);
  return `${lines.join("\n")}\n`;
};

const buildEnvMappingDoc = (env: DeploymentEnvVar[]): string => {
  const lines = [
    "# Deployment Environment Variables",
    "",
    "| Name | Secret | Used By | Description |",
    "| --- | --- | --- | --- |",
    ...env.map(
      (item) =>
        `| ${item.name} | ${item.secret ? "Yes" : "No"} | ${item.usedBy
          .slice()
          .sort()
          .join(", ")} | ${item.description} |`,
    ),
    "",
  ];
  return lines.join("\n");
};

const buildDockerCompose = (
  appName: string,
  port: number,
  env: DeploymentEnvVar[],
  dependencies: DependencyDefinition[],
): string => {
  const lines: string[] = ['version: "3.9"', "services:"];
  const appEnv = env.filter((item) => item.usedBy.includes(appName));
  const depNames = dependencies.map((dep) => dep.name).sort();

  lines.push(`  ${appName}:`);
  lines.push(`    image: ${appName}`);
  lines.push("    ports:");
  lines.push(`      - "${envRef("SERVICE_PORT")}:${envRef("SERVICE_PORT")}"`);
  if (appEnv.length > 0) {
    lines.push("    environment:");
    for (const item of appEnv) {
      lines.push(`      ${item.name}: "${envRef(item.name)}"`);
    }
  }
  if (depNames.length > 0) {
    lines.push("    depends_on:");
    for (const dep of depNames) {
      lines.push(`      - ${dep}`);
    }
  }

  const sortedDeps = dependencies.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const dependency of sortedDeps) {
    lines.push(`  ${dependency.name}:`);
    lines.push(`    image: ${dependency.image}`);
    if (dependency.command) {
      lines.push(`    command: ${dependency.command}`);
    }
    lines.push("    ports:");
    lines.push(`      - "${dependency.port}:${dependency.port}"`);
    if (dependency.serviceEnv.length > 0) {
      lines.push("    environment:");
      for (const item of dependency.serviceEnv) {
        lines.push(`      ${item.name}: "${envRef(item.name)}"`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
};

const buildConfigMap = (name: string, env: DeploymentEnvVar[]): string => {
  const entries = env.filter((item) => !item.secret);
  const lines = [
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata:",
    `  name: ${name}`,
    "data:",
  ];
  if (entries.length === 0) {
    lines.push("  {}");
  } else {
    for (const item of entries) {
      lines.push(`  ${item.name}: "${item.value}"`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const buildSecret = (name: string, env: DeploymentEnvVar[]): string => {
  const entries = env.filter((item) => item.secret);
  const lines = [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${name}`,
    "type: Opaque",
    "stringData:",
  ];
  if (entries.length === 0) {
    lines.push("  {}");
  } else {
    for (const item of entries) {
      lines.push(`  ${item.name}: "${item.value}"`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const buildDeployment = (
  name: string,
  image: string,
  port: number,
  configName: string,
  secretName: string,
): string => {
  const lines = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    "  replicas: 1",
    "  selector:",
    "    matchLabels:",
    `      app: ${name}`,
    "  template:",
    "    metadata:",
    "      labels:",
    `        app: ${name}`,
    "    spec:",
    "      containers:",
    `        - name: ${name}`,
    `          image: ${image}`,
    "          ports:",
    `            - containerPort: ${port}`,
    "          envFrom:",
    "            - configMapRef:",
    `                name: ${configName}`,
    "            - secretRef:",
    `                name: ${secretName}`,
  ];
  return `${lines.join("\n")}\n`;
};

const buildService = (name: string, port: number): string => {
  const lines = [
    "apiVersion: v1",
    "kind: Service",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    "  selector:",
    `    app: ${name}`,
    "  ports:",
    `    - port: ${port}`,
    `      targetPort: ${port}`,
  ];
  return `${lines.join("\n")}\n`;
};

const buildKustomization = (resources: string[]): string => {
  const lines = [
    "apiVersion: kustomize.config.k8s.io/v1beta1",
    "kind: Kustomization",
    "resources:",
    ...resources.map((resource) => `  - ${resource}`),
  ];
  return `${lines.join("\n")}\n`;
};

export class DocsScaffolder {
  generateDeploymentBlueprint(input: DeploymentBlueprintInput): DeploymentBlueprintOutput {
    const serviceName = normalizeServiceName(input.serviceName);
    const port = resolveServicePort(input.openapiContent);
    const dependencies = detectDependencies(input.sdsContent);

    const baseEnv: DeploymentEnvVar = {
      name: "SERVICE_PORT",
      value: String(port),
      secret: false,
      description: "Port exposed by the service.",
      usedBy: [serviceName],
    };

    const envVars = [
      baseEnv,
      ...dependencies.flatMap((dependency) =>
        dependency.appEnv.map((env) => remapUsedBy(env, serviceName)),
      ),
      ...dependencies.flatMap((dependency) => dependency.serviceEnv),
    ];
    const mergedEnv = mergeEnvVars(envVars);

    const baseDir = input.outputDir;
    const k8sDir = path.join(baseDir, "k8s");
    const configName = `${serviceName}-config`;
    const secretName = `${serviceName}-secrets`;

    const files: DeploymentBlueprintFile[] = [];
    files.push({
      path: path.join(baseDir, "docker-compose.yml"),
      content: buildDockerCompose(serviceName, port, mergedEnv, dependencies),
    });
    files.push({
      path: path.join(baseDir, ".env.example"),
      content: buildEnvExample(mergedEnv),
    });
    files.push({
      path: path.join(baseDir, "env-secrets.md"),
      content: buildEnvMappingDoc(mergedEnv),
    });
    files.push({
      path: path.join(k8sDir, "configmap.yaml"),
      content: buildConfigMap(configName, mergedEnv),
    });
    files.push({
      path: path.join(k8sDir, "secret.yaml"),
      content: buildSecret(secretName, mergedEnv),
    });
    files.push({
      path: path.join(k8sDir, `${serviceName}-deployment.yaml`),
      content: buildDeployment(serviceName, serviceName, port, configName, secretName),
    });
    files.push({
      path: path.join(k8sDir, `${serviceName}-service.yaml`),
      content: buildService(serviceName, port),
    });

    const sortedDeps = dependencies.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const dependency of sortedDeps) {
      files.push({
        path: path.join(k8sDir, `${dependency.name}-deployment.yaml`),
        content: buildDeployment(
          dependency.name,
          dependency.image,
          dependency.port,
          configName,
          secretName,
        ),
      });
      files.push({
        path: path.join(k8sDir, `${dependency.name}-service.yaml`),
        content: buildService(dependency.name, dependency.port),
      });
    }

    const k8sResources = files
      .filter((file) => path.dirname(file.path) === k8sDir)
      .map((file) => path.basename(file.path))
      .filter((name) => name !== "kustomization.yaml")
      .sort();
    files.push({
      path: path.join(k8sDir, "kustomization.yaml"),
      content: buildKustomization(k8sResources),
    });

    const sortedFiles = files.slice().sort((a, b) => a.path.localeCompare(b.path));
    return {
      baseDir,
      files: sortedFiles,
      env: mergedEnv,
      services: [serviceName, ...sortedDeps.map((dep) => dep.name)],
      port,
    };
  }

  async writeDeploymentBlueprint(output: DeploymentBlueprintOutput): Promise<void> {
    const dirs = Array.from(new Set(output.files.map((file) => path.dirname(file.path))));
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
    await Promise.all(
      output.files.map((file) => fs.writeFile(file.path, file.content, "utf8")),
    );
  }

  async generateDeploymentBlueprintFiles(
    input: DeploymentBlueprintInput,
  ): Promise<DeploymentBlueprintOutput> {
    const output = this.generateDeploymentBlueprint(input);
    await this.writeDeploymentBlueprint(output);
    return output;
  }
}
