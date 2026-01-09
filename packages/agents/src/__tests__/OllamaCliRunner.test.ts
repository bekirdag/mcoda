import test from "node:test";
import assert from "node:assert/strict";
import { ollamaHealthy, runOllamaExec } from "../adapters/ollama/OllamaCliRunner.js";

test("Ollama CLI health returns failure details when CLI missing", { concurrency: false }, () => {
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const result = ollamaHealthy();
    assert.equal(result.ok, false);
    assert.equal(result.details?.reason, "missing_cli");
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test("Ollama CLI exec throws when CLI missing", { concurrency: false }, () => {
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "";
    assert.throws(() => runOllamaExec("hello"), /AUTH_ERROR: ollama CLI unavailable/);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});
