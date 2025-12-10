import path from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { QaProfile } from '@mcoda/shared/qa/QaProfile.js';
import { QaAdapter } from './QaAdapter.js';
import { QaContext, QaEnsureResult, QaRunResult } from './QaTypes.js';

const exec = promisify(execCb);

export class CliQaAdapter implements QaAdapter {
  private resolveCwd(profile: QaProfile, ctx: QaContext): string {
    if (profile.working_dir) {
      return path.isAbsolute(profile.working_dir)
        ? profile.working_dir
        : path.join(ctx.workspaceRoot, profile.working_dir);
    }
    return ctx.workspaceRoot;
  }

  async ensureInstalled(profile: QaProfile, ctx: QaContext): Promise<QaEnsureResult> {
    if (!profile.install_command) return { ok: true };
    try {
      await exec(profile.install_command, {
        cwd: this.resolveCwd(profile, ctx),
        env: { ...process.env, ...profile.env, ...ctx.env },
      });
      return { ok: true };
    } catch (error: any) {
      return { ok: false, message: error?.message ?? 'QA install failed' };
    }
  }

  async invoke(profile: QaProfile, ctx: QaContext): Promise<QaRunResult> {
    const command = ctx.testCommandOverride ?? profile.test_command;
    const startedAt = new Date().toISOString();
    if (!command) {
      const finishedAt = new Date().toISOString();
      return {
        outcome: 'infra_issue',
        exitCode: null,
        stdout: '',
        stderr: 'No test_command configured for QA profile',
        artifacts: [],
        startedAt,
        finishedAt,
      };
    }
    const cwd = this.resolveCwd(profile, ctx);
    try {
      const { stdout, stderr } = await exec(command, {
        cwd,
        env: { ...process.env, ...profile.env, ...ctx.env },
      });
      const finishedAt = new Date().toISOString();
      return {
        outcome: 'pass',
        exitCode: 0,
        stdout,
        stderr,
        artifacts: [],
        startedAt,
        finishedAt,
      };
    } catch (error: any) {
      const stdout = error?.stdout ?? '';
      const stderr = error?.stderr ?? String(error);
      const exitCode = typeof error?.code === 'number' ? error.code : 1;
      const finishedAt = new Date().toISOString();
      return {
        outcome: exitCode === 0 ? 'pass' : 'fail',
        exitCode,
        stdout,
        stderr,
        artifacts: [],
        startedAt,
        finishedAt,
      };
    }
  }
}
