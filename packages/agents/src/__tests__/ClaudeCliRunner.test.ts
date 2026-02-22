import test from "node:test";
import assert from "node:assert/strict";
import { claudeHealthy, runClaudeExec, runClaudeExecStream } from "../adapters/claude/ClaudeCliRunner.js";

test("Claude CLI runner uses stub outputs when stub env is enabled", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLAUDE_STUB;
  const originalGlobalStub = process.env.MCODA_CLI_STUB;
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalBin = process.env.MCODA_CLAUDE_CLI_BIN;
  try {
    process.env.MCODA_CLAUDE_STUB = "1";
    delete process.env.MCODA_CLI_STUB;
    delete process.env.MCODA_SKIP_CLI_CHECKS;
    process.env.MCODA_CLAUDE_CLI_BIN = "/definitely/missing/claude";

    const health = claudeHealthy();
    assert.equal(health.ok, true);
    assert.equal(health.details?.stub, true);

    const execResult = runClaudeExec("hello");
    assert.equal(execResult.output, "claude-stub:hello");
    assert.equal(execResult.raw, "claude-stub:hello");

    const streamed: string[] = [];
    for await (const chunk of runClaudeExecStream("stream")) {
      streamed.push(chunk.output);
    }
    assert.deepEqual(streamed, ["claude-stub:stream\n"]);
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLAUDE_STUB;
    } else {
      process.env.MCODA_CLAUDE_STUB = originalStub;
    }
    if (originalGlobalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalGlobalStub;
    }
    if (originalSkip === undefined) {
      delete process.env.MCODA_SKIP_CLI_CHECKS;
    } else {
      process.env.MCODA_SKIP_CLI_CHECKS = originalSkip;
    }
    if (originalBin === undefined) {
      delete process.env.MCODA_CLAUDE_CLI_BIN;
    } else {
      process.env.MCODA_CLAUDE_CLI_BIN = originalBin;
    }
  }
});

test("Claude CLI runner throws when CLI is unavailable", { concurrency: false }, () => {
  const originalStub = process.env.MCODA_CLAUDE_STUB;
  const originalGlobalStub = process.env.MCODA_CLI_STUB;
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalBin = process.env.MCODA_CLAUDE_CLI_BIN;
  try {
    delete process.env.MCODA_CLAUDE_STUB;
    delete process.env.MCODA_CLI_STUB;
    delete process.env.MCODA_SKIP_CLI_CHECKS;
    process.env.MCODA_CLAUDE_CLI_BIN = "/definitely/missing/claude";

    assert.throws(() => claudeHealthy(true), /AUTH_ERROR: claude CLI unavailable/);
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLAUDE_STUB;
    } else {
      process.env.MCODA_CLAUDE_STUB = originalStub;
    }
    if (originalGlobalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalGlobalStub;
    }
    if (originalSkip === undefined) {
      delete process.env.MCODA_SKIP_CLI_CHECKS;
    } else {
      process.env.MCODA_SKIP_CLI_CHECKS = originalSkip;
    }
    if (originalBin === undefined) {
      delete process.env.MCODA_CLAUDE_CLI_BIN;
    } else {
      process.env.MCODA_CLAUDE_CLI_BIN = originalBin;
    }
  }
});

test("Claude CLI runner surfaces CLI diagnostics when invocation fails", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLAUDE_STUB;
  const originalGlobalStub = process.env.MCODA_CLI_STUB;
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  const originalBin = process.env.MCODA_CLAUDE_CLI_BIN;
  try {
    delete process.env.MCODA_CLAUDE_STUB;
    delete process.env.MCODA_CLI_STUB;
    delete process.env.MCODA_SKIP_CLI_CHECKS;
    process.env.MCODA_CLAUDE_CLI_BIN = process.execPath;

    assert.throws(() => runClaudeExec("hello"), /output-format|bad option|unknown option/i);
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLAUDE_STUB;
    } else {
      process.env.MCODA_CLAUDE_STUB = originalStub;
    }
    if (originalGlobalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalGlobalStub;
    }
    if (originalSkip === undefined) {
      delete process.env.MCODA_SKIP_CLI_CHECKS;
    } else {
      process.env.MCODA_SKIP_CLI_CHECKS = originalSkip;
    }
    if (originalBin === undefined) {
      delete process.env.MCODA_CLAUDE_CLI_BIN;
    } else {
      process.env.MCODA_CLAUDE_CLI_BIN = originalBin;
    }
  }
});
