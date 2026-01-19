import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { WorkspaceResolver } from "@mcoda/core";
import { WorkspaceRepository } from "@mcoda/db";

const USAGE = "Usage: mcoda set-workspace [--workspace-root <path>] [--no-git] [--no-docdex]";
const DOCDEX_ENV_URLS = ["MCODA_DOCDEX_URL", "DOCDEX_URL"];

export const parseSetWorkspaceArgs = (argv: string[]): { workspaceRoot?: string; git: boolean; docdex: boolean } => {
  let workspaceRoot: string | undefined;
  let git = true;
  let docdex = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--workspace-root":
        workspaceRoot = argv[i + 1];
        i += 1;
        break;
      case "--no-git":
        git = false;
        break;
      case "--no-docdex":
        docdex = false;
        break;
      case "--help":
      case "-h":
        throw new Error(USAGE);
      default:
        break;
    }
  }
  return { workspaceRoot, git, docdex };
};

const ensureConfigFile = async (mcodaDir: string): Promise<void> => {
  const configPath = path.join(mcodaDir, "config.json");
  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(configPath, "{}", "utf8");
  }
};

const readWorkspaceConfig = async (mcodaDir: string): Promise<Record<string, unknown>> => {
  const configPath = path.join(mcodaDir, "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const writeWorkspaceConfig = async (mcodaDir: string, config: Record<string, unknown>): Promise<void> => {
  const configPath = path.join(mcodaDir, "config.json");
  await fs.mkdir(mcodaDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
};

const normalizeDocdexUrl = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const extractDocdexUrlFromCheck = (output: string): string | undefined => {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed];
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(trimmed.slice(braceStart, braceEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, any>;
      const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
      const bind = checks.find((check: any) => check?.name === "bind");
      const bindAddr = bind?.details?.bind_addr ?? bind?.details?.bindAddr;
      if (typeof bindAddr === "string" && bindAddr.trim().length > 0) {
        return bindAddr.startsWith("http://") || bindAddr.startsWith("https://")
          ? bindAddr
          : `http://${bindAddr}`;
      }
    } catch {
      // ignore parse errors
    }
  }
  const urlMatch = trimmed.match(/https?:\/\/[^\s]+/);
  if (urlMatch) return urlMatch[0];
  const onMatch = trimmed.match(/\bon\s+([^\s;]+:\d+)\b/i);
  if (onMatch) {
    return `http://${onMatch[1].replace(/[;,]$/, "")}`;
  }
  const hostPortMatch = trimmed.match(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[a-zA-Z0-9.-]+):\d{2,5}\b/);
  if (hostPortMatch) return `http://${hostPortMatch[0]}`;
  const bindMatch = trimmed.match(/bind_addr[:=]\s*([0-9.:]+(?:\:\d+)?)/i);
  if (bindMatch) return `http://${bindMatch[1]}`;
  return undefined;
};

