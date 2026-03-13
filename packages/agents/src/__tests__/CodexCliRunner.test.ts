import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cliHealthy, runCodexExec, runCodexExecStream } from "../adapters/codex/CodexCliRunner.js";

const CODEX_COMMAND_ENV = "MCODA_CODEX_COMMAND";
const CODEX_COMMAND_ARGS_ENV = "MCODA_CODEX_COMMAND_ARGS";
const CODEX_TIMEOUT_ENV = "MCODA_CODEX_TIMEOUT_MS";
const CODEX_EXIT_GRACE_ENV = "MCODA_CODEX_EXIT_GRACE_MS";

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

test("Codex CLI runner uses stub outputs when MCODA_CLI_STUB=1", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  try {
    process.env.MCODA_CLI_STUB = "1";
    delete process.env.MCODA_SKIP_CLI_CHECKS;

    const health = cliHealthy();
    assert.equal(health.ok, true);
    assert.equal(health.details?.stub, true);

    const execResult = await runCodexExec("hello");
    assert.equal(execResult.output, "qa-stub:hello");
    assert.ok(execResult.raw.includes("agent_message"));

    const streamed: string[] = [];
    for await (const chunk of runCodexExecStream("stream")) {
      streamed.push(chunk.output);
    }
    assert.deepEqual(streamed, ["qa-stub:stream\n"]);
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    if (originalSkip === undefined) {
      delete process.env.MCODA_SKIP_CLI_CHECKS;
    } else {
      process.env.MCODA_SKIP_CLI_CHECKS = originalSkip;
    }
  }
});

