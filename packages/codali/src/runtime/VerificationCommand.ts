import path from "node:path";

/** Command-shape eligibility only; success, fresh input hashes and review remain mandatory. */
export const isVerificationCommand = (args: unknown): boolean => {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const value = args as { command?: unknown; args?: unknown };
  if (typeof value.command !== "string" || value.args !== undefined && (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string"))) return false;
  const command = path.basename(value.command); const argv = (value.args ?? []) as string[];
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
