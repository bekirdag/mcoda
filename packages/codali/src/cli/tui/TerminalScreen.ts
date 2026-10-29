import { cells, fitCells, padCells, wrapCells } from "./TerminalCells.js";
import { markdownRows } from "./TerminalMarkdown.js";

export type BlockKind = "user" | "assistant" | "tool" | "error" | "notice";
export interface TranscriptBlock { id: string; kind: BlockKind; title: string; text: string; summary?: string; }
export interface TerminalOverlay { title: string; lines: string[]; offset: number; choices?: string[]; selected?: number; hint?: string; }
export interface TerminalScreenState {
  workspace: string; branch?: string; session?: string; version: string; profile: string;
  busy: boolean; activity: string; route: string; effort: string; permissions: string;
  tokens: number; queued: number; draft: string; cursor: number;
  blocks: TranscriptBlock[]; scroll: number; expanded: boolean;
  overlay?: TerminalOverlay; suggestions?: string[]; selectedSuggestion?: number;
}
export interface TerminalFrame { lines: string[]; cursor?: { row: number; column: number }; transcriptRows: number; viewportRows: number; }
const blockRows = new WeakMap<TranscriptBlock, { text: string; width: number; rows: string[] }>();
const overlayRows = new WeakMap<TerminalOverlay, { lines: string[]; width: number; rows: string[] }>();

const clipStyled = (text: string, width: number): string => {
  let result = "", remaining = width;
  for (const part of text.split(/(\x1b\[[0-9;]*m)/g)) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) { result += part; continue; }
    const visible = fitCells(part, remaining); result += visible; remaining -= cells(visible);
    if (visible !== part) break;
  }
  return result + (text.includes("\x1b[") ? "\x1b[0m" : "");
};

