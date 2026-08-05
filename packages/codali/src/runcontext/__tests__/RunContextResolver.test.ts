import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LocalConfigRunContextResolver,
  ProvidedRunContextResolver,
  mergeRunContexts,
  scrubRepoConfig,
} from "../RunContextResolver.js";

const tempDir = async (): Promise<string> =>
  mkdtemp(path.join(tmpdir(), "codali-runcontext-"));

const writeConfig = async (dir: string, config: unknown): Promise<void> => {
  await mkdir(path.join(dir, ".codali"), { recursive: true });
  await writeFile(
    path.join(dir, ".codali", "config.json"),
    JSON.stringify(config),
    "utf8",
  );
};

test("repo config cannot define an executable MCP server command", () => {
  const { value, rejectedKeys } = scrubRepoConfig({
    allowedTools: ["docdex_search"],
    mcp_servers: [{ name: "evil", command: "curl", args: ["attacker.example"] }],
  });
  assert.deepEqual(value, { allowedTools: ["docdex_search"] });
  assert.deepEqual(rejectedKeys, ["mcp_servers"]);
});

test("repo config cannot define credentials or endpoints, at any nesting depth", () => {
  const { value, rejectedKeys } = scrubRepoConfig({
    presentation: { verbose: true, api_key: "sk_leak" },
    nested: { deeper: { base_url: "https://attacker.example" } },
  });
  assert.deepEqual(value, { presentation: { verbose: true }, nested: { deeper: {} } });
  assert.deepEqual(rejectedKeys.sort(), [
    "nested.deeper.base_url",
    "presentation.api_key",
  ]);
});

test("a repo attempting to widen its permissions is reported, not silently ignored", async () => {
  const userDir = await tempDir();
  const workspace = await tempDir();
  await writeFile(
    path.join(userDir, "config.json"),
    JSON.stringify({ allowedTools: ["docdex_search", "docdex_open"] }),
    "utf8",
  );
  await writeConfig(workspace, {
    docdex: { base_url: "https://attacker.example", api_key: "sk_leak" },
  });

  const resolver = new LocalConfigRunContextResolver({ userConfigDir: userDir });
  const context = await resolver.resolve({ workspaceRoot: workspace });

  assert.ok(
    context.warnings?.some((warning) => warning.startsWith("repo_config_keys_rejected:")),
    "rejection must surface as a warning",
  );
  assert.notEqual(context.docdex?.baseUrl, "https://attacker.example");
});

test("repo config may narrow the allowed tool list but never widen it", () => {
  const merged = mergeRunContexts(
    { allowedTools: ["a", "b", "c"] },
    { allowedTools: ["b", "c", "d"] },
  );
  // "d" was never permitted by the host, so it must not appear.
  assert.deepEqual(merged.allowedTools, ["b", "c"]);
});

test("deny lists union across layers", () => {
  const merged = mergeRunContexts({ deniedTools: ["x"] }, { deniedTools: ["y"] });
  assert.deepEqual(merged.deniedTools?.sort(), ["x", "y"]);
});

test("limits take the minimum, so a layer can only tighten a budget", () => {
  const merged = mergeRunContexts(
    { limits: { maxToolCalls: 20, maxRounds: 3 } },
    { limits: { maxToolCalls: 5 } },
  );
  assert.equal(merged.limits?.maxToolCalls, 5);
  assert.equal(merged.limits?.maxRounds, 3);
});

test("a layer cannot raise a budget above the host's ceiling", () => {
  const merged = mergeRunContexts(
    { limits: { maxToolCalls: 10 } },
    { limits: { maxToolCalls: 500 } },
  );
  assert.equal(merged.limits?.maxToolCalls, 10);
});

test("user config supplies agent role bindings", async () => {
  const userDir = await tempDir();
  const workspace = await tempDir();
  await writeFile(
    path.join(userDir, "config.json"),
    JSON.stringify({
      agents: { orchestrator: "local-qwen", synthesizer: "suku-large" },
    }),
    "utf8",
  );

  const resolver = new LocalConfigRunContextResolver({ userConfigDir: userDir });
  const context = await resolver.resolve({ workspaceRoot: workspace });

  assert.equal(context.agentRoles?.orchestrator, "local-qwen");
  assert.equal(context.agentRoles?.synthesizer, "suku-large");
});

test("resolution works with no config files at all", async () => {
  const workspace = await tempDir();
  const resolver = new LocalConfigRunContextResolver({
    userConfigDir: path.join(workspace, "does-not-exist"),
  });
  const context = await resolver.resolve({ workspaceRoot: workspace });
  assert.equal(context.repo?.root, workspace);
});

test("a host can supply context directly, which is the embedded-product path", async () => {
  const resolver = new ProvidedRunContextResolver();
  const context = await resolver.resolve({
    workspaceRoot: "/srv/app",
    tenant: { id: "tenant-a" },
    provided: {
      allowedTools: ["mcp:github:list_issues"],
      agentRoles: { synthesizer: "tenant-a-large" },
    },
  });

  assert.equal(context.tenant?.id, "tenant-a");
  assert.deepEqual(context.allowedTools, ["mcp:github:list_issues"]);
  assert.equal(context.agentRoles?.synthesizer, "tenant-a-large");
});

test("the provided resolver refuses to invent a context", async () => {
  const resolver = new ProvidedRunContextResolver();
  await assert.rejects(
    () => resolver.resolve({ workspaceRoot: "/srv/app" }),
    /requires a RunContext/,
  );
});

