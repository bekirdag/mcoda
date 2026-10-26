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
  constructor(private readonly options: { onPaste: (text: string) => void; onRejected: (reason: string) => void; maxPasteBytes?: number }) { super(); }
  private append(text: string): void {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > (this.options.maxPasteBytes ?? 262144)) { this.overflow = true; this.pasted = ""; }
    else if (!this.overflow) this.pasted += text;
  }
  private consume(text: string): void {
    this.pending += text;
    while (this.pending) {
      const token = this.pasting ? END : START;
      const index = this.pending.indexOf(token);
      if (index < 0) {
        const keep = suffixLength(this.pending, token); const ready = this.pending.slice(0, this.pending.length - keep);
        if (this.pasting) this.append(ready); else if (ready) this.push(ready);
        this.pending = keep ? this.pending.slice(-keep) : ""; return;
      }
      const ready = this.pending.slice(0, index); this.pending = this.pending.slice(index + token.length);
      if (this.pasting) {
        this.append(ready);
        if (this.overflow) this.options.onRejected("Paste exceeds the 256 KiB input limit");
        else this.options.onPaste(this.pasted.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ""));
        this.pasting = false; this.pasted = ""; this.bytes = 0; this.overflow = false;
      } else { if (ready) this.push(ready); this.pasting = true; }
    }
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try { this.consume(this.decoder.write(chunk)); callback(); } catch (error) { callback(error as Error); }
  }
  override _flush(callback: TransformCallback): void {
    try {
      this.consume(this.decoder.end());
      if (this.pasting) this.options.onRejected("Incomplete paste discarded"); else if (this.pending) this.push(this.pending);
      callback();
    } catch (error) { callback(error as Error); }
  }
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
