import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextAssembler } from "../ContextAssembler.js";
import { ContextManager } from "../ContextManager.js";
import { ContextStore } from "../ContextStore.js";
import type { DocdexClient } from "../../docdex/DocdexClient.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import type { LocalContextConfig } from "../Types.js";

class FakeDocdexClient {
  lastProfileAgentId?: string;
  impactGraphCalls: string[] = [];
  impactDiagnosticsCalls: string[] = [];
  treeCalls: unknown[] = [];
  constructor(private impactDiagnosticsPayload: unknown = { diagnostics: [] }) {}
  getRepoId(): string | undefined {
    return undefined;
  }

  getRepoRoot(): string | undefined {
    return "/repo";
  }

  async initialize(): Promise<unknown> {
    return { repoId: "repo-id" };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async stats(): Promise<unknown> {
    return { last_updated_epoch_ms: 123, num_docs: 10 };
  }

  async files(): Promise<unknown> {
    return { results: [] };
  }

  async tree(options?: unknown): Promise<unknown> {
    this.treeCalls.push(options);
    return {
      tree: "repo\n└── src\n    └── index.ts",
    };
  }

  async search(): Promise<unknown> {
    return { hits: [{ doc_id: "doc-1", path: "src/index.ts" }] };
  }

  async openSnippet(): Promise<unknown> {
    return "snippet-content";
  }

  async openFile(pathValue: string): Promise<unknown> {
    return { content: `open-file:${pathValue}` };
  }

  async symbols(): Promise<unknown> {
    return { symbols: ["sym"] };
  }

  async ast(): Promise<unknown> {
    return { nodes: ["node"] };
  }

  async impactGraph(): Promise<unknown> {
    this.impactGraphCalls.push("last");
    return { inbound: [], outbound: [] };
  }

  async impactDiagnostics(): Promise<unknown> {
    this.impactDiagnosticsCalls.push("last");
    return this.impactDiagnosticsPayload;
  }

  async memoryRecall(): Promise<unknown> {
    return { results: [{ content: "src/index.ts is the primary file for formatting changes." }] };
  }

  async getProfile(agentId?: string): Promise<unknown> {
    this.lastProfileAgentId = agentId;
    return { preferences: [{ content: "use async/await" }] };
  }
}

class EmptySearchDocdexClient extends FakeDocdexClient {
  async files(): Promise<unknown> {
    return { results: [] };
  }

  async search(): Promise<unknown> {
    return { hits: [] };
  }
}

class StubProvider implements Provider {
  name = "stub";
  constructor(private response: ProviderResponse) {}

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return this.response;
  }
}

const makeLocalConfig = (overrides: Partial<LocalContextConfig> = {}): LocalContextConfig => ({
  enabled: true,
  storageDir: "codali/context",
  persistToolMessages: false,
  maxMessages: 200,
  maxBytesPerLane: 200_000,
  modelTokenLimits: {},
  summarize: {
    enabled: false,
    provider: "librarian",
    model: "gemma2:2b",
    targetTokens: 1200,
    thresholdPct: 0.9,
  },
  ...overrides,
});

test("ContextAssembler builds a complete context bundle", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const foo = 1;", "utf8");
  const client = new FakeDocdexClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, { maxQueries: 2, workspaceRoot: tmpDir, readStrategy: "fs" });
  const bundle = await assembler.assemble("Update src/index.ts formatting");

  assert.equal(bundle.request, "Update src/index.ts formatting");
  assert.ok(bundle.queries.length >= 1);
  assert.equal(bundle.snippets[0]?.content, "snippet-content");
  assert.equal(bundle.symbols[0]?.path, "src/index.ts");
  assert.equal(bundle.ast[0]?.path, "src/index.ts");
  assert.equal(bundle.index.last_updated_epoch_ms, 123);
  assert.equal(bundle.index.num_docs, 10);
  assert.equal(bundle.impact_diagnostics.length, 1);
  assert.ok(bundle.search_results && bundle.search_results.length > 0);
  assert.equal(bundle.project_info?.workspace_root, tmpDir);
  assert.ok(bundle.selection?.focus.includes("src/index.ts"));
  assert.ok(bundle.allow_write_paths?.includes("src/index.ts"));
  assert.match(bundle.repo_map ?? "", /index\.ts/);
  assert.match(bundle.repo_map_raw ?? "", /index\.ts/);
  assert.equal(bundle.preferences_detected.length, 0);
  assert.equal(bundle.memory[0]?.text, "src/index.ts is the primary file for formatting changes.");
  assert.equal(bundle.profile[0]?.content, "use async/await");
});

