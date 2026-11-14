import { cells, graphemes } from "./TerminalCells.js";
import { terminalText } from "../TerminalText.js";

export interface CellPosition { x: number; y: number; }
export class TerminalSelection {
  readonly lines: string[];
  end: CellPosition;
  constructor(lines: string[], readonly start: CellPosition) {
    this.lines = lines.map(terminalText); this.end = { ...start };
  }
  private range(row: number): [number, number] {
    const [a, b] = this.start.y < this.end.y || this.start.y === this.end.y && this.start.x <= this.end.x ? [this.start, this.end] : [this.end, this.start];
    return row < a.y || row > b.y ? [0, 0] : [row === a.y ? a.x : 0, row === b.y ? b.x + 1 : Infinity];
  }
  text(): string {
    const result: string[] = [];
    this.lines.forEach((line, row) => {
      const [from, to] = this.range(row); if (from === to) return;
      let column = 0, selected = "";
      for (const part of graphemes(line)) { const width = cells(part); if (column < to && column + width > from) selected += part; column += width; }
      result.push(selected.trimEnd());
    });
    return result.join("\n");
  }
  frame(): string[] {
    return this.lines.map((line, row) => {
      const [from, to] = this.range(row); let column = 0;
      return graphemes(line).map(part => { const width = cells(part), selected = column < to && column + width > from; column += width; return selected ? `\x1b[7m${part}\x1b[27m` : part; }).join("");
    });
  }
}
export const clipboardSequence = (text: string): string => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
