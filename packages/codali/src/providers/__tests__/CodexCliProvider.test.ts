import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { CodexCliProvider } from "../CodexCliProvider.js";
import type { AgentEvent, ProviderRequest } from "../ProviderTypes.js";

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
  const fakeCodex = path.join(tempDir, "codex");
  const originalPath = process.env.PATH;
  try {
    await writeFile(
      fakeCodex,
      "#!/bin/sh\nsleep 5\n",
      "utf8",
    );
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
    const provider = new CodexCliProvider({ model: "test-model", timeoutMs: 50 });
    const request: ProviderRequest = { messages: [{ role: "user", content: "hello" }] };
    await assert.rejects(
      provider.generate(request),
      /timed out/i,
    );
  } finally {
    process.env.PATH = originalPath;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliProvider normalizes unsupported reasoning effort aliases", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-reasoning-"));
  const fakeCodex = path.join(tempDir, "codex");
  const capturedArgs = path.join(tempDir, "args.txt");
  const originalPath = process.env.PATH;
  const originalReasoning = process.env.MCODA_CODEX_REASONING_EFFORT;
  const originalFallbackReasoning = process.env.CODEX_REASONING_EFFORT;
  try {
    await writeFile(
      fakeCodex,
      `#!/bin/sh
printf '%s\n' "$@" > "${capturedArgs}"
echo '{"type":"response.output_text.delta","delta":"ok"}'
`,
      "utf8",
    );
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
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
    process.env.PATH = originalPath;
    if (originalReasoning === undefined) {
      delete process.env.MCODA_CODEX_REASONING_EFFORT;
    } else {
      process.env.MCODA_CODEX_REASONING_EFFORT = originalReasoning;
    }
    if (originalFallbackReasoning === undefined) {
      delete process.env.CODEX_REASONING_EFFORT;
    } else {
      process.env.CODEX_REASONING_EFFORT = originalFallbackReasoning;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliProvider falls back to a supported reasoning effort when values are invalid", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-reasoning-invalid-"));
  const fakeCodex = path.join(tempDir, "codex");
  const capturedArgs = path.join(tempDir, "args.txt");
  const originalPath = process.env.PATH;
  const originalReasoning = process.env.MCODA_CODEX_REASONING_EFFORT;
  const originalFallbackReasoning = process.env.CODEX_REASONING_EFFORT;
  try {
    await writeFile(
      fakeCodex,
      `#!/bin/sh
printf '%s\n' "$@" > "${capturedArgs}"
echo '{"type":"response.output_text.delta","delta":"ok"}'
`,
      "utf8",
    );
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
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
    process.env.PATH = originalPath;
    if (originalReasoning === undefined) {
      delete process.env.MCODA_CODEX_REASONING_EFFORT;
    } else {
      process.env.MCODA_CODEX_REASONING_EFFORT = originalReasoning;
    }
    if (originalFallbackReasoning === undefined) {
      delete process.env.CODEX_REASONING_EFFORT;
    } else {
      process.env.CODEX_REASONING_EFFORT = originalFallbackReasoning;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CodexCliProvider overwrites invalid inherited reasoning env values for child process", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-reasoning-child-env-"));
  const fakeCodex = path.join(tempDir, "codex");
  const capturedArgs = path.join(tempDir, "args.txt");
  const capturedEnv = path.join(tempDir, "env.txt");
  const originalPath = process.env.PATH;
  const originalReasoning = process.env.MCODA_CODEX_REASONING_EFFORT;
  const originalFallbackReasoning = process.env.CODEX_REASONING_EFFORT;
  try {
    await writeFile(
      fakeCodex,
      `#!/bin/sh
printf '%s\n' "$@" > "${capturedArgs}"
echo "MCODA=$MCODA_CODEX_REASONING_EFFORT" > "${capturedEnv}"
echo "CODEX=$CODEX_REASONING_EFFORT" >> "${capturedEnv}"
echo '{"type":"response.output_text.delta","delta":"ok"}'
`,
      "utf8",
    );
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
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
    process.env.PATH = originalPath;
    if (originalReasoning === undefined) {
      delete process.env.MCODA_CODEX_REASONING_EFFORT;
    } else {
      process.env.MCODA_CODEX_REASONING_EFFORT = originalReasoning;
    }
    if (originalFallbackReasoning === undefined) {
      delete process.env.CODEX_REASONING_EFFORT;
    } else {
      process.env.CODEX_REASONING_EFFORT = originalFallbackReasoning;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
