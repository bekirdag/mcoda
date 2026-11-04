import { cells, graphemes } from "./TerminalCells.js";

/** Cursor offsets are UTF-16 boundaries of complete graphemes, never terminal cells. */
export class TerminalEditor {
  text = "";
  cursor = 0;
  private historyIndex = -1;
  private draft = "";
  constructor(public history: string[] = [], private readonly limit = 262144) {}
  set(text: string): void { this.text = text; this.cursor = text.length; this.historyIndex = -1; }
  insert(text: string): boolean {
    const next = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    if (Buffer.byteLength(next) > this.limit) return false;
    this.text = next; this.cursor += text.length; this.historyIndex = -1; return true;
  }
  move(direction: -1 | 1): void {
    if (direction < 0) this.cursor -= graphemes(this.text.slice(0, this.cursor)).at(-1)?.length ?? 0;
    else this.cursor += graphemes(this.text.slice(this.cursor))[0]?.length ?? 0;
  }
  delete(backward: boolean): void {
    const old = this.cursor; this.move(backward ? -1 : 1);
    const start = Math.min(old, this.cursor), end = Math.max(old, this.cursor);
    this.text = this.text.slice(0, start) + this.text.slice(end); this.cursor = start;
  }
  home(): void { this.cursor = this.cursor === 0 ? 0 : this.text.lastIndexOf("\n", this.cursor - 1) + 1; }
  end(): void { const next = this.text.indexOf("\n", this.cursor); this.cursor = next < 0 ? this.text.length : next; }
  vertical(direction: -1 | 1): boolean {
    const start = this.cursor === 0 ? 0 : this.text.lastIndexOf("\n", this.cursor - 1) + 1;
    const column = cells(this.text.slice(start, this.cursor));
    let target: number, end: number;
    if (direction < 0) { if (start === 0) return false; end = start - 1; target = end === 0 ? 0 : this.text.lastIndexOf("\n", end - 1) + 1; }
    else { const next = this.text.indexOf("\n", this.cursor); if (next < 0) return false; target = next + 1; const following = this.text.indexOf("\n", target); end = following < 0 ? this.text.length : following; }
    let width = 0; this.cursor = target;
    for (const part of graphemes(this.text.slice(target, end))) { if (width + cells(part) > column) break; width += cells(part); this.cursor += part.length; }
    return true;
  }
  clear(): void { this.set(""); }
  killWord(): void {
    const before = this.text.slice(0, this.cursor);
    const match = before.match(/(?:\s+|\S+\s*)$/u);
    if (match) { this.text = before.slice(0, -match[0].length) + this.text.slice(this.cursor); this.cursor -= match[0].length; }
  }
  previous(direction: -1 | 1): void {
    if (this.historyIndex < 0) this.draft = this.text;
    this.historyIndex = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex - direction));
    this.text = this.historyIndex < 0 ? this.draft : this.history[this.historyIndex]; this.cursor = this.text.length;
  }
  submit(): string {
    const text = this.text;
    if (text.trim()) this.history = [text, ...this.history.filter(item => item !== text)].slice(0, 500);
    this.clear(); return text;
  }
}
