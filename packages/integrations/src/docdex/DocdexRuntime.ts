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

export interface DocdexHealthSummary {
  ok: boolean;
  message?: string;
  failedChecks?: Array<{ name?: string; status?: string; message?: string }>;
}

export interface DocdexChromiumDetails {
  path?: string;
  manifestPath?: string;
  installedAt?: string;
  version?: string;
  platform?: string;
  downloadUrl?: string;
}

export interface DocdexBrowserInfo {
  ok: boolean;
  message?: string;
  installHint?: string;
  autoInstallEnabled?: boolean;
  configuredKind?: string;
  chromium?: DocdexChromiumDetails;
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

const MAX_DOCDEX_SNIPPET = 240;

const formatDocdexSnippet = (value: string): string => {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_DOCDEX_SNIPPET) return trimmed;
  return `${trimmed.slice(0, MAX_DOCDEX_SNIPPET)}...`;
};

export const parseDocdexCheckOutput = (output: string): DocdexCheckResult => {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("Docdex check returned empty output");
  }

  const attempts: Array<{ label: string; candidate: string }> = [{ label: "full", candidate: trimmed }];
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    attempts.push({ label: "brace-slice", candidate: trimmed.slice(braceStart, braceEnd + 1) });
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    const joined = lines.slice(i).join("\n").trim();
    attempts.push({ label: "line-join", candidate: joined });
    break;
  }

  let lastError: Error | undefined;
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt.candidate) as DocdexCheckResult;
    } catch (error) {
      lastError = error as Error;
    }
  }

  const snippet = formatDocdexSnippet(trimmed);
  const message = lastError?.message ? `${lastError.message}. ` : "";
  throw new Error(`Docdex check returned invalid JSON: ${message}Output: "${snippet}"`);
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
  return parseDocdexCheckOutput(trimmed);
};

export const summarizeDocdexCheck = (check: DocdexCheckResult): DocdexHealthSummary => {
  const failures =
    check.checks?.filter((item) => item?.status && item.status !== "ok")?.map((item) => ({
      name: item.name,
      status: item.status,
      message: item.message,
    })) ?? [];
  if (check.success === false || failures.length > 0) {
    const details = failures
      .map((item) => {
        const head = item.name ? `${item.name}=${item.status ?? "error"}` : item.status ?? "error";
        const tail = item.message ? ` (${item.message})` : "";
        return `${head}${tail}`;
      })
      .join("; ");
    return {
      ok: false,
      message: details || "Docdex check failed.",
      failedChecks: failures,
    };
  }
  return { ok: true };
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

const coerceString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const coerceChromiumDetails = (value: unknown): DocdexChromiumDetails | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Record<string, unknown>;
  return {
    path: coerceString(details.path),
    manifestPath: coerceString(details.manifest_path ?? details.manifestPath),
    installedAt: coerceString(details.installed_at ?? details.installedAt),
    version: coerceString(details.version),
    platform: coerceString(details.platform),
    downloadUrl: coerceString(details.download_url ?? details.downloadUrl),
  };
};

const buildBrowserSetupHint = (installHint?: string): string => {
  const hint = installHint ?? "docdexd browser install";
  return `Run \`${hint}\` to install the headless Chromium browser.`;
};

export const parseDocdexBrowserCheck = (check: DocdexCheckResult): DocdexBrowserInfo => {
  const browserCheck = check.checks?.find((c) => c.name === "browser");
  const details = browserCheck?.details as Record<string, unknown> | undefined;
  const chromium = coerceChromiumDetails(details?.chromium);
  const installHint = coerceString(details?.install_hint);
  const autoInstallEnabled = typeof details?.auto_install_enabled === "boolean" ? details.auto_install_enabled : undefined;
  const configuredKind = coerceString(details?.configured_kind);
  if (!browserCheck) {
    const setupHint = buildBrowserSetupHint(installHint);
    return {
      ok: false,
      message: `Docdex browser check unavailable. ${setupHint}`,
      chromium,
      installHint,
      autoInstallEnabled,
      configuredKind,
    };
  }
  if (browserCheck.status !== "ok") {
    const setupHint = buildBrowserSetupHint(installHint);
    return {
      ok: false,
      message: `${browserCheck.message ?? "Docdex browser check failed."} ${setupHint}`,
      chromium,
      installHint,
      autoInstallEnabled,
      configuredKind,
    };
  }
  return {
    ok: true,
    chromium,
    installHint,
    autoInstallEnabled,
    configuredKind,
  };
};

export const resolveDocdexBrowserInfo = async (
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<DocdexBrowserInfo> => {
  try {
    const check = await readDocdexCheck(options);
    return parseDocdexBrowserCheck(check);
  } catch (error) {
    const setupHint = buildBrowserSetupHint();
    return {
      ok: false,
      message: `Docdex check failed: ${(error as Error).message}. ${setupHint}`,
    };
  }
};
