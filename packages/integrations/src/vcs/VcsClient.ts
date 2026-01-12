import { exec as execCb, execFile as execFileCb, type ExecOptions } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execCb);
const execFile = promisify(execFileCb);

export class VcsClient {
  private async runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFile("git", args, { cwd });
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

  private async hasCommits(cwd: string): Promise<boolean> {
    try {
      await this.runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureMainBranch(cwd: string): Promise<void> {
    await this.ensureRepo(cwd);
    if (await this.branchExists(cwd, "main")) return;
    const hasHistory = await this.hasCommits(cwd);
    if (!hasHistory) {
      await this.runGit(cwd, ["checkout", "--orphan", "main"]);
      await this.runGit(cwd, ["commit", "--allow-empty", "-m", "chore:init-repo"]);
      return;
    }
    const current = (await this.currentBranch(cwd)) ?? "HEAD";
    await this.runGit(cwd, ["checkout", "-b", "main", current]);
  }

  async ensureBaseBranch(cwd: string, base: string): Promise<void> {
    await this.ensureMainBranch(cwd);
    if (await this.branchExists(cwd, base)) return;
    const hasHistory = await this.hasCommits(cwd);
    const baseFrom = hasHistory
      ? (await this.branchExists(cwd, "main")) ? "main" : (await this.currentBranch(cwd)) ?? "HEAD"
      : undefined;
    const args = ["checkout", "-b", base];
    if (baseFrom) args.push(baseFrom);
    await this.runGit(cwd, args);
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
    const opts: ExecOptions = { cwd, shell: true } as any;
    const applyCmd = `cat <<'__PATCH__' | git apply --whitespace=nowarn\n${patch}\n__PATCH__`;
    try {
      await exec(applyCmd, opts as any);
      return;
    } catch (error) {
      // Retry with 3-way merge for drifted files.
      const apply3wayCmd = `cat <<'__PATCH__' | git apply --3way --whitespace=nowarn\n${patch}\n__PATCH__`;
      try {
        await exec(apply3wayCmd, opts as any);
        return;
      } catch {
        // If the patch is already applied, a reverse --check succeeds; treat that as a no-op.
        const reverseCheckCmd = `cat <<'__PATCH__' | git apply --reverse --check --whitespace=nowarn\n${patch}\n__PATCH__`;
        try {
          await exec(reverseCheckCmd, opts as any);
          return;
        } catch {
          throw error;
        }
      }
    }
  }

  async stage(cwd: string, paths: string[]): Promise<void> {
    await this.runGit(cwd, ["add", ...paths]);
  }

  async commit(
    cwd: string,
    message: string,
    options: { noVerify?: boolean; noGpgSign?: boolean } = {},
  ): Promise<void> {
    const args = ["commit", "-m", message];
    if (options.noVerify) args.push("--no-verify");
    if (options.noGpgSign) args.push("--no-gpg-sign");
    await this.runGit(cwd, args);
  }

  async merge(cwd: string, source: string, target: string, ensureClean = false): Promise<void> {
    await this.checkoutBranch(cwd, target);
    if (ensureClean) {
      await this.ensureClean(cwd);
    }
    await this.runGit(cwd, ["merge", "--no-edit", source]);
  }

  async abortMerge(cwd: string): Promise<void> {
    try {
      await this.runGit(cwd, ["merge", "--abort"]);
    } catch {
      // Ignore when no merge is in progress.
    }
  }

  async push(cwd: string, remote: string, branch: string): Promise<void> {
    await this.runGit(cwd, ["push", remote, branch]);
  }

  async pull(cwd: string, remote: string, branch: string, ffOnly = true): Promise<void> {
    const args = ["pull"];
    if (ffOnly) args.push("--ff-only");
    args.push(remote, branch);
    await this.runGit(cwd, args);
  }

  async status(cwd: string): Promise<string> {
    const { stdout } = await this.runGit(cwd, ["status", "--porcelain"]);
    return stdout;
  }

  async dirtyPaths(cwd: string): Promise<string[]> {
    // Use NUL-terminated porcelain to avoid quoting/escaping issues and to handle renames reliably.
    // Format: `XY <path>\0` or for renames/copies: `XY <old>\0<new>\0`.
    const { stdout } = await this.runGit(cwd, ["status", "--porcelain", "-z"]);
    const entries = stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.length < 4) continue;
      const x = entry[0];
      const path1 = entry.slice(3);
      if ((x === "R" || x === "C") && i + 1 < entries.length) {
        const path2 = entries[i + 1];
        if (path2) paths.push(path2);
        i += 1;
        continue;
      }
      if (path1) paths.push(path1);
    }
    return paths;
  }

  async conflictPaths(cwd: string): Promise<string[]> {
    try {
      const { stdout } = await this.runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]);
      return stdout.split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  }

  async ensureClean(cwd: string, ignoreDotMcoda = true, ignorePaths: string[] = []): Promise<void> {
    const dirty = await this.dirtyPaths(cwd);
    const filtered = dirty.filter((p) => {
      if (ignoreDotMcoda && p.startsWith(".mcoda")) return false;
      return !ignorePaths.some((prefix) => p.startsWith(prefix));
    });
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
