import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSearchTool } from "../search/SearchTool.js";

const runTool = async (workspaceRoot: string, query: string) => {
  const tool = createSearchTool();
  return tool.handler({ query }, { workspaceRoot });
};

test("SearchTool finds text in workspace", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-search-"));
  const samplePath = path.join(workspaceRoot, "sample.txt");
  writeFileSync(samplePath, "needle\n", "utf8");

  const result = await runTool(workspaceRoot, "needle");
  assert.match(result.output, /sample\.txt/);
  assert.match(result.output, /needle/);
});
