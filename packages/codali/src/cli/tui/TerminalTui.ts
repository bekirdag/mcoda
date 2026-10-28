import { emitKeypressEvents, type Key } from "node:readline";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionEvent } from "../../runtime/SessionController.js";
import { TerminalInput } from "../TerminalInput.js";
import { terminalText, TerminalTextStream } from "../TerminalText.js";
import { TerminalEditor } from "./TerminalEditor.js";
import { renderTerminalScreen, type TerminalOverlay, type TerminalScreenState, type TranscriptBlock } from "./TerminalScreen.js";

export interface TuiCommand { name: string; description: string; }
export interface TerminalTuiOptions {
  workspace: string; branch?: string; version: string; profile: string; effort: string; permissions: string;
  history: string[]; commands: TuiCommand[];
  submit: (text: string, intent: "queue" | "steer") => void;
  cancel: () => void; close: () => void;
}
interface Picker { kind: "command" | "history" | "file"; query: string; items: { label: string; value: string }[]; selected: number; prefix?: string; suffix?: string; }

/** One terminal owner; controller events are rendered as data, never executable escape codes. */
export class TerminalTui {
  readonly editor: TerminalEditor;
  readonly state: TerminalScreenState;
  private input: TerminalInput;
  private timer?: NodeJS.Timeout;
  private live = false;
  private previousRaw = false;
  private previousFrame: string[] = [];
  private picker?: Picker;
  private approval?: { resolve: (choice: "once" | "session" | "deny") => void; selected: number; overlay: TerminalOverlay };
  private stream = new TerminalTextStream();
  private assistant?: TranscriptBlock;
  private lastTool?: TranscriptBlock;
  private sequence = 0;
  private closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private frameRows = 12;
  private transcriptRows = 0;
  private outputBlocked = false;
  private pendingInspection?: TerminalOverlay;

