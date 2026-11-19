import { MswarmConfigStore } from '@mcoda/core';

export const CONSENT_NOT_REQUIRED_MESSAGE =
  'Telemetry consent is no longer required. mcoda does not collect or upload usage data, and every command works without setup.';

const USAGE = `
Usage: mcoda consent [show|accept|revoke|request-deletion] [--json]

mcoda no longer asks for telemetry consent and does not collect or upload
usage data. This command is kept only for backward compatibility: it never
contacts mswarm. Any subcommand prints this notice and removes consent tokens
or client ids left in the local config by older mcoda releases.
`.trim();

export type ConsentCommandResult = {
  consentRequired: false;
  message: string;
  removedLegacyKeys: string[];
  configPath: string;
};

export class ConsentCommands {
  static async run(
    argv: string[],
    options: { store?: MswarmConfigStore } = {}
  ): Promise<ConsentCommandResult | undefined> {
    if (argv.includes('--help') || argv.includes('-h')) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return undefined;
    }
    const store = options.store ?? new MswarmConfigStore();
    const removedLegacyKeys = await store.clearLegacyConsentState();
    const result: ConsentCommandResult = {
      consentRequired: false,
      message: CONSENT_NOT_REQUIRED_MESSAGE,
      removedLegacyKeys,
      configPath: store.configPath(),
    };
    if (argv.includes('--json')) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    // eslint-disable-next-line no-console
    console.log(CONSENT_NOT_REQUIRED_MESSAGE);
    if (removedLegacyKeys.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `Removed legacy consent data from ${result.configPath}: ${removedLegacyKeys.join(', ')}.`
      );
    }
    return result;
  }
}
