import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("OpenAPI spec includes core endpoints", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const specPath = path.join(root, "openapi", "mcoda.yaml");
  const raw = await fs.readFile(specPath, "utf8");
  const openapiLine = raw.split("\n").find((line) => line.startsWith("openapi:"));
  assert.ok(openapiLine, "Missing openapi version line");
  assert.ok(openapiLine?.includes("3."), "Expected OpenAPI 3.x version");

  const requiredPaths = ["/agents", "/tasks/{id}", "/workspaces/{id}/backlog", "/system/ping"];
  for (const entry of requiredPaths) {
    const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\s*${escaped}:`, "m");
    assert.ok(pattern.test(raw), `Missing OpenAPI path: ${entry}`);
  }
});
