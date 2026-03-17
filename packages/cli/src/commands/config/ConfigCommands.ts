import { MswarmConfigStore } from "@mcoda/core";

const USAGE = `
Usage: mcoda config set mswarm-api-key <KEY>

Subcommands:
  set mswarm-api-key <KEY>   Persist an encrypted global mswarm API key under ~/.mcoda/config.json

Flags:
  --help                     Show this help
`.trim();

export class ConfigCommands {
  static async run(argv: string[]): Promise<void> {
    const [subcommand, key, value] = argv;
    if (!subcommand || argv.includes("--help") || argv.includes("-h")) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
      return;
    }
    if (subcommand !== "set") {
      throw new Error(`Unknown config subcommand: ${subcommand}`);
    }
    if (key !== "mswarm-api-key") {
      throw new Error(`Unknown config key: ${key ?? "<missing>"}`);
    }
    if (!value?.trim()) {
      throw new Error("Usage: mcoda config set mswarm-api-key <KEY>");
    }

    const store = new MswarmConfigStore();
    await store.saveApiKey(value);
    // eslint-disable-next-line no-console
    console.log(`Saved encrypted mswarm API key to ${store.configPath()}.`);
  }
}
