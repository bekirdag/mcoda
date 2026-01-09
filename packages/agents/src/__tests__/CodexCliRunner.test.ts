import test from "node:test";
import assert from "node:assert/strict";
import { cliHealthy, runCodexExec, runCodexExecStream } from "../adapters/codex/CodexCliRunner.js";

test("Codex CLI runner uses stub outputs when MCODA_CLI_STUB=1", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  try {
    process.env.MCODA_CLI_STUB = "1";
    delete process.env.MCODA_SKIP_CLI_CHECKS;

    const health = cliHealthy();
    assert.equal(health.ok, true);
    assert.equal(health.details?.stub, true);

    const execResult = runCodexExec("hello");
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
