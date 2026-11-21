import path from "node:path";

/** Budget eligibility for inspection only; never substitutes for test evidence. */
export const isVerificationInspectionCommand = (args: unknown): boolean => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const value = args as { command?: unknown; args?: unknown; writePaths?: unknown };
  if (value.command !== "git" || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string")) return false;
  if (value.writePaths !== undefined && (!Array.isArray(value.writePaths) || value.writePaths.length !== 0)) return false;
  const argv = value.args as string[];
  const flags = argv[0] === "diff"
    ? ["--no-ext-diff", "--no-textconv", "--no-color", "--stat", "--name-only", "--name-status", "--check", "--cached", "--staged"]
    : argv[0] === "status" ? ["--short", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--branch"] : undefined;
  if (!flags) return false;
  let paths = false;
  for (const arg of argv.slice(1)) {
    if (paths) { if (!arg) return false; }
    else if (arg === "--") paths = true;
    else if (!flags.includes(arg)) return false;
  }
  return true;
};

/** Words of one simple command, or undefined when it holds anything a shell
 * would expand or interpret: variables, braces, globs, tildes, escapes, comments. */
const shellWords = (text: string): string[] | undefined => {
  const words: string[] = []; let current = "", quoted: string | undefined, started = false;
  for (const char of text) {
    if (quoted) { if (char === quoted) quoted = undefined; else if (quoted === '"' && /[`\\$]/.test(char)) return undefined; else current += char; continue; }
    if (char === '"' || char === "'") { quoted = char; started = true; continue; }
    if (/\s/.test(char)) { if (started || current) words.push(current); current = ""; started = false; continue; }
    if (!/[A-Za-z0-9_@%+=:,.\/-]/.test(char)) return undefined;
    current += char;
  }
  if (quoted) return undefined;
  if (started || current) words.push(current);
  return words;
};

/** Environment a test line may set: names that configure the app under test,
 * never ones that change how the shell, npm or the runtime start a command. */
const SAFE_ENV = /^(?:PORT|HOST|NODE_ENV|CI|TZ|LANG|LC_ALL|FORCE_COLOR|NO_COLOR|DB_PATH|DATA_DIR|LOG_LEVEL|DEBUG)=[A-Za-z0-9_@%+:,.\/-]*$/;
/** Programs that may run before or after the test in the same line. They are
 * ordinary processes: unlike exit, exec, trap, eval or set +o they cannot change
 * what the shell reports for the steps around them. */
const STEP_PROGRAMS = new Set(["npm", "pnpm", "yarn", "bun", "node", "npx", "tsc", "python3", "pytest", "cargo", "go", "make", "mkdir"]);

/** Whether a `bash -c` / `sh -c` line can stand as validation: steps joined
 * only by &&, so any failing step fails the call, with a real test command
 * among them. Every step is `cd <dir>`, `set -e` (never `set +...`) or one of a
 * few ordinary programs; nothing is expanded, substituted or redefined.
 * `cmd; echo EXIT=$?`, `|| true`, `exit 0 && ...`, `trap`, variables and brace
 * lists are refused. Output may go to a file, and in bash (which runs with
 * pipefail) through tail, head, grep, tee or cat. */
export const failFastShellVerification = (command: string, argv: string[]): boolean => {
  if (!["bash", "sh"].includes(command)) return false;
  const flags = argv.slice(0, -1).filter(arg => arg !== "-o" && arg !== "pipefail");
  if (argv.length < 2 || flags.length !== flags.filter(arg => /^-[euxc]+$/.test(arg) || arg === "--noprofile" || arg === "--norc").length || !flags.some(arg => /^-[eux]*c$/.test(arg))) return false;
  const script = argv.at(-1)!;
  if (script.length > 2000 || /[\n`]|\$\(|\$'|\$"|<</.test(script)) return false;
  // Quoted text is set aside so a "|" or ";" inside a grep pattern is not read as shell syntax.
  const quoted: string[] = [];
  const masked = script.replace(/2>&1/g, " ").replace(/"[^"]*"|'[^']*'/g, text => `\u0000${quoted.push(text) - 1}\u0000`);
  if (/["';#]|\|\||&(?!&)(?<!&&)/.test(masked)) return false;
  const restore = (text: string) => text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => quoted[Number(index)]);
  let verified = false;
  for (const step of masked.split("&&")) {
    const [head, ...filters] = step.split("|");
    if (filters.length && (command !== "bash" || filters.some(filter => !/^\s*(?:tail|head|grep|tee|cat)\b[^<>&]*$/.test(filter) || /[$`]/.test(restore(filter))))) return false;
    // Redirection to a file keeps the exit status; the target is not a word of the command.
    const words = shellWords(restore(head.replace(/\s\d?>>?\s*\S+/g, " ")));
    if (!words?.length) return false;
    let at = 0;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) { if (!SAFE_ENV.test(words[at])) return false; at++; }
    if (at >= words.length) return false;
    if (words[at] === "timeout") {
      at++;
      while (words[at] === "-s" || words[at] === "-k") { if (!/^[A-Za-z0-9.]+$/.test(words[at + 1] ?? "")) return false; at += 2; }
      if (!/^\d+(?:\.\d+)?[smh]?$/.test(words[at] ?? "")) return false;
      at++;
    }
    const program = words[at], args = words.slice(at + 1);
    if (program === "cd") { if (at !== 0 || args.length !== 1 || args[0].startsWith("-")) return false; continue; }
    if (program === "set") { if (at !== 0 || !(args.length === 1 && /^-[eux]+$/.test(args[0]) || args.length === 2 && /^-[eux]*o$/.test(args[0]) && args[1] === "pipefail")) return false; continue; }
    if (!STEP_PROGRAMS.has(program)) return false;
    if (isVerificationCommand({ command: program, args })) verified = true;
  }
  return verified;
};

/** Command-shape eligibility only; success, fresh input hashes and review remain mandatory. */
export const isVerificationCommand = (args: unknown): boolean => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const value = args as { command?: unknown; args?: unknown };
  if (typeof value.command !== "string" || value.args !== undefined && (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string"))) return false;
  const command = path.basename(value.command); const argv = (value.args ?? []) as string[];
  if (failFastShellVerification(command, argv)) return true;
  if (argv.some(arg => /^(?:--help|-h|--version|--dry-run|--if-present|--collect-only|--collectonly|--listTests|--list-tests|--showConfig|--listFilesOnly)(?:=|$)/.test(arg))) return false;
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
    let offset = 0;
    const directoryFlags = command === "npm" ? ["--prefix"] : command === "pnpm" ? ["--dir", "-C"] : ["--cwd"];
    while (offset < argv.length) {
      if (["--silent", "-s", "--quiet", "-q", "--no-progress"].includes(argv[offset])) { offset++; continue; }
      if (directoryFlags.includes(argv[offset])) {
        if (!argv[offset + 1] || argv[offset + 1].startsWith("-")) return false;
        offset += 2; continue;
      }
      if (directoryFlags.some(flag => argv[offset].startsWith(`${flag}=`) && argv[offset].length > flag.length + 1)) { offset++; continue; }
      break;
    }
    return argv[offset] === "test" || argv[offset] === "run" && /^(test|check|typecheck|lint)(:|$)/.test(argv[offset + 1] ?? "");
  }
  if (command === "node") {
    let offset = 0;
    while (["--no-warnings", "--enable-source-maps"].includes(argv[offset])) offset++;
    return argv[offset] === "--test" || /(?:^|\/)\S+\.(?:test|spec)\.[cm]?js$/.test(argv[offset] ?? "");
  }
  if (command === "pytest") return !argv.includes("-V");
  if (command === "tsc") return !argv.includes("-v");
  if (["cargo", "go", "make"].includes(command)) return argv[0] === "test";
  return command === "python3" && argv[0] === "-m" && ["pytest", "unittest"].includes(argv[1]);
};
