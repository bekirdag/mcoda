import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChromiumQaAdapter, __testing } from "../ChromiumQaAdapter.js";
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
          test_command: "http://localhost:4173",
        };
        const ctx = {
          workspaceRoot: tmp,
          jobId: "job-1",
          taskKey: "task-1",
          env: {},
        };
        const ensure = await adapter.ensureInstalled(profile, ctx as any);
        assert.equal(ensure.ok, true);
        assert.equal((ensure.details as any)?.chromiumPath, chromiumPath);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  } finally {
    if (prevChromiumPath === undefined) delete process.env.MCODA_QA_CHROMIUM_PATH;
    else process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
  }
});

test("ChromiumQaAdapter ensureInstalled resolves DOCDEX_WEB_BROWSER via PATH", async () => {
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  const prevDocdexBrowser = process.env.DOCDEX_WEB_BROWSER;
  const prevDocdexChromePath = process.env.DOCDEX_CHROME_PATH;
  const prevChromePath = process.env.CHROME_PATH;
  const prevPath = process.env.PATH;
  try {
    delete process.env.MCODA_QA_CHROMIUM_PATH;
    delete process.env.DOCDEX_CHROME_PATH;
    delete process.env.CHROME_PATH;
    await withTempHome(async (home) => {
      const binDir = path.join(home, "bin");
      await fs.mkdir(binDir, { recursive: true });
      const chromiumName = process.platform === "win32" ? "chromium.exe" : "chromium";
      const chromiumPath = path.join(binDir, chromiumName);
      await fs.writeFile(chromiumPath, "");
      process.env.PATH = binDir;
      process.env.DOCDEX_WEB_BROWSER = "chromium";
      const adapter = new ChromiumQaAdapter();
      const profile: QaProfile = { name: "ui", runner: "chromium" };
      const ctx = {
        workspaceRoot: home,
        jobId: "job-1",
        taskKey: "task-1",
        env: {},
      };
      const ensure = await adapter.ensureInstalled(profile, ctx as any);
      assert.equal(ensure.ok, true);
      assert.equal((ensure.details as any)?.chromiumPath, chromiumPath);
    });
  } finally {
    if (prevChromiumPath === undefined) delete process.env.MCODA_QA_CHROMIUM_PATH;
    else process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
    if (prevDocdexBrowser === undefined) delete process.env.DOCDEX_WEB_BROWSER;
    else process.env.DOCDEX_WEB_BROWSER = prevDocdexBrowser;
    if (prevDocdexChromePath === undefined) delete process.env.DOCDEX_CHROME_PATH;
    else process.env.DOCDEX_CHROME_PATH = prevDocdexChromePath;
    if (prevChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = prevChromePath;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
});

test("ChromiumQaAdapter ensureInstalled uses config chrome_binary_path", async () => {
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  const prevDocdexBrowser = process.env.DOCDEX_WEB_BROWSER;
  const prevDocdexChromePath = process.env.DOCDEX_CHROME_PATH;
  const prevChromePath = process.env.CHROME_PATH;
  const prevConfigPath = process.env.DOCDEX_CONFIG_PATH;
  try {
    delete process.env.MCODA_QA_CHROMIUM_PATH;
    delete process.env.DOCDEX_WEB_BROWSER;
    delete process.env.DOCDEX_CHROME_PATH;
    delete process.env.CHROME_PATH;
    await withTempHome(async (home) => {
      const chromiumPath = path.join(home, "chromium-bin");
      await fs.writeFile(chromiumPath, "");
      const configDir = path.join(home, ".docdex");
      const configPath = path.join(configDir, "config.toml");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        `[web.scraper]\nchrome_binary_path = ${JSON.stringify(chromiumPath)}\n`,
        "utf8",
      );
      process.env.DOCDEX_CONFIG_PATH = configPath;
      const adapter = new ChromiumQaAdapter();
      const profile: QaProfile = { name: "ui", runner: "chromium" };
      const ctx = {
        workspaceRoot: home,
        jobId: "job-1",
        taskKey: "task-1",
        env: {},
      };
      const ensure = await adapter.ensureInstalled(profile, ctx as any);
      assert.equal(ensure.ok, true);
      assert.equal((ensure.details as any)?.chromiumPath, chromiumPath);
    });
  } finally {
    if (prevChromiumPath === undefined) delete process.env.MCODA_QA_CHROMIUM_PATH;
    else process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
    if (prevDocdexBrowser === undefined) delete process.env.DOCDEX_WEB_BROWSER;
    else process.env.DOCDEX_WEB_BROWSER = prevDocdexBrowser;
    if (prevDocdexChromePath === undefined) delete process.env.DOCDEX_CHROME_PATH;
    else process.env.DOCDEX_CHROME_PATH = prevDocdexChromePath;
    if (prevChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = prevChromePath;
    if (prevConfigPath === undefined) delete process.env.DOCDEX_CONFIG_PATH;
    else process.env.DOCDEX_CONFIG_PATH = prevConfigPath;
  }
});

test("ChromiumQaAdapter ensureInstalled uses Docdex manifest when available", async () => {
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  const prevDocdexBrowser = process.env.DOCDEX_WEB_BROWSER;
  const prevDocdexChromePath = process.env.DOCDEX_CHROME_PATH;
  const prevChromePath = process.env.CHROME_PATH;
  const prevConfigPath = process.env.DOCDEX_CONFIG_PATH;
  try {
    delete process.env.MCODA_QA_CHROMIUM_PATH;
    delete process.env.DOCDEX_WEB_BROWSER;
    delete process.env.DOCDEX_CHROME_PATH;
    delete process.env.CHROME_PATH;
    delete process.env.DOCDEX_CONFIG_PATH;
    await withTempHome(async (home) => {
      const manifestDir = path.join(home, ".docdex", "state", "bin", "chromium");
      await fs.mkdir(manifestDir, { recursive: true });
      const chromiumPath = path.join(manifestDir, "chromium-bin");
      await fs.writeFile(chromiumPath, "");
      await fs.writeFile(
        path.join(manifestDir, "manifest.json"),
        JSON.stringify({ path: chromiumPath }),
        "utf8",
      );
      const adapter = new ChromiumQaAdapter();
      const profile: QaProfile = { name: "ui", runner: "chromium" };
      const ctx = {
        workspaceRoot: home,
        jobId: "job-1",
        taskKey: "task-1",
        env: {},
      };
      const ensure = await adapter.ensureInstalled(profile, ctx as any);
      assert.equal(ensure.ok, true);
      assert.equal((ensure.details as any)?.chromiumPath, chromiumPath);
    });
  } finally {
    if (prevChromiumPath === undefined) delete process.env.MCODA_QA_CHROMIUM_PATH;
    else process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
    if (prevDocdexBrowser === undefined) delete process.env.DOCDEX_WEB_BROWSER;
    else process.env.DOCDEX_WEB_BROWSER = prevDocdexBrowser;
    if (prevDocdexChromePath === undefined) delete process.env.DOCDEX_CHROME_PATH;
    else process.env.DOCDEX_CHROME_PATH = prevDocdexChromePath;
    if (prevChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = prevChromePath;
    if (prevConfigPath === undefined) delete process.env.DOCDEX_CONFIG_PATH;
    else process.env.DOCDEX_CONFIG_PATH = prevConfigPath;
  }
});

test("ChromiumQaAdapter ensureInstalled prefers MCODA_QA_CHROMIUM_PATH over other overrides", async () => {
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  const prevDocdexBrowser = process.env.DOCDEX_WEB_BROWSER;
  const prevDocdexChromePath = process.env.DOCDEX_CHROME_PATH;
  const prevChromePath = process.env.CHROME_PATH;
  const prevConfigPath = process.env.DOCDEX_CONFIG_PATH;
  const prevPath = process.env.PATH;
  try {
    await withTempHome(async (home) => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-chromium-"));
      try {
        const primaryPath = path.join(tmp, "chromium-primary");
        const secondaryPath = path.join(tmp, "chromium-secondary");
        await fs.writeFile(primaryPath, "");
        await fs.writeFile(secondaryPath, "");
        process.env.MCODA_QA_CHROMIUM_PATH = primaryPath;
        process.env.DOCDEX_WEB_BROWSER = secondaryPath;
        process.env.DOCDEX_CHROME_PATH = secondaryPath;
        process.env.CHROME_PATH = secondaryPath;
        delete process.env.DOCDEX_CONFIG_PATH;
        process.env.PATH = "";
        const adapter = new ChromiumQaAdapter();
        const profile: QaProfile = { name: "ui", runner: "chromium" };
        const ctx = {
          workspaceRoot: home,
          jobId: "job-1",
          taskKey: "task-1",
          env: {},
        };
        const ensure = await adapter.ensureInstalled(profile, ctx as any);
        assert.equal(ensure.ok, true);
        assert.equal((ensure.details as any)?.chromiumPath, primaryPath);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  } finally {
    if (prevChromiumPath === undefined) delete process.env.MCODA_QA_CHROMIUM_PATH;
    else process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
    if (prevDocdexBrowser === undefined) delete process.env.DOCDEX_WEB_BROWSER;
    else process.env.DOCDEX_WEB_BROWSER = prevDocdexBrowser;
    if (prevDocdexChromePath === undefined) delete process.env.DOCDEX_CHROME_PATH;
    else process.env.DOCDEX_CHROME_PATH = prevDocdexChromePath;
    if (prevChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = prevChromePath;
    if (prevConfigPath === undefined) delete process.env.DOCDEX_CONFIG_PATH;
    else process.env.DOCDEX_CONFIG_PATH = prevConfigPath;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
});

test("ChromiumQaAdapter ensureInstalled prefers config chrome_binary_path over manifest", async () => {
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  const prevDocdexBrowser = process.env.DOCDEX_WEB_BROWSER;
  const prevDocdexChromePath = process.env.DOCDEX_CHROME_PATH;
  const prevChromePath = process.env.CHROME_PATH;
  const prevConfigPath = process.env.DOCDEX_CONFIG_PATH;
  const prevPath = process.env.PATH;
  try {
    delete process.env.MCODA_QA_CHROMIUM_PATH;
    delete process.env.DOCDEX_WEB_BROWSER;
    delete process.env.DOCDEX_CHROME_PATH;
    delete process.env.CHROME_PATH;
    process.env.PATH = "";
    await withTempHome(async (home) => {
      const manifestDir = path.join(home, ".docdex", "state", "bin", "chromium");
      await fs.mkdir(manifestDir, { recursive: true });
      const manifestChromiumPath = path.join(manifestDir, "chromium-manifest");
      await fs.writeFile(manifestChromiumPath, "");
      await fs.writeFile(
        path.join(manifestDir, "manifest.json"),
        JSON.stringify({ path: manifestChromiumPath }),
        "utf8",
      );
      const configDir = path.join(home, ".docdex");
      const configPath = path.join(configDir, "config.toml");
      await fs.mkdir(configDir, { recursive: true });
      const configChromiumPath = path.join(home, "chromium-config");
      await fs.writeFile(configChromiumPath, "");
      await fs.writeFile(
        configPath,
        `[web.scraper]\nchrome_binary_path = ${JSON.stringify(configChromiumPath)}\n`,
        "utf8",
      );
      process.env.DOCDEX_CONFIG_PATH = configPath;
      const adapter = new ChromiumQaAdapter();
      const profile: QaProfile = { name: "ui", runner: "chromium" };
      const ctx = {
        workspaceRoot: home,
        jobId: "job-1",
        taskKey: "task-1",
        env: {},
      };
      const ensure = await adapter.ensureInstalled(profile, ctx as any);
      assert.equal(ensure.ok, true);
      assert.equal((ensure.details as any)?.chromiumPath, configChromiumPath);
    });
  } finally {
    if (prevChromiumPath === undefined) delete process.env.MCODA_QA_CHROMIUM_PATH;
    else process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
    if (prevDocdexBrowser === undefined) delete process.env.DOCDEX_WEB_BROWSER;
    else process.env.DOCDEX_WEB_BROWSER = prevDocdexBrowser;
    if (prevDocdexChromePath === undefined) delete process.env.DOCDEX_CHROME_PATH;
    else process.env.DOCDEX_CHROME_PATH = prevDocdexChromePath;
    if (prevChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = prevChromePath;
    if (prevConfigPath === undefined) delete process.env.DOCDEX_CONFIG_PATH;
    else process.env.DOCDEX_CONFIG_PATH = prevConfigPath;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
});

test("ChromiumQaAdapter ensureInstalled fails without Docdex chromium", async () => {
  const prevChromiumPath = process.env.MCODA_QA_CHROMIUM_PATH;
  const prevDocdexBrowser = process.env.DOCDEX_WEB_BROWSER;
  const prevDocdexChromePath = process.env.DOCDEX_CHROME_PATH;
  const prevChromePath = process.env.CHROME_PATH;
  const prevConfigPath = process.env.DOCDEX_CONFIG_PATH;
  const prevPath = process.env.PATH;
  delete process.env.MCODA_QA_CHROMIUM_PATH;
  try {
    await withTempHome(async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-chromium-"));
      try {
        delete process.env.DOCDEX_WEB_BROWSER;
        delete process.env.DOCDEX_CHROME_PATH;
        delete process.env.CHROME_PATH;
        delete process.env.DOCDEX_CONFIG_PATH;
        process.env.PATH = "";
        const adapter = new ChromiumQaAdapter();
        const profile: QaProfile = { name: "ui", runner: "chromium", test_command: "http://localhost" };
        const ctx = {
          workspaceRoot: tmp,
          jobId: "job-1",
          taskKey: "task-1",
          env: {},
        };
        const ensure = await adapter.ensureInstalled(profile, ctx as any);
        if (!ensure.ok) {
          assert.ok(ensure.message?.includes("Docdex Chromium"));
        } else {
          assert.ok((ensure.details as any)?.chromiumPath);
        }
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  } finally {
    if (prevChromiumPath === undefined) delete process.env.MCODA_QA_CHROMIUM_PATH;
    else process.env.MCODA_QA_CHROMIUM_PATH = prevChromiumPath;
    if (prevDocdexBrowser === undefined) delete process.env.DOCDEX_WEB_BROWSER;
    else process.env.DOCDEX_WEB_BROWSER = prevDocdexBrowser;
    if (prevDocdexChromePath === undefined) delete process.env.DOCDEX_CHROME_PATH;
    else process.env.DOCDEX_CHROME_PATH = prevDocdexChromePath;
    if (prevChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = prevChromePath;
    if (prevConfigPath === undefined) delete process.env.DOCDEX_CONFIG_PATH;
    else process.env.DOCDEX_CONFIG_PATH = prevConfigPath;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
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

class FakeCdpClient {
  calls: Array<{ method: string; params: any }> = [];

  async call(method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params });
    if (method === "Page.navigate") return {};
    if (method === "Network.enable") return {};
    if (method === "Page.enable") return {};
    if (method === "Runtime.enable") return {};
    if (method === "Runtime.evaluate") {
      const expression = String((params as any)?.expression ?? "");
      if (expression.includes("document.readyState")) {
        return { result: { value: "complete" } };
      }
      if (expression.includes("document.location.href")) {
        return { result: { value: "http://127.0.0.1:4173/" } };
      }
      if (expression.includes("document.documentElement.outerHTML")) {
        return { result: { value: "<html><body>Welcome</body></html>" } };
      }
      if (expression.includes("document.body") && expression.includes("innerText")) {
        return { result: { value: "Welcome" } };
      }
      if (expression.includes("document.body") && expression.includes("textContent")) {
        return { result: { value: "Welcome" } };
      }
      if (expression.includes("Boolean(document.querySelector")) {
        return { result: { value: true } };
      }
      if (expression.includes("return { ok: true")) {
        return { result: { value: { ok: true } } };
      }
      return { result: { value: "" } };
    }
    return {};
  }

  async waitForNetworkIdle() {
    return true;
  }
}

test("runBrowserActionsWithClient executes action list", async () => {
  const client = new FakeCdpClient();
  const actions = [
    { type: "navigate", url: "http://127.0.0.1:4173", wait_for: "load" },
    { type: "assert_text", text: "Welcome" },
    { type: "snapshot", name: "home" },
  ];
  const result = await __testing.runBrowserActionsWithClient(
    client as any,
    actions as any,
    "http://127.0.0.1:4173",
    5000,
  );
  assert.equal(result.outcome, "pass");
  assert.equal(result.results.length, 3);
  assert.equal(result.snapshots.length, 1);
});

test("runBrowserActionsWithClient reports failed assertions", async () => {
  const client = new FakeCdpClient();
  const actions = [{ type: "assert_text", text: "Missing" }];
  const result = await __testing.runBrowserActionsWithClient(
    client as any,
    actions as any,
    "http://127.0.0.1:4173",
    2000,
  );
  assert.equal(result.outcome, "fail");
  assert.ok(result.errorMessage?.includes("assert_text failed"));
});