test("ContextAssembler always includes full repo tree when repo map is enabled", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-tree-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const x = 1;", "utf8");
  const client = new FakeDocdexClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, {
    includeRepoMap: true,
    workspaceRoot: tmpDir,
    readStrategy: "fs",
  });
  const bundle = await assembler.assemble("Update src/index.ts formatting");

  const fake = client as unknown as FakeDocdexClient;
  assert.equal(fake.treeCalls.length, 1);
  assert.deepEqual(fake.treeCalls[0], { includeHidden: true });
  assert.match(bundle.repo_map ?? "", /repo/);
  assert.match(bundle.repo_map_raw ?? "", /repo/);
});

test("ContextAssembler does not fall back to partial symbol repo map when tree fails", { concurrency: false }, async () => {
  class TreeFailClient extends FakeDocdexClient {
    async tree(): Promise<unknown> {
      throw new Error("tree failed");
    }
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-tree-fail-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const x = 1;", "utf8");
  const client = new TreeFailClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, {
    includeRepoMap: true,
    workspaceRoot: tmpDir,
    readStrategy: "fs",
  });
  const bundle = await assembler.assemble("Update src/index.ts formatting");

  assert.equal(bundle.repo_map, undefined);
  assert.ok(bundle.warnings.includes("docdex_tree_failed"));
});

test("ContextAssembler warns on impact_graph_sparse when diagnostics present", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const foo = 1;", "utf8");
  const client = new FakeDocdexClient({ diagnostics: ["missing import"] }) as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, { maxQueries: 2, workspaceRoot: tmpDir, readStrategy: "fs" });
  const bundle = await assembler.assemble("Update src/index.ts formatting");

  assert.ok(bundle.warnings.some((warning) => warning.startsWith("impact_graph_sparse")));
});

test("ContextAssembler does not warn when diagnostics are empty", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const foo = 1;", "utf8");
  const client = new FakeDocdexClient({ diagnostics: [] }) as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, { maxQueries: 2, workspaceRoot: tmpDir, readStrategy: "fs" });
  const bundle = await assembler.assemble("Update src/index.ts formatting");

  assert.ok(!bundle.warnings.some((warning) => warning.startsWith("impact_graph_sparse")));
});

test("ContextAssembler supplies a default agent id for profile lookup", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-profile-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const x = 1;", "utf8");
  const client = new FakeDocdexClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, { workspaceRoot: tmpDir, readStrategy: "fs" });
  await assembler.assemble("Check profile defaults");
  assert.equal((client as unknown as FakeDocdexClient).lastProfileAgentId, "codali");
});

test("ContextAssembler skips impact graph for unsupported files", { concurrency: false }, async () => {
  const client = new FakeDocdexClient() as unknown as DocdexClient;
  (client as unknown as FakeDocdexClient).impactGraphCalls = [];
  (client as unknown as FakeDocdexClient).impactDiagnosticsCalls = [];
  (client as unknown as FakeDocdexClient).search = async (): Promise<unknown> => ({
    hits: [{ doc_id: "doc-1", path: "docs/readme.md" }],
  });
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
  writeFileSync(path.join(tmpDir, "docs/readme.md"), "Hello", "utf8");
  const assembler = new ContextAssembler(client, { maxQueries: 1, workspaceRoot: tmpDir, readStrategy: "fs" });
  const bundle = await assembler.assemble("Update readme");
  assert.ok(!bundle.warnings.some((warning) => warning.startsWith("impact_graph_sparse")));
  assert.equal((client as unknown as FakeDocdexClient).impactGraphCalls.length, 0);
});

