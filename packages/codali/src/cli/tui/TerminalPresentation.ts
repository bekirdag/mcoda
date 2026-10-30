const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fragment = (value: unknown): string => typeof value === "string" ? value.slice(0, 120) : "";

export const toolActivity = (name: string, args: unknown): string => {
  const data = record(args), file = fragment(data.path ?? data.file), query = fragment(data.query);
  switch (name) {
    case "read_file": return `Reading ${file || "a file"}`;
    case "write_file": return `Updating ${file || "a file"}`;
    case "prepare_edit": return `Checking ${file || "the code"} before editing`;
    case "list_files": case "docdex_tree": return `Exploring ${file || "the workspace"}`;
    case "search": case "search_files": case "docdex_search": return query ? `Searching for “${query}”` : "Searching the project";
    case "run_shell": return `Running ${fragment([data.command, ...(Array.isArray(data.args) ? data.args.filter(x => typeof x === "string") : [])].join(" "))}`;
    case "docdex_symbols": case "docdex_ast": return `Understanding the structure of ${file || "the code"}`;
    case "docdex_impact_graph": return `Checking what depends on ${file || "this code"}`;
    case "docdex_web_research": return query ? `Looking up “${query}” on the web` : "Looking up web sources";
    case "server_time": return `Checking the server clock${data.timezone ? ` in ${fragment(data.timezone)}` : ""}`;
    case "calculate": return `Calculating ${fragment(data.expression)}`;
    case "browser_open": return `Opening ${fragment(data.url)} in the browser`;
    case "browser_read": return "Reading more of the browser page";
    case "skill_list": return "Finding relevant skills";
    case "skill_load": return `Loading ${fragment(data.id) || "a skill"}`;
    case "skill_read": return "Reading a skill reference";
    case "context_read": return "Recovering earlier conversation details";
    case "work_claim": return "Starting the next task";
    case "work_verify": return "Reviewing the work and its checks";
    case "work_complete": return "Checking that every requirement is complete";
    case "work_checkpoint": return "Saving progress";
    case "work_plan": case "work_refine": return "Updating the work plan";
    case "work_status": return "Checking progress";
    case "work_block": return "Recording what needs attention";
    default: return name.replace(/_/g, " ");
  }
};

export const terminalHelp = (): string => [
  "GET STARTED", "  Just type a message. Ask a question, inspect your project, or request a change.", "",
  "CONVERSATION", "  /new             Start fresh; keep the saved session", "  /sessions        Browse saved conversations", "  /resume ID       Pick up a saved session", "  /continue        Resume the active work", "  /stop            Stop safely and keep progress", "  /quit            Close Codali", "",
  "WORK & REVIEW", "  /status          Current workspace and progress", "  /goal · /plan · /tasks · /decisions", "  /diff            Inspect workspace changes", "  /review          Review the current work", "  /artifacts       Browse, open or export generated files", "",
  "MODELS & LIMITS", "  /usage           Tokens, model calls and account limits", "  /model · /models  Inspect or select model routes", "  /effort          low · medium · high · max", "  /permissions     plan · ask · workspace", "  /config          Inspect, validate or reload configuration", "",
  "CONTEXT & RECOVERY", "  /context · /compact · /checkpoint · /fork", "  /skills          Browse available local skills", "  /tools · /mcp · /docdex", "  /reconcile · /reconcile-media · /retention", "",
  "KEYBOARD & MOUSE", "  Enter            Send or queue a message", "  Alt+Enter        New line (Ctrl+J also works)", "  Wheel / PgUp↓    Scroll messages and command views", "  Ctrl+End         Return to the latest message", "  Shift+drag       Select text in mouse-aware terminals", "  Ctrl+O           Show tool details", "  Ctrl+P / Ctrl+R  Commands / input history", "  Tab              Complete a command or @file", "  Ctrl+S           Interrupt and steer", "  Esc / Ctrl+C     Cancel; Esc also closes views",
].join("\n");

export const terminalUsage = (value: unknown): string => {
  const data = record(value), usage = record(data.session), turn = record(data.turn);
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : "—";
  const total = Number(usage.tokens) || 0, input = Number(usage.inputTokens) || 0;
  const filled = Math.max(0, Math.min(24, Math.round(total ? 24 * input / total : 0)));
  const lines = ["SESSION USAGE", "", `  ${number(usage.tokens)} tokens${usage.estimated ? " · includes estimates" : ""}`,
    `  ${"━".repeat(filled)}${"░".repeat(24 - filled)}  input / output`, "",
    `  Input       ${number(usage.inputTokens)}`, `  Output      ${number(usage.outputTokens)}`,
    `  Model calls ${number(usage.modelCalls)}`, `  Tool calls  ${number(usage.toolCalls)}`, "",
    "LATEST TURN", `  ${number(turn.tokens)} tokens · ${number(turn.modelCalls)} model calls · ${number(turn.toolCalls)} tool calls`, "",
    "Session totals accumulate. Turn limits restart for each message; uncertain requests keep their reservations.", "", "ACCOUNT LIMITS"];
  for (const [provider, raw] of Object.entries(record(data.server))) {
    lines.push("", `  ${provider}`);
    const item = record(raw);
    if (item.available === false) lines.push(`  ${fragment(item.error) || "Usage is unavailable from this provider."}`);
    else {
      const describe = (value: unknown, indent = "  "): string[] => {
        if (Array.isArray(value)) return value.flatMap((entry, index) => [`${indent}${index + 1}.`, ...describe(entry, indent + "  ")]);
        if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => {
          const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
          return entry && typeof entry === "object" ? [`${indent}${label}`, ...describe(entry, indent + "  ")] : [`${indent}${label}: ${typeof entry === "number" ? number(entry) : entry ?? "—"}`];
        });
        return [`${indent}${String(value)}`];
      };
      lines.push(...describe(raw));
    }
  }
  return lines.join("\n");
};
