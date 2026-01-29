import test from "node:test";
import assert from "node:assert/strict";
import { CodaliAdapter } from "../adapters/codali/CodaliAdapter.js";
import type { AdapterConfig } from "../adapters/AdapterTypes.js";
import type { Agent } from "@mcoda/shared";

test("CodaliAdapter uses stub CLI output", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";

    const agent: Agent = {
      id: "agent-1",
      slug: "agent-1",
      adapter: "codali-cli",
      defaultModel: "stub-model",
      config: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const config: AdapterConfig = {
      agent,
      capabilities: ["code_write"],
      model: "stub-model",
      provider: "stub",
      adapter: "codali-cli",
    };

    const adapter = new CodaliAdapter(config);
    const result = await adapter.invoke({
      input: "hello",
      metadata: { workspaceRoot: process.cwd() },
    });

    assert.equal(result.output, "codali-stub:hello");
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
  }
});

test("CodaliAdapter consumes command metadata from invocation", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";

    const agent: Agent = {
      id: "agent-ctx",
      slug: "agent-ctx",
      adapter: "codali-cli",
      defaultModel: "stub-model",
      config: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const config: AdapterConfig = {
      agent,
      capabilities: ["code_write"],
      model: "stub-model",
      provider: "stub",
      adapter: "codali-cli",
    };

    const adapter = new CodaliAdapter(config);
    const result = await adapter.invoke({
      input: "hello",
      metadata: {
        workspaceRoot: process.cwd(),
        command: "work-on-tasks",
        commandRunId: "run-123",
        jobId: "job-456",
        taskId: "task-789",
        taskKey: "TASK-1",
        projectKey: "proj",
      },
    });

    const meta = result.metadata as Record<string, unknown>;
    assert.equal(meta.command, "work-on-tasks");
    assert.equal(meta.commandRunId, "run-123");
    assert.equal(meta.jobId, "job-456");
    assert.equal(meta.taskId, "task-789");
    assert.equal(meta.taskKey, "TASK-1");
    assert.equal(meta.project, "proj");
    assert.equal(meta.agentId, "agent-ctx");
    assert.equal(meta.agentSlug, "agent-ctx");
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
  }
});

test("CodaliAdapter maps openai adapters and requires api key", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  const originalKey = process.env.CODALI_API_KEY;
  try {
    process.env.MCODA_CLI_STUB = "1";
    delete process.env.CODALI_API_KEY;

    const agent: Agent = {
      id: "agent-2",
      slug: "agent-2",
      adapter: "openai-api",
      defaultModel: "gpt-4o-mini",
      config: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const config: AdapterConfig = {
      agent,
      capabilities: ["code_write"],
      model: "gpt-4o-mini",
      adapter: "codali-cli",
    };

    const adapter = new CodaliAdapter(config);
    await assert.rejects(
      adapter.invoke({ input: "hello", metadata: { workspaceRoot: process.cwd() } }),
      /AUTH_REQUIRED: API key missing for codali provider openai-compatible/,
    );
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    if (originalKey === undefined) {
      delete process.env.CODALI_API_KEY;
    } else {
      process.env.CODALI_API_KEY = originalKey;
    }
  }
});

test("CodaliAdapter maps ollama adapters without api key", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";

    const agent: Agent = {
      id: "agent-3",
      slug: "agent-3",
      adapter: "ollama-cli",
      defaultModel: "llama3",
      config: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const config: AdapterConfig = {
      agent,
      capabilities: ["code_write"],
      model: "llama3",
      adapter: "codali-cli",
    };

    const adapter = new CodaliAdapter(config);
    const result = await adapter.invoke({ input: "hello", metadata: { workspaceRoot: process.cwd() } });
    assert.equal(result.output, "codali-stub:hello");
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
  }
});

test("CodaliAdapter rejects unsupported adapters without explicit provider", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";

    const agent: Agent = {
      id: "agent-4",
      slug: "agent-4",
      adapter: "gemini-cli",
      defaultModel: "gemini-1.5",
      config: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const config: AdapterConfig = {
      agent,
      capabilities: ["code_write"],
      model: "gemini-1.5",
      adapter: "codali-cli",
    };

    const adapter = new CodaliAdapter(config);
    await assert.rejects(
      adapter.invoke({ input: "hello", metadata: { workspaceRoot: process.cwd() } }),
      /CODALI_UNSUPPORTED_ADAPTER: gemini-cli/,
    );
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
  }
});