  constructor(private readonly options: TerminalTuiOptions) {
    this.editor = new TerminalEditor(options.history.filter(value => Buffer.byteLength(value) <= 262144).map(value => terminalText(value).replace(/\t/g, "  ")));
    this.state = { ...options, workspace: terminalText(options.workspace), branch: options.branch ? terminalText(options.branch) : undefined, profile: terminalText(options.profile), version: terminalText(options.version), busy: false, activity: "Ready", route: "", tokens: 0, queued: 0, draft: "", cursor: 0, blocks: [], scroll: 0, expanded: false };
    this.closedPromise = new Promise(resolve => { this.resolveClosed = resolve; });
    this.input = new TerminalInput({ onPaste: text => {
      if (this.approval || this.picker || this.state.overlay) return;
      if (!this.editor.insert(terminalText(text).replace(/\t/g, "  "))) this.notice("Input exceeds 256 KiB");
      this.schedule();
    }, onRejected: text => this.notice(text), onEscape: () => this.onKey("", { name: "escape" }) });
  }
  start(): void {
    if (this.live) return;
    this.live = true; this.previousRaw = !!process.stdin.isRaw;
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J");
    process.stdin.setRawMode(true);
    emitKeypressEvents(this.input);
    this.input.on("keypress", this.onKey);
    process.stdin.pipe(this.input); process.stdin.resume();
    process.stdout.on("resize", this.resize);
    process.stdout.on("drain", this.drain);
    this.draw();
  }
  wait(): Promise<void> { return this.closedPromise; }
  stop(): void {
    if (!this.live) { this.resolveClosed(); return; }
    this.live = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.approval?.resolve("deny"); this.approval = undefined;
    process.stdout.off("resize", this.resize);
    process.stdout.off("drain", this.drain);
    process.stdin.unpipe(this.input); this.input.off("keypress", this.onKey); this.input.destroy();
    process.stdin.setRawMode(this.previousRaw); process.stdin.pause();
    process.stdout.write("\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l");
    this.resolveClosed();
  }
  private resize = (): void => { this.previousFrame = []; this.schedule(); };
  private drain = (): void => { this.outputBlocked = false; this.schedule(); };
  private schedule(): void {
    if (!this.live || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.draw(); }, 24);
  }
  private draw(): void {
    if (!this.live || this.outputBlocked) return;
    this.state.draft = this.editor.text; this.state.cursor = this.editor.cursor;
    this.state.suggestions = undefined;
    if (!this.state.overlay && !this.approval && this.editor.text.startsWith("/") && !/\s/.test(this.editor.text)) {
      this.state.suggestions = this.options.commands.filter(command => command.name.startsWith(this.editor.text)).slice(0, 5).map(command => `${command.name}  ${command.description}`);
      this.state.selectedSuggestion = 0;
    }
    const frame = renderTerminalScreen(this.state, process.stdout.columns || 80, process.stdout.rows || 24, process.env.NO_COLOR === undefined);
    this.frameRows = frame.viewportRows; this.transcriptRows = frame.transcriptRows;
    let output = "\x1b[?25l";
    frame.lines.forEach((line, i) => { if (this.previousFrame[i] !== line) output += `\x1b[${i + 1};1H\x1b[2K${line}`; });
    if (frame.cursor) output += `\x1b[${frame.cursor.row + 1};${frame.cursor.column + 1}H\x1b[?25h`;
    this.outputBlocked = !process.stdout.write(output); this.previousFrame = frame.lines;
  }
  private append(kind: TranscriptBlock["kind"], title: string, text: string): TranscriptBlock {
    const block = { id: `ui-${++this.sequence}`, kind, title: terminalText(title), text: terminalText(text).slice(-262144) };
    this.state.blocks.push(block);
    while (this.state.blocks.length > 200 || (this.state.blocks.length > 1 && this.state.blocks.reduce((sum, item) => sum + item.text.length, 0) > 262144)) this.state.blocks.shift();
    this.schedule(); return block;
  }
  notice(text: string): void { this.append("notice", "NOTICE", text); }
  error(text: string): void { this.append("error", "ERROR", text); }
  user(text: string): void { this.state.scroll = 0; this.append("user", "YOU", text); }
  result(text: string): void {
    const clean = terminalText(text);
    if (this.assistant && this.assistant.text.trim() === clean.trim()) return;
    this.assistant = this.append("assistant", "CODALI", clean);
  }
  show(value: unknown, title = "Details"): void {
    const text = typeof value === "string" ? value : formatInspection(value);
    const overlay = { title: terminalText(title), lines: terminalText(text).split("\n"), offset: 0 };
    if (this.approval) this.pendingInspection = overlay;
    else { this.picker = undefined; this.state.overlay = overlay; }
    this.schedule();
  }
  update(status: { busy?: boolean; activity?: string; effort?: string; permissions?: string; tokens?: number; queued?: number; session?: string }): void { Object.assign(this.state, status); this.schedule(); }
  restore(events: SessionEvent[]): void {
    this.state.blocks = []; this.assistant = undefined; this.lastTool = undefined; this.stream.reset();
    this.state.tokens = 0; this.state.route = ""; this.state.session = undefined;
    for (const event of events.slice(-3000)) {
      if (!event?.data || typeof event.type !== "string") continue;
      if (event.sessionId) this.state.session = event.sessionId;
      if (event.type === "session_started" && typeof event.data.objective === "string") this.user(event.data.objective);
      else if (event.type === "goal_amended" && typeof event.data.instruction === "string") this.user(event.data.instruction);
      else if (event.type === "turn_result" && typeof event.data.content === "string") this.result(event.data.content);
      else if (event.type === "turn_failed" && typeof event.data.message === "string") this.error(event.data.message);
      else if (["tool_intent", "tool_receipt", "usage", "model_route"].includes(event.type)) this.event(event);
    }
    this.state.busy = false; this.state.activity = "Session resumed"; this.state.scroll = 0; this.schedule();
  }
  event(event: SessionEvent): void {
    const data = event.data;
    if (event.sessionId) this.state.session = event.sessionId;
    if (event.type === "turn_started") { this.stream.reset(); this.assistant = undefined; this.state.busy = true; this.state.activity = "Thinking"; }
    else if (event.type === "token" && typeof data.content === "string") {
      if (!this.assistant) this.assistant = this.append("assistant", "CODALI", "");
      this.assistant.text = (this.assistant.text + this.stream.write(data.content)).slice(-262144);
    } else if (event.type === "model_route") { this.state.route = terminalText(`${data.modelId ?? "Model"}${data.host ? ` on ${data.host}` : ""}`); this.state.activity = "Thinking"; }
    else if (event.type === "usage") { const usage = data.usage as { tokens?: number }; if (Number.isFinite(usage?.tokens)) this.state.tokens = usage.tokens!; }
    else if (event.type === "tool_intent") {
      const receipt = data.receipt as { tool: string; id: string; args?: unknown };
      this.lastTool = this.append("tool", `● ${receipt.tool}`, receipt.args ? JSON.stringify(receipt.args, null, 2) : "Running…");
      this.lastTool.id = receipt.id; this.state.activity = terminalText(receipt.tool);
    } else if (event.type === "process_output" && typeof data.content === "string") {
      if (!this.lastTool) this.lastTool = this.append("tool", "Process output", "");
      this.lastTool.text = (this.lastTool.text + terminalText(data.content)).slice(-65536);
    } else if (event.type === "tool_receipt") {
      const receipt = data.receipt as { id: string; tool: string; status: string; args?: unknown; output?: string; error?: string };
      const block = this.state.blocks.find(item => item.id === receipt.id);
      if (block) {
        block.title = terminalText(`${receipt.status === "success" ? "✓" : "!"} ${receipt.tool} · ${receipt.status}`);
        if (typeof receipt.output === "string") block.text = terminalText([receipt.args ? JSON.stringify(receipt.args, null, 2) : "", receipt.output].filter(Boolean).join("\n\n")).slice(-65536);
        else if (receipt.error) block.text += "\n" + terminalText(receipt.error);
      }
    } else if (event.type === "status" && typeof data.message === "string") this.state.activity = terminalText(data.message);
    else if (event.type === "turn_result" || event.type === "turn_failed") {
      if (this.assistant) this.assistant.text += this.stream.finish();
      this.state.busy = false; this.state.activity = event.type === "turn_failed" ? "Turn stopped" : data.completed ? "Goal completed" : "Ready to continue";
    }
    this.schedule();
  }
  approve(title: string, details: string, signal?: AbortSignal): Promise<"once" | "session" | "deny"> {
    this.approval?.resolve("deny");
    this.picker = undefined;
    return new Promise(resolve => {
      const abort = (): void => finish("deny");
      const finish = (choice: "once" | "session" | "deny"): void => {
        signal?.removeEventListener("abort", abort); this.approval = undefined; this.state.overlay = this.pendingInspection; this.pendingInspection = undefined; this.schedule(); resolve(choice);
      };
      const overlay = { title: terminalText(title), lines: terminalText(details).split("\n"), offset: 0, choices: ["Allow once", "Allow for this session", "Deny"], selected: 2, hint: "←→ choose · Enter confirm · PgUp/PgDn inspect · Esc deny" };
      this.approval = { resolve: finish, selected: 2, overlay }; this.state.overlay = overlay;
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      this.schedule();
    });
  }
  private pickerItems(): Picker["items"] {
    if (!this.picker) return [];
    return this.picker.items.filter(item => item.label.toLowerCase().includes(this.picker!.query.toLowerCase()));
  }
  private showPicker(): void {
    const picker = this.picker!; const items = this.pickerItems();
    picker.selected = Math.max(0, Math.min(items.length - 1, picker.selected));
    const count = Math.max(1, (process.stdout.rows || 24) - 10);
    const offset = Math.max(0, picker.selected - count + 1);
    this.state.overlay = { title: `${picker.kind === "command" ? "Commands" : picker.kind === "history" ? "History" : "Workspace files"} › ${picker.query}`, lines: items.length ? items.slice(offset, offset + count).map((item, i) => `${i + offset === picker.selected ? "›" : " "} ${item.label}`) : ["No matches"], offset: 0, hint: "Type to search · ↑↓ choose · Enter select · Esc close" };
    this.schedule();
  }
  private openPicker(kind: "command" | "history"): void {
    this.picker = { kind, query: "", selected: 0, items: kind === "command" ? this.options.commands.map(command => ({ label: `${command.name}  ${command.description}`, value: command.name })) : this.editor.history.map(value => ({ label: value.replace(/\n/g, " ↵ "), value })) };
    this.showPicker();
  }
  private async completeFile(): Promise<void> {
    const draft = this.editor.text, cursor = this.editor.cursor;
    const before = draft.slice(0, cursor); const match = before.match(/(?:^|\s)@([^\n]*)$/u);
    if (!match) return;
    const token = match[1], directory = token.endsWith("/") ? token : path.dirname(token), fragment = token.endsWith("/") ? "" : path.basename(token);
    const relative = directory === "." ? "" : directory;
    const root = await fs.realpath(this.options.workspace); const target = await fs.realpath(path.resolve(root, relative));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error("File completion is confined to this workspace");
    const entries = await fs.readdir(target, { withFileTypes: true });
    if (this.editor.text !== draft || this.editor.cursor !== cursor || this.approval || this.state.overlay) return;
    this.picker = { kind: "file", query: fragment, selected: 0, prefix: before.slice(0, before.length - token.length - 1), suffix: draft.slice(cursor), items: entries.filter(item => item.name !== ".git" && !item.isSymbolicLink() && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(item.name)).slice(0, 1000).map(item => { const value = path.join(relative, item.name) + (item.isDirectory() ? "/" : ""); return { label: value, value }; }).sort((a, b) => a.label.localeCompare(b.label)) };
    this.showPicker();
  }
  private onKey = (text: string, key: Key): void => {
    try { this.key(text, key); } catch (error) { this.error(error instanceof Error ? error.message : String(error)); }
    this.schedule();
  };
  private key(text: string, key: Key): void {
    if (key.ctrl && key.name === "c") { this.options.cancel(); return; }
    if (this.approval) {
      if (key.name === "escape") this.approval.resolve("deny");
      else if ((process.stdout.columns || 80) < 24 || (process.stdout.rows || 24) < 10) return;
      else if (key.name === "left" || key.name === "right") { this.approval.selected = (this.approval.selected + (key.name === "left" ? 2 : 1)) % 3; this.approval.overlay.selected = this.approval.selected; }
      else if (key.name === "return") this.approval.resolve((["once", "session", "deny"] as const)[this.approval.selected]);
      else if (["pageup", "pagedown", "up", "down"].includes(key.name ?? "")) this.approval.overlay.offset = Math.max(0, this.approval.overlay.offset + (["pageup", "up"].includes(key.name!) ? -1 : 1) * (key.name!.startsWith("page") ? 6 : 1));
      return;
    }
    if (this.picker) {
      if (key.name === "escape") { this.picker = undefined; this.state.overlay = undefined; return; }
      if (key.name === "up" || key.name === "down") this.picker.selected += key.name === "up" ? -1 : 1;
      else if (key.name === "backspace") this.picker.query = [...this.picker.query].slice(0, -1).join("");
      else if (key.name === "return") {
        const selected = this.pickerItems()[this.picker.selected]; if (!selected) return;
        const picker = this.picker; this.picker = undefined; this.state.overlay = undefined;
        if (picker.kind === "command") this.options.submit(selected.value, "queue");
        else if (picker.kind === "history") this.editor.set(selected.value);
        else { const prefix = (picker.prefix ?? "") + "@" + selected.value; this.editor.set(prefix + (picker.suffix ?? "")); this.editor.cursor = prefix.length; if (selected.value.endsWith("/")) void this.completeFile().catch(error => this.error(String(error))); }
        return;
      } else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) { this.picker.query += text; this.picker.selected = 0; }
      this.showPicker(); return;
    }
    if (this.state.overlay) {
      if (key.name === "escape" || key.name === "q") this.state.overlay = undefined;
      else if (["up", "down", "pageup", "pagedown"].includes(key.name ?? "")) this.state.overlay.offset = Math.max(0, this.state.overlay.offset + (["up", "pageup"].includes(key.name!) ? -1 : 1) * (key.name!.startsWith("page") ? 8 : 1));
      return;
    }
    if (key.ctrl && key.name === "p") { this.openPicker("command"); return; }
    if (key.ctrl && key.name === "r") { this.openPicker("history"); return; }
    if (key.ctrl && key.name === "o") { this.state.expanded = !this.state.expanded; return; }
    if (key.ctrl && key.name === "l") { this.previousFrame = []; return; }
    if (key.name === "escape") { if (this.state.busy) this.options.cancel(); else this.editor.clear(); return; }
    if (key.name === "pageup" || key.name === "pagedown") { this.state.scroll = Math.max(0, Math.min(Math.max(0, this.transcriptRows - this.frameRows), this.state.scroll + (key.name === "pageup" ? 1 : -1) * Math.max(1, this.frameRows - 2))); return; }
    if (key.ctrl && key.name === "s") { const value = this.editor.submit(); if (value.trim()) this.options.submit(value, "steer"); return; }
    if (key.name === "return") {
      if (key.meta || key.shift) this.editor.insert("\n");
      else { const value = this.editor.submit(); if (value.trim()) this.options.submit(value, "queue"); }
    } else if (key.ctrl && key.name === "j") this.editor.insert("\n");
    else if (key.name === "backspace") this.editor.delete(true);
    else if (key.name === "delete") this.editor.delete(false);
    else if (key.name === "left") this.editor.move(-1);
    else if (key.name === "right") this.editor.move(1);
    else if (key.name === "home" || (key.ctrl && key.name === "a")) this.editor.home();
    else if (key.name === "end" || (key.ctrl && key.name === "e")) this.editor.end();
    else if (key.ctrl && key.name === "u") this.editor.clear();
    else if (key.ctrl && key.name === "w") this.editor.killWord();
    else if (key.ctrl && key.name === "d" && !this.editor.text) this.options.close();
    else if (key.name === "up" || key.name === "down") { const direction = key.name === "up" ? -1 : 1; if (!this.editor.vertical(direction)) this.editor.previous(direction); }
    else if (key.name === "tab") {
      const matches = this.options.commands.filter(command => command.name.startsWith(this.editor.text));
      if (this.editor.text.startsWith("/") && matches.length) this.editor.set(matches[0].name + " ");
      else void this.completeFile().catch(error => this.error(error instanceof Error ? error.message : String(error)));
    } else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) this.editor.insert(terminalText(text));
  }
}

export const formatInspection = (value: unknown, depth = 0): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.length ? value.map((item, index) => `${index + 1}. ${formatInspection(item, depth + 1)}`).join("\n\n") : "None";
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth > 4) return JSON.stringify(value);
  return entries.map(([key, item]) => {
    const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
    return `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}: ${item && typeof item === "object" ? "\n" : ""}${formatInspection(item, depth + 1)}`;
  }).join("\n");
};
