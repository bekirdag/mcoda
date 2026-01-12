import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const planPath = path.resolve(process.cwd(), "docs", "gateway-trio-plan.md");

test("gateway-trio plan locks decisions and includes status matrix", async () => {
  const content = await fs.readFile(planPath, "utf8");
  assert.ok(content.includes("Name: `mcoda gateway-trio`"));
  assert.ok(content.includes("### Status gating matrix"));
  assert.ok(content.includes("## Decisions (locked)"));
});