test("ContextAssembler keeps protected paths read-only even when focused", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const foo = 1;", "utf8");
  const client = new FakeDocdexClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, {
    maxQueries: 2,
    workspaceRoot: tmpDir,
    readStrategy: "fs",
    readOnlyPaths: ["src/index.ts"],
    allowDocEdits: false,
  });
  const bundle = await assembler.assemble("Update src/index.ts formatting");
  assert.ok(bundle.selection?.focus.includes("src/index.ts"));
  assert.ok(bundle.read_only_paths?.includes("src/index.ts"));
  assert.ok(!bundle.allow_write_paths?.includes("src/index.ts"));
});

test("ContextAssembler allows doc focus writes for doc tasks", { concurrency: false }, async () => {
  const client = new FakeDocdexClient() as unknown as DocdexClient;
  (client as unknown as FakeDocdexClient).search = async (): Promise<unknown> => ({
    hits: [{ doc_id: "doc-1", path: "docs/readme.md" }],
  });
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
  writeFileSync(path.join(tmpDir, "docs/readme.md"), "Hello", "utf8");
  const assembler = new ContextAssembler(client, {
    maxQueries: 1,
    workspaceRoot: tmpDir,
    readStrategy: "fs",
    allowDocEdits: false,
  });
  const bundle = await assembler.assemble("Update documentation");
  assert.ok(bundle.selection?.focus.includes("docs/readme.md"));
  assert.ok(bundle.allow_write_paths?.includes("docs/readme.md"));
  assert.ok(!bundle.warnings.includes("write_policy_blocks_focus"));
});

test("ContextAssembler skips docdex search when preferred files are provided", { concurrency: false }, async () => {
  class NoSearchClient extends FakeDocdexClient {
    async search(): Promise<unknown> {
      throw new Error("search should not be called");
    }
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const foo = 1;", "utf8");
  const client = new NoSearchClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, {
    workspaceRoot: tmpDir,
    readStrategy: "fs",
    preferredFiles: ["src/index.ts"],
    skipSearchWhenPreferred: true,
  });
  const bundle = await assembler.assemble("Update src/index.ts formatting");
  assert.ok(bundle.warnings.includes("docdex_search_skipped"));
  assert.ok(!bundle.warnings.includes("docdex_no_hits"));
  assert.ok(bundle.selection?.focus.includes("src/index.ts"));
});

test("ContextAssembler infers HTML focus when request targets root page", { concurrency: false }, async () => {
  class HtmlHintClient extends FakeDocdexClient {
    async files(): Promise<unknown> {
      return {
        results: [
          { rel_path: "src/public/index.html" },
          { rel_path: "docs/rfp.md" },
        ],
      };
    }

    async search(): Promise<unknown> {
      return { hits: [{ doc_id: "doc-1", path: "docs/rfp.md" }] };
    }
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "src/public"), { recursive: true });
  mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
  writeFileSync(
    path.join(tmpDir, "src/public/index.html"),
    "<h1>Welcome</h1>",
    "utf8",
  );
  writeFileSync(path.join(tmpDir, "docs/rfp.md"), "RFP", "utf8");
  const client = new HtmlHintClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, {
    maxQueries: 2,
    workspaceRoot: tmpDir,
    readStrategy: "fs",
  });
  const bundle = await assembler.assemble(
    "Add a visible Welcome header to the root page. Only touch HTML.",
  );

  assert.ok(bundle.selection?.focus.includes("src/public/index.html"));
  assert.ok(bundle.allow_write_paths?.includes("src/public/index.html"));
});

