import path from "node:path";
import { ToolExecutionError, type ToolContext, type ToolDefinition } from "../ToolTypes.js";
import { runProcess } from "./AsyncProcess.js";
import { resolveShellWorkingDirectory } from "./ShellWorkingDirectory.js";

/** Shared by terminal execution and tool-enabled benchmark baselines. */
export const DEVELOPMENT_COMMANDS = ["git", "rg", "grep", "node", "npm", "pnpm", "npx", "python3", "pytest", "cargo", "rustc", "go", "make", "cmake", "tsc", "sh", "bash", "ls", "cat", "pwd", "expr", "printf", "head", "tail", "sed", "awk", "uname", "which", "env", "find", "wc", "sort", "uniq", "cut", "diff", "file", "stat", "du", "df", "mkdir", "touch", "cp", "mv", "rm", "curl", "wget", "tar", "unzip", "zip", "cc", "gcc", "g++", "clang", "clang++", "ar", "swift", "swiftc", "java", "javac", "xcrun", "xcodebuild", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** A fixed two minutes ended test suites and browser journeys fifteen times in
 * one 12-hour build; the caller can now ask for the time a command needs. */
/** What to use when a listed command is missing on the host. */
const MISSING_ALTERNATIVES: Record<string, string> = { rg: "grep -rn (add -E for extended patterns)", fd: "find", python3: "node", pytest: "python3 -m unittest", pnpm: "npm", tsc: "npx tsc" };

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 120;
export const MAX_SHELL_TIMEOUT_SECONDS = 900;

const resolveAllowlist = (context: ToolContext): string[] => {
  return context.shellAllowlist ?? [];
};

const DESTRUCTIVE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "unlink",
  "shred",
  "truncate",
  "mkfs",
  "dd",
  "format",
]);

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/,
  /\brmdir\b/,
  /\bdel(?:ete)?\b/,
  /\berase\b/,
  /\bremove-item\b/,
  /\btruncate\b/,
  /\bshred\b/,
  /\bmkfs\b/,
  /\bdd\b/,
  // Swift's named argument and formatting methods are source syntax, not the
  // disk-format command. Direct executable names are checked separately.
  /(?<!\.)\bformat\b(?!\s*:)/,
  /\bfs\.rm(?:sync)?\s*\(/,
  /\bunlink(?:sync)?\s*\(/,
];

const isDestructiveShellAction = (command: string, args: string[]): boolean => {
  const base = path.basename(command).toLowerCase();
  if (DESTRUCTIVE_COMMANDS.has(base)) {
    return true;
  }
  const joined = [command, ...args].join(" ").toLowerCase();
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(joined));
};

