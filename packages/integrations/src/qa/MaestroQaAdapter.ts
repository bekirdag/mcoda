import path from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { QaProfile } from '@mcoda/shared/qa/QaProfile.js';
import { QaAdapter } from './QaAdapter.js';
import { QaContext, QaEnsureResult, QaRunResult } from './QaTypes.js';
import fs from 'node:fs/promises';

const exec = promisify(execCb);
const shouldSkipInstall = (ctx: QaContext) =>
  process.env.MCODA_QA_SKIP_INSTALL === '1' || ctx.env?.MCODA_QA_SKIP_INSTALL === '1';

export class MaestroQaAdapter implements QaAdapter {
  private resolveCwd(profile: QaProfile, ctx: QaContext): string {
    if (profile.working_dir) {
      return path.isAbsolute(profile.working_dir)
        ? profile.working_dir
        : path.join(ctx.workspaceRoot, profile.working_dir);
    }
    return ctx.workspaceRoot;
  }

  async ensureInstalled(profile: QaProfile, ctx: QaContext): Promise<QaEnsureResult> {
    if (shouldSkipInstall(ctx)) return { ok: true, details: { skipped: true } };
    const cwd = this.resolveCwd(profile, ctx);
    try {
      await exec('maestro --version', { cwd, env: { ...process.env, ...profile.env, ...ctx.env } });
      return { ok: true };
    } catch (versionError: any) {
      if (!profile.install_command) {
        return { ok: false, message: versionError?.message ?? 'Maestro not available' };
      }
      try {
        await exec(profile.install_command, { cwd, env: { ...process.env, ...profile.env, ...ctx.env } });
        return { ok: true, details: { installedVia: profile.install_command } };
      } catch (error: any) {
        return { ok: false, message: error?.message ?? versionError?.message ?? 'Maestro install failed' };
      }
    }
  }

  private async persistLogs(ctx: QaContext, stdout: string, stderr: string): Promise<string[]> {
    const artifacts: string[] = [];
    if (!ctx.artifactDir) return artifacts;
    await fs.mkdir(ctx.artifactDir, { recursive: true });
    const outPath = path.join(ctx.artifactDir, 'stdout.log');
    const errPath = path.join(ctx.artifactDir, 'stderr.log');
    await fs.writeFile(outPath, stdout ?? '', 'utf8');
    await fs.writeFile(errPath, stderr ?? '', 'utf8');
    artifacts.push(path.relative(ctx.workspaceRoot, outPath), path.relative(ctx.workspaceRoot, errPath));
    return artifacts;
  }

  async invoke(profile: QaProfile, ctx: QaContext): Promise<QaRunResult> {
    const command = ctx.testCommandOverride ?? profile.test_command ?? 'maestro test';
    const startedAt = new Date().toISOString();
    const cwd = this.resolveCwd(profile, ctx);
    try {
      const { stdout, stderr } = await exec(command, {
        cwd,
        env: { ...process.env, ...profile.env, ...ctx.env },
      });
      const finishedAt = new Date().toISOString();
      const artifacts = await this.persistLogs(ctx, stdout, stderr);
      return {
        outcome: 'pass',
        exitCode: 0,
        stdout,
        stderr,
        artifacts,
        startedAt,
        finishedAt,
      };
    } catch (error: any) {
      const stdout = error?.stdout ?? '';
      const stderr = error?.stderr ?? String(error);
      const exitCode = typeof error?.code === 'number' ? error.code : null;
      const finishedAt = new Date().toISOString();
      const artifacts = await this.persistLogs(ctx, stdout, stderr);
      return {
        outcome: exitCode === null ? 'infra_issue' : exitCode === 0 ? 'pass' : 'fail',
        exitCode,
        stdout,
        stderr,
        artifacts,
        startedAt,
        finishedAt,
      };
    }
  }
}
