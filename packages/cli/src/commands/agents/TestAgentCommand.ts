import { AgentsApi } from "@mcoda/core";

const USAGE = "Usage: mcoda test-agent <NAME> [--prompt \"<text>\"] [--json]";

const parseArgs = (argv: string[]): { flags: Record<string, string | boolean>; positionals: string[] } => {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.replace(/^--/, "");
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
};

export class TestAgentCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseArgs(argv);
    const name = parsed.positionals[0];
    if (!name || parsed.flags.help) {
      throw new Error(USAGE);
    }
    if (parsed.flags.prompt === true) {
      throw new Error("test-agent: missing value for --prompt");
    }
    const prompt = typeof parsed.flags.prompt === "string" ? parsed.flags.prompt : undefined;

    const api = await AgentsApi.create();
    try {
      const { health, response, prompt: usedPrompt } = await api.probeAgent(name, prompt);
      if (parsed.flags.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              health,
              prompt: usedPrompt,
              response,
            },
            null,
            2,
          ),
        );
      } else {
        // eslint-disable-next-line no-console
        console.log(`Agent ${name} health=${health.status} lastCheckedAt=${health.lastCheckedAt ?? ""} latencyMs=${health.latencyMs ?? ""}`);
        // eslint-disable-next-line no-console
        console.log(`Prompt: ${usedPrompt}`);
        // eslint-disable-next-line no-console
        console.log(`Response (${response.adapter}${response.model ? `:${response.model}` : ""}):\n${response.output}`);
      }
    } finally {
      await api.close();
    }
  }
}
