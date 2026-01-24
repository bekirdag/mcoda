import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChromiumQaAdapter } from "../ChromiumQaAdapter.js";
import { QaProfile } from "@mcoda/shared/qa/QaProfile.js";

const withTempHome = async <T>(fn: (home: string) => Promise<T>): Promise<T> => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    await fs.rm(home, { recursive: true, force: true });
  }
};

test("ChromiumQaAdapter ensureInstalled succeeds with Docdex chromium", async () => {
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  try {
    await withTempHome(async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-chromium-"));
      try {
        const adapter = new ChromiumQaAdapter();
        const chromiumPath = path.join(tmp, "chromium-bin");
        await fs.writeFile(chromiumPath, "");
        process.env.MCODA_QA_CHROMIUM_PATH = chromiumPath;
        const profile: QaProfile = {
          name: "ui",
          runner: "chromium",
          test_command: "http://localhost:3000",
        };
        const ctx = {
          workspaceRoot: tmp,
          jobId: "job-1",
          taskKey: "task-1",
          env: {},
        };
        const ensure = await adapter.ensureInstalled(profile, ctx as any);
        assert.equal(ensure.ok, true);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  } finally {
    if (prevChromiumPath === undefined) delete process.env.MCODA_QA_CHROMIUM_PATH;
    else process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
  }
});

test("ChromiumQaAdapter ensureInstalled fails without Docdex chromium", async () => {
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  delete process.env.MCODA_QA_CHROMIUM_PATH;
  try {
    await withTempHome(async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-chromium-"));
      try {
        const adapter = new ChromiumQaAdapter();
        const profile: QaProfile = { name: "ui", runner: "chromium", test_command: "http://localhost" };
        const ctx = {
          workspaceRoot: tmp,
          jobId: "job-1",
          taskKey: "task-1",
          env: {},
        };
        const ensure = await adapter.ensureInstalled(profile, ctx as any);
        assert.equal(ensure.ok, false);
        assert.ok(ensure.message?.includes("Docdex Chromium"));
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  } finally {
    if (prevChromiumPath === undefined) delete process.env.MCODA_QA_CHROMIUM_PATH;
    else process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
  }
});

test("ChromiumQaAdapter ensureInstalled succeeds when no URL is configured", async () => {
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  try {
    await withTempHome(async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-chromium-"));
      try {
        const adapter = new ChromiumQaAdapter();
        const chromiumPath = path.join(tmp, "chromium-bin");
        await fs.writeFile(chromiumPath, "");
        process.env.MCODA_QA_CHROMIUM_PATH = chromiumPath;
        const profile: QaProfile = { name: "ui", runner: "chromium" };
        const ctx = {
          workspaceRoot: tmp,
          jobId: "job-1",
          taskKey: "task-1",
          env: {},
        };
        const ensure = await adapter.ensureInstalled(profile, ctx as any);
        assert.equal(ensure.ok, true);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  } finally {
    if (prevChromiumPath === undefined) delete process.env.MCODA_QA_CHROMIUM_PATH;
    else process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
  }
});
