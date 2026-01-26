import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { QaApiRequest } from "@mcoda/shared";
import { QaRunResult } from "@mcoda/integrations/qa/QaTypes.js";

type ApiRequestResult = {
  id?: string;
  method: string;
  url: string;
  status?: number;
  ok: boolean;
  durationMs: number;
  error?: string;
  expectations?: string[];
  responseSnippet?: string;
};

const DEFAULT_API_PORT = 3000;
const DEFAULT_API_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 600_000;
const RESPONSE_SNIPPET_LIMIT = 2000;
const SAMPLE_PLACEHOLDER_KEYS = ["QA_SAMPLE_EMAIL", "QA_SAMPLE_PASSWORD", "QA_SAMPLE_TOKEN"] as const;

const buildSamplePlaceholderMap = (env: NodeJS.ProcessEnv): Record<string, string | undefined> => ({
  QA_SAMPLE_EMAIL: env.MCODA_QA_SAMPLE_EMAIL ?? env.QA_SAMPLE_EMAIL,
  QA_SAMPLE_PASSWORD: env.MCODA_QA_SAMPLE_PASSWORD ?? env.QA_SAMPLE_PASSWORD,
  QA_SAMPLE_TOKEN: env.MCODA_QA_SAMPLE_TOKEN ?? env.QA_SAMPLE_TOKEN,
});

const replaceSamplePlaceholders = (value: string, map: Record<string, string | undefined>): string => {
  return value.replace(/\{\{(QA_SAMPLE_EMAIL|QA_SAMPLE_PASSWORD|QA_SAMPLE_TOKEN)\}\}/g, (_match, key) => {
    const replacement = map[key as keyof typeof map];
    return replacement ?? _match;
  });
};

const applySamplePlaceholders = (
  input: unknown,
  map: Record<string, string | undefined>,
): unknown => {
  if (typeof input === "string") {
    return replaceSamplePlaceholders(input, map);
  }
  if (Array.isArray(input)) {
    return input.map((item) => applySamplePlaceholders(item, map));
  }
  if (input && typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      result[key] = applySamplePlaceholders(value, map);
    }
    return result;
  }
  return input;
};

const normalizeBaseUrl = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname === "0.0.0.0") {
      url.hostname = DEFAULT_API_HOST;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
};

const extractPort = (script: string): number | undefined => {
  const matches = [
    script.match(/(?:--port|-p)\s*(\d{2,5})/),
    script.match(/PORT\s*=\s*(\d{2,5})/),
  ];
  for (const match of matches) {
    if (!match) continue;
    const port = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(port)) return port;
  }
  return undefined;
};

const inferPort = (script: string): number | undefined => {
  const lower = script.toLowerCase();
  if (lower.includes("vite")) return 5173;
  if (lower.includes("astro")) return 4321;
  if (lower.includes("next")) return 3000;
  if (lower.includes("react-scripts")) return 3000;
  if (lower.includes("nuxt")) return 3000;
  return undefined;
};

const resolveSchemaRef = (spec: any, schema: any): any => {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref && typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (ref.startsWith("#/components/schemas/")) {
      const key = ref.split("/").pop();
      if (key && spec?.components?.schemas?.[key]) {
        return spec.components.schemas[key];
      }
    }
  }
  return schema;
};

const pickSchemaVariant = (schema: any): any => {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return schema.oneOf[0];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return schema.anyOf[0];
  if (Array.isArray(schema.allOf) && schema.allOf.length) return schema.allOf[0];
  return schema;
};

