import test from "node:test";
import assert from "node:assert/strict";
import { createTimeTool } from "../TimeTool.js";

test("clock reports the supplied host instant with timezone and provenance", async () => {
  const instant = Date.parse("2026-10-29T23:30:00Z");
  const tool = createTimeTool(() => instant);
  const utc = JSON.parse((await tool.handler({}, { workspaceRoot: "." })).output);
  assert.equal(utc.utc, "2026-10-29T23:30:00.000Z"); assert.equal(utc.unixMilliseconds, instant);
  assert.equal(utc.timezone, "UTC"); assert.match(utc.source, /execution host/);
  const tokyo = JSON.parse((await tool.handler({ timezone: "Asia/Tokyo" }, { workspaceRoot: "." })).output);
  assert.equal(tokyo.utc, utc.utc); assert.match(tokyo.local, /2026-10-30/); assert.match(tokyo.local, /08:30:00/);
});

test("clock validates timezone and honors cancellation before reading time", async () => {
  let reads = 0; const tool = createTimeTool(() => { reads++; return 0; });
  await assert.rejects(tool.handler({ timezone: "Mars/Olympus" }, { workspaceRoot: "." }), /IANA timezone/);
  await assert.rejects(tool.handler({}, { workspaceRoot: ".", signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
  assert.equal(reads, 0);
});
