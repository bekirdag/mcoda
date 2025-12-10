import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { QaProfileService } from "../QaProfileService.js";

const makeTask = (key: string, type?: string, metadata?: Record<string, unknown>) =>
  ({
    id: key,
    projectId: "proj",
    epicId: "epic",
    userStoryId: "story",
    key,
    title: "Task",
    description: "",
    status: "ready_to_qa",
    type,
    storyPoints: 1,
    priority: 1,
    metadata,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as any;

test("QaProfileService resolves by tag/type and falls back to default", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-profile-"));
  const configDir = path.join(dir, ".mcoda");
  await fs.mkdir(configDir, { recursive: true });
  const profiles = [
    { name: "unit", runner: "cli", default: true, matcher: { task_types: ["backend"] } },
    { name: "mobile", runner: "maestro", matcher: { tags: ["mobile"] } },
  ];
  await fs.writeFile(path.join(configDir, "qa-profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  const service = new QaProfileService(dir);

  try {
    const tagged = await service.resolveProfileForTask(makeTask("t-1", "frontend", { tags: ["mobile"] }));
    assert.equal(tagged?.name, "mobile");

    const typed = await service.resolveProfileForTask(makeTask("t-2", "backend"));
    assert.equal(typed?.name, "unit");

    const fallback = await service.resolveProfileForTask(makeTask("t-3", "docs"));
    assert.equal(fallback?.name, "unit");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
