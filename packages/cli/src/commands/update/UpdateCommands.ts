import { createRequire } from "node:module";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { SystemUpdateService } from "@mcoda/core";
import { ApplyUpdateResponse, UpdateChannel } from "@mcoda/shared";

interface UpdateArgs {
  checkOnly: boolean;
  channel?: UpdateChannel;
  version?: string;
  force: boolean;
  json: boolean;
  quiet: boolean;
  debug: boolean;
}

const usage = `mcoda update \\
  [--check] \\
  [--channel <stable|beta|nightly>] \\
  [--version <SEMVER>] \\
  [--force] \\
  [--json] \\
  [--quiet]`;

const readCliVersion = (): string => {
  const require = createRequire(import.meta.url);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const parseUpdateArgs = (argv: string[]): UpdateArgs => {
  const parsed: UpdateArgs = {
    checkOnly: false,
    force: false,
    json: false,
    quiet: false,
    debug: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--check":
        parsed.checkOnly = true;
        break;
      case "--channel":
        parsed.channel = argv[i + 1] as UpdateChannel | undefined;
        i += 1;
        break;
      case "--version":
        parsed.version = argv[i + 1];
        i += 1;
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--quiet":
        parsed.quiet = true;
        break;
      case "--debug":
        parsed.debug = true;
        break;
      case "--workspace":
      case "--workspace-root":
        i += 1;
        break;
      case "--help":
      case "-h":
        // eslint-disable-next-line no-console
        console.log(usage);
        process.exit(0);
        break;
      case "--no-color":
      case "--no-telemetry":
        // ignored global flags
        break;
      default:
        if (arg.startsWith("--channel=")) {
          parsed.channel = arg.split("=")[1] as UpdateChannel;
        } else if (arg.startsWith("--version=")) {
          parsed.version = arg.split("=")[1];
        } else {
          throw new Error(`Unknown flag: ${arg}\n\n${usage}`);
        }
        break;
    }
  }
  return parsed;
};

const isValidVersion = (value?: string): boolean => {
  if (!value) return true;
  return /^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(value);
};

const confirmInteractive = async (prompt: string): Promise<boolean> => {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(prompt);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
};

