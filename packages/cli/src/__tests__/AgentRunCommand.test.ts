import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AgentsCommands } from "../commands/agents/AgentsCommands.js";
import { AgentRunCommand } from "../commands/agents/AgentRunCommand.js";
import { GlobalRepository } from "@mcoda/db";

const withTempHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalHomeDrive = process.env.HOMEDRIVE;
  const originalHomePath = process.env.HOMEPATH;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-agent-run-"));
  const originalSkip = process.env.MCODA_SKIP_CLI_CHECKS;
  process.env.HOME = tempHome;
  if (process.platform === "win32") {
    const parsed = path.parse(tempHome);
    process.env.USERPROFILE = tempHome;
    process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
    process.env.HOMEPATH = tempHome.slice(parsed.root.length - 1);
  }
  process.env.MCODA_SKIP_CLI_CHECKS = "1";
  try {
    await fn(tempHome);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalHomeDrive === undefined) {
      delete process.env.HOMEDRIVE;
    } else {
      process.env.HOMEDRIVE = originalHomeDrive;
    }
    if (originalHomePath === undefined) {
      delete process.env.HOMEPATH;
    } else {
      process.env.HOMEPATH = originalHomePath;
    }
    if (originalSkip === undefined) {
      delete process.env.MCODA_SKIP_CLI_CHECKS;
    } else {
      process.env.MCODA_SKIP_CLI_CHECKS = originalSkip;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
};

const withMockedStdin = async (input: string, fn: () => Promise<void>): Promise<void> => {
  const originalStdin = process.stdin;
  const stream = Readable.from([input]);
  Object.defineProperty(stream, "isTTY", { value: false });
  Object.defineProperty(process, "stdin", { value: stream });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin });
  }
};

test("mcoda agent-run records command_runs and token_usage", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "qa", "--adapter", "qa-cli", "--capability", "chat"]);
    await AgentRunCommand.run(["qa", "--prompt", "Summarize this task", "--prompt", "List risks"]);

    const repo = await GlobalRepository.create();
    const runs = await repo["db"].all("SELECT command_name FROM command_runs WHERE command_name = 'agent.run'");
    assert.ok(runs.length >= 1);
    const tokens = await repo["db"].all("SELECT agent_id FROM token_usage WHERE command_run_id IS NOT NULL");
    assert.ok(tokens.length >= 1);
    await repo.close();
  });
});

test("mcoda agent-run validates missing prompt flag values", async () => {
  const cases = [
    { args: ["qa", "--prompt"], message: "agent-run: missing value for --prompt" },
    { args: ["qa", "--prompt-file"], message: "agent-run: missing value for --prompt-file" },
    { args: ["qa", "--task-file"], message: "agent-run: missing value for --task-file" },
  ];

  for (const { args, message } of cases) {
    await assert.rejects(() => AgentRunCommand.run(args), { message });
  }
});

test("mcoda agent-run includes stdin when --stdin is set", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "qa", "--adapter", "qa-cli", "--capability", "chat"]);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      await withMockedStdin("stdin prompt", async () => {
        await AgentRunCommand.run(["qa", "--prompt", "Inline prompt", "--stdin", "--json"]);
      });
    } finally {
      console.log = originalLog;
    }

    const parsed = (() => {
      for (let i = logs.length - 1; i >= 0; i -= 1) {
        const entry = logs[i];
        try {
          return JSON.parse(entry);
        } catch {
          continue;
        }
      }
      throw new Error("Expected JSON output from agent-run");
    })();

    const prompts = parsed.responses.map((entry: { prompt: string }) => entry.prompt);
    assert.ok(prompts.includes("Inline prompt"));
    assert.ok(prompts.includes("stdin prompt"));
  });
});

test("mcoda agent-run emits JSON output with prompts and responses", { concurrency: false }, async () => {
  await withTempHome(async () => {
    await AgentsCommands.run(["add", "json-run", "--adapter", "qa-cli", "--capability", "chat"]);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      await AgentRunCommand.run(["json-run", "--prompt", "Ping", "--json"]);
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(logs.join("\n"));
    assert.equal(parsed.agent.slug, "json-run");
    assert.ok(Array.isArray(parsed.responses));
    assert.equal(parsed.responses[0].prompt, "Ping");
    assert.equal(typeof parsed.responses[0].output, "string");
  });
});
