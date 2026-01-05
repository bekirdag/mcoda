import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "../repositories/workspace/WorkspaceRepository.js";

test("WorkspaceRepository createProjectIfMissing is idempotent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-db-"));
  const repo = await WorkspaceRepository.create(dir);
  try {
    const first = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    const second = await repo.createProjectIfMissing({ key: "proj", name: "Project" });
    assert.equal(first.id, second.id);
  } finally {
    await repo.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
