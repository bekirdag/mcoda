import { spawn } from "node:child_process";
import type { Provider, ProviderConfig, ProviderMessage, ProviderRequest, ProviderResponse } from "./ProviderTypes.js";

const CODEX_NO_SANDBOX_ENV = "MCODA_CODEX_NO_SANDBOX";
const CODEX_REASONING_ENV = "MCODA_CODEX_REASONING_EFFORT";
const CODEX_REASONING_ENV_FALLBACK = "CODEX_REASONING_EFFORT";
const CODEX_STUB_ENV = "MCODA_CLI_STUB";
const ALLOWED_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const DEFAULT_REASONING_EFFORT = "high";

const normalizeReasoningEffort = (raw: string): string | undefined => {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  const compact = normalized.replace(/[\s_-]+/g, "");
  if (compact === "xhigh" || compact === "veryhigh" || compact === "max") return "high";
  if (compact === "xmedium" || compact === "med") return "medium";
  if (compact === "xlow" || compact === "min") return "low";
  if (ALLOWED_REASONING_EFFORTS.has(normalized)) return normalized;
  return undefined;
};

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
  if (!raw) return DEFAULT_REASONING_EFFORT;
  return normalizeReasoningEffort(raw) ?? DEFAULT_REASONING_EFFORT;
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
    const resolvedModel = this.config.model?.trim();
    if (!resolvedModel) {
      throw new Error(
        "AUTH_ERROR: codex-cli provider requires model from selected mcoda agent/config.",
      );
    }
    const sandbox = resolveSandboxArgs();
    const args = [...sandbox.args, "exec", "--model", resolvedModel, "--json"];
    if (!sandbox.bypass) {
      args.push("--full-auto");
    }
    const reasoningEffort = resolveReasoningEffort();
    if (reasoningEffort) {
      args.push("-c", `reasoning_effort=${reasoningEffort}`);
      args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
    }
    const timeoutMs = Math.max(1, this.config.timeoutMs ?? 120_000);
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (reasoningEffort) {
      childEnv[CODEX_REASONING_ENV] = reasoningEffort;
      childEnv[CODEX_REASONING_ENV_FALLBACK] = reasoningEffort;
    } else {
      delete childEnv[CODEX_REASONING_ENV];
      delete childEnv[CODEX_REASONING_ENV_FALLBACK];
    }

    return await new Promise<ProviderResponse>((resolve, reject) => {
      const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
      let raw = "";
      let stderr = "";
      let lineBuffer = "";
      let message = "";
      let settled = false;

      const finishResolve = (response: ProviderResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(response);
      };

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      };

      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        const reason =
          `AUTH_ERROR: codex CLI timed out after ${timeoutMs}ms` +
          (stderr.trim().length > 0 ? `: ${stderr.trim()}` : "");
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 500).unref();
        finishReject(new Error(reason));
      }, timeoutMs);
      timeoutHandle.unref();

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

      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        // Codex can exit before consuming stdin; ignore the resulting broken-pipe.
        if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") {
          return;
        }
        finishReject(new Error(`AUTH_ERROR: codex CLI stdin failed (${error.message})`));
      });

      child.on("error", (error) => {
        finishReject(new Error(`AUTH_ERROR: codex CLI failed (${error.message})`));
      });

      child.on("close", (code) => {
        if (settled) return;
        if (lineBuffer.trim()) {
          handleLine(lineBuffer);
        }
        if (code !== 0) {
          finishReject(
            new Error(
              `AUTH_ERROR: codex CLI failed (exit ${code}): ${stderr || raw}`.trim(),
            ),
          );
          return;
        }
        const output = message.trim() || parseCodexOutput(raw).trim();
        finishResolve({ message: { role: "assistant", content: output }, raw });
      });

      try {
        child.stdin.end(prompt);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "EPIPE" && err.code !== "ERR_STREAM_DESTROYED") {
          finishReject(new Error(`AUTH_ERROR: codex CLI stdin failed (${err.message})`));
        }
      }
    });
  }
}
