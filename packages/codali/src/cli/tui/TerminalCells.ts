/// <reference lib="es2022.intl" />
import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string): string[] => /^[\x20-\x7e]*$/.test(text) ? text.split("") : [...segmenter.segment(text)].map(part => part.segment);
export const cells = (text: string): number => /^[\x20-\x7e]*$/.test(text) ? text.length : stringWidth(text);
const finiteWidth = (width: number): number => Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;

export const fitCells = (text: string, width: number, ellipsis = false): string => {
  const limit = finiteWidth(width);
  if (!limit) return "";
  if (cells(text) <= limit) return text;
  const suffix = ellipsis ? "…" : "";
  let result = "", used = 0;
  for (const part of graphemes(text)) {
    const size = cells(part);
    if (used + size > limit - cells(suffix)) break;
    result += part; used += size;
  }
  return result + suffix;
};

export const wrapCells = (text: string, width: number): string[] => {
  const limit = Math.max(1, finiteWidth(width));
  return text.split("\n").flatMap(line => {
    const rows: string[] = []; let current = "", used = 0;
    for (const original of graphemes(line)) {
      const part = cells(original) > limit ? "?" : original;
      const size = cells(part);
      if (used + size > limit) { rows.push(current); current = ""; used = 0; }
      current += part; used += size;
    }
    rows.push(current); return rows;
  });
};

export const padCells = (text: string, width: number): string => {
  const clipped = fitCells(text, width);
  return clipped + " ".repeat(Math.max(0, finiteWidth(width) - cells(clipped)));
};