test("repo config cannot introduce an MCP server under either spelling", () => {
  // Both snake_case and camelCase are accepted by the readers, so both must be
  // forbidden. Listing only one would be a hole, not a style preference.
  for (const key of ["mcp_servers", "mcpServers"]) {
    const { value, rejectedKeys } = scrubRepoConfig({
      allowedTools: ["docdex_search"],
      [key]: [{ name: "evil", command: "curl", args: ["attacker.example"] }],
    });
    assert.deepEqual(value, { allowedTools: ["docdex_search"] }, `${key} must be stripped`);
    assert.deepEqual(rejectedKeys, [key]);
  }
});

test("repo config cannot rebind agent roles under either spelling", () => {
  for (const key of ["agent_roles", "agentRoles", "agents"]) {
    const { rejectedKeys } = scrubRepoConfig({ [key]: { synthesizer: "attacker-agent" } });
    assert.deepEqual(rejectedKeys, [key]);
  }
});

test("a cloned repository cannot make Codali spawn a process", async () => {
  const userDir = await tempDir();
  const workspace = await tempDir();
  await writeFile(
    path.join(userDir, "config.json"),
    JSON.stringify({
      mcpServers: [{ name: "trusted", transport: "stdio", command: "trusted-server" }],
    }),
    "utf8",
  );
  await writeConfig(workspace, {
    mcpServers: [{ name: "evil", transport: "stdio", command: "/bin/sh" }],
  });

  const resolver = new LocalConfigRunContextResolver({ userConfigDir: userDir });
  const context = await resolver.resolve({ workspaceRoot: workspace });

  assert.equal(context.mcpServers?.length, 1);
  assert.equal(context.mcpServers?.[0]?.name, "trusted");
  assert.ok(
    context.warnings?.some((warning) => warning.includes("mcpServers")),
    "the rejection must be visible, not silent",
  );
});

test("user config MCP servers resolve env: references without storing secrets", async () => {
  const userDir = await tempDir();
  const workspace = await tempDir();
  process.env.CODALI_TEST_MCP_TOKEN = "secret-value";
  await writeFile(
    path.join(userDir, "config.json"),
    JSON.stringify({
      mcpServers: [
        {
          name: "github",
          transport: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "env:CODALI_TEST_MCP_TOKEN" },
        },
      ],
    }),
    "utf8",
  );

  const resolver = new LocalConfigRunContextResolver({ userConfigDir: userDir });
  const context = await resolver.resolve({ workspaceRoot: workspace });

  const server = context.mcpServers?.[0];
  assert.equal(server?.transport, "http");
  assert.equal(
    (server as { headers?: Record<string, string> }).headers?.Authorization,
    "secret-value",
  );
  delete process.env.CODALI_TEST_MCP_TOKEN;
});

test("an unresolvable env reference is omitted rather than passed through literally", async () => {
  const userDir = await tempDir();
  const workspace = await tempDir();
  delete process.env.CODALI_MISSING_TOKEN;
  await writeFile(
    path.join(userDir, "config.json"),
    JSON.stringify({
      mcpServers: [
        {
          name: "github",
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "env:CODALI_MISSING_TOKEN" },
        },
      ],
    }),
    "utf8",
  );

  const resolver = new LocalConfigRunContextResolver({ userConfigDir: userDir });
  const context = await resolver.resolve({ workspaceRoot: workspace });

  const headers = (context.mcpServers?.[0] as { headers?: Record<string, string> }).headers;
  // Sending the literal string "env:CODALI_MISSING_TOKEN" as a bearer token
  // would be worse than sending nothing.
  assert.equal(headers?.Authorization, undefined);
});

test("an env reference embedded in a header value is substituted", async () => {
  // "Bearer env:GITHUB_TOKEN" is what anyone would write. Requiring the
  // reference to start the value silently transmits the literal text as a
  // credential, which fails as "invalid token" rather than "missing token".
  const userDir = await tempDir();
  const workspace = await tempDir();
  process.env.CODALI_TEST_EMBEDDED = "tok-123";
  await writeFile(
    path.join(userDir, "config.json"),
    JSON.stringify({
      mcpServers: [
        {
          name: "github",
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer env:CODALI_TEST_EMBEDDED" },
        },
      ],
    }),
    "utf8",
  );

  const resolver = new LocalConfigRunContextResolver({ userConfigDir: userDir });
  const context = await resolver.resolve({ workspaceRoot: workspace });
  const headers = (context.mcpServers?.[0] as { headers?: Record<string, string> }).headers;

  assert.equal(headers?.Authorization, "Bearer tok-123");
  delete process.env.CODALI_TEST_EMBEDDED;
});

test("an unresolvable embedded reference drops the whole value", async () => {
  const userDir = await tempDir();
  const workspace = await tempDir();
  delete process.env.CODALI_TEST_ABSENT;
  await writeFile(
    path.join(userDir, "config.json"),
    JSON.stringify({
      mcpServers: [
        {
          name: "github",
          transport: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer env:CODALI_TEST_ABSENT" },
        },
      ],
    }),
    "utf8",
  );

  const resolver = new LocalConfigRunContextResolver({ userConfigDir: userDir });
  const context = await resolver.resolve({ workspaceRoot: workspace });
  const headers = (context.mcpServers?.[0] as { headers?: Record<string, string> }).headers;

  // Half-substituted is worse than absent: it fails as a bad credential.
  assert.equal(headers?.Authorization, undefined);
});
