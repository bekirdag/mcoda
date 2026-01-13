import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  readDocdexCheck,
  resolveDocdexBaseUrl,
  resolveDocdexBinary,
  resolveDocdexBrowserInfo,
  resolvePlaywrightCli,
} from "../DocdexRuntime.js";

const shouldSkipDocdexCheck = process.platform === "win32" || process.env.MCODA_SKIP_DOCDEX_CHECKS === "1";

test("resolveDocdexBinary returns an existing binary path when docdex is installed", () => {
  const binary = resolveDocdexBinary();
  assert.ok(binary, "expected docdex binary to resolve");
  assert.ok(existsSync(binary), "expected docdex binary to exist on disk");
});

test("resolvePlaywrightCli returns an existing path when available", () => {
  const cli = resolvePlaywrightCli();
  if (cli) {
    assert.ok(existsSync(cli), "expected playwright cli to exist on disk");
  }
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
  const result = await readDocdexCheck();
  assert.ok(result);
  assert.ok(Array.isArray(result.checks), "expected checks array");
});

test("resolveDocdexBrowserInfo returns a stable shape", async (t) => {
  if (shouldSkipDocdexCheck) {
    t.skip("docdex check can hang on Windows CI");
    return;
  }
  const info = await resolveDocdexBrowserInfo();
  assert.equal(typeof info.ok, "boolean");
  if (info.ok) {
    assert.ok(Array.isArray(info.browsers), "expected browsers array when ok");
  } else {
    assert.ok(info.message?.includes("docdex setup"), "expected setup hint in failure message");
  }
});

test("resolveDocdexBrowserInfo reports missing Playwright CLI", async () => {
  const prev = process.env.MCODA_FORCE_NO_PLAYWRIGHT;
  process.env.MCODA_FORCE_NO_PLAYWRIGHT = "1";
  try {
    const info = await resolveDocdexBrowserInfo();
    assert.equal(info.ok, false);
    assert.ok(info.message?.toLowerCase().includes("playwright cli"));
    assert.ok(info.message?.toLowerCase().includes("docdex setup"));
  } finally {
    if (prev === undefined) delete process.env.MCODA_FORCE_NO_PLAYWRIGHT;
    else process.env.MCODA_FORCE_NO_PLAYWRIGHT = prev;
  }
});