test("ContextAssembler expands queries with provider when available", { concurrency: false }, async () => {
  class NoHitClient extends FakeDocdexClient {
    async search(): Promise<unknown> {
      return { hits: [] };
    }
  }
  const client = new NoHitClient() as unknown as DocdexClient;
  const provider = new StubProvider({
    message: { role: "assistant", content: JSON.stringify({ queries: ["auth", "login"] }) },
  });
  const assembler = new ContextAssembler(client, { maxQueries: 2, queryProvider: provider });
  const bundle = await assembler.assemble("Update login flow");
  assert.ok(bundle.queries.includes("Update login flow"));
  assert.ok(bundle.queries.length <= 2);
});

test("ContextAssembler uses ephemeral lane for query expansion when context manager provided", { concurrency: false }, async () => {
  class NoHitClient extends FakeDocdexClient {
    async search(): Promise<unknown> {
      return { hits: [] };
    }
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  const client = new NoHitClient() as unknown as DocdexClient;
  const provider = new StubProvider({
    message: { role: "assistant", content: JSON.stringify({ queries: ["auth", "login"] }) },
  });
  const store = new ContextStore({ workspaceRoot: tmpDir, storageDir: "codali/context" });
  const contextManager = new ContextManager({ config: makeLocalConfig(), store });
  const assembler = new ContextAssembler(client, {
    maxQueries: 2,
    queryProvider: provider,
    contextManager,
    laneScope: { jobId: "job-q", taskId: "task-q" },
  });
  await assembler.assemble("Update login flow");
  const lane = await contextManager.getLane({
    jobId: "job-q",
    taskId: "task-q",
    role: "librarian",
    ephemeral: true,
  });
  assert.ok(lane.messages.length >= 2);
});

test("ContextAssembler warns when index is empty", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-index-"));
  const client = {
    getRepoId() {
      return undefined;
    },
    getRepoRoot() {
      return "/repo";
    },
    async initialize() {
      return { repoId: "repo-id" };
    },
    async healthCheck() {
      return true;
    },
    async stats() {
      return { last_updated_epoch_ms: 0, num_docs: 0 };
    },
    async files() {
      return { results: [] };
    },
    async search() {
      return { hits: [] };
    },
    async openSnippet() {
      return "";
    },
    async symbols() {
      return {};
    },
    async ast() {
      return { nodes: [] };
    },
    async impactGraph() {
      return { inbound: [], outbound: [] };
    },
    async impactDiagnostics() {
      return { diagnostics: [] };
    },
    async memoryRecall() {
      return { results: [] };
    },
    async getProfile() {
      return { preferences: [] };
    },
  } as unknown as DocdexClient;

  const assembler = new ContextAssembler(client, { maxQueries: 1, workspaceRoot: tmpDir });
  const bundle = await assembler.assemble("Check indexing");
  assert.ok(bundle.warnings.includes("docdex_index_empty"));
  assert.ok(bundle.warnings.includes("docdex_index_stale"));
});

test("ContextAssembler suppresses index-empty warning when snippet evidence exists", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-index-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const foo = 1;", "utf8");
  const client = {
    getRepoId() {
      return undefined;
    },
    getRepoRoot() {
      return "/repo";
    },
    async initialize() {
      return { repoId: "repo-id" };
    },
    async healthCheck() {
      return true;
    },
    async stats() {
      return { last_updated_epoch_ms: 0, num_docs: 0 };
    },
    async files() {
      return { results: [] };
    },
    async search() {
      return { hits: [{ doc_id: "doc-1", path: "src/index.ts" }] };
    },
    async openSnippet() {
      return "snippet-content";
    },
    async symbols() {
      return { symbols: ["sym"] };
    },
    async ast() {
      return { nodes: ["node"] };
    },
    async impactGraph() {
      return { inbound: [], outbound: [] };
    },
    async impactDiagnostics() {
      return { diagnostics: [] };
    },
    async memoryRecall() {
      return { results: [] };
    },
    async getProfile() {
      return { preferences: [] };
    },
  } as unknown as DocdexClient;

  const assembler = new ContextAssembler(client, { maxQueries: 1, workspaceRoot: tmpDir });
  const bundle = await assembler.assemble("Check indexing");
  assert.ok(!bundle.warnings.includes("docdex_index_empty"));
});

