#!/usr/bin/env node

const DEFAULT_TOKENS = ["hello ", "from ", "codali ", "stream"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = (argv) => {
  const options = {
    delayMs: 250,
    rawSse: false,
    tokens: DEFAULT_TOKENS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--raw-sse") {
      options.rawSse = true;
      continue;
    }
    if (arg === "--delay-ms") {
      options.delayMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--tokens") {
      options.tokens = String(argv[index + 1] ?? "")
        .split("|")
        .filter((token) => token.length > 0);
      index += 1;
    }
  }

  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative number");
  }
  if (options.tokens.length === 0) {
    throw new Error("--tokens must contain at least one token");
  }

  return options;
};

const loadCodali = async () => {
  if (process.env.CODALI_STREAM_IMPORT !== "local") {
    try {
      return await import("@mcoda/codali");
    } catch (packageError) {
      if (process.env.CODALI_STREAM_IMPORT === "package") {
        throw packageError;
      }
    }
  }

  try {
    return await import(new URL("../packages/codali/dist/index.js", import.meta.url).href);
  } catch (localError) {
    throw new Error(
      "Could not import @mcoda/codali or local packages/codali/dist/index.js. " +
        "Run `pnpm --filter @mcoda/codali run build` in the mcoda repo, or install @mcoda/codali in the current project.",
      { cause: localError },
    );
  }
};

class DelayedProvider {
  name = "codali-stream-smoke-provider";

  constructor(tokens, delayMs) {
    this.tokens = tokens;
    this.delayMs = delayMs;
  }

  async generate(request) {
    for (const token of this.tokens) {
      await sleep(this.delayMs);
      request.onEvent?.({ type: "token", content: token });
    }

    return {
      message: { role: "assistant", content: this.tokens.join("") },
      usage: {
        inputTokens: this.tokens.length,
        outputTokens: this.tokens.length,
        totalTokens: this.tokens.length * 2,
      },
    };
  }
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const { codaliEventToOpenAISseData, runCodaliTask } = await loadCodali();
  const started = Date.now();
  const frames = [];

  const writeFrame = (sse) => {
    frames.push(sse);
    if (options.rawSse) {
      process.stdout.write(sse);
      return;
    }
    process.stdout.write(`${String(Date.now() - started).padStart(4)}ms ${sse.trim()}\n\n`);
  };

  const result = await runCodaliTask({
    task: "Stream a short Codali smoke response.",
    workspace: { root: process.cwd(), readOnly: true },
    provider: { name: "codali-stream-smoke-provider", model: "delayed-stub" },
    providerInstance: new DelayedProvider(options.tokens, options.delayMs),
    tools: [],
    policy: {
      allowWrites: false,
      allowShell: false,
      allowDestructiveOperations: false,
      allowOutsideWorkspace: false,
      maxSteps: 2,
      maxToolCalls: 0,
      timeoutMs: 10_000,
      mode: "tool_loop",
    },
    streaming: { enabled: true, flushEveryMs: 1 },
    onEvent: (event) => {
      const sse = codaliEventToOpenAISseData(event, {
        id: "chatcmpl-codali-stream-smoke",
        model: "delayed-stub",
      });
      if (sse) {
        writeFrame(sse);
      }
    },
  });

  const doneFrame = "data: [DONE]\n\n";
  writeFrame(doneFrame);

  process.stderr.write(
    `${JSON.stringify(
      {
        finalMessage: result.finalMessage,
        sseFrames: frames.length,
        tokenEvents: result.events.filter((event) => event.type === "token").length,
        finalEvents: result.events.filter((event) => event.type === "final").length,
        usage: result.usage,
      },
      null,
      2,
    )}\n`,
  );
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