const resolveSuccessStatus = (responses: any): number => {
  if (!responses || typeof responses !== "object") return 200;
  const codes = Object.keys(responses);
  const success = codes.find((code) => /^2\d\d$/.test(code));
  if (success) {
    const parsed = Number.parseInt(success, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 200;
};

const pickExampleValue = (schema: any): unknown => {
  if (!schema || typeof schema !== "object") return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.examples) {
    if (Array.isArray(schema.examples) && schema.examples.length) {
      return schema.examples[0];
    }
    if (typeof schema.examples === "object") {
      const first = Object.values(schema.examples)[0] as any;
      if (first && typeof first === "object" && "value" in first) return first.value;
      return first;
    }
  }
  return undefined;
};

const buildSampleValue = (
  spec: any,
  rawSchema: any,
  nameHint?: string,
  depth = 0,
): unknown => {
  if (!rawSchema || typeof rawSchema !== "object") return undefined;
  if (depth > 3) return undefined;
  const schema = pickSchemaVariant(resolveSchemaRef(spec, rawSchema));
  const example = pickExampleValue(schema);
  if (example !== undefined) return example;

  const hint = (nameHint ?? "").toLowerCase();
  if (hint.includes("email")) return "{{QA_SAMPLE_EMAIL}}";
  if (hint.includes("password")) return "{{QA_SAMPLE_PASSWORD}}";
  if (hint.includes("token") || hint.includes("auth")) return "{{QA_SAMPLE_TOKEN}}";

  const type = schema.type;
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum[0];
  }
  if (type === "string") {
    const format = String(schema.format ?? "").toLowerCase();
    if (format === "email") return "{{QA_SAMPLE_EMAIL}}";
    if (format === "uuid") return "00000000-0000-4000-8000-000000000000";
    if (format === "date-time") return new Date().toISOString();
    return "sample";
  }
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "array") {
    const itemSample = buildSampleValue(spec, schema.items, nameHint, depth + 1);
    return itemSample !== undefined ? [itemSample] : [];
  }
  const properties = schema.properties ?? {};
  if (type === "object" || Object.keys(properties).length) {
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    const entries = Object.entries(properties) as Array<[string, any]>;
    const keys = required.length ? required : entries.map(([key]) => key).slice(0, 3);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const childSchema = properties[key];
      const child = buildSampleValue(spec, childSchema, key, depth + 1);
      if (child !== undefined) result[key] = child;
    }
    return result;
  }
  return undefined;
};

const buildRequestBody = (spec: any, operation: any): unknown => {
  const requestBody = operation?.requestBody;
  if (!requestBody) return undefined;
  const content = requestBody.content ?? {};
  const jsonContent =
    content["application/json"] ??
    content["application/*+json"] ??
    Object.values(content)[0];
  const schema = jsonContent?.schema;
  if (!schema) return undefined;
  return buildSampleValue(spec, schema);
};

const TOKEN_KEYS = new Set([
  "access_token",
  "accessToken",
  "token",
  "id_token",
  "idToken",
  "jwt",
]);

const findTokenValue = (value: unknown, depth = 0): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  if (depth > 3) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTokenValue(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (TOKEN_KEYS.has(key) && typeof val === "string" && val.trim()) {
      return val;
    }
  }
  for (const val of Object.values(value as Record<string, unknown>)) {
    const found = findTokenValue(val, depth + 1);
    if (found) return found;
  }
  return undefined;
};

const extractBearerToken = (value: unknown): string | undefined => {
  if (!value) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.length > 200) return undefined;
    if (/\s/.test(trimmed)) return undefined;
    return trimmed;
  }
  return findTokenValue(value);
};

const extractCookieHeader = (value: string | string[] | null | undefined): string | undefined => {
  if (!value) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  const cookies = entries
    .map((entry) => entry.split(";")[0]?.trim())
    .filter((entry): entry is string => Boolean(entry));
  return cookies.length ? cookies.join("; ") : undefined;
};