test("ContextAssembler does not mark index empty when stats fail", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-index-"));
  const client = {
    getRepoId() {
      return undefined;
    },
    getRepoRoot() {
      return "/repo";
    },
    async initialize() {
      return { repoId: "repo-id" };
    },
    async healthCheck() {
      return true;
    },
    async stats() {
      throw new Error("stats unavailable");
    },
    async files() {
      return { results: [] };
    },
    async search() {
      return { hits: [] };
    },
    async openSnippet() {
      return "";
    },
    async symbols() {
      return {};
    },
    async ast() {
      return { nodes: [] };
    },
    async impactGraph() {
      return { inbound: [], outbound: [] };
    },
    async impactDiagnostics() {
      return { diagnostics: [] };
    },
    async memoryRecall() {
      return { results: [] };
    },
    async getProfile() {
      return { preferences: [] };
    },
  } as unknown as DocdexClient;

  const assembler = new ContextAssembler(client, { maxQueries: 1, workspaceRoot: tmpDir });
  const bundle = await assembler.assemble("Check indexing");
  assert.ok(bundle.warnings.includes("docdex_stats_failed"));
  assert.ok(!bundle.warnings.includes("docdex_index_empty"));
  assert.ok(!bundle.warnings.includes("docdex_index_stale"));
});

test("ContextAssembler falls back to workspace enumeration on low confidence", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-fallback-"));
  mkdirSync(path.join(tmpDir, "src/public"), { recursive: true });
  writeFileSync(
    path.join(tmpDir, "src/public/index.html"),
    "<html><body><h1>Welcome</h1></body></html>",
    "utf8",
  );
  const client = new EmptySearchDocdexClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, { maxQueries: 2, workspaceRoot: tmpDir, readStrategy: "fs" });
  const bundle = await assembler.assemble("Add a welcome header to the page");

  assert.ok(bundle.selection?.all.includes("src/public/index.html"));
  assert.ok(!bundle.warnings.includes("docdex_ui_no_hits"));
});

test("ContextAssembler prunes contradictory memory facts", { concurrency: false }, async () => {
  class ContradictoryMemoryClient extends FakeDocdexClient {
    async memoryRecall(): Promise<unknown> {
      return {
        results: [
          {
            content:
              "src/public/index.html already has a visible Welcome header at the top of main content.",
            score: 0.92,
          },
          {
            content:
              "src/public/index.html lacks a visible Welcome header in the root page content.",
            score: 0.71,
          },
        ],
      };
    }
  }

  const client = new ContradictoryMemoryClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, { maxQueries: 1 });
  const bundle = await assembler.assemble("Change the welcome header color");

  assert.equal(bundle.memory.length, 1);
  assert.ok(bundle.warnings.includes("memory_conflicts_pruned"));
});

test("ContextAssembler filters stale memory unrelated to request and focus", { concurrency: false }, async () => {
  class StaleMemoryClient extends FakeDocdexClient {
    async search(): Promise<unknown> {
      return { hits: [{ doc_id: "doc-1", path: "docs/sds/test-web-app.md" }] };
    }
    async memoryRecall(): Promise<unknown> {
      return {
        results: [
          {
            content:
              "Task ops-01-us-02-t18 requires adding a visible Welcome header to src/public/index.html.",
            score: 0.95,
          },
          {
            content:
              "Security requirements include safe task rendering and XSS-safe output in app.js.",
            score: 0.7,
          },
        ],
      };
    }
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-memory-filter-"));
  mkdirSync(path.join(tmpDir, "docs/sds"), { recursive: true });
  writeFileSync(path.join(tmpDir, "docs/sds/test-web-app.md"), "# SDS", "utf8");
  const client = new StaleMemoryClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, {
    maxQueries: 1,
    workspaceRoot: tmpDir,
    readStrategy: "fs",
  });
  const bundle = await assembler.assemble("Develop secure task rendering engine");

  assert.equal(bundle.memory.length, 1);
  assert.match(bundle.memory[0]?.text ?? "", /security requirements include safe task rendering/i);
  assert.ok(bundle.warnings.includes("memory_irrelevant_filtered"));
});

