import path from 'node:path';
import { createRequire } from 'node:module';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { QaProfile } from '@mcoda/shared/qa/QaProfile.js';
import { QaAdapter } from './QaAdapter.js';
import { QaContext, QaEnsureResult, QaRunResult } from './QaTypes.js';
import fs from 'node:fs/promises';
const exec = promisify(execCb);
const shouldSkipInstall = (ctx: QaContext) =>
  process.env.MCODA_QA_SKIP_INSTALL === '1' || ctx.env?.MCODA_QA_SKIP_INSTALL === '1';
const PLAYWRIGHT_MISSING_MESSAGE =
  'Playwright CLI not available. Install Playwright in the repo or set a chromium QA test_command.';

const resolvePlaywrightCli = (cwd: string): string | undefined => {
  if (process.env.MCODA_FORCE_NO_PLAYWRIGHT === '1') {
    return undefined;
  }
  try {
    const requireFromCwd = createRequire(path.join(cwd, 'package.json'));
    return requireFromCwd.resolve('playwright/cli.js');
  } catch {
    // fall through to local resolution
  }
  try {
    const requireFromSelf = createRequire(import.meta.url);
    return requireFromSelf.resolve('playwright/cli.js');
  } catch {
    return undefined;
  }
};

export class ChromiumQaAdapter implements QaAdapter {
  private resolveCwd(profile: QaProfile, ctx: QaContext): string {
    if (profile.working_dir) {
      return path.isAbsolute(profile.working_dir)
        ? profile.working_dir
        : path.join(ctx.workspaceRoot, profile.working_dir);
    }
    return ctx.workspaceRoot;
  }

  private resolveCommand(profile: QaProfile, ctx: QaContext, cwd: string): string {
    const override = ctx.testCommandOverride ?? profile.test_command;
    if (override) return override;
    const playwrightCli = resolvePlaywrightCli(cwd);
    return playwrightCli ? `node ${playwrightCli} test --reporter=list` : '';
  }

  async ensureInstalled(profile: QaProfile, ctx: QaContext): Promise<QaEnsureResult> {
    if (shouldSkipInstall(ctx)) return { ok: true, details: { skipped: true } };
    const cwd = this.resolveCwd(profile, ctx);
    const command = this.resolveCommand(profile, ctx, cwd);
    if (!command) {
      return {
        ok: false,
        message: PLAYWRIGHT_MISSING_MESSAGE,
      };
    }
    return { ok: true };
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
    const cwd = this.resolveCwd(profile, ctx);
    const command = this.resolveCommand(profile, ctx, cwd);
    const startedAt = new Date().toISOString();
    if (!command) {
      const message = PLAYWRIGHT_MISSING_MESSAGE;
      const finishedAt = new Date().toISOString();
      return {
        outcome: 'infra_issue',
        exitCode: null,
        stdout: '',
        stderr: message,
        artifacts: [],
        startedAt,
        finishedAt,
      };
    }
    try {
      const { stdout, stderr } = await exec(command, {
        cwd,
        env: {
          ...process.env,
          ...profile.env,
          ...ctx.env,
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ?? '1',
        },
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
