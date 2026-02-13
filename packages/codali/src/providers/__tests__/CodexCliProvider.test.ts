import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { CodexCliProvider } from "../CodexCliProvider.js";
import type { AgentEvent, ProviderRequest } from "../ProviderTypes.js";

const CODEX_COMMAND_ENV = "MCODA_CODEX_COMMAND";
const CODEX_COMMAND_ARGS_ENV = "MCODA_CODEX_COMMAND_ARGS";

const restoreEnvVar = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

const writeFakeCodexScript = async (tempDir: string, scriptSource: string): Promise<string> => {
  const scriptPath = path.join(tempDir, "codex.js");
  await writeFile(scriptPath, scriptSource, "utf8");
  return scriptPath;
};

test("CodexCliProvider returns stub output when MCODA_CLI_STUB=1", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";
    const provider = new CodexCliProvider({ model: "test-model" });
    const request: ProviderRequest = { messages: [{ role: "user", content: "hi" }] };
    const result = await provider.generate(request);
    assert.equal(result.message.content, "codex-stub:hi");
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
  }
});

test("CodexCliProvider emits token event when stream requested", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";
    const provider = new CodexCliProvider({ model: "test-model" });
    const events: AgentEvent[] = [];
    const request: ProviderRequest = {
      messages: [{ role: "user", content: "stream" }],
      stream: true,
      onEvent: (event) => events.push(event),
    };
    const result = await provider.generate(request);
    assert.equal(result.message.content, "codex-stub:stream");
    assert.deepEqual(events, [{ type: "token", content: "codex-stub:stream" }]);
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
  }
});

test("CodexCliProvider throws when model is missing", async () => {
  const provider = new CodexCliProvider({ model: "" });
  const request: ProviderRequest = { messages: [{ role: "user", content: "hi" }] };
  await assert.rejects(
    provider.generate(request),
    /requires model from selected mcoda agent\/config/i,
  );
});

test("CodexCliProvider enforces timeout for stalled codex process", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-timeout-"));
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
process.stdin.resume();
process.stdin.on("error", () => {});
setTimeout(() => {}, 5000);
`,
    );
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    const provider = new CodexCliProvider({ model: "test-model", timeoutMs: 50 });
    const request: ProviderRequest = { messages: [{ role: "user", content: "hello" }] };
    await assert.rejects(
      provider.generate(request),
      /timed out/i,
    );
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliProvider normalizes unsupported reasoning effort aliases", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-reasoning-"));
  const capturedArgs = path.join(tempDir, "args.txt");
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  const originalReasoning = process.env.MCODA_CODEX_REASONING_EFFORT;
  const originalFallbackReasoning = process.env.CODEX_REASONING_EFFORT;
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
const fs = require("node:fs");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capturedArgs)}, process.argv.slice(2).join("\\n"), "utf8");
  process.stdout.write('{"type":"response.output_text.delta","delta":"ok"}\\n');
});
`,
    );
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    process.env.MCODA_CODEX_REASONING_EFFORT = "xhigh";
    delete process.env.CODEX_REASONING_EFFORT;
    const provider = new CodexCliProvider({ model: "test-model", timeoutMs: 1000 });
    const request: ProviderRequest = { messages: [{ role: "user", content: "hello" }] };
    const result = await provider.generate(request);
    assert.equal(result.message.content, "ok");
    const argsRaw = await readFile(capturedArgs, "utf8");
    const args = argsRaw.split(/\r?\n/).filter(Boolean);
    assert.ok(args.includes("-c"));
    assert.ok(args.includes("reasoning_effort=high"));
    assert.ok(args.includes("model_reasoning_effort=high"));
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    restoreEnvVar("MCODA_CODEX_REASONING_EFFORT", originalReasoning);
    restoreEnvVar("CODEX_REASONING_EFFORT", originalFallbackReasoning);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliProvider falls back to a supported reasoning effort when values are invalid", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-reasoning-invalid-"));
  const capturedArgs = path.join(tempDir, "args.txt");
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  const originalReasoning = process.env.MCODA_CODEX_REASONING_EFFORT;
  const originalFallbackReasoning = process.env.CODEX_REASONING_EFFORT;
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
const fs = require("node:fs");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capturedArgs)}, process.argv.slice(2).join("\\n"), "utf8");
  process.stdout.write('{"type":"response.output_text.delta","delta":"ok"}\\n');
});
`,
    );
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    process.env.MCODA_CODEX_REASONING_EFFORT = "banana";
    delete process.env.CODEX_REASONING_EFFORT;
    const provider = new CodexCliProvider({ model: "test-model", timeoutMs: 1000 });
    const request: ProviderRequest = { messages: [{ role: "user", content: "hello" }] };
    const result = await provider.generate(request);
    assert.equal(result.message.content, "ok");
    const argsRaw = await readFile(capturedArgs, "utf8");
    assert.match(argsRaw, /model_reasoning_effort=high/);
    assert.match(argsRaw, /reasoning_effort=high/);
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    restoreEnvVar("MCODA_CODEX_REASONING_EFFORT", originalReasoning);
    restoreEnvVar("CODEX_REASONING_EFFORT", originalFallbackReasoning);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliProvider overwrites invalid inherited reasoning env values for child process", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-reasoning-child-env-"));
  const capturedArgs = path.join(tempDir, "args.txt");
  const capturedEnv = path.join(tempDir, "env.txt");
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  const originalReasoning = process.env.MCODA_CODEX_REASONING_EFFORT;
  const originalFallbackReasoning = process.env.CODEX_REASONING_EFFORT;
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
const fs = require("node:fs");
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capturedArgs)}, process.argv.slice(2).join("\\n"), "utf8");
  fs.writeFileSync(
    ${JSON.stringify(capturedEnv)},
    "MCODA=" + (process.env.MCODA_CODEX_REASONING_EFFORT ?? "") + "\\nCODEX=" + (process.env.CODEX_REASONING_EFFORT ?? "") + "\\n",
    "utf8",
  );
  process.stdout.write('{"type":"response.output_text.delta","delta":"ok"}\\n');
});
`,
    );
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    delete process.env.MCODA_CODEX_REASONING_EFFORT;
    process.env.CODEX_REASONING_EFFORT = "invalid-effort";
    const provider = new CodexCliProvider({ model: "test-model", timeoutMs: 1000 });
    const request: ProviderRequest = { messages: [{ role: "user", content: "hello" }] };
    const result = await provider.generate(request);
    assert.equal(result.message.content, "ok");
    const argsRaw = await readFile(capturedArgs, "utf8");
    assert.match(argsRaw, /model_reasoning_effort=high/);
    assert.match(argsRaw, /reasoning_effort=high/);
    const envRaw = await readFile(capturedEnv, "utf8");
    assert.match(envRaw, /MCODA=high/m);
    assert.match(envRaw, /CODEX=high/m);
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    restoreEnvVar("MCODA_CODEX_REASONING_EFFORT", originalReasoning);
    restoreEnvVar("CODEX_REASONING_EFFORT", originalFallbackReasoning);
    await rm(tempDir, { recursive: true, force: true });
  }
});
