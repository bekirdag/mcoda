import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const usagePath = path.resolve(process.cwd(), "docs", "usage.md");
const sdsPath = path.resolve(process.cwd(), "docs", "sds", "sds.md");

test("gateway-trio docs mention usage and SDS behavior", async () => {
  const usage = await fs.readFile(usagePath, "utf8");
  const sds = await fs.readFile(sdsPath, "utf8");
  assert.ok(usage.includes("mcoda gateway-trio"));
  assert.ok(sds.includes("gateway-trio"));
});
