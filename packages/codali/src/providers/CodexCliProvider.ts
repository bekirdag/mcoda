import { spawn } from "node:child_process";
import type { Provider, ProviderConfig, ProviderMessage, ProviderRequest, ProviderResponse } from "./ProviderTypes.js";

const CODEX_NO_SANDBOX_ENV = "MCODA_CODEX_NO_SANDBOX";
const CODEX_REASONING_ENV = "MCODA_CODEX_REASONING_EFFORT";
const CODEX_REASONING_ENV_FALLBACK = "CODEX_REASONING_EFFORT";
const CODEX_STUB_ENV = "MCODA_CLI_STUB";

const resolveSandboxArgs = (): { args: string[]; bypass: boolean } => {
  const raw = process.env[CODEX_NO_SANDBOX_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { args: ["--dangerously-bypass-approvals-and-sandbox"], bypass: true };
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "0") {
    return { args: [], bypass: false };
  }
  return { args: ["--dangerously-bypass-approvals-and-sandbox"], bypass: true };
};

const resolveReasoningEffort = (): string | undefined => {
  const raw = process.env[CODEX_REASONING_ENV] ?? process.env[CODEX_REASONING_ENV_FALLBACK];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : undefined;
};

const formatMessages = (messages: ProviderMessage[]): string => {
  return messages
    .map((message) => {
      const name = message.name ? `(${message.name})` : "";
      return `${message.role}${name}: ${message.content}`;
    })
    .join("\n\n");
};

const extractAssistantText = (parsed: any): { text: string; isDelta: boolean } | null => {
  if (!parsed || typeof parsed !== "object") return null;
  const type = typeof parsed.type === "string" ? parsed.type : "";
  const isDelta = type.includes("delta");
  const item = parsed.item ?? parsed;
  const contentParts = Array.isArray(item?.content)
    ? item.content.map((entry: any) => entry?.text ?? entry?.content ?? "").filter(Boolean)
    : [];
  const text =
    (typeof item?.text === "string" && item.text) ||
    (typeof item?.content === "string" && item.content) ||
    (contentParts.length ? contentParts.join("") : "") ||
    (typeof parsed.text === "string" && parsed.text) ||
    (typeof parsed.delta === "string" && parsed.delta);
  if (!text) return null;
  return { text, isDelta };
};

const parseCodexOutput = (raw: string): string => {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let message = "";
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const event = extractAssistantText(parsed);
      if (!event) continue;
      if (event.isDelta) {
        message += event.text;
      } else {
        message = event.text;
      }
    } catch {
      // ignore parse errors
    }
  }
  if (!message) {
    return lines[lines.length - 1] ?? "";
  }
  return message;
};

export class CodexCliProvider implements Provider {
  name = "codex-cli";

  constructor(private config: ProviderConfig) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const last = request.messages[request.messages.length - 1];
    const emitToken = (token: string) => {
      if (request.onEvent) {
        request.onEvent({ type: "token", content: token });
        return;
      }
      request.onToken?.(token);
    };
    if (process.env[CODEX_STUB_ENV] === "1") {
      const stubContent = `codex-stub:${last?.content ?? ""}`;
      if (request.stream) {
        emitToken(stubContent);
      }
      return {
        message: {
          role: "assistant",
          content: stubContent,
        },
      };
    }

    const prompt = formatMessages(request.messages);
    const resolvedModel = this.config.model ?? "gpt-5.1-codex-max";
    const sandbox = resolveSandboxArgs();
    const args = [...sandbox.args, "exec", "--model", resolvedModel, "--json"];
    if (!sandbox.bypass) {
      args.push("--full-auto");
    }
    const reasoningEffort = resolveReasoningEffort();
    if (reasoningEffort) {
      args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
    }

    return await new Promise<ProviderResponse>((resolve, reject) => {
      const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
      let raw = "";
      let stderr = "";
      let lineBuffer = "";
      let message = "";

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const parsedLine = (() => {
          try {
            return JSON.parse(trimmed);
          } catch {
            return null;
          }
        })();
        const event = extractAssistantText(parsedLine);
        if (!event) return;
        if (event.isDelta) {
          message += event.text;
          if (request.stream) emitToken(event.text);
          return;
        }
        message = event.text;
        if (request.stream) emitToken(event.text);
      };

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        raw += text;
        lineBuffer += text;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line);
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        reject(new Error(`AUTH_ERROR: codex CLI failed (${error.message})`));
      });

      child.on("close", (code) => {
        if (lineBuffer.trim()) {
          handleLine(lineBuffer);
        }
        if (code !== 0) {
          reject(
            new Error(
              `AUTH_ERROR: codex CLI failed (exit ${code}): ${stderr || raw}`.trim(),
            ),
          );
          return;
        }
        const output = message.trim() || parseCodexOutput(raw).trim();
        resolve({ message: { role: "assistant", content: output }, raw });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
