import fs from "node:fs/promises";
import { AgentsApi } from "@mcoda/core";

const USAGE =
  "Usage: mcoda agent-run <NAME> [--prompt \"<text>\"] [--prompt-file <PATH>] [--task-file <PATH>] [--stdin] [--json]";

const parseArgs = (argv: string[]): { flags: Record<string, string | boolean | string[]>; positionals: string[] } => {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.replace(/^--/, "");
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        const existing = flags[key];
        if (Array.isArray(existing)) {
          flags[key] = [...existing, next];
        } else if (typeof existing === "string") {
          flags[key] = [existing, next];
        } else {
          flags[key] = next;
        }
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

const readTaskFile = async (filePath: string): Promise<string[]> => {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
};

const toArray = (value: string | boolean | string[] | undefined): string[] => {
  if (!value || typeof value === "boolean") return [];
  return Array.isArray(value) ? value : [value];
};

const readStdinIfProvided = async (): Promise<string | undefined> => {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const input = Buffer.concat(chunks).toString("utf8").trim();
  return input.length ? input : undefined;
};

export class AgentRunCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseArgs(argv);
    const name = parsed.positionals[0];
    if (!name || parsed.flags.help) {
      throw new Error(USAGE);
    }
    if (parsed.flags.prompt === true) {
      throw new Error("agent-run: missing value for --prompt");
    }
    if (parsed.flags["prompt-file"] === true) {
      throw new Error("agent-run: missing value for --prompt-file");
    }
    if (parsed.flags["task-file"] === true) {
      throw new Error("agent-run: missing value for --task-file");
    }

    const prompts: string[] = [];
    const inlinePrompts = toArray(parsed.flags.prompt);
    for (const prompt of inlinePrompts) {
      const trimmed = prompt.trim();
      if (trimmed) prompts.push(trimmed);
    }

    const promptFiles = toArray(parsed.flags["prompt-file"]);
    for (const filePath of promptFiles) {
      const content = await fs.readFile(String(filePath), "utf8");
      const trimmed = content.trim();
      if (trimmed) prompts.push(trimmed);
    }

    const taskFiles = toArray(parsed.flags["task-file"]);
    for (const filePath of taskFiles) {
      const entries = await readTaskFile(String(filePath));
      for (const entry of entries) {
        if (entry) prompts.push(entry);
      }
    }

    if (parsed.flags.stdin) {
      const stdinPrompt = await readStdinIfProvided();
      if (stdinPrompt) prompts.push(stdinPrompt);
    } else if (prompts.length === 0) {
      const stdinPrompt = await readStdinIfProvided();
      if (stdinPrompt) prompts.push(stdinPrompt);
    }

    if (prompts.length === 0) {
      throw new Error("agent-run: at least one prompt is required via --prompt, --prompt-file, --task-file, or stdin");
    }

    const api = await AgentsApi.create();
    try {
      const result = await api.runAgent(name, prompts);
      if (parsed.flags.json) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              agent: result.agent,
              responses: result.responses.map((response, index) => ({
                prompt: result.prompts[index],
                output: response.output,
                adapter: response.adapter,
                model: response.model,
                metadata: response.metadata,
              })),
            },
            null,
            2,
          ),
        );
      } else {
        // eslint-disable-next-line no-console
        console.log(`Agent ${result.agent.slug} responded to ${result.responses.length} prompt(s).`);
        result.responses.forEach((response, index) => {
          const label = `${response.adapter}${response.model ? `:${response.model}` : ""}`;
          // eslint-disable-next-line no-console
          console.log(`\n--- Prompt ${index + 1} ---\n${result.prompts[index]}`);
          // eslint-disable-next-line no-console
          console.log(`--- Response ${index + 1} (${label}) ---\n${response.output}`);
        });
      }
    } finally {
      await api.close();
    }
  }
}
