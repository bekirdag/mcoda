import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { WorkspaceResolver } from "@mcoda/core";
import { WorkspaceRepository } from "@mcoda/db";

const USAGE = "Usage: mcoda set-workspace [--workspace-root <path>] [--no-git] [--no-docdex]";

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

  const runDocdex = (args: string[], cwd: string): boolean => {
    const bin = resolveDocdexBin();
    try {
      if (bin) {
        execFileSync(process.execPath, [bin, ...args], { cwd, stdio: "ignore" });
      } else {
        execSync(`docdex ${args.join(" ")}`, { cwd, stdio: "ignore" });
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
    console.log(`.mcoda directory: ${resolution.mcodaDir}`);
    // eslint-disable-next-line no-console
    console.log("You can now run mcoda commands here.");
  }
}