export const createShellTool = (): ToolDefinition => ({
  name: "run_shell",
  description: 'Run an allowlisted executable. Use $TMPDIR for scratch space: files written under $TMPDIR stay available to later calls in this session, while exports, cwd changes and other /tmp paths do not persist between calls. Save required project outputs in claimed workspace writePaths; create missing scoped files/directories with write_file/create_directory first. Package-manager cache environment variables point to persistent workspace-private caches; do not hardcode their paths. Deleting files works only inside $TMPDIR and the writePaths of the call. Each call is isolated and kills its background processes on return; nohup, setsid and tmux cannot keep a server alive. Use browser_session for persistent noVNC/static previews and browser_interact for official Browser Use. Default cwd is the workspace root; set cwd for a module-local command, e.g. {"command":"npm","args":["test"],"cwd":"packages/app"}. In terminal mode the workspace is read-only unless writePaths names root-relative paths inside the claimed task. Existing source files in those paths require current reads and structural analysis.',
  readOnly: false,
  capability: "shell",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "One executable name, without arguments or shell syntax." },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string", description: "Existing working directory inside the workspace, relative to its root. Default: workspace root. Does not change the base of writePaths." },
      writePaths: { type: "array", items: { type: "string" }, description: "Terminal mode: root-relative files/directories to make writable, regardless of cwd; a path the command creates (such as a rename target) may be named when its parent directory exists. Default: no workspace writes. Must fit the claimed task scope." },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_SHELL_TIMEOUT_SECONDS, description: `Time allowed for this command. Default ${DEFAULT_SHELL_TIMEOUT_SECONDS}; raise it (up to ${MAX_SHELL_TIMEOUT_SECONDS}) for a full test suite, a build or a browser journey that needs longer.` },
    },
  },
  handler: async (args, context: ToolContext) => {
    if (!context.allowShell) {
      throw new ToolExecutionError("tool_permission_denied", "Shell tool is disabled", {
        retryable: false,
      });
    }
    const { command, args: commandArgs = [], cwd, timeoutSeconds } = args as { command: string; args?: string[]; cwd?: string; timeoutSeconds?: number };
    if (timeoutSeconds !== undefined && (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_SHELL_TIMEOUT_SECONDS)) {
      throw new ToolExecutionError("tool_invalid_args", `timeoutSeconds must be a whole number from 1 to ${MAX_SHELL_TIMEOUT_SECONDS}`, { retryable: false });
    }
    if (
      !context.allowDestructiveOperations
      && !context.shellIsolated
      && isDestructiveShellAction(command, commandArgs)
    ) {
      throw new ToolExecutionError(
        "tool_permission_denied",
        "Destructive operation blocked by policy",
        {
          retryable: false,
          details: {
            command,
            args: commandArgs,
            reason_code: "destructive_operation_blocked",
            policy: "allowDestructiveOperations",
          },
        },
      );
    }
    const allowlist = resolveAllowlist(context);
    if (!allowlist.length || !allowlist.includes(command)) {
      throw new ToolExecutionError("tool_permission_denied", `Command not allowed: ${command.slice(0, 160)}. Available executables: ${allowlist.slice(0, 12).join(", ").slice(0, 700)}${allowlist.length > 12 ? " (first 12 shown)" : ""}`, {
        retryable: false,
        details: { command },
      });
    }

    const shellWorkingDirectory = resolveShellWorkingDirectory(context.workspaceRoot, cwd);
    const effectiveArgs = [...commandArgs];
    if (command === "bash") {
      // Bash requires long options before short options. Preserve caller flags
      // and script parameters; only make failed pipeline stages observable.
      let at = 0;
      while (effectiveArgs[at]?.startsWith("--") && effectiveArgs[at] !== "--") {
        at += ["--rcfile", "--init-file"].includes(effectiveArgs[at]) ? 2 : 1;
      }
      effectiveArgs.splice(at, 0, "-o", "pipefail");
    }
    // A host may set the default (shellTimeoutMs) and the most a command may ask
    // for (shellMaxTimeoutMs). A host that sets only a default keeps it as the cap.
    const defaultMs = context.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_SECONDS * 1000;
    const maxMs = context.shellMaxTimeoutMs ?? (context.shellTimeoutMs !== undefined ? context.shellTimeoutMs : MAX_SHELL_TIMEOUT_SECONDS * 1000);
    const shellTimeoutMs = timeoutSeconds === undefined ? defaultMs : Math.min(timeoutSeconds * 1000, maxMs);
    try {
      return await (context.shellExecutor ?? runProcess)(command, effectiveArgs, { ...context, shellWorkingDirectory, shellTimeoutMs });
    } catch (error) {
      // An allowed command that is not installed on this machine (rg on a host
      // without ripgrep) is named as such, with what to use instead.
      const missing = error instanceof ToolExecutionError ? /execvp ([\w.+-]+): No such file or directory|spawn ([\w.+-]+) ENOENT/.exec(`${error.message} ${String((error.details as { stderr?: unknown } | undefined)?.stderr ?? "")}`) : null;
      if (missing) {
        const name = missing[1] ?? missing[2];
        throw new ToolExecutionError("tool_execution_failed", `${name} is not installed on this machine.${MISSING_ALTERNATIVES[name] ? ` Use ${MISSING_ALTERNATIVES[name]} instead.` : " Use another available command."}`, { retryable: false, details: (error as ToolExecutionError).details });
      }
      if (error instanceof ToolExecutionError && error.code === "tool_timeout" && shellTimeoutMs < maxMs) {
        error.message += `\nThe command was stopped after ${Math.round(shellTimeoutMs / 1000)} s. If it needs longer, pass timeoutSeconds (up to ${Math.floor(maxMs / 1000)}); start servers in the background so the call can return.`;
      }
      throw error;
    }
  },
});
