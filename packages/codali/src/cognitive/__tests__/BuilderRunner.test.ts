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
import { parsePatchOutput, type PatchFormat } from "../BuilderOutputParser.js";
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

class ReadOnlyFileWriteProvider implements Provider {
  name = "patch-readonly";
  async generate(): Promise<ProviderResponse> {
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          files: [
            {
              path: "docs/sds/spec.md",
              content: "blocked\n",
            },
          ],
        }),
      },
    };
  }
}

class AnyFileWriteProvider implements Provider {
  name = "patch-any";
  async generate(): Promise<ProviderResponse> {
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          files: [
            {
              path: "src/other.ts",
              content: "export const other = 1;\n",
            },
          ],
        }),
      },
    };
  }
}

class PlannedTargetFileWriteProvider implements Provider {
  name = "patch-planned-target";
  async generate(): Promise<ProviderResponse> {
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          files: [
            {
              path: "src/healthz.js",
              content: "export const healthz = () => ({ ok: true });\n",
            },
          ],
        }),
      },
    };
  }
}

class RetryFileWriteProvider implements Provider {
  name = "retry-files";
  calls = 0;
  lastRequest?: ProviderRequest;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    this.calls += 1;
    if (this.calls === 1) {
      return { message: { role: "assistant", content: JSON.stringify({ foo: "bar" }) } };
    }
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          files: [
            {
              path: "src/example.ts",
              content: "const value = 9;\n",
            },
          ],
        }),
      },
    };
  }
}

class ToolUnsupportedProvider implements Provider {
  name = "tool-unsupported";
  calls = 0;
  lastRequest?: ProviderRequest;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls += 1;
    this.lastRequest = request;
    if (request.tools && request.tools.length > 0) {
      throw new Error("Ollama error 400: registry.ollama.ai/library/codellama:34b does not support tools");
    }
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          patches: [
            {
              action: "replace",
              file: "src/example.ts",
              search_block: "const value = 1;",
              replace_block: "const value = 5;",
            },
          ],
        }),
      },
    };
  }
}

class FallbackFileWriteProvider implements Provider {
  name = "fallback-files";
  calls = 0;
  lastRequest?: ProviderRequest;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    this.calls += 1;
    if (this.calls <= 2) {
      return { message: { role: "assistant", content: JSON.stringify({ nope: true }) } };
    }
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          patches: [
            {
              action: "replace",
              file: "src/example.ts",
              search_block: "const value = 1;",
              replace_block: "const value = 7;",
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

class FreeformProvider implements Provider {
  name = "freeform";
  lastRequest?: ProviderRequest;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    return {
      message: {
        role: "assistant",
        content: "Change src/example.ts to set const value = 4;",
      },
    };
  }
}

class InvalidPatchProvider implements Provider {
  name = "invalid-patch";
  lastRequest?: ProviderRequest;

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.lastRequest = request;
    return {
      message: {
        role: "assistant",
        content: "I made the changes you asked for.",
      },
    };
  }
}

class StubInterpreter {
  calls = 0;
  async interpret(
    _raw: string,
    _format?: PatchFormat,
  ): Promise<{
    patches: Array<{ action: "replace"; file: string; search_block: string; replace_block: string }>;
  }> {
    this.calls += 1;
    return {
      patches: [
        {
          action: "replace",
          file: "src/example.ts",
          search_block: "const value = 1;",
          replace_block: "const value = 4;",
        },
      ],
    };
  }
}

class PassThroughInterpreter {
  calls = 0;
  async interpret(raw: string, format: PatchFormat = "search_replace") {
    this.calls += 1;
    return parsePatchOutput(raw, format);
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
    thresholdPct: 0.9,
  },
  ...overrides,
});

