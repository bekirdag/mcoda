import { terminalText } from "../TerminalText.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fragment = (value: unknown): string => typeof value === "string" ? value.slice(0, 120) : "";

export const toolActivity = (name: string, args: unknown): string => {
  const data = record(args), file = fragment(data.path ?? data.file), query = fragment(data.query);
  switch (name) {
    case "tools_discover": return "Finding available tools";
    case "tools_enable": return "Preparing selected tools";
    case "read_file": case "docdex_open": case "docdex_open_file": return `Reading ${file || "a file"}`;
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

/** Render only observed output: no extra inference and no invented success claims. */
export const toolCompletionSummary = (name: string, args: unknown, output?: string): string => {
  const snippet = (value: unknown): string => {
    if (typeof value !== "string") return "";
    const clean = terminalText(value).trim();
    const lines = clean.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const preview = lines.slice(0, 3).join("\n");
    return preview.slice(0, 280) + (preview.length > 280 || lines.length > 3 ? "…" : "");
  };
  let parsed: unknown;
  if (output && output.length <= 262144) { try { parsed = JSON.parse(output); } catch { /* Plain text is already a useful excerpt. */ } }
  const data = record(parsed), input = record(args);
  if (name === "tools_discover") {
    if (!Array.isArray(parsed)) return "Tool discovery returned a partial listing. Ctrl+O shows the available details.";
    if (!parsed.length) return "No additional tools were listed.";
    const descriptions = parsed.slice(0, 3).map(item => {
      const tool = record(item);
      return snippet(tool.description) || snippet(typeof tool.name === "string" ? tool.name.replace(/_/g, " ") : "");
    }).filter(Boolean);
    return `Listed ${parsed.length} available tool${parsed.length === 1 ? "" : "s"}.${descriptions.length ? `\n${snippet(descriptions.map(value => `• ${value}`).join("\n"))}` : ""}\nCtrl+O shows the full listing.`;
  }
  if (name === "tools_enable" && Array.isArray(data.enabled)) {
    return `Prepared ${data.enabled.length} tool${data.enabled.length === 1 ? "" : "s"} for the model to use. Execution permissions still apply. Ctrl+O shows which tools.`;
  }
  const path = snippet(data.path ?? input.path ?? input.file);
  if (["docdex_open", "docdex_open_file", "read_file"].includes(name)) {
    const content = typeof data.content === "string" ? data.content : parsed === undefined ? output : "";
    const range = Number.isInteger(data.start_line) && Number.isInteger(data.end_line) ? ` · lines ${data.start_line}–${data.end_line}` : "";
    return `Read ${path || "file content"}${range}.\n${snippet(content) || "No text returned."}`;
  }
  if (["docdex_search", "search", "search_files"].includes(name) && Array.isArray(data.hits)) {
    if (!data.hits.length) return "No matching results returned. Try a narrower query or check the index.";
    const hits = data.hits.slice(0, 3).map(hit => { const row = record(hit); return snippet(row.path ?? row.rel_path ?? row.doc_id); }).filter(Boolean);
    return `Found ${data.hits.length} result${data.hits.length === 1 ? "" : "s"}${hits.length ? `: ${hits.join(", ")}` : "."}`;
  }
  if (typeof data.tree === "string") return `Workspace structure:\n${snippet(data.tree) || "No entries returned."}`;
  if (Array.isArray(data.entries)) return `Found ${data.entries.length} entries.\n${snippet(data.entries.filter(entry => typeof entry === "string").slice(0, 3).join("\n"))}`;
  const message = snippet(data.message ?? data.output ?? data.summary ?? data.content);
  if (message) return message;
  if (parsed === undefined && output?.trim()) {
    if (/^\s*[\[{]/.test(output)) return "Received structured output. Ctrl+O shows the available details.";
    return snippet(output);
  }
  if (Array.isArray(data.tasks)) return `Plan contains ${data.tasks.length} tasks. Ctrl+O shows the plan.`;
  if (name === "work_claim" && typeof data.title === "string") return `Started: ${snippet(data.title)}`;
  return "Result received. Ctrl+O shows the full details.";
};

export const terminalHelp = (): string => [
  "GET STARTED", "  Just type a message. Ask a question, inspect your project, or request a change.", "",
  "CONVERSATION", "  /new             Start fresh; keep the saved session", "  /sessions        Browse saved conversations", "  /resume ID       Pick up a saved session", "  /continue        Resume the active work", "  /stop            Stop safely and keep progress", "  /quit            Close Codali", "",
  "WORK & REVIEW", "  /status          Current workspace and progress", "  /goal · /plan · /tasks · /decisions", "  /diff            Inspect workspace changes", "  /review          Review the current work", "  /artifacts       Browse, open or export generated files", "",
  "MODELS & LIMITS", "  /usage           Tokens, model calls and account limits", "  /model · /models  Inspect or select model routes", "  /effort          low · medium · high · max", "  /permissions     plan · ask · workspace · full (saved per directory)", "  /config          Inspect, validate or reload configuration", "",
  "CONTEXT & RECOVERY", "  /context · /compact · /checkpoint · /fork", "  /skills          Browse available local skills", "  /tools · /mcp · /docdex", "  /reconcile · /reconcile-media · /retention", "",
  "KEYBOARD & MOUSE", "  Enter / Tab      Send/queue; Tab completes /commands", "  Alt+Enter        New line (Ctrl+J also works)", "  Wheel / PgUp↓    Scroll messages and command views", "  Ctrl+End         Return to the latest message", "  Drag             Select and auto-copy text (OSC52)", "  Ctrl+O           Show tool details", "  Ctrl+P / Ctrl+R  Commands / input history", "  Shift+Tab        Complete a command or @file", "  Ctrl+S           Interrupt and steer", "  Ctrl+C / Ctrl+Z  Cancel work; press again to exit",
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
