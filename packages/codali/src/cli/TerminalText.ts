import { stripVTControlCharacters } from "node:util";
import { redactSecretValues } from "../gateway/GatewayTracer.js";
import { StreamingSecretRedactor } from "../runtime/SecretRedaction.js";

/** Model/tool text is data, never terminal control sequences or clipboard commands. */
const stripTerminalControls = (value: string): string => stripVTControlCharacters(value)
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
  .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
export const terminalText = (value: string): string => redactSecretValues(stripTerminalControls(value));

/** Buffers incomplete ANSI/OSC sequences split across streamed chunks. */
export class TerminalTextStream {
  private pending = "";
  private secrets = new StreamingSecretRedactor();
  write(chunk: string): string {
    this.pending += chunk;
    let cutoff = this.pending.length;
    for (let index = 0; index < this.pending.length; index++) {
      if (this.pending[index] !== "\u001b") continue;
      const next = this.pending[index + 1];
      if (next === undefined) { cutoff = index; break; }
      if (["]", "P", "_", "^", "X"].includes(next)) {
        const rest = this.pending.slice(index + 2);
        const end = rest.search(/\u0007|\u001b\\/);
        if (end < 0) { cutoff = index; break; }
        index += end + 2;
      } else if (next === "[") {
        const rest = this.pending.slice(index + 2);
        const end = rest.search(/[\x40-\x7e]/);
        if (end < 0) { cutoff = index; break; }
        index += end + 2;
      }
    }
    const ready = this.pending.slice(0, cutoff);
    this.pending = this.pending.slice(cutoff);
    if (this.pending.length > 8192) this.pending = "";
    return this.secrets.write(stripTerminalControls(ready));
  }
  finish(): string { this.pending = ""; return this.secrets.finish(); }
  reset(): void { this.pending = ""; this.secrets = new StreamingSecretRedactor(); }
}
