import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { QaProfileService } from "../QaProfileService.js";
import { PathHelper } from "@mcoda/shared";

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
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-profile-"));
  const configDir = PathHelper.getWorkspaceDir(dir);
  await fs.mkdir(configDir, { recursive: true });
  const profiles = [
    { name: "unit", runner: "cli", default: true, matcher: { task_types: ["backend"] } },
    { name: "mobile", runner: "maestro", matcher: { tags: ["mobile"] } },
  ];
  await fs.writeFile(
    path.join(configDir, "qa-profiles.json"),
    JSON.stringify(profiles, null, 2),
    "utf8",
  );
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
    await fs.rm(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("QaProfileService honors explicit profile even when runner preference differs", async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-profile-"));
  const configDir = PathHelper.getWorkspaceDir(dir);
  await fs.mkdir(configDir, { recursive: true });
  const profiles = [
    { name: "cli", runner: "cli", default: true },
    { name: "chromium", runner: "chromium" },
  ];
  await fs.writeFile(path.join(configDir, "qa-profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  const service = new QaProfileService(dir);

  try {
    const explicit = await service.resolveProfileForTask(makeTask("t-1", "backend"), { profileName: "chromium" });
    assert.equal(explicit?.name, "chromium");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("QaProfileService resolves multiple profiles for UI-capable projects", async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-profile-"));
  const configDir = PathHelper.getWorkspaceDir(dir);
  await fs.mkdir(configDir, { recursive: true });
  const profiles = [
    { name: "cli", runner: "cli", default: true },
    { name: "chromium", runner: "chromium" },
  ];
  await fs.writeFile(path.join(configDir, "qa-profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  await fs.mkdir(path.join(dir, "src", "public"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src", "public", "index.html"),
    "<!doctype html>",
    "utf8",
  );
  const service = new QaProfileService(dir);

  try {
    const resolved = await service.resolveProfilesForTask(
      makeTask("t-ui", "backend", { files: ["src/components/App.tsx"] }),
    );
    assert.deepEqual(
      resolved.map((profile) => profile.name),
      ["cli", "chromium"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("QaProfileService prefers qa metadata profiles when present", async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-profile-"));
  const configDir = PathHelper.getWorkspaceDir(dir);
  await fs.mkdir(configDir, { recursive: true });
  const profiles = [
    { name: "cli", runner: "cli", default: true },
    { name: "chromium", runner: "chromium" },
  ];
  await fs.writeFile(path.join(configDir, "qa-profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  const service = new QaProfileService(dir);

  try {
    const resolved = await service.resolveProfilesForTask(
      makeTask("t-meta", "backend", { qa: { profiles_expected: ["chromium"] } }),
    );
    assert.deepEqual(
      resolved.map((profile) => profile.name),
      ["chromium"],
    );
    const resolvedApi = await service.resolveProfilesForTask(
      makeTask("t-api", "backend", { qa: { profiles_expected: ["api"] } }),
    );
    assert.deepEqual(
      resolvedApi.map((profile) => profile.name),
      ["cli"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("QaProfileService avoids chromium for non-UI tasks", async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-profile-"));
  const configDir = PathHelper.getWorkspaceDir(dir);
  await fs.mkdir(configDir, { recursive: true });
  const profiles = [
    { name: "cli", runner: "cli", default: true },
    { name: "chromium", runner: "chromium" },
  ];
  await fs.writeFile(path.join(configDir, "qa-profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  await fs.mkdir(path.join(dir, "src", "public"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src", "public", "index.html"),
    "<!doctype html>",
    "utf8",
  );
  const service = new QaProfileService(dir);

  try {
    const resolved = await service.resolveProfilesForTask(makeTask("t-cli", "backend"));
    assert.deepEqual(
      resolved.map((profile) => profile.name),
      ["cli"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("QaProfileService ignores review UI paths for backend tasks without explicit UI signals", async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-profile-"));
  const configDir = PathHelper.getWorkspaceDir(dir);
  await fs.mkdir(configDir, { recursive: true });
  const profiles = [
    { name: "cli", runner: "cli", default: true },
    { name: "chromium", runner: "chromium" },
  ];
  await fs.writeFile(path.join(configDir, "qa-profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  await fs.mkdir(path.join(dir, "src", "public"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src", "public", "index.html"),
    "<!doctype html>",
    "utf8",
  );
  const service = new QaProfileService(dir);

  try {
    const resolved = await service.resolveProfilesForTask(
      makeTask("bck-01-us-01-t01", "backend", {
        last_review_changed_paths: ["src/public/index.html"],
      }),
    );
    assert.deepEqual(
      resolved.map((profile) => profile.name),
      ["cli"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("QaProfileService treats web-prefixed tasks as UI", async () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-profile-"));
  const configDir = PathHelper.getWorkspaceDir(dir);
  await fs.mkdir(configDir, { recursive: true });
  const profiles = [
    { name: "cli", runner: "cli", default: true },
    { name: "chromium", runner: "chromium" },
  ];
  await fs.writeFile(path.join(configDir, "qa-profiles.json"), JSON.stringify(profiles, null, 2), "utf8");
  await fs.mkdir(path.join(dir, "src", "public"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src", "public", "index.html"),
    "<!doctype html>",
    "utf8",
  );
  const service = new QaProfileService(dir);

  try {
    const resolved = await service.resolveProfilesForTask(makeTask("web-01-us-01-t01", "backend"));
    assert.deepEqual(
      resolved.map((profile) => profile.name),
      ["cli", "chromium"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});
