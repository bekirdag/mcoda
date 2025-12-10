import { exec as execCb, type ExecOptions } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execCb);

export class VcsClient {
  private async runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await exec(`git ${args.join(" ")}`, { cwd });
    return { stdout, stderr };
  }

  private async gitDirExists(cwd: string): Promise<boolean> {
    try {
      await fs.access(path.join(cwd, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  async ensureRepo(cwd: string): Promise<void> {
    if (await this.gitDirExists(cwd)) return;
    await this.runGit(cwd, ["init"]);
  }

  async hasRemote(cwd: string): Promise<boolean> {
    try {
      const { stdout } = await this.runGit(cwd, ["remote"]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async currentBranch(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await this.runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    try {
      await this.runGit(cwd, ["show-ref", "--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  async ensureBaseBranch(cwd: string, base: string): Promise<void> {
    if (await this.branchExists(cwd, base)) return;
    const current = (await this.currentBranch(cwd)) ?? "master";
    await this.runGit(cwd, ["checkout", "-b", base, current]);
  }

  async checkoutBranch(cwd: string, branch: string): Promise<void> {
    await this.runGit(cwd, ["checkout", branch]);
  }

  async createOrCheckoutBranch(cwd: string, branch: string, base: string): Promise<void> {
    if (await this.branchExists(cwd, branch)) {
      await this.checkoutBranch(cwd, branch);
      return;
    }
    await this.runGit(cwd, ["checkout", "-b", branch, base]);
  }

  async applyPatch(cwd: string, patch: string): Promise<void> {
    const command = `cat <<'__PATCH__' | git apply --whitespace=nowarn\n${patch}\n__PATCH__`;
    const opts: ExecOptions = { cwd, shell: true } as any;
    await exec(command, opts as any);
  }

  async stage(cwd: string, paths: string[]): Promise<void> {
    await this.runGit(cwd, ["add", ...paths]);
  }

  async commit(cwd: string, message: string): Promise<void> {
    await this.runGit(cwd, ["commit", "-m", message]);
  }

  async merge(cwd: string, source: string, target: string): Promise<void> {
    await this.checkoutBranch(cwd, target);
    await this.runGit(cwd, ["merge", "--no-edit", source]);
  }

  async push(cwd: string, remote: string, branch: string): Promise<void> {
    await this.runGit(cwd, ["push", remote, branch]);
  }

  async status(cwd: string): Promise<string> {
    const { stdout } = await this.runGit(cwd, ["status", "--porcelain"]);
    return stdout;
  }

  async dirtyPaths(cwd: string): Promise<string[]> {
    const status = await this.status(cwd);
    return status
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[\?MADRCU!\s]+/, "").trim());
  }

  async ensureClean(cwd: string, ignoreDotMcoda = true): Promise<void> {
    const dirty = await this.dirtyPaths(cwd);
    const filtered = ignoreDotMcoda ? dirty.filter((p) => !p.startsWith(".mcoda")) : dirty;
    if (filtered.length) {
      throw new Error(`Working tree dirty: ${filtered.join(", ")}`);
    }
  }

  async lastCommitSha(cwd: string): Promise<string> {
    const { stdout } = await this.runGit(cwd, ["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async diff(cwd: string, base: string, head: string, paths?: string[]): Promise<string> {
    const args = ["diff", `${base}...${head}`];
    if (paths && paths.length) {
      args.push("--", ...paths);
    }
    const { stdout } = await this.runGit(cwd, args);
    return stdout;
  }
}