test("ContextAssembler limits structural analysis to high-signal paths", { concurrency: false }, async () => {
  class UiHeavyClient extends FakeDocdexClient {
    async files(): Promise<unknown> {
      return {
        results: [
          { rel_path: "src/public/index.html" },
          { rel_path: "src/public/style.css" },
          { rel_path: "docs/rfp.md" },
          { rel_path: "tests/footer.test.js" },
        ],
      };
    }

    async search(): Promise<unknown> {
      return {
        hits: [
          { doc_id: "doc-1", path: "docs/rfp.md", score: 10 },
          { doc_id: "doc-2", path: "tests/footer.test.js", score: 7 },
        ],
      };
    }
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-ui-analysis-"));
  mkdirSync(path.join(tmpDir, "src/public"), { recursive: true });
  mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
  mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/public/index.html"), "<h1>Welcome</h1>", "utf8");
  writeFileSync(path.join(tmpDir, "src/public/style.css"), ".app-title { color: black; }", "utf8");
  writeFileSync(path.join(tmpDir, "docs/rfp.md"), "# RFP", "utf8");
  writeFileSync(path.join(tmpDir, "tests/footer.test.js"), "test('x', () => {});", "utf8");

  const client = new UiHeavyClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, { maxQueries: 3, workspaceRoot: tmpDir, readStrategy: "fs" });
  const bundle = await assembler.assemble("Change welcome header color on the main page");
  const snippetPaths = new Set(bundle.snippets.map((entry) => entry.path).filter((entry): entry is string => !!entry));
  const symbolPaths = new Set(bundle.symbols.map((entry) => entry.path));

  assert.ok(snippetPaths.has("src/public/index.html"));
  assert.ok(snippetPaths.has("src/public/style.css"));
  assert.ok(!snippetPaths.has("tests/footer.test.js"));
  assert.ok(symbolPaths.has("src/public/index.html"));
  assert.ok(symbolPaths.has("src/public/style.css"));
  assert.ok(!symbolPaths.has("docs/rfp.md"));
  assert.ok(!symbolPaths.has("tests/footer.test.js"));
});

test("ContextAssembler reports missing data when no files are selected", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-missing-"));
  const client = new EmptySearchDocdexClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, { maxQueries: 1, workspaceRoot: tmpDir, readStrategy: "fs" });
  const bundle = await assembler.assemble("Update the homepage");

  assert.ok(bundle.missing?.includes("no_focus_files_selected"));
  assert.ok(bundle.missing?.includes("no_context_files_loaded"));
  assert.ok(bundle.missing?.includes("low_confidence_selection"));
});

test("ContextAssembler trims context to fit budget", { concurrency: false }, async () => {
  class BudgetClient extends FakeDocdexClient {
    async search(): Promise<unknown> {
      return { hits: [{ doc_id: "doc-1", path: "src/index.ts" }] };
    }
    async impactGraph(): Promise<unknown> {
      return { inbound: [], outbound: ["src/dep.ts"] };
    }
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const foo = 1;", "utf8");
  writeFileSync(path.join(tmpDir, "src/dep.ts"), "export const bar = 2;", "utf8");

  const client = new BudgetClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, {
    workspaceRoot: tmpDir,
    readStrategy: "fs",
    maxTotalBytes: 10,
    tokenBudget: 10,
    maxFiles: 2,
    focusMaxFileBytes: 100,
    peripheryMaxBytes: 100,
  });
  const bundle = await assembler.assemble("Update src/index.ts");
  const periphery = (bundle.files ?? []).filter((file) => file.role === "periphery");
  assert.equal(periphery.length, 0);
  assert.ok(bundle.warnings.includes("context_budget_pruned"));
});
