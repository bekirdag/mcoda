export type IntentBucket =
  | "ui"
  | "content"
  | "behavior"
  | "data"
  | "testing"
  | "infra"
  | "security"
  | "performance"
  | "observability";

export interface IntentSignals {
  intents: IntentBucket[];
  matches: Record<IntentBucket, string[]>;
}

const UI_KEYWORDS = [
  "ui",
  "ux",
  "page",
  "screen",
  "layout",
  "header",
  "hero",
  "navbar",
  "footer",
  "landing",
  "welcome",
  "title",
  "button",
  "style",
  "css",
  "html",
  "markup",
  "template",
  "component",
  "view",
];

const CONTENT_KEYWORDS = [
  "copy",
  "text",
  "label",
  "wording",
  "message",
  "string",
  "content",
];

const BEHAVIOR_KEYWORDS = [
  "logic",
  "behavior",
  "bug",
  "fix",
  "error",
  "crash",
  "api",
  "backend",
  "server",
  "endpoint",
  "route",
  "router",
  "handler",
  "healthz",
  "health",
  "logging",
  "logger",
  "uptime",
  "flow",
  "auth",
  "estimate",
  "estimation",
  "stats",
  "stat",
  "completion",
  "completions",
  "calculate",
  "computed",
  "compute",
  "count",
  "aggregate",
  "summary",
];

const DATA_KEYWORDS = [
  "schema",
  "database",
  "db",
  "model",
  "migration",
  "table",
  "field",
  "column",
  "sql",
];

const TESTING_KEYWORDS = [
  "test",
  "tests",
  "testing",
  "unit",
  "integration",
  "e2e",
  "spec",
  "specs",
  "snapshot",
  "snapshots",
  "golden",
  "approval",
  "assertion",
  "assertions",
  "jest",
  "vitest",
  "mocha",
  "pytest",
  "rspec",
  "junit",
  "xunit",
  "cypress",
  "playwright",
  "fixture",
  "fixtures",
  "mock",
  "mocking",
  "coverage",
];

const INFRA_BASE_KEYWORDS = [
  "infra",
  "infrastructure",
  "ops",
  "devops",
  "ci",
  "cd",
  "pipeline",
  "deploy",
  "deployment",
  "docker",
  "compose",
  "k8s",
  "kubernetes",
  "helm",
  "terraform",
  "ansible",
  "makefile",
  "workflow",
  "runner",
  "github actions",
  "gitlab",
  "gitlab ci",
  "circleci",
  "artifact",
  "registry",
];

const INFRA_CONDITIONAL_KEYWORDS = ["build", "release", "package"];

const SECURITY_KEYWORDS = [
  "security",
  "secure",
  "auth",
  "authentication",
  "authorization",
  "permission",
  "permissions",
  "rbac",
  "acl",
  "policy",
  "jwt",
  "oauth",
  "sso",
  "csrf",
  "xss",
  "samesite",
  "csp",
  "encrypt",
  "encryption",
  "crypto",
  "secret",
  "secrets",
  "vault",
  "audit",
  "vulnerability",
  "sanitize",
];

const PERFORMANCE_KEYWORDS = [
  "performance",
  "perf",
  "slow",
  "slowdown",
  "latency",
  "throughput",
  "optimize",
  "optimization",
  "cache",
  "caching",
  "cache miss",
  "memo",
  "benchmark",
  "profiling",
  "profile",
  "hot path",
  "n+1",
  "memory",
  "cpu",
  "throttle",
  "rate limit",
  "rate-limit",
  "batch",
  "queue",
  "timeout",
];

const OBSERVABILITY_KEYWORDS = [
  "observability",
  "telemetry",
  "instrument",
  "instrumentation",
  "logging",
  "log",
  "logger",
  "log level",
  "structured logging",
  "metrics",
  "monitor",
  "monitoring",
  "trace",
  "tracing",
  "trace id",
  "span",
  "otel",
  "opentelemetry",
  "sentry",
  "datadog",
  "prometheus",
  "grafana",
  "alert",
  "alerts",
];

const OBSERVABILITY_LOGGING_ONLY = new Set([
  "logging",
  "log",
  "logger",
  "log level",
  "structured logging",
]);

const normalize = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9\\s]/g, " ");

const collectMatches = (text: string, keywords: string[]): string[] => {
  const matches: string[] = [];
  for (const keyword of keywords) {
    if (text.includes(keyword)) matches.push(keyword);
  }
  return matches;
};

export const deriveIntentSignals = (request: string): IntentSignals => {
  const normalized = normalize(request ?? "");
  const uiMatches = collectMatches(normalized, UI_KEYWORDS);
  const contentMatches = collectMatches(normalized, CONTENT_KEYWORDS);
  const behaviorMatches = collectMatches(normalized, BEHAVIOR_KEYWORDS);
  const dataMatches = collectMatches(normalized, DATA_KEYWORDS);
  const testingMatches = collectMatches(normalized, TESTING_KEYWORDS);
  const infraBaseMatches = collectMatches(normalized, INFRA_BASE_KEYWORDS);
  const infraConditionalMatches = collectMatches(normalized, INFRA_CONDITIONAL_KEYWORDS);
  const infraMatches =
    infraBaseMatches.length > 0
      ? [...infraBaseMatches, ...infraConditionalMatches]
      : infraBaseMatches;
  const securityMatches = collectMatches(normalized, SECURITY_KEYWORDS);
  const performanceMatches = collectMatches(normalized, PERFORMANCE_KEYWORDS);
  const observabilityMatches = collectMatches(normalized, OBSERVABILITY_KEYWORDS);
  const observabilityHasSignal = observabilityMatches.some(
    (match) => !OBSERVABILITY_LOGGING_ONLY.has(match),
  );
  const observabilityFinal = observabilityHasSignal ? observabilityMatches : [];

  const intents: IntentBucket[] = [];
  if (uiMatches.length) intents.push("ui");
  if (contentMatches.length) intents.push("content");
  if (behaviorMatches.length) intents.push("behavior");
  if (dataMatches.length) intents.push("data");
  if (testingMatches.length) intents.push("testing");
  if (infraMatches.length) intents.push("infra");
  if (securityMatches.length) intents.push("security");
  if (performanceMatches.length) intents.push("performance");
  if (observabilityFinal.length) intents.push("observability");

  if (intents.length === 0) {
    intents.push("behavior");
  }

  return {
    intents,
    matches: {
      ui: uiMatches,
      content: contentMatches,
      behavior: behaviorMatches,
      data: dataMatches,
      testing: testingMatches,
      infra: infraMatches,
      security: securityMatches,
      performance: performanceMatches,
      observability: observabilityFinal,
    },
  };
};
