import { spawn } from "node:child_process";
import type {
  Provider,
  ProviderConfig,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
} from "./ProviderTypes.js";

const CLAUDE_BIN_ENV = "MCODA_CLAUDE_CLI_BIN";
const CLAUDE_STUB_ENV = "MCODA_CLAUDE_STUB";
const GLOBAL_STUB_ENV = "MCODA_CLI_STUB";
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const formatMessages = (messages: ProviderMessage[]): string =>
  messages
    .map((message) => {
      const name = message.name ? `(${message.name})` : "";
      return `${message.role}${name}: ${message.content}`;
    })
    .join("\n\n");

const isIgnorableStdinError = (error: NodeJS.ErrnoException): boolean =>
  error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED";

export class ClaudeCliProvider implements Provider {
  /** Driven through the claude CLI's text interface; no structured tool calls. */
  readonly supportsToolCalls = false;

  name = "claude-cli";

  constructor(private readonly config: ProviderConfig) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const last = request.messages[request.messages.length - 1];
    const emitToken = (token: string) => {
      if (request.onEvent) {
        request.onEvent({ type: "token", content: token });
        return;
      }
      request.onToken?.(token);
    };
    if (process.env[CLAUDE_STUB_ENV] === "1" || process.env[GLOBAL_STUB_ENV] === "1") {
      const stubContent = `claude-stub:${last?.content ?? ""}`;
      if (request.stream) emitToken(stubContent);
      return { message: { role: "assistant", content: stubContent } };
    }

    const model = this.config.model?.trim();
    if (!model) {
      throw new Error(
        "AUTH_ERROR: claude-cli provider requires model from selected mcoda agent/config.",
      );
    }

    const command = process.env[CLAUDE_BIN_ENV]?.trim() || "claude";
    const args = ["--print", "--output-format", "text", "--model", model];
    const prompt = formatMessages(request.messages);
    const timeoutMs = Math.max(1, this.config.timeoutMs ?? 300_000);

    return await new Promise<ProviderResponse>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
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
      const terminate = () => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 500).unref();
      };

      const timeoutHandle = setTimeout(() => {
        terminate();
        finishReject(new Error(`AUTH_ERROR: claude CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeoutHandle.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          terminate();
          finishReject(new Error(`AUTH_ERROR: claude CLI output exceeded ${MAX_OUTPUT_BYTES} bytes`));
          return;
        }
        const text = chunk.toString();
        stdout += text;
        if (request.stream && text) emitToken(text);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (settled || isIgnorableStdinError(error)) return;
        finishReject(new Error(`AUTH_ERROR: claude CLI stdin failed (${error.message})`));
      });
      child.on("error", (error) => {
        finishReject(new Error(`AUTH_ERROR: claude CLI failed (${error.message})`));
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finishReject(
            new Error(`AUTH_ERROR: claude CLI failed (exit ${code}): ${stderr || stdout}`.trim()),
          );
          return;
        }
        finishResolve({
          message: { role: "assistant", content: stdout.trim() },
          raw: stdout,
        });
      });

      setImmediate(() => {
        if (settled || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
        try {
          child.stdin.end(prompt);
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (!isIgnorableStdinError(err)) {
            finishReject(new Error(`AUTH_ERROR: claude CLI stdin failed (${err.message})`));
          }
        }
      });
    });
  }
}
