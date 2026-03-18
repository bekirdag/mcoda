import { runMswarmConsentBootstrap } from '../../install/MswarmConsentBootstrap.js';

const USAGE = `
Usage: mcoda setup [options]

Runs the interactive mcoda setup flow for mandatory mswarm telemetry consent.

Options:
  --policy-version <VER>   Override the consent policy version
  --json                   Emit JSON output
  --help                   Show this help
`.trim();

type ParsedSetupArgs = {
  json: boolean;
  policyVersion?: string;
};

export class SetupCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseSetupArgs(argv);
    if (argv.includes('--help') || argv.includes('-h')) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return;
    }
    const result = await runMswarmConsentBootstrap({
      mode: 'setup',
      onDeferred: 'error',
      policyVersion: parsed.policyVersion,
      logger: parsed.json ? defaultErrorLogger : defaultLogger,
    });
    if (parsed.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      [
        `status=${result.status}`,
        `consentAccepted=${String(result.consentAccepted)}`,
        `consentTokenSet=${String(result.consentTokenSet)}`,
        result.clientId ? `clientId=${result.clientId}` : undefined,
        result.clientType ? `clientType=${result.clientType}` : undefined,
        result.policyVersion ? `policyVersion=${result.policyVersion}` : undefined,
      ]
        .filter(Boolean)
        .join(' ')
    );
  }
}

export function parseSetupArgs(argv: string[]): ParsedSetupArgs {
  const parsed: ParsedSetupArgs = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') {
      parsed.json = true;
      continue;
    }
    if (value === '--policy-version') {
      const next = argv[index + 1];
      if (!next?.trim()) {
        throw new Error('--policy-version requires a value');
      }
      parsed.policyVersion = next.trim();
      index += 1;
      continue;
    }
    if (value === '--help' || value === '-h') {
      continue;
    }
    if (value.startsWith('--')) {
      throw new Error(`Unknown setup flag: ${value}`);
    }
    throw new Error(`Unknown setup argument: ${value}`);
  }
  return parsed;
}

function defaultLogger(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

function defaultErrorLogger(line: string): void {
  // eslint-disable-next-line no-console
  console.error(line);
}
