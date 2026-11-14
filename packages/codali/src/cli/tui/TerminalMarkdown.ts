import { terminalText } from "../TerminalText.js";
import { cells, padCells, wrapCells } from "./TerminalCells.js";

/** Pipes inside code spans and escaped pipes are cell content, not separators. */
export const splitTableRow = (line: string): string[] => {
  const input = line.trim(), result: string[] = [];
  let current = "", ticks = 0;
  for (let i = 0; i < input.length;) {
    const character = input[i];
    if (character === "\\" && i + 1 < input.length) {
      current += input[i + 1] === "|" ? "|" : input.slice(i, i + 2); i += 2;
    } else if (character === "`") {
      let end = i + 1; while (input[end] === "`") end++;
      const count = end - i;
      if (!ticks) ticks = count; else if (ticks === count) ticks = 0;
      current += input.slice(i, end); i = end;
    } else if (character === "|" && !ticks) {
      result.push(current.trim()); current = ""; i++;
    } else { current += character; i++; }
  }
  result.push(current.trim());
  if (result.length > 1 && result[0] === "") result.shift();
  if (result.length > 1 && result.at(-1) === "") result.pop();
  return result;
};

const plainCell = (value: string): string => value
  .replace(/(`+)(.*?)\1/g, "$2")
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/<br\s*\/?\s*>/gi, "\n");

const tableRows = (header: string[], body: string[][], separators: string[], width: number): string[] => {
  const records = [header, ...body].map(row => row.map(plainCell));
  const count = header.length, space = width - 3 * count - 1;
  if (space < count * 7) {
    // A narrow screen shows each record as labeled fields instead of dropping
    // columns or squeezing words into unreadable one-character cells.
    if (!body.length) return records[0].flatMap(value => wrapCells(value, width));
    return records.slice(1).flatMap((record, index) => [
      ...(index ? ["─".repeat(width)] : []),
      ...record.flatMap((value, column) => wrapCells(`${records[0][column] || `Column ${column + 1}`}: ${value}`, width)),
    ]);
  }
  const widths = header.map((_, column) => Math.min(space, records.reduce((largest, record) =>
    Math.max(largest, ...record[column].split("\n").map(cells)), 3)));
  while (widths.reduce((sum, value) => sum + value, 0) > space) {
    const largest = Math.max(...widths); widths[widths.indexOf(largest)]--;
  }
  const border = (left: string, joint: string, right: string): string => left + widths.map(value => "─".repeat(value + 2)).join(joint) + right;
  const aligned = (value: string, column: number): string => {
    const padding = Math.max(0, widths[column] - cells(value));
    if (separators[column].endsWith(":")) {
      const left = separators[column].startsWith(":") ? Math.floor(padding / 2) : padding;
      return " ".repeat(left) + value + " ".repeat(padding - left);
    }
    return padCells(value, widths[column]);
  };
  const lines = [border("┌", "┬", "┐")];
  records.forEach((record, index) => {
    const wrapped = record.map((value, column) => wrapCells(value, widths[column]));
    for (let line = 0; line < Math.max(...wrapped.map(value => value.length)); line++) {
      lines.push("│ " + wrapped.map((value, column) => aligned(value[line] ?? "", column)).join(" │ ") + " │");
    }
    if (index === 0) lines.push(border("├", "┼", "┤"));
  });
  lines.push(border("└", "┴", "┘"));
  return lines;
};

/** Render Markdown blocks before wrapping; no source text becomes terminal control. */
export const markdownRows = (text: string, width: number): string[] => {
  width = Math.max(1, Math.floor(width));
  const source = terminalText(text).replace(/\t/g, "  ").split("\n"), rows: string[] = [];
  let fence = "";
  for (let i = 0; i < source.length; i++) {
    const line = source[i], marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      rows.push(...wrapCells(line, width)); continue;
    }
    const header = splitTableRow(line), separators = splitTableRow(source[i + 1] ?? "");
    if (!fence && line.includes("|") && header.length <= 16 && header.length === separators.length
      && separators.every(value => /^:?-{3,}:?$/.test(value))) {
      const body: string[][] = []; let end = i + 2;
      for (; end < source.length && source[end].includes("|"); end++) {
        const row = splitTableRow(source[end]);
        if (row.length !== header.length) break; // Streaming/malformed rows remain visible as source.
        body.push(row);
      }
      rows.push(...tableRows(header, body, separators, width)); i = end - 1;
    } else rows.push(...wrapCells(line, width));
  }
  return rows;
};
