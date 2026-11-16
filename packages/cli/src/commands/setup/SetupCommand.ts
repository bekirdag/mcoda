import { CONSENT_NOT_REQUIRED_MESSAGE } from '../consent/ConsentCommands.js';

const USAGE = `
Usage: mcoda setup [--json]

mcoda works right after installation; there is no mandatory setup step and no
telemetry consent. This command only prints optional next steps. It never
contacts mswarm.

Optional:
  mcoda config set mswarm-api-key <KEY>   Use mswarm cloud agents, workers and routing
  mcoda set-workspace                     Initialize a workspace in the current repo
`.trim();

export type SetupCommandResult = {
  status: 'ready';
  consentRequired: false;
  message: string;
};

export class SetupCommand {
  static async run(argv: string[]): Promise<SetupCommandResult | undefined> {
    if (argv.includes('--help') || argv.includes('-h')) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return undefined;
    }
    parseSetupArgs(argv);
    const result: SetupCommandResult = {
      status: 'ready',
      consentRequired: false,
      message: `mcoda is ready to use. ${CONSENT_NOT_REQUIRED_MESSAGE}`,
    };
    if (argv.includes('--json')) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    // eslint-disable-next-line no-console
    console.log(result.message);
    // eslint-disable-next-line no-console
    console.log(
      'Optional: run `mcoda config set mswarm-api-key <KEY>` to use mswarm cloud agents, workers and routing.'
    );
    return result;
  }
}

export function parseSetupArgs(argv: string[]): { json: boolean } {
  const parsed = { json: false };
  for (const value of argv) {
    if (value === '--json') {
      parsed.json = true;
      continue;
    }
    if (value === '--help' || value === '-h') continue;
    // Accepted for backward compatibility with older consent-based setup.
    if (value === '--policy-version' || value.startsWith('--policy-version=')) continue;
    if (value.startsWith('--')) {
      throw new Error(`Unknown setup flag: ${value}`);
    }
  }
  return parsed;
}
