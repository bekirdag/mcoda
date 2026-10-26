import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface, type Interface } from "node:readline";
import { TerminalInput, insertTerminalPaste } from "../TerminalInput.js";

test("bracketed paste remains one input across every byte boundary", async () => {
  const bytes = Buffer.from("before\u001b[200~日本語\r\n/quit\u001b[201~after");
  for (let split = 0; split <= bytes.length; split++) {
    const pastes: string[] = []; const rejected: string[] = []; let forwarded = "";
    const input = new TerminalInput({ onPaste: value => pastes.push(value), onRejected: value => rejected.push(value) });
    input.on("data", chunk => { forwarded += chunk.toString(); });
    input.write(bytes.subarray(0, split)); input.end(bytes.subarray(split));
    await new Promise<void>(resolve => input.once("end", resolve));
    assert.equal(forwarded, "beforeafter"); assert.deepEqual(pastes, ["日本語\n/quit"]); assert.deepEqual(rejected, []);
  }
});

test("pasted newline and slash text are editable and do not submit until Enter", () => {
  let readline: Interface | undefined; const lines: string[] = [];
  const input = new TerminalInput({ onPaste: text => insertTerminalPaste(readline!, text), onRejected: reason => assert.fail(reason) });
  const output = new PassThrough(); output.resume();
  readline = createInterface({ input, output, terminal: true }); readline.on("line", line => lines.push(line));
  try {
    input.write("\u001b[200~alpha\n/quit\nβeta\u001b[201~");
    assert.deepEqual(lines, []); assert.equal(readline.line, "alpha\n/quit\nβeta");
    input.write("\r"); assert.deepEqual(lines, ["alpha\n/quit\nβeta"]);
  } finally { readline.close(); input.destroy(); output.destroy(); }
});

test("oversized and incomplete pastes are discarded without turning their text into commands", async () => {
  const rejected: string[] = []; let raw = "";
  const input = new TerminalInput({ maxPasteBytes: 16, onPaste: () => assert.fail("Unsafe paste was accepted"), onRejected: reason => rejected.push(reason) });
  input.on("data", chunk => { raw += chunk.toString(); });
  input.write("\u001b[200~" + "x".repeat(100) + "\n/quit\u001b[201~");
  input.end("\u001b[200~incomplete"); await new Promise<void>(resolve => input.once("end", resolve));
  assert.equal(rejected.length, 2); assert.equal(raw, "");
});
