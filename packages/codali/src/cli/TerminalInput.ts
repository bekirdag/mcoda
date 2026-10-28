import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Interface } from "node:readline";

const START = "\u001b[200~";
const END = "\u001b[201~";
const suffixLength = (text: string, token: string): number => {
  for (let size = Math.min(text.length, token.length - 1); size > 0; size--) if (text.endsWith(token.slice(0, size))) return size;
  return 0;
};

/** Bracketed paste is one editable input, never a sequence of submitted commands. */
export class TerminalInput extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private pasting = false;
  private pasted = "";
  private bytes = 0;
  private overflow = false;
  private escapeTimer?: NodeJS.Timeout;
  private escapeNotified = false;
  constructor(private readonly options: { onPaste: (text: string) => void; onRejected: (reason: string) => void; maxPasteBytes?: number; onEscape?: () => void }) { super(); }
  private append(text: string): void {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > (this.options.maxPasteBytes ?? 262144)) { this.overflow = true; this.pasted = ""; }
    else if (!this.overflow) this.pasted += text;
  }
  private forward(text: string): void {
    // A standalone Escape can share a read with the next paste marker. Notify
    // it before delivering that paste instead of leaving readline's escape
    // timeout pending while the paste callback observes the old modal state.
    let escapes = 0;
    if (this.options.onEscape) while (text.endsWith("\u001b")) { text = text.slice(0, -1); escapes++; }
    if (text) this.push(text);
    for (let index = 0; index < escapes; index++) this.options.onEscape!();
  }
  private consume(text: string): void {
    this.pending += text;
    while (this.pending) {
      const token = this.pasting ? END : START;
      const index = this.pending.indexOf(token);
      if (index < 0) {
        const keep = suffixLength(this.pending, token); const ready = this.pending.slice(0, this.pending.length - keep);
        if (this.pasting) this.append(ready); else this.forward(ready);
        this.pending = keep ? this.pending.slice(-keep) : ""; return;
      }
      const ready = this.pending.slice(0, index); this.pending = this.pending.slice(index + token.length);
      if (this.pasting) {
        this.append(ready);
        if (this.overflow) this.options.onRejected("Paste exceeds the 256 KiB input limit");
        else this.options.onPaste(this.pasted.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ""));
        this.pasting = false; this.pasted = ""; this.bytes = 0; this.overflow = false;
      } else { this.forward(ready); this.pasting = true; }
    }
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      if (this.escapeTimer) clearTimeout(this.escapeTimer);
      const text = this.decoder.write(chunk);
      // Notify a standalone Escape promptly, but retain its prefix so a delayed
      // bracketed-paste marker still cannot turn pasted newlines into commands.
      if (this.escapeNotified && this.pending === "\u001b" && !text.startsWith("[")) this.pending = "";
      this.escapeNotified = false;
      this.consume(text);
      if (!this.pasting && this.pending === "\u001b" && this.options.onEscape) {
        this.escapeTimer = setTimeout(() => { this.escapeNotified = true; this.options.onEscape?.(); }, 100);
      }
      callback();
    } catch (error) { callback(error as Error); }
  }
  override _flush(callback: TransformCallback): void {
    try {
      if (this.escapeTimer) clearTimeout(this.escapeTimer);
      this.consume(this.decoder.end());
      if (this.pasting) this.options.onRejected("Incomplete paste discarded"); else if (this.pending && !(this.pending === "\u001b" && this.escapeNotified)) this.forward(this.pending);
      callback();
    } catch (error) { callback(error as Error); }
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void { if (this.escapeTimer) clearTimeout(this.escapeTimer); callback(error); }
}

/** readline exposes the current editable line and cursor; refresh preserves multiline content. */
export const insertTerminalPaste = (readline: Interface, text: string): void => {
  // Node documents coordinated line/cursor updates; @types/node marks both readonly.
  // Keep this compatibility boundary together: https://nodejs.org/api/readline.html#rlline
  const editable = readline as { line: string; cursor: number };
  editable.line = editable.line.slice(0, editable.cursor) + text + editable.line.slice(editable.cursor);
  editable.cursor += text.length;
  readline.prompt(true);
};
