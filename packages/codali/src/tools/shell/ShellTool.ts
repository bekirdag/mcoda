import path from "node:path";
import { ToolExecutionError, type ToolContext, type ToolDefinition } from "../ToolTypes.js";
import { runProcess } from "./AsyncProcess.js";
import { resolveShellWorkingDirectory } from "./ShellWorkingDirectory.js";

/** Shared by terminal execution and tool-enabled benchmark baselines. */
export const DEVELOPMENT_COMMANDS = ["git", "rg", "node", "npm", "pnpm", "npx", "python3", "pytest", "cargo", "rustc", "go", "make", "cmake", "tsc", "sh", "bash", "ls", "cat", "pwd", "expr", "printf", "head", "tail", "sed", "awk", "uname", "which", "env", "find", "wc", "sort", "uniq", "cut", "diff", "file", "stat", "du", "df", "mkdir", "touch", "cp", "mv", "curl", "wget", "tar", "unzip", "zip", "cc", "gcc", "g++", "clang", "clang++", "ar", "swift", "swiftc", "java", "javac", "xcrun", "xcodebuild", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

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
  description: 'Run an allowlisted executable. Use $TMPDIR for transient per-call scratch space; scratch files, exports and cwd changes do not persist between calls. Save required project outputs in claimed workspace writePaths; create missing scoped files/directories with write_file/create_directory first. Package-manager cache environment variables point to persistent workspace-private caches; do not hardcode their paths. Each call is isolated and kills its background processes on return; nohup, setsid and tmux cannot keep a server alive. Use browser_session for persistent noVNC/static previews and browser_interact for official Browser Use. Default cwd is the workspace root; set cwd for a module-local command, e.g. {"command":"npm","args":["test"],"cwd":"packages/app"}. In terminal mode the workspace is read-only unless writePaths names root-relative paths inside the claimed task. Existing source files in those paths require current reads and structural analysis.',
  readOnly: false,
  capability: "shell",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "One executable name, without arguments or shell syntax." },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string", description: "Existing working directory inside the workspace, relative to its root. Default: workspace root. Does not change the base of writePaths." },
      writePaths: { type: "array", items: { type: "string" }, description: "Terminal mode: root-relative existing files/directories to make writable, regardless of cwd. Default: no workspace writes. Must fit the claimed task scope." },
    },
  },
  handler: async (args, context: ToolContext) => {
    if (!context.allowShell) {
      throw new ToolExecutionError("tool_permission_denied", "Shell tool is disabled", {
        retryable: false,
      });
    }
    const { command, args: commandArgs = [], cwd } = args as { command: string; args?: string[]; cwd?: string };
    if (
      !context.allowDestructiveOperations
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
    return (context.shellExecutor ?? runProcess)(command, effectiveArgs, { ...context, shellWorkingDirectory });
  },
});
