import path from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { QaProfile } from '@mcoda/shared/qa/QaProfile.js';
import { QaAdapter } from './QaAdapter.js';
import { QaContext, QaEnsureResult, QaRunResult } from './QaTypes.js';
import fs from 'node:fs/promises';

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

  private async persistLogs(
    ctx: QaContext,
    stdout: string,
    stderr: string,
    suffix?: string,
  ): Promise<string[]> {
    const artifacts: string[] = [];
    if (!ctx.artifactDir) return artifacts;
    await fs.mkdir(ctx.artifactDir, { recursive: true });
    const suffixLabel = suffix ? `-${suffix}` : '';
    const outPath = path.join(ctx.artifactDir, `stdout${suffixLabel}.log`);
    const errPath = path.join(ctx.artifactDir, `stderr${suffixLabel}.log`);
    await fs.writeFile(outPath, stdout ?? '', 'utf8');
    await fs.writeFile(errPath, stderr ?? '', 'utf8');
    artifacts.push(path.relative(ctx.workspaceRoot, outPath), path.relative(ctx.workspaceRoot, errPath));
    return artifacts;
  }

  private formatCommandHeader(
    command: string,
    index: number,
    total: number,
    outcome: QaRunResult['outcome'],
    exitCode: number | null,
  ): string {
    const label = total > 1 ? `command ${index}/${total}` : 'command';
    return `=== ${label} outcome=${outcome} exit=${exitCode ?? 'null'} cmd=${command} ===`;
  }

  private async runCommand(
    command: string,
    profile: QaProfile,
    ctx: QaContext,
    index: number,
    total: number,
  ): Promise<{ command: string; result: QaRunResult }> {
    const startedAt = new Date().toISOString();
    const cwd = this.resolveCwd(profile, ctx);
    try {
      const { stdout, stderr } = await exec(command, {
        cwd,
        env: { ...process.env, ...profile.env, ...ctx.env },
      });
      const finishedAt = new Date().toISOString();
      const artifacts = await this.persistLogs(ctx, stdout, stderr, total > 1 ? String(index) : undefined);
      return {
        command,
        result: {
          outcome: 'pass',
          exitCode: 0,
          stdout,
          stderr,
          artifacts,
          startedAt,
          finishedAt,
        },
      };
    } catch (error: any) {
      const stdout = error?.stdout ?? '';
      const stderr = error?.stderr ?? String(error);
      const exitCode = typeof error?.code === 'number' ? error.code : null;
      const finishedAt = new Date().toISOString();
      const artifacts = await this.persistLogs(ctx, stdout, stderr, total > 1 ? String(index) : undefined);
      return {
        command,
        result: {
          outcome: exitCode === null ? 'infra_issue' : exitCode === 0 ? 'pass' : 'fail',
          exitCode,
          stdout,
          stderr,
          artifacts,
          startedAt,
          finishedAt,
        },
      };
    }
  }

  async invoke(profile: QaProfile, ctx: QaContext): Promise<QaRunResult> {
    const commandList = (ctx.commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
    const fallback = ctx.testCommandOverride ?? profile.test_command;
    const commands = commandList.length ? commandList : fallback ? [fallback] : [];
    if (!commands.length) {
      const now = new Date().toISOString();
      return {
        outcome: 'infra_issue',
        exitCode: null,
        stdout: '',
        stderr: 'No test_command configured for QA profile',
        artifacts: [],
        startedAt: now,
        finishedAt: now,
      };
    }
    if (commands.length === 1) {
      return (await this.runCommand(commands[0], profile, ctx, 1, 1)).result;
    }
    const runs: Array<{ command: string; result: QaRunResult }> = [];
    for (let index = 0; index < commands.length; index += 1) {
      runs.push(await this.runCommand(commands[index], profile, ctx, index + 1, commands.length));
    }
    const outcome = runs.some((run) => run.result.outcome === 'infra_issue')
      ? 'infra_issue'
      : runs.some((run) => run.result.outcome === 'fail')
        ? 'fail'
        : 'pass';
    const exitCode =
      outcome === 'infra_issue'
        ? null
        : outcome === 'pass'
          ? 0
          : runs.find((run) => typeof run.result.exitCode === 'number' && run.result.exitCode !== 0)?.result
              .exitCode ?? 1;
    const stdout = runs
      .map((run, index) =>
        [this.formatCommandHeader(run.command, index + 1, runs.length, run.result.outcome, run.result.exitCode), run.result.stdout]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');
    const stderr = runs
      .map((run, index) =>
        [this.formatCommandHeader(run.command, index + 1, runs.length, run.result.outcome, run.result.exitCode), run.result.stderr]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n');
    const artifacts = runs.flatMap((run) => run.result.artifacts ?? []);
    const startedAt = runs.reduce(
      (min, run) => (run.result.startedAt < min ? run.result.startedAt : min),
      runs[0].result.startedAt,
    );
    const finishedAt = runs.reduce(
      (max, run) => (run.result.finishedAt > max ? run.result.finishedAt : max),
      runs[0].result.finishedAt,
    );
    return {
      outcome,
      exitCode,
      stdout,
      stderr,
      artifacts,
      startedAt,
      finishedAt,
    };
  }
}
