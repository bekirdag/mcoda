import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface DocdexCheckResult {
  status?: string;
  success?: boolean;
  checks?: Array<{
    name?: string;
    status?: string;
    message?: string;
    details?: Record<string, unknown>;
  }>;
}

export interface DocdexBrowserInfo {
  ok: boolean;
  message?: string;
  browsersPath?: string;
  browsers?: Array<{ name?: string; path?: string; version?: string }>;
}

const DOCDEX_ENV_URLS = ["MCODA_DOCDEX_URL", "DOCDEX_URL"];
const DEFAULT_DOCDEX_STATE_DIR = path.join(os.homedir(), ".docdex", "state");

const buildDocdexEnv = (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const merged = { ...process.env, ...(env ?? {}) };
  if (!merged.DOCDEX_STATE_DIR) {
    merged.DOCDEX_STATE_DIR = DEFAULT_DOCDEX_STATE_DIR;
  }
  return merged;
};

const resolveDocdexPackageRoot = (): string | undefined => {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("docdex/package.json");
    return path.dirname(pkgPath);
  } catch {
    return undefined;
  }
};

export const resolveDocdexBinary = (): string | undefined => {
  const root = resolveDocdexPackageRoot();
  if (!root) return undefined;
  return path.join(root, "bin", "docdex.js");
};

export const resolvePlaywrightCli = (): string | undefined => {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("playwright/cli.js");
  } catch {
    // fall through to docdex-local resolution
  }
  const root = resolveDocdexPackageRoot();
  if (!root) return undefined;
  try {
    const requireFromDocdex = createRequire(path.join(root, "package.json"));
    return requireFromDocdex.resolve("playwright/cli.js");
  } catch {
    return undefined;
  }
};

export const runDocdex = async (
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> => {
  const binary = resolveDocdexBinary();
  if (!binary) {
    throw new Error("Docdex npm package not found. Install docdex and retry.");
  }
  const { stdout, stderr } = await execFile(process.execPath, [binary, ...args], {
    cwd: options.cwd,
    env: buildDocdexEnv(options.env),
  });
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
};

export const readDocdexCheck = async (options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<DocdexCheckResult> => {
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await runDocdex(["check"], options));
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    stdout = typeof execError.stdout === "string" ? execError.stdout : execError.stdout?.toString() ?? "";
    stderr = typeof execError.stderr === "string" ? execError.stderr : execError.stderr?.toString() ?? "";
    if (!stdout && !stderr) {
      throw error;
    }
  }
  const trimmed = stdout.trim() || stderr.trim();
  if (!trimmed) {
    throw new Error("Docdex check returned empty output");
  }
  try {
    return JSON.parse(trimmed) as DocdexCheckResult;
  } catch (error) {
    throw new Error(`Docdex check returned invalid JSON: ${(error as Error).message}`);
  }
};

export const resolveDocdexBaseUrl = async (options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string | undefined> => {
  for (const key of DOCDEX_ENV_URLS) {
    const envValue = process.env[key];
    if (envValue) return envValue;
  }
  if (
    process.env.MCODA_SKIP_DOCDEX_CHECKS === "1" ||
    process.env.MCODA_SKIP_DOCDEX_RUNTIME_CHECKS === "1" ||
    (process.platform === "win32" && process.env.CI)
  ) {
    return undefined;
  }
  try {
    const check = await readDocdexCheck(options);
    const bind = check.checks?.find((c) => c.name === "bind")?.details as Record<string, unknown> | undefined;
    const bindAddr = bind?.bind_addr as string | undefined;
    if (!bindAddr) return undefined;
    if (bindAddr.startsWith("http://") || bindAddr.startsWith("https://")) return bindAddr;
    return `http://${bindAddr}`;
  } catch {
    return undefined;
  }
};

export const resolveDocdexBrowserInfo = async (
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<DocdexBrowserInfo> => {
  const setupHint = "Run `docdex setup` to install Playwright and at least one browser.";
  try {
    const check = await readDocdexCheck(options);
    const browserCheck = check.checks?.find((c) => c.name === "browser");
    if (!browserCheck || browserCheck.status !== "ok") {
      return {
        ok: false,
        message: `${browserCheck?.message ?? "Docdex browser check failed."} ${setupHint}`,
      };
    }
    const details = browserCheck.details ?? {};
    const playwright = (details.playwright as Record<string, unknown>) ?? {};
    const browsers = Array.isArray(playwright.browsers) ? playwright.browsers : [];
    if (!browsers.length) {
      return {
        ok: false,
        message: `Docdex has no Playwright browsers configured. ${setupHint}`,
      };
    }
    const browsersPath = typeof playwright.browsers_path === "string" ? playwright.browsers_path : undefined;
    return {
      ok: true,
      browsersPath,
      browsers,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Docdex check failed: ${(error as Error).message}. ${setupHint}`,
    };
  }
};