export class UpdateCommands {
  static async run(argv: string[]): Promise<void> {
    let runId: string | undefined;
    let service: SystemUpdateService | undefined;
    let exitCode = 0;
    let errorSummary: string | null = null;
    let result: Record<string, unknown> | undefined;
    const cliVersion = readCliVersion();
    try {
      const parsed = parseUpdateArgs(argv);
      if (!isValidVersion(parsed.version)) {
        throw new Error(`Invalid --version value (expected semver): ${parsed.version}`);
      }
      service = await SystemUpdateService.create();

      runId = await service.startRun({
        cliVersion,
        channel: parsed.channel ?? "stable",
        versionOverride: parsed.version,
        checkOnly: parsed.checkOnly,
        force: parsed.force,
      });

      const channel = await service.resolveChannel(parsed.channel);
      if (parsed.channel) {
        await service.savePreferredChannel(channel);
      }

      let check;
      try {
        check = await service.checkUpdate(channel);
      } catch (error) {
        errorSummary = error instanceof Error ? error.message : String(error);
        exitCode = 4;
        if (!parsed.quiet) {
          // eslint-disable-next-line no-console
          console.error(errorSummary);
        }
        return;
      }

      const targetVersion = parsed.version ?? check.info.latestVersion;
      const npmCommand = `npm install -g mcoda@${targetVersion}`;
      result = { check, targetVersion, npmCommand };

      if (parsed.checkOnly) {
        if (parsed.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({ ...check.info, channel: check.channel, checkedAt: check.checkedAt }, null, 2));
        } else if (!parsed.quiet) {
          const summary = `Current: ${check.info.currentVersion}, Latest (channel=${check.channel}): ${check.info.latestVersion}, updateAvailable: ${check.info.updateAvailable}`;
          // eslint-disable-next-line no-console
          console.log(summary);
          if (check.info.notes) {
            // eslint-disable-next-line no-console
            console.log(check.info.notes);
          }
        }
        return;
      }

      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const requiresForce = !interactive || Boolean(process.env.CI);
      if (requiresForce && !parsed.force) {
        exitCode = 2;
        errorSummary = "Non-interactive update requires --force.";
        if (!parsed.quiet) {
          // eslint-disable-next-line no-console
          console.error(`${errorSummary} Planned npm command: ${npmCommand}`);
        }
        return;
      }

      if (interactive && !parsed.force) {
        const proceed = await confirmInteractive(
          `Update mcoda from ${check.info.currentVersion} -> ${targetVersion} on channel ${channel}? [y/N] `,
        );
        if (!proceed) {
          exitCode = 2;
          errorSummary = "Update cancelled by user.";
          return;
        }
      }

      if (!check.info.updateAvailable && !parsed.version) {
        if (!parsed.quiet) {
          // eslint-disable-next-line no-console
          console.log("Already up to date.");
        }
        await service.recordApplyState(check.info, channel, check.info.currentVersion);
        return;
      }

      if (!parsed.quiet) {
        // eslint-disable-next-line no-console
        console.log(`Applying update via API (npm command: ${npmCommand})...`);
      }

      let applyResponse: ApplyUpdateResponse | undefined;
      let npmFallbackSucceeded = false;
      try {
        applyResponse = await service.applyUpdate(channel);
        result = { ...result, applyResponse };
      } catch (error) {
        errorSummary = error instanceof Error ? error.message : String(error);
        try {
          const npmResult = await service.runNpmInstall(targetVersion, { quiet: parsed.quiet });
          result = { ...result, npmResult };
          if (npmResult.code !== 0) {
            exitCode = 6;
            errorSummary = `npm install exited with code ${npmResult.code}`;
          } else {
            npmFallbackSucceeded = true;
            exitCode = 0;
            errorSummary = null;
          }
        } catch (installError) {
          exitCode = 6;
          errorSummary = installError instanceof Error ? installError.message : String(installError);
        }
      }

      if (applyResponse) {
        if (applyResponse.status === "already_up_to_date") {
          if (!parsed.quiet) {
            // eslint-disable-next-line no-console
            console.log("Already up to date.");
          }
          exitCode = 0;
        } else if (applyResponse.status === "started") {
          if (!parsed.quiet) {
            // eslint-disable-next-line no-console
            console.log(`Update started. Logs: ${applyResponse.logFile ?? "n/a"}`);
          }
        } else if (applyResponse.status === "completed") {
          if (!parsed.quiet) {
            // eslint-disable-next-line no-console
            console.log(`Update completed. Logs: ${applyResponse.logFile ?? "n/a"}`);
          }
        }
        await service.recordApplyState(check.info, channel, targetVersion);
        if (parsed.json) {
          // eslint-disable-next-line no-console
          console.log(
            JSON.stringify(
              {
                status: applyResponse.status,
                logFile: applyResponse.logFile,
                targetVersion,
                channel,
                npmCommand,
              },
              null,
              2,
            ),
          );
        }
      } else if (npmFallbackSucceeded) {
        // npm fallback succeeded
        await service.recordApplyState(check.info, channel, targetVersion);
        if (parsed.json) {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({ status: "completed", targetVersion, channel, npmCommand }, null, 2));
        }
      } else if (exitCode === 4 && !parsed.quiet) {
        // eslint-disable-next-line no-console
        console.error(`Update apply failed; run manually: ${npmCommand}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(message);
      exitCode = exitCode || 1;
      errorSummary = message;
    } finally {
      if (service && runId) {
        await service.finishRun(runId, {
          status: exitCode === 0 ? "succeeded" : "failed",
          exitCode,
          errorSummary,
          result,
        });
      }
      if (service) {
        await service.close();
      }
      if (exitCode) {
        process.exitCode = exitCode;
      }
    }
  }
}