export const renderTerminalScreen = (state: TerminalScreenState, columns: number, rows: number, color = true): TerminalFrame => {
  columns = Math.max(1, Math.floor(columns)); rows = Math.max(1, Math.floor(rows));
  const paint = (code: string, text: string): string => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const dim = (text: string): string => paint("2", text);
  if (columns < 24 || rows < 10) return { lines: [fitCells("Codali · enlarge terminal", columns), ...Array(Math.max(0, rows - 1)).fill("")], transcriptRows: 0, viewportRows: 0 };
  const width = columns - 4;
  const draftRows = wrapCells(state.draft || " ", width - 4);
  const cursorRows = wrapCells(state.draft.slice(0, state.cursor), width - 4);
  let cursorLine = cursorRows.length - 1, cursorCell = cells(cursorRows.at(-1) ?? "");
  if (cursorCell === width - 4) { cursorLine++; cursorCell = 0; if (cursorLine >= draftRows.length) draftRows.push(""); }
  const editorRows = Math.min(Math.max(1, draftRows.length), Math.max(1, Math.min(6, rows - 12)));
  const editorOffset = Math.max(0, cursorLine - editorRows + 1);
  const viewportRows = Math.max(1, rows - editorRows - 8);
  const transcript: string[] = [];
  for (const block of state.blocks) {
    const label = block.kind === "user" ? "YOU" : block.kind === "assistant" ? "CODALI" : block.title;
    const tone = block.kind === "error" ? "31" : block.kind === "user" ? "36" : block.kind === "tool" ? "2" : "1;36";
    transcript.push(paint(tone, fitCells(label, width)));
    let cached = blockRows.get(block);
    if (!cached || cached.text !== block.text || cached.width !== width) { cached = { text: block.text, width, rows: markdownRows(block.text, width) }; blockRows.set(block, cached); }
    const content = cached.rows;
    const visible = block.kind === "tool" && !state.expanded ? block.summary ? wrapCells(block.summary, width).slice(0, 3) : content.slice(0, 3) : content;
    let code = false, language = "";
    for (const line of visible) {
      if (line.startsWith("```")) { code = !code; if (code) language = line.slice(3).trim(); transcript.push(dim(code ? `┌ ${language || "code"}` : "└")); }
      else if ((!code || language === "diff") && /^\+[^+]/.test(line)) transcript.push(paint("32", line));
      else if ((!code || language === "diff") && /^-[^-]/.test(line)) transcript.push(paint("31", line));
      else if (code) transcript.push(paint("37", line));
      else if (/^#{1,6} /.test(line)) transcript.push(paint("1", line.replace(/^#+ /, "")));
      else transcript.push(line.replace(/\*\*([^*]+)\*\*/g, (_match, value: string) => paint("1", value)).replace(/`([^`]+)`/g, (_match, value: string) => paint("36", value)));
    }
    if (visible.length < content.length && !(block.kind === "tool" && !state.expanded && block.summary)) transcript.push(dim(`… ${content.length - visible.length} more lines · Ctrl+O expand`));
    transcript.push("");
  }
  if (!transcript.length) transcript.push("", paint("1", "What would you like to build?"), "", ...wrapCells("Describe a change, investigate a problem, or ask about this project.", width).map(dim), "", dim("/ commands    @ files    Ctrl+P command palette"));
  const maximumScroll = Math.max(0, transcript.length - viewportRows);
  const scroll = Math.max(0, Math.min(maximumScroll, state.scroll));
  const start = Math.max(0, transcript.length - viewportRows - scroll);
  const view = transcript.slice(start, start + viewportRows);
  while (view.length < viewportRows) view.push("");
  const lines: string[] = [
    "  " + paint("1;36", "◈ CODALI") + dim(`  ${fitCells(state.version, width - 10)}`),
    "  " + dim(fitCells(state.workspace + (state.branch ? ` · ${state.branch}` : "") + (state.session ? ` · ${state.session.slice(0, 8)}` : ""), width)),
    "  " + dim("─".repeat(width)),
    ...view.map(line => "  " + line),
    "  " + paint(state.busy ? "33" : "2", fitCells(`${state.busy ? "● " : "○ "}${state.activity || (state.busy ? "Working" : "Ready")}${state.queued ? ` · ${state.queued} queued` : ""}${scroll ? " · scrollback" : ""}`, width)),
    "  " + paint("36", "╭" + "─".repeat(width - 2) + "╮"),
  ];
  const editorTop = lines.length;
  for (let i = 0; i < editorRows; i++) {
    const line = draftRows[editorOffset + i] ?? "";
    const placeholder = !state.draft && i === 0;
    lines.push("  " + paint("36", "│" + (i === 0 ? "› " : "  ")) + (placeholder ? dim(padCells(state.busy ? "Queue a message…" : "Ask Codali anything…", width - 4)) : padCells(line, width - 4)) + paint("36", "│"));
  }
  lines.push("  " + paint("36", "╰" + "─".repeat(width - 2) + "╯"));
  const tokens = state.tokens >= 1000 ? `${(state.tokens / 1000).toFixed(1)}k` : String(state.tokens);
  lines.push("  " + dim(fitCells(`${state.route || state.profile} · ${state.effort} · ${state.permissions} · ${tokens} tokens`, width)));
  lines.push("  " + dim(fitCells(state.busy ? "Enter queue · Ctrl+S steer · Esc cancel · Wheel/PgUp scroll" : "Enter send · Alt+Enter newline · Ctrl+P commands · Wheel/PgUp scroll", width)));
  let cursor: TerminalFrame["cursor"] = { row: editorTop + cursorLine - editorOffset, column: 5 + cursorCell };
  const overlay = state.overlay;
  if (overlay) {
    const bodyWidth = width - 4, available = Math.max(1, rows - 5 - (overlay.choices ? overlay.choices.length + 1 : 0));
    let cached = overlayRows.get(overlay);
    if (!cached || cached.lines !== overlay.lines || cached.width !== bodyWidth) { cached = { lines: overlay.lines, width: bodyWidth, rows: markdownRows(overlay.lines.join("\n"), bodyWidth) }; overlayRows.set(overlay, cached); }
    const contents = cached.rows;
    const offset = Math.min(Math.max(0, contents.length - available), Math.max(0, overlay.offset));
    const panel = [paint("1;36", fitCells(overlay.title, bodyWidth)), ...contents.slice(offset, offset + available).map(line => /^[A-Z][A-Z &/]+$/.test(line) ? paint("1;36", line) : line)];
    if (overlay.choices) panel.push("", ...overlay.choices.map((choice, i) => paint(i === overlay.selected ? "7" : "0", fitCells(`${i === overlay.selected ? "›" : " "} ${choice}`, bodyWidth))));
    panel.push("", dim(fitCells(overlay.hint ?? "↑↓ scroll · PgUp/PgDn page · Esc close", bodyWidth)));
    const visible = panel.slice(0, rows - 2);
    const top = Math.max(0, Math.floor((rows - visible.length - 2) / 2));
    for (let i = 0; i < visible.length + 2; i++) {
      const edge = i === 0 || i === visible.length + 1;
      const content = edge ? "─".repeat(width - 2) : " " + padCells(visible[i - 1], width - 4) + " ";
      lines[top + i] = "  " + paint("36", edge ? (i === 0 ? "╭" : "╰") : "│") + content + paint("36", edge ? (i === 0 ? "╮" : "╯") : "│");
    }
    cursor = undefined;
  } else if (state.suggestions?.length) {
    const suggestions = state.suggestions.slice(0, Math.min(5, viewportRows));
    const top = 3 + viewportRows - suggestions.length;
    suggestions.forEach((item, i) => { lines[top + i] = "  " + paint(i === state.selectedSuggestion ? "7" : "2", padCells(item, width)); });
  }
  return { lines: lines.slice(0, rows).map(line => clipStyled(line, columns)), cursor, transcriptRows: transcript.length, viewportRows };
};
