import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Provider, ProviderRequest, ProviderResponse, ProviderToolCall } from "../../providers/ProviderTypes.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import type { ToolContext } from "../../tools/ToolTypes.js";
import { BuilderRunner } from "../BuilderRunner.js";
import type { ContextBundle, Plan } from "../Types.js";
import { PatchApplier } from "../PatchApplier.js";
import { ContextManager } from "../ContextManager.js";
import { ContextStore } from "../ContextStore.js";
import type { LocalContextConfig } from "../Types.js";

class StubProvider implements Provider {
  name = "stub";
  private calls = 0;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    if (this.calls === 0) {
      this.calls += 1;
      const toolCalls: ProviderToolCall[] = [{ id: "call_1", name: "echo", args: { text: "hi" } }];
      return { message: { role: "assistant", content: "" }, toolCalls };
    }
    return { message: { role: "assistant", content: "done" } };
  }
}

class PatchProvider implements Provider {
  name = "patch";
  lastRequest?: ProviderRequest;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          patches: [
            {
              action: "replace",
              file: "src/example.ts",
              search_block: "const value = 1;",
              replace_block: "const value = 2;",
            },
          ],
        }),
      },
    };
  }
}

class FileWriteProvider implements Provider {
  name = "patch-files";
  lastRequest?: ProviderRequest;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          files: [
            {
              path: "src/example.ts",
              content: "const value = 3;\n",
            },
          ],
        }),
      },
    };
  }
}

class NeedsContextProvider implements Provider {
  name = "needs-context";

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          needs_context: true,
          queries: ["auth flow"],
          files: ["src/auth.ts"],
          reason: "missing auth handler",
        }),
      },
    };
  }
}

const makeConfig = (overrides: Partial<LocalContextConfig> = {}): LocalContextConfig => ({
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
  },
  ...overrides,
});

const plan: Plan = {
  steps: ["step"],
  target_files: ["file.ts"],
  risk_assessment: "low",
  verification: ["test"],
};

const contextBundle: ContextBundle = {
  request: "do thing",
  queries: [],
  snippets: [],
  symbols: [],
  ast: [],
  impact: [],
  impact_diagnostics: [],
  memory: [],
  preferences_detected: [],
  profile: [],
  index: { last_updated_epoch_ms: 0, num_docs: 0 },
  warnings: [],
};

test("BuilderRunner executes tool calls and returns final message", { concurrency: false }, async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "echo",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    handler: async (args) => ({ output: `echo:${(args as { text: string }).text}` }),
  });

  const toolContext: ToolContext = { workspaceRoot: process.cwd() };
  const builder = new BuilderRunner({
    provider: new StubProvider(),
    tools: registry,
    context: toolContext,
    maxSteps: 3,
    maxToolCalls: 3,
  });

  const result = await builder.run(plan, contextBundle);
  assert.equal(result.finalMessage.content, "done");
  assert.equal(result.toolCallsExecuted, 1);
});

test("BuilderRunner prepends context history when configured", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-context-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\\n", "utf8");

  const store = new ContextStore({ workspaceRoot, storageDir: "codali/context" });
  const contextManager = new ContextManager({ config: makeConfig(), store });
  const lane = await contextManager.getLane({ jobId: "job-builder", taskId: "task-builder", role: "builder" });
  await contextManager.append(lane.id, { role: "assistant", content: "prior context" }, { role: "builder" });

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const provider = new PatchProvider();
  const builder = new BuilderRunner({
    provider,
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "patch_json",
    patchApplier: new PatchApplier({ workspaceRoot }),
    contextManager,
    laneId: lane.id,
    model: "test",
  });

  await builder.run(plan, contextBundle);
  const messages = provider.lastRequest?.messages ?? [];
  assert.ok(messages.some((msg) => msg.content.includes("prior context")));

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner applies patch_json output without tool calls", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\\n", "utf8");

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const provider = new PatchProvider();
  const builder = new BuilderRunner({
    provider,
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "patch_json",
    patchApplier: new PatchApplier({ workspaceRoot }),
  });

  const result = await builder.run(plan, contextBundle);
  const updated = await readFile(path.join(workspaceRoot, "src/example.ts"), "utf8");
  assert.match(updated, /const value = 2;/);
  assert.equal(result.toolCallsExecuted, 0);
  assert.equal(provider.lastRequest?.toolChoice, "none");

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner applies file_writes patch format", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\n", "utf8");

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const provider = new FileWriteProvider();
  const builder = new BuilderRunner({
    provider,
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "patch_json",
    patchFormat: "file_writes",
    patchApplier: new PatchApplier({ workspaceRoot }),
  });

  await builder.run(plan, contextBundle);
  const updated = await readFile(path.join(workspaceRoot, "src/example.ts"), "utf8");
  assert.match(updated, /const value = 3;/);
  assert.equal(provider.lastRequest?.toolChoice, "none");

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner returns context request without applying patches", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\n", "utf8");

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const builder = new BuilderRunner({
    provider: new NeedsContextProvider(),
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "patch_json",
    patchApplier: new PatchApplier({ workspaceRoot }),
  });

  const result = await builder.run(plan, contextBundle);
  const updated = await readFile(path.join(workspaceRoot, "src/example.ts"), "utf8");
  assert.equal(updated.trim(), "const value = 1;");
  assert.ok(result.contextRequest);

  await rm(workspaceRoot, { recursive: true, force: true });
});
