import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  readDocdexCheck,
  resolveDocdexBaseUrl,
  resolveDocdexBinary,
  resolveDocdexBrowserInfo,
  parseDocdexBrowserCheck,
  parseDocdexCheckOutput,
  summarizeDocdexCheck,
} from "../DocdexRuntime.js";

const shouldSkipDocdexCheck = process.platform === "win32" || process.env.MCODA_SKIP_DOCDEX_CHECKS === "1";

test("resolveDocdexBinary returns an existing binary path when docdex is installed", () => {
  const binary = resolveDocdexBinary();
  assert.ok(binary, "expected docdex binary to resolve");
  assert.ok(existsSync(binary), "expected docdex binary to exist on disk");
});

test("resolveDocdexBaseUrl respects explicit env overrides", async () => {
  const prevMcoda = process.env.MCODA_DOCDEX_URL;
  const prevDocdex = process.env.DOCDEX_URL;
  process.env.MCODA_DOCDEX_URL = "http://127.0.0.1:9999";
  delete process.env.DOCDEX_URL;
  try {
    const resolved = await resolveDocdexBaseUrl();
    assert.equal(resolved, "http://127.0.0.1:9999");
  } finally {
    if (prevMcoda === undefined) delete process.env.MCODA_DOCDEX_URL;
    else process.env.MCODA_DOCDEX_URL = prevMcoda;
    if (prevDocdex === undefined) delete process.env.DOCDEX_URL;
    else process.env.DOCDEX_URL = prevDocdex;
  }
});

test("readDocdexCheck returns parsed JSON output", async (t) => {
  if (shouldSkipDocdexCheck) {
    t.skip("docdex check can hang on Windows CI");
    return;
  }
  if (!resolveDocdexBinary()) {
    t.skip("docdex binary not available in this environment");
    return;
  }
  try {
    const result = await readDocdexCheck();
    assert.ok(result);
    assert.ok(Array.isArray(result.checks), "expected checks array");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Missing binary") || message.includes("Expected target triple")) {
      t.skip("docdexd binary not available for this platform");
      return;
    }
    throw error;
  }
});

test("resolveDocdexBrowserInfo returns a stable shape", async (t) => {
  if (shouldSkipDocdexCheck) {
    t.skip("docdex check can hang on Windows CI");
    return;
  }
  const info = await resolveDocdexBrowserInfo();
  assert.equal(typeof info.ok, "boolean");
  if (info.ok) {
    if (info.chromium) {
      assert.equal(typeof info.chromium, "object");
    }
  } else {
    assert.ok(info.message?.toLowerCase().includes("docdex"), "expected setup hint in failure message");
  }
});

test("parseDocdexBrowserCheck captures chromium details", () => {
  const info = parseDocdexBrowserCheck({
    checks: [
      {
        name: "browser",
        status: "ok",
        details: {
          install_hint: "docdexd browser install",
          auto_install_enabled: true,
          configured_kind: "chromium",
          chromium: {
            path: "/tmp/chromium",
            manifest_path: "/tmp/manifest.json",
            version: "123.0.0",
            platform: "darwin",
          },
        },
      },
    ],
  });
  assert.equal(info.ok, true);
  assert.equal(info.installHint, "docdexd browser install");
  assert.equal(info.autoInstallEnabled, true);
  assert.equal(info.configuredKind, "chromium");
  assert.equal(info.chromium?.path, "/tmp/chromium");
  assert.equal(info.chromium?.manifestPath, "/tmp/manifest.json");
  assert.equal(info.chromium?.version, "123.0.0");
  assert.equal(info.chromium?.platform, "darwin");
});

test("parseDocdexBrowserCheck reports missing browser check", () => {
  const info = parseDocdexBrowserCheck({ checks: [] });
  assert.equal(info.ok, false);
  assert.ok(info.message?.toLowerCase().includes("docdex"));
});

test("parseDocdexCheckOutput extracts JSON with log prefix", () => {
  const output = [
    "[docdex] Starting check",
    "[docdex] Ready",
    '{"success":true,"checks":[{"name":"bind","status":"ok"}]}',
  ].join("\n");
  const parsed = parseDocdexCheckOutput(output);
  assert.equal(parsed.success, true);
  assert.equal(parsed.checks?.[0]?.name, "bind");
});

test("parseDocdexCheckOutput throws with snippet on invalid output", () => {
  const output = "[docdex] Missing config: no daemon";
  assert.throws(() => parseDocdexCheckOutput(output), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes("Output:"));
    assert.ok(error.message.includes("Missing config"));
    return true;
  });
});

test("summarizeDocdexCheck reports failures", () => {
  const summary = summarizeDocdexCheck({
    success: false,
    checks: [
      { name: "bind", status: "error", message: "bind blocked" },
      { name: "ollama", status: "error", message: "ollama unreachable" },
    ],
  });
  assert.equal(summary.ok, false);
  assert.ok(summary.message?.includes("bind"));
  assert.ok(summary.message?.includes("ollama"));
  assert.equal(summary.failedChecks?.length, 2);
});