const resolveDocdexUrl = (workspaceRoot: string): string | undefined => {
  for (const key of DOCDEX_ENV_URLS) {
    const value = process.env[key];
    if (value && value.trim().length > 0) return normalizeDocdexUrl(value);
  }
  try {
    const stdout = execFileSync("docdexd", ["check"], {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = stdout ? stdout.toString() : "";
    const parsed = extractDocdexUrlFromCheck(output);
    if (parsed) return normalizeDocdexUrl(parsed);
  } catch (error: any) {
    const stdout = error?.stdout ? error.stdout.toString() : "";
    const stderr = error?.stderr ? error.stderr.toString() : "";
    const parsed = extractDocdexUrlFromCheck(stdout) ?? extractDocdexUrlFromCheck(stderr);
    if (parsed) return normalizeDocdexUrl(parsed);
  }
  return undefined;
};

const ensureDocdexUrl = async (mcodaDir: string, workspaceRoot: string): Promise<string | undefined> => {
  const config = await readWorkspaceConfig(mcodaDir);
  const existing = typeof config.docdexUrl === "string" ? config.docdexUrl.trim() : "";
  if (existing) return existing;
  const resolved = resolveDocdexUrl(workspaceRoot);
  if (!resolved) return undefined;
  await writeWorkspaceConfig(mcodaDir, { ...config, docdexUrl: resolved });
  return resolved;
};

const ensureDocsDirs = async (mcodaDir: string): Promise<void> => {
  await fs.mkdir(path.join(mcodaDir, "docs", "pdr"), { recursive: true });
  await fs.mkdir(path.join(mcodaDir, "docs", "sds"), { recursive: true });
  await fs.mkdir(path.join(mcodaDir, "jobs"), { recursive: true });
};

const ensureGitRepo = async (workspaceRoot: string): Promise<boolean> => {
  try {
    await fs.access(path.join(workspaceRoot, ".git"));
    return false;
  } catch {
    try {
      execSync("git init", { cwd: workspaceRoot, stdio: "ignore" });
      return true;
    } catch {
      // ignore git init failures; user can init later
      return false;
    }
  }
};

const ensureCodexTrust = async (workspaceRoot: string): Promise<boolean> => {
  try {
    execSync("codex --version", { stdio: "ignore" });
  } catch {
    return false;
  }
  try {
    execSync(`codex trust add "${workspaceRoot}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const ensureDocdexIndex = async (workspaceRoot: string): Promise<boolean> => {
  const resolveDocdexBin = (): string | undefined => {
    try {
      const require = createRequire(import.meta.url);
      const pkgPath = require.resolve("docdex/package.json");
      return path.join(path.dirname(pkgPath), "bin", "docdex.js");
    } catch {
      return undefined;
    }
  };

  const buildDocdexEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    if (!env.DOCDEX_STATE_DIR) {
      env.DOCDEX_STATE_DIR = path.join(os.homedir(), ".docdex", "state");
    }
    return env;
  };

  const runDocdex = (args: string[], cwd: string): boolean => {
    const bin = resolveDocdexBin();
    const env = buildDocdexEnv();
    try {
      if (bin) {
        execFileSync(process.execPath, [bin, ...args], { cwd, stdio: "ignore", env });
      } else {
        execSync(`docdex ${args.join(" ")}`, { cwd, stdio: "ignore", env });
      }
      return true;
    } catch {
      return false;
    }
  };

  if (!runDocdex(["--version"], workspaceRoot)) return false;
  return runDocdex(["index", "--repo", workspaceRoot], workspaceRoot);
};

export class SetWorkspaceCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseSetWorkspaceArgs(argv);
    const resolution = await WorkspaceResolver.resolveWorkspace({
      cwd: process.cwd(),
      explicitWorkspace: parsed.workspaceRoot,
    });

    await ensureConfigFile(resolution.mcodaDir);
    await ensureDocsDirs(resolution.mcodaDir);
    await (await WorkspaceRepository.create(resolution.workspaceRoot)).close();
    await ensureDocdexUrl(resolution.mcodaDir, resolution.workspaceRoot);

    let gitInited = false;
    if (parsed.git) {
      gitInited = await ensureGitRepo(resolution.workspaceRoot);
    }
    const codexTrusted = await ensureCodexTrust(resolution.workspaceRoot);
    const docdexIndexed = parsed.docdex ? await ensureDocdexIndex(resolution.workspaceRoot) : false;

    // eslint-disable-next-line no-console
    console.log(`Workspace ready at ${resolution.workspaceRoot}`);
    if (gitInited) {
      // eslint-disable-next-line no-console
      console.log("Initialized new git repository.");
    }
    if (codexTrusted) {
      // eslint-disable-next-line no-console
      console.log("Granted codex CLI trust for this workspace.");
    }
    if (docdexIndexed) {
      // eslint-disable-next-line no-console
      console.log("Docdex index initialized for this workspace.");
    }
    // eslint-disable-next-line no-console
    console.log(`Workspace data directory: ${resolution.mcodaDir}`);
    // eslint-disable-next-line no-console
    console.log("You can now run mcoda commands here.");
  }
}
