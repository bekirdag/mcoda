import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseTerminalArguments } from "../TerminalCommand.js";

test("documented output and permission options preserve their existing aliases", () => {
  for (const profile of ["plan", "ask", "workspace"]) {
    const current = parseTerminalArguments(["exec", "do work", "--permission-profile", profile, "--output-format", "jsonl"]);
    const original = parseTerminalArguments(["exec", "do work", "--permissions", profile, "--json"]);
    assert.deepEqual(current, original);
  }
  assert.equal(parseTerminalArguments(["exec", "--json", "--output-format", "text"]).json, false);
  assert.equal(parseTerminalArguments(["exec", "--output-format", "text", "--json"]).json, true);
  assert.throws(() => parseTerminalArguments(["exec", "--output-format", "xml"]), /jsonl or text/);
  assert.throws(() => parseTerminalArguments(["exec", "--permission-profile", "unrestricted"]), /Invalid permission profile/);
  assert.throws(() => parseTerminalArguments(["exec", "--output-format"]), /Missing value/);
});

test("configuration validation accepts a file only on the config command", () => {
  const parsed = parseTerminalArguments(["config", "validate", "--file", "proposal.json"]);
  assert.equal(parsed.config, path.resolve("proposal.json"));
  assert.equal(parsed.prompt, "validate");
  assert.throws(() => parseTerminalArguments(["exec", "--file", "proposal.json"]), /config validate/);
});

test("actual CLI validates configuration without inference and reports JSONL startup failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-cli-contract-"));
  try {
    const config = path.join(root, "models.json");
    await fs.writeFile(config, JSON.stringify({ schemaVersion: 1, profile: "syntax-test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } }, models: { local: { provider: "local", catalogId: "fixture", revision: "1", operations: ["chat.completions"], contextWindow: 8192, maxOutputTokens: 1024, supportsTools: true } }, bindings: { lead: { candidates: ["local"] } } }));
    const cli = fileURLToPath(new URL("../../cli.js", import.meta.url));
    const validate = spawnSync(process.execPath, [cli, "config", "validate", "--file", config, "--output-format", "jsonl"], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(JSON.parse(validate.stdout).valid, true);
    const missing = spawnSync(process.execPath, [cli, "exec", "must not run", "--config", path.join(root, "absent.json"), "--output-format", "jsonl"], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).type, "command_failed");
    assert.equal(JSON.parse(missing.stdout).data.completed, false);
    assert.deepEqual(await fs.readdir(root), ["models.json"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