const plan: Plan = {
  steps: ["step"],
  target_files: ["src/example.ts"],
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
    interpreter: new PassThroughInterpreter(),
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
    interpreter: new PassThroughInterpreter(),
  });

  const result = await builder.run(plan, contextBundle);
  const updated = await readFile(path.join(workspaceRoot, "src/example.ts"), "utf8");
  assert.match(updated, /const value = 2;/);
  assert.equal(result.toolCallsExecuted, 0);
  assert.equal(provider.lastRequest?.toolChoice, undefined);

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner runs interpreter precheck for patch_json when configured", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\n", "utf8");

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const provider = new PatchProvider();
  const interpreter = new PassThroughInterpreter();
  const builder = new BuilderRunner({
    provider,
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "patch_json",
    patchApplier: new PatchApplier({ workspaceRoot }),
    interpreter,
  });

  await builder.run(plan, contextBundle);
  const updated = await readFile(path.join(workspaceRoot, "src/example.ts"), "utf8");
  assert.match(updated, /const value = 2;/);
  assert.equal(interpreter.calls, 1);

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner falls back to patch_json when tools are unsupported", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-tools-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\n", "utf8");

  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "echo",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    handler: async (args) => ({ output: `echo:${(args as { text: string }).text}` }),
  });
  const toolContext: ToolContext = { workspaceRoot };
  const provider = new ToolUnsupportedProvider();
  const builder = new BuilderRunner({
    provider,
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "tool_calls",
    patchApplier: new PatchApplier({ workspaceRoot }),
    interpreter: new PassThroughInterpreter(),
  });

  await builder.run(plan, contextBundle);
  const updated = await readFile(path.join(workspaceRoot, "src/example.ts"), "utf8");
  assert.match(updated, /const value = 5;/);
  assert.ok(provider.calls >= 2);

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner applies freeform output via interpreter", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\n", "utf8");

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const provider = new FreeformProvider();
  const interpreter = new StubInterpreter();
  const builder = new BuilderRunner({
    provider,
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "freeform",
    patchApplier: new PatchApplier({ workspaceRoot }),
    interpreter,
  });

  await builder.run(plan, contextBundle);
  const updated = await readFile(path.join(workspaceRoot, "src/example.ts"), "utf8");
  assert.match(updated, /const value = 4;/);
  assert.equal(interpreter.calls, 1);
  assert.equal(provider.lastRequest?.toolChoice, undefined);

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
    interpreter: new PassThroughInterpreter(),
  });

  await builder.run(plan, contextBundle);
  const updated = await readFile(path.join(workspaceRoot, "src/example.ts"), "utf8");
  assert.match(updated, /const value = 3;/);
  assert.equal(provider.lastRequest?.toolChoice, undefined);

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner retries file_writes on invalid payload", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\n", "utf8");

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const provider = new RetryFileWriteProvider();
  const builder = new BuilderRunner({
    provider,
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "patch_json",
    patchFormat: "file_writes",
    patchApplier: new PatchApplier({ workspaceRoot }),
    interpreter: new PassThroughInterpreter(),
  });

  await builder.run(plan, contextBundle);
  const updated = await readFile(path.join(workspaceRoot, "src/example.ts"), "utf8");
  assert.match(updated, /const value = 9;/);
  assert.equal(provider.calls, 2);

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner falls back to search_replace when file_writes retry fails", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\n", "utf8");

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const provider = new FallbackFileWriteProvider();
  const builder = new BuilderRunner({
    provider,
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "patch_json",
    patchFormat: "file_writes",
    patchApplier: new PatchApplier({ workspaceRoot }),
    interpreter: new PassThroughInterpreter(),
  });

  await builder.run(plan, contextBundle);
  const updated = await readFile(path.join(workspaceRoot, "src/example.ts"), "utf8");
  assert.match(updated, /const value = 7;/);
  assert.equal(provider.calls, 3);
  assert.ok(provider.lastRequest?.messages[0]?.content.includes("\"patches\""));

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner fails when patch_json output cannot be interpreted", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\n", "utf8");

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const provider = new InvalidPatchProvider();
  const interpreter = new PassThroughInterpreter();
  const builder = new BuilderRunner({
    provider,
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "patch_json",
    patchFormat: "file_writes",
    patchApplier: new PatchApplier({ workspaceRoot }),
    interpreter,
  });

  await assert.rejects(() => builder.run(plan, contextBundle));

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner rejects patches that target read-only paths", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-readonly-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\n", "utf8");

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const patchApplier = new PatchApplier({ workspaceRoot });
  const builder = new BuilderRunner({
    provider: new ReadOnlyFileWriteProvider(),
    tools: registry,
    context: toolContext,
    maxSteps: 2,
    maxToolCalls: 1,
    mode: "patch_json",
    patchFormat: "file_writes",
    patchApplier,
    interpreter: new PassThroughInterpreter(),
  });
  const bundle: ContextBundle = {
    ...contextBundle,
    allow_write_paths: ["src/example.ts"],
    read_only_paths: ["docs/sds"],
  };

  await assert.rejects(() => builder.run(plan, bundle), /disallowed files/i);
});

test("BuilderRunner allows non-read-only edits when allow list is empty", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-allowall-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const patchApplier = new PatchApplier({ workspaceRoot });
  const builder = new BuilderRunner({
    provider: new AnyFileWriteProvider(),
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "patch_json",
    patchFormat: "file_writes",
    patchApplier,
    interpreter: new PassThroughInterpreter(),
  });
  const bundle: ContextBundle = {
    ...contextBundle,
    allow_write_paths: [],
    read_only_paths: ["docs/sds"],
  };

  await builder.run(plan, bundle);
  const updated = await readFile(path.join(workspaceRoot, "src/other.ts"), "utf8");
  assert.match(updated, /export const other/);

  await rm(workspaceRoot, { recursive: true, force: true });
});

test("BuilderRunner allows architect-planned new files even when bundle allow list is narrow", { concurrency: false }, async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codali-builder-planned-target-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src/example.ts"), "const value = 1;\n", "utf8");

  const registry = new ToolRegistry();
  const toolContext: ToolContext = { workspaceRoot };
  const patchApplier = new PatchApplier({ workspaceRoot });
  const builder = new BuilderRunner({
    provider: new PlannedTargetFileWriteProvider(),
    tools: registry,
    context: toolContext,
    maxSteps: 1,
    maxToolCalls: 0,
    mode: "patch_json",
    patchFormat: "file_writes",
    patchApplier,
    interpreter: new PassThroughInterpreter(),
  });
  const bundle: ContextBundle = {
    ...contextBundle,
    allow_write_paths: ["src/example.ts"],
    read_only_paths: ["docs/sds"],
  };
  const planWithPlannedCreate: Plan = {
    ...plan,
    target_files: ["src/healthz.js"],
  };

  await builder.run(planWithPlannedCreate, bundle);
  const created = await readFile(path.join(workspaceRoot, "src/healthz.js"), "utf8");
  assert.match(created, /healthz/);

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
