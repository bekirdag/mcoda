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
  const extractInfoVersion = (content) => {
    const lines = content.split("\n");
    let inInfo = false;
    for (const line of lines) {
      if (!inInfo && /^info:\s*$/.test(line)) {
        inInfo = true;
        continue;
      }
      if (inInfo) {
        if (/^\S/.test(line)) break;
        const match = line.match(/^\s+version:\s*(.+)\s*$/);
        if (match) return match[1]?.trim();
      }
    }
    return undefined;
  };
  const primaryVersion = extractInfoVersion(raw);

  const requiredPaths = ["/agents", "/tasks/{id}", "/workspaces/{id}/backlog", "/system/ping"];
  for (const entry of requiredPaths) {
    const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\s*${escaped}:`, "m");
    assert.ok(pattern.test(raw), `Missing OpenAPI path: ${entry}`);
    const operationPattern = new RegExp(
      `^\\s*${escaped}:\\n(?:\\s{2,}.*\\n)*?\\s+operationId:\\s*\\S+`,
      "m",
    );
    assert.ok(operationPattern.test(raw), `Missing operationId for path: ${entry}`);
  }

  const adminSpecPath = path.join(root, "openapi", "mcoda-admin.yaml");
  const adminExists = await fs
    .access(adminSpecPath)
    .then(() => true)
    .catch(() => false);
  if (adminExists) {
    const adminRaw = await fs.readFile(adminSpecPath, "utf8");
    const adminOpenapiLine = adminRaw.split("\n").find((line) => line.startsWith("openapi:"));
    assert.ok(adminOpenapiLine, "Missing admin openapi version line");
    assert.equal(adminOpenapiLine?.trim(), openapiLine?.trim());
    const adminVersion = extractInfoVersion(adminRaw);
    if (primaryVersion || adminVersion) {
      assert.equal(adminVersion, primaryVersion);
    }
  }
});