test("Codex CLI runner throws when CLI is unavailable", { concurrency: false }, () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalPath = process.env.PATH;
  try {
    delete process.env.MCODA_CLI_STUB;
    delete process.env.MCODA_SKIP_CLI_CHECKS;
    process.env.PATH = "";

    assert.throws(() => cliHealthy(true), /AUTH_ERROR: codex CLI unavailable/);
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
    if (originalSkip === undefined) {
      delete process.env.MCODA_SKIP_CLI_CHECKS;
    } else {
      process.env.MCODA_SKIP_CLI_CHECKS = originalSkip;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("Codex CLI runner times out when codex never returns", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-runner-timeout-"));
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalTimeout = process.env[CODEX_TIMEOUT_ENV];
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
process.stdin.resume();
process.stdin.on("error", () => {});
setTimeout(() => {}, 5000);
`,
    );
    process.env.MCODA_SKIP_CLI_CHECKS = "1";
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    process.env[CODEX_TIMEOUT_ENV] = "50";

    await assert.rejects(runCodexExec("hello"), /timed out/i);
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    restoreEnvVar("MCODA_SKIP_CLI_CHECKS", originalSkip);
    restoreEnvVar(CODEX_TIMEOUT_ENV, originalTimeout);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Codex CLI runner honors explicit timeout overrides", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-runner-timeout-override-"));
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalTimeout = process.env[CODEX_TIMEOUT_ENV];
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
process.stdin.resume();
process.stdin.on("error", () => {});
setTimeout(() => {
  process.stdout.write('{"type":"response.output_text.done","text":"late answer"}\\n');
  process.exit(0);
}, 150);
`,
    );
    process.env.MCODA_SKIP_CLI_CHECKS = "1";
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    process.env[CODEX_TIMEOUT_ENV] = "25";

    const result = await runCodexExec("hello", undefined, undefined, 1000);
    assert.equal(result.output, "late answer");
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    restoreEnvVar("MCODA_SKIP_CLI_CHECKS", originalSkip);
    restoreEnvVar(CODEX_TIMEOUT_ENV, originalTimeout);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Codex CLI runner returns final output when codex stalls after completion", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-runner-final-"));
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalTimeout = process.env[CODEX_TIMEOUT_ENV];
  const originalExitGrace = process.env[CODEX_EXIT_GRACE_ENV];
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write('{"type":"response.output_text.done","text":"complete answer"}\\n');
  setTimeout(() => {}, 5000);
});
process.stdin.on("error", () => {});
`,
    );
    process.env.MCODA_SKIP_CLI_CHECKS = "1";
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    process.env[CODEX_TIMEOUT_ENV] = "1000";
    process.env[CODEX_EXIT_GRACE_ENV] = "50";

    const result = await runCodexExec("hello");
    assert.equal(result.output, "complete answer");
    assert.match(result.raw, /response\.output_text\.done/);
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    restoreEnvVar("MCODA_SKIP_CLI_CHECKS", originalSkip);
    restoreEnvVar(CODEX_TIMEOUT_ENV, originalTimeout);
    restoreEnvVar(CODEX_EXIT_GRACE_ENV, originalExitGrace);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Codex CLI runner passes output schema files to codex exec when provided", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-runner-schema-"));
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalTimeout = process.env[CODEX_TIMEOUT_ENV];
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
const fs = require("node:fs");
process.stdin.setEncoding("utf8");
let prompt = "";
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  const schemaIndex = process.argv.indexOf("--output-schema");
  if (schemaIndex === -1 || !process.argv[schemaIndex + 1]) {
    console.error("missing output schema");
    process.exit(2);
  }
  const schema = JSON.parse(fs.readFileSync(process.argv[schemaIndex + 1], "utf8"));
  process.stdout.write(
    JSON.stringify({
      type: "response.output_text.done",
      text: JSON.stringify({
        prompt,
        schemaTitle: schema.title ?? "",
        required: Array.isArray(schema.required) ? schema.required : [],
      }),
    }) + "\\n",
  );
});
process.stdin.on("error", () => {});
`,
    );
    process.env.MCODA_SKIP_CLI_CHECKS = "1";
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    process.env[CODEX_TIMEOUT_ENV] = "1000";

    const result = await runCodexExec("hello", undefined, {
      type: "object",
      title: "full-plan",
      required: ["epics"],
      properties: {
        epics: { type: "array" },
      },
    });
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.prompt, "hello");
    assert.equal(parsed.schemaTitle, "full-plan");
    assert.deepEqual(parsed.required, ["epics"]);
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    restoreEnvVar("MCODA_SKIP_CLI_CHECKS", originalSkip);
    restoreEnvVar(CODEX_TIMEOUT_ENV, originalTimeout);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Codex CLI stream runner returns final output when codex stalls after completion", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-runner-stream-final-"));
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalTimeout = process.env[CODEX_TIMEOUT_ENV];
  const originalExitGrace = process.env[CODEX_EXIT_GRACE_ENV];
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write('{"type":"response.output_text.done","text":"complete stream"}\\n');
  setTimeout(() => {}, 5000);
});
process.stdin.on("error", () => {});
`,
    );
    process.env.MCODA_SKIP_CLI_CHECKS = "1";
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    process.env[CODEX_TIMEOUT_ENV] = "1000";
    process.env[CODEX_EXIT_GRACE_ENV] = "50";

    const outputs: string[] = [];
    for await (const chunk of runCodexExecStream("hello")) {
      outputs.push(chunk.output);
    }
    assert.deepEqual(outputs, ["complete stream\n"]);
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    restoreEnvVar("MCODA_SKIP_CLI_CHECKS", originalSkip);
    restoreEnvVar(CODEX_TIMEOUT_ENV, originalTimeout);
    restoreEnvVar(CODEX_EXIT_GRACE_ENV, originalExitGrace);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Codex CLI stream runner emits a final answer when it differs from streamed deltas", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-runner-stream-different-final-"));
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalTimeout = process.env[CODEX_TIMEOUT_ENV];
  const originalExitGrace = process.env[CODEX_EXIT_GRACE_ENV];
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write('{"type":"response.output_text.delta","delta":"I am checking repo context first."}\\n');
  process.stdout.write(
    JSON.stringify({
      type: "response.output_text.done",
      text: '{"operations":[{"op":"update_estimate","taskKey":"demo-01-us-01-t01","storyPoints":3}]}',
    }) + "\\n",
  );
  setTimeout(() => {}, 5000);
});
process.stdin.on("error", () => {});
`,
    );
    process.env.MCODA_SKIP_CLI_CHECKS = "1";
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    process.env[CODEX_TIMEOUT_ENV] = "1000";
    process.env[CODEX_EXIT_GRACE_ENV] = "50";

    const outputs: string[] = [];
    for await (const chunk of runCodexExecStream("hello")) {
      outputs.push(chunk.output);
    }
    assert.deepEqual(outputs, [
      "I am checking repo context first.",
      '{"operations":[{"op":"update_estimate","taskKey":"demo-01-us-01-t01","storyPoints":3}]}\n',
    ]);
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    restoreEnvVar("MCODA_SKIP_CLI_CHECKS", originalSkip);
    restoreEnvVar(CODEX_TIMEOUT_ENV, originalTimeout);
    restoreEnvVar(CODEX_EXIT_GRACE_ENV, originalExitGrace);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Codex CLI stream runner suppresses duplicate final answers after matching deltas", { concurrency: false }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-runner-stream-matching-final-"));
  const originalCommand = process.env[CODEX_COMMAND_ENV];
  const originalCommandArgs = process.env[CODEX_COMMAND_ARGS_ENV];
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalTimeout = process.env[CODEX_TIMEOUT_ENV];
  const originalExitGrace = process.env[CODEX_EXIT_GRACE_ENV];
  try {
    const scriptPath = await writeFakeCodexScript(
      tempDir,
      `
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write('{"type":"response.output_text.delta","delta":"hello "}\\n');
  process.stdout.write('{"type":"response.output_text.delta","delta":"world"}\\n');
  process.stdout.write('{"type":"response.output_text.done","text":"hello world"}\\n');
  setTimeout(() => {}, 5000);
});
process.stdin.on("error", () => {});
`,
    );
    process.env.MCODA_SKIP_CLI_CHECKS = "1";
    process.env[CODEX_COMMAND_ENV] = process.execPath;
    process.env[CODEX_COMMAND_ARGS_ENV] = JSON.stringify([scriptPath]);
    process.env[CODEX_TIMEOUT_ENV] = "1000";
    process.env[CODEX_EXIT_GRACE_ENV] = "50";

    const outputs: string[] = [];
    for await (const chunk of runCodexExecStream("hello")) {
      outputs.push(chunk.output);
    }
    assert.deepEqual(outputs, ["hello ", "world"]);
  } finally {
    restoreEnvVar(CODEX_COMMAND_ENV, originalCommand);
    restoreEnvVar(CODEX_COMMAND_ARGS_ENV, originalCommandArgs);
    restoreEnvVar("MCODA_SKIP_CLI_CHECKS", originalSkip);
    restoreEnvVar(CODEX_TIMEOUT_ENV, originalTimeout);
    restoreEnvVar(CODEX_EXIT_GRACE_ENV, originalExitGrace);
    await rm(tempDir, { recursive: true, force: true });
  }
});