const resolveRequestPath = (urlOrPath: string): string | undefined => {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    if (!urlOrPath) return undefined;
    return urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`;
  }
};

const buildPathRegex = (pattern: string): RegExp => {
  const token = "__PARAM__";
  const replaced = pattern.replace(/\{[^}]+\}/g, token);
  const escaped = replaced.replace(/([.+^$|()[\]\\])/g, "\\$1");
  const withParams = escaped.replace(new RegExp(token, "g"), "[^/]+");
  return new RegExp(`^${withParams}$`);
};

const resolveOperationForRequest = (spec: any, method: string, urlOrPath: string): any => {
  const paths = spec?.paths ?? {};
  const pathValue = resolveRequestPath(urlOrPath);
  if (!pathValue) return undefined;
  const target = pathValue.split("?")[0];
  const lower = method.toLowerCase();
  for (const [specPath, entry] of Object.entries(paths)) {
    const specPattern = String(specPath);
    const regex = buildPathRegex(specPattern);
    if (!regex.test(target)) continue;
    const operation = (entry as any)?.[lower];
    if (operation) return operation;
  }
  return undefined;
};

const resolveResponseSchema = (spec: any, operation: any, status: number): any => {
  const responses = operation?.responses ?? {};
  const statusKey = String(status);
  const direct = responses[statusKey];
  const successKey = Object.keys(responses).find((code) => /^2\d\d$/.test(code));
  const response = direct ?? (successKey ? responses[successKey] : responses.default);
  if (!response) return undefined;
  const content = response.content ?? {};
  const jsonContent =
    content["application/json"] ??
    content["application/*+json"] ??
    Object.values(content)[0];
  return jsonContent?.schema;
};

const resolveSchemaType = (schema: any): string | undefined => {
  if (!schema || typeof schema !== "object") return undefined;
  if (schema.type) {
    if (Array.isArray(schema.type)) {
      return schema.type.find((entry: string) => entry !== "null") ?? schema.type[0];
    }
    return schema.type;
  }
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return undefined;
};

const collectSchemaIssues = (
  spec: any,
  rawSchema: any,
  value: unknown,
  path: string = "$",
  depth = 0,
): string[] => {
  if (depth > 4) return [];
  if (!rawSchema || typeof rawSchema !== "object") return [];
  const schema = pickSchemaVariant(resolveSchemaRef(spec, rawSchema));
  if (!schema || typeof schema !== "object") return [];
  const nullable = schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes("null"));
  if (value === null) {
    return nullable ? [] : [`${path} is null but schema requires non-null`];
  }
  const schemaType = resolveSchemaType(schema);
  if (schemaType === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [`${path} expected object`];
    }
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    const issues: string[] = [];
    for (const key of required) {
      if (!(key in (value as Record<string, unknown>))) {
        issues.push(`${path}.${key} is required`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value as Record<string, unknown>, key)) {
        const childValue = (value as Record<string, unknown>)[key];
        issues.push(...collectSchemaIssues(spec, childSchema, childValue, `${path}.${key}`, depth + 1));
      }
    }
    return issues;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value)) return [`${path} expected array`];
    if (schema.items && value.length) {
      const limit = Math.min(value.length, 3);
      const issues: string[] = [];
      for (let index = 0; index < limit; index += 1) {
        issues.push(...collectSchemaIssues(spec, schema.items, value[index], `${path}[${index}]`, depth + 1));
      }
      return issues;
    }
    return [];
  }
  if (schemaType === "string" && typeof value !== "string") {
    return [`${path} expected string`];
  }
  if (schemaType === "number" && typeof value !== "number") {
    return [`${path} expected number`];
  }
  if (schemaType === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
    return [`${path} expected integer`];
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    return [`${path} expected boolean`];
  }
  return [];
};

const matchesSubset = (expected: unknown, actual: unknown): boolean => {
  if (expected === actual) return true;
  if (expected === null || typeof expected !== "object") return expected === actual;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((value, index) => matchesSubset(value, (actual as unknown[])[index]));
  }
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    matchesSubset(value, (actual as Record<string, unknown>)[key]),
  );
};

export class QaApiRunner {
  constructor(
    private workspaceRoot: string,
    private options: { timeoutMs?: number } = {},
  ) {}

  private async readPackageJson(): Promise<Record<string, any> | undefined> {
    const pkgPath = path.join(this.workspaceRoot, "package.json");
    try {
      const raw = await fs.readFile(pkgPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  async resolveBaseUrl(options: {
    planBaseUrl?: string;
    planBrowserBaseUrl?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<string> {
    const env = options.env ?? process.env;
    const candidates = [
      options.planBaseUrl,
      options.planBrowserBaseUrl,
      env.MCODA_QA_API_BASE_URL,
      env.MCODA_API_BASE_URL,
      env.API_BASE_URL,
      env.BASE_URL,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const normalized = normalizeBaseUrl(candidate);
      if (normalized) return normalized;
    }
    const pkg = await this.readPackageJson();
    const script = pkg?.scripts?.dev ?? pkg?.scripts?.start ?? pkg?.scripts?.serve;
    if (typeof script === "string") {
      const port = extractPort(script) ?? inferPort(script);
      if (port) return `http://${DEFAULT_API_HOST}:${port}`;
    }
    return `http://${DEFAULT_API_HOST}:${DEFAULT_API_PORT}`;
  }

  private async loadOpenApiSpec(): Promise<any | undefined> {
    const candidates = [
      path.join(this.workspaceRoot, "openapi", "mcoda.yaml"),
      path.join(this.workspaceRoot, "openapi", "mcoda.yml"),
      path.join(this.workspaceRoot, "openapi", "mcoda.json"),
      path.join(this.workspaceRoot, "openapi.yaml"),
      path.join(this.workspaceRoot, "openapi.yml"),
      path.join(this.workspaceRoot, "openapi.json"),
    ];
    for (const candidate of candidates) {
      try {
        const raw = await fs.readFile(candidate, "utf8");
        if (candidate.endsWith(".json")) {
          return JSON.parse(raw);
        }
        return YAML.parse(raw);
      } catch {
        // try next
      }
    }
    return undefined;
  }

  private buildDefaultRequestsFromSpec(spec: any): QaApiRequest[] {
    if (!spec || typeof spec !== "object") return [];
    const paths = spec.paths ?? {};
    const requests: QaApiRequest[] = [];
    if (paths["/health"]) {
      requests.push({ method: "GET", path: "/health", expect: { status: 200 } });
    } else if (paths["/healthz"]) {
      requests.push({ method: "GET", path: "/healthz", expect: { status: 200 } });
    }

    let loginAdded = false;
    for (const [pathKey, methods] of Object.entries(paths)) {
      const normalizedPath = String(pathKey);
      if (!/login|auth/i.test(normalizedPath)) continue;
      const op = (methods as any)?.post ?? (methods as any)?.put;
      if (!op) continue;
      const body = buildRequestBody(spec, op);
      const status = resolveSuccessStatus(op.responses);
      const fallbackBody = body ?? {
        email: "{{QA_SAMPLE_EMAIL}}",
        password: "{{QA_SAMPLE_PASSWORD}}",
      };
      requests.push({
        method: (methods as any)?.post ? "POST" : "PUT",
        path: normalizedPath,
        body: fallbackBody,
        expect: { status },
      });
      loginAdded = true;
      break;
    }

    for (const [pathKey, methods] of Object.entries(paths)) {
      const normalizedPath = String(pathKey);
      if (normalizedPath.includes("{")) continue;
      const op = (methods as any)?.get;
      if (!op) continue;
      const params = Array.isArray(op.parameters) ? op.parameters : [];
      const requiredParams = params.filter((param: any) => param?.required);
      if (requiredParams.length) continue;
      const status = resolveSuccessStatus(op.responses);
      requests.push({ method: "GET", path: normalizedPath, expect: { status } });
      break;
    }

    const unique: QaApiRequest[] = [];
    const seen = new Set<string>();
    for (const req of requests) {
      const key = `${req.method ?? "GET"}:${req.path ?? req.url ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(req);
    }
    return unique.slice(0, loginAdded ? 3 : 2);
  }

  async suggestDefaultRequests(): Promise<QaApiRequest[]> {
    const spec = await this.loadOpenApiSpec();
    const fromSpec = this.buildDefaultRequestsFromSpec(spec);
    if (fromSpec.length) return fromSpec;
    return [{ method: "GET", path: "/health", expect: { status: 200 } }];
  }

  async hasOpenApiSpec(): Promise<boolean> {
    const spec = await this.loadOpenApiSpec();
    return !!(spec && typeof spec === "object" && (spec as any).paths);
  }

  private async persistResults(
    artifactDir: string | undefined,
    results: ApiRequestResult[],
  ): Promise<string[]> {
    if (!artifactDir) return [];
    await fs.mkdir(artifactDir, { recursive: true });
    const filePath = path.join(artifactDir, "api-results.json");
    const payload = {
      generatedAt: new Date().toISOString(),
      results,
    };
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    return [path.relative(this.workspaceRoot, filePath)];
  }

  private buildRequestUrl(request: QaApiRequest, baseUrl: string): string | undefined {
    if (request.url) {
      return normalizeBaseUrl(request.url) ?? request.url;
    }
    if (!request.path) return undefined;
    try {
      return new URL(request.path, baseUrl).toString();
    } catch {
      return undefined;
    }
  }

  async run(params: {
    baseUrl: string;
    requests: QaApiRequest[];
    env?: NodeJS.ProcessEnv;
    artifactDir?: string;
  }): Promise<QaRunResult> {
    const startedAt = new Date().toISOString();
    if (!params.requests.length) {
      const finishedAt = new Date().toISOString();
      return {
        outcome: "pass",
        exitCode: 0,
        stdout: "No API requests to execute.",
        stderr: "",
        artifacts: [],
        startedAt,
        finishedAt,
      };
    }
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const spec = await this.loadOpenApiSpec();
    const results: ApiRequestResult[] = [];
    const stdoutLines: string[] = [`Base URL: ${params.baseUrl}`];
    const stderrLines: string[] = [];
    let hasInfra = false;
    let hasFailure = false;

    const env = params.env ?? process.env;
    const placeholderMap = buildSamplePlaceholderMap(env);
    const authState: { bearerToken?: string; cookie?: string } = {};
    if (placeholderMap.QA_SAMPLE_TOKEN) {
      authState.bearerToken = placeholderMap.QA_SAMPLE_TOKEN;
    }
    for (const request of params.requests) {
      const resolvedRequest = applySamplePlaceholders(request, placeholderMap) as QaApiRequest;
      const method = (resolvedRequest.method ?? "GET").toUpperCase();
      const url = this.buildRequestUrl(resolvedRequest, params.baseUrl);
      const operation = spec ? resolveOperationForRequest(spec, method, url ?? resolvedRequest.path ?? "") : undefined;
      const start = Date.now();
      if (!url) {
        hasInfra = true;
        const message = `Missing URL/path for API request (${method}).`;
        stderrLines.push(message);
        results.push({
          id: request.id,
          method,
          url: "",
          ok: false,
          durationMs: 0,
          error: message,
        });
        continue;
      }
      const headers: Record<string, string> = {
        accept: "application/json",
        ...(resolvedRequest.headers ?? {}),
      };
      const headerKeys = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
      if (authState.bearerToken && !headerKeys.has("authorization")) {
        headers.authorization = `Bearer ${authState.bearerToken}`;
        headerKeys.add("authorization");
      }
      if (authState.cookie && !headerKeys.has("cookie")) {
        headers.cookie = authState.cookie;
      }
      let body: string | undefined;
      if (resolvedRequest.body !== undefined && resolvedRequest.body !== null && method !== "GET") {
        if (typeof resolvedRequest.body === "string") {
          body = resolvedRequest.body;
        } else {
          body = JSON.stringify(resolvedRequest.body);
          if (!headers["content-type"]) headers["content-type"] = "application/json";
        }
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
        const responseText = await response.text();
        const durationMs = Date.now() - start;
        const expectations: string[] = [];
        let ok = true;
        const contentType = response.headers.get("content-type") ?? "";
        let json: unknown = undefined;
        if (
          contentType.includes("application/json") ||
          request.expect?.json_contains ||
          (spec && operation)
        ) {
          try {
            json = JSON.parse(responseText);
          } catch {
            json = undefined;
          }
        }
        if (request.expect?.status && response.status !== request.expect.status) {
          ok = false;
          expectations.push(`Expected status ${request.expect.status}, got ${response.status}.`);
        }
        if (request.expect?.text_includes?.length) {
          for (const token of request.expect.text_includes) {
            if (!responseText.includes(token)) {
              ok = false;
              expectations.push(`Expected response text to include "${token}".`);
            }
          }
        }
        if (request.expect?.json_contains) {
          if (json === undefined) {
            ok = false;
            expectations.push("Expected JSON body but response was not valid JSON.");
          } else if (!matchesSubset(request.expect.json_contains, json)) {
            ok = false;
            expectations.push("Expected JSON body to contain specified fields.");
          }
        }
        if (spec && operation) {
          const schema = resolveResponseSchema(spec, operation, response.status);
          if (schema) {
            if (json === undefined) {
              ok = false;
              expectations.push("Expected JSON response matching schema but response was not valid JSON.");
            } else {
              const schemaIssues = collectSchemaIssues(spec, schema, json);
              if (schemaIssues.length) {
                ok = false;
                expectations.push(...schemaIssues.slice(0, 3).map((issue) => `Schema: ${issue}`));
              }
            }
          }
        }
        const token = extractBearerToken(json ?? responseText);
        if (token) {
          authState.bearerToken = token;
        }
        const rawSetCookie =
          typeof (response.headers as any).getSetCookie === "function"
            ? (response.headers as any).getSetCookie()
            : response.headers.get("set-cookie");
        const cookieHeader = extractCookieHeader(rawSetCookie);
        if (cookieHeader) {
          authState.cookie = authState.cookie ? `${authState.cookie}; ${cookieHeader}` : cookieHeader;
        }
        results.push({
          id: request.id,
          method,
          url,
          status: response.status,
          ok,
          durationMs,
          expectations: expectations.length ? expectations : undefined,
          responseSnippet: responseText.slice(0, RESPONSE_SNIPPET_LIMIT),
        });
        stdoutLines.push(`${method} ${url} -> ${response.status} (${durationMs}ms) ${ok ? "ok" : "fail"}`);
        if (!ok) {
          hasFailure = true;
          stderrLines.push([`Request failed: ${method} ${url}`, ...expectations].join(" "));
        }
      } catch (error: any) {
        const durationMs = Date.now() - start;
        const message = error?.message ?? String(error);
        results.push({
          id: request.id,
          method,
          url,
          ok: false,
          durationMs,
          error: message,
        });
        hasInfra = true;
        stderrLines.push(`Request error: ${method} ${url} -> ${message}`);
      } finally {
        clearTimeout(timeout);
      }
    }

    const artifacts = await this.persistResults(params.artifactDir, results);
    const outcome = hasInfra ? "infra_issue" : hasFailure ? "fail" : "pass";
    const exitCode = outcome === "infra_issue" ? null : outcome === "pass" ? 0 : 1;
    const finishedAt = new Date().toISOString();
    return {
      outcome,
      exitCode,
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
      artifacts,
      startedAt,
      finishedAt,
    };
  }
}
