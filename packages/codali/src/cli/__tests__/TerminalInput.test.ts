import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface, type Interface } from "node:readline";
import { TerminalInput, insertTerminalPaste } from "../TerminalInput.js";

test("mouse wheel sequences are consumed across every byte boundary without changing the draft", async () => {
  const sequence = Buffer.from("draft\x1b[<64;12;4M\x1b[<65;12;4Mtail");
  for (let split = 0; split <= sequence.length; split++) {
    const wheel: number[] = []; let raw = "";
    const input = new TerminalInput({ onWheel: direction => wheel.push(direction), onPaste: () => assert.fail(), onRejected: reason => assert.fail(reason) });
    input.on("data", chunk => { raw += chunk.toString(); });
    input.write(sequence.subarray(0, split)); input.end(sequence.subarray(split));
    await new Promise<void>(resolve => input.once("end", resolve));
    assert.deepEqual(wheel, [-1, 1]); assert.equal(raw, "drafttail");
  }
});

test("pasted mouse bytes cannot scroll or approve anything", () => {
  let wheel = 0;
  const input = new TerminalInput({ onWheel: () => { wheel++; }, onPaste: () => {}, onRejected: reason => assert.fail(reason) });
  input.write("\x1b[200~\x1b[<64;1;1M\x1b[201~");
  assert.equal(wheel, 0); input.destroy();
});

test("coalesced Escape closes a modal before the next paste is delivered", () => {
  const events: string[] = [];
  const input = new TerminalInput({ onEscape: () => events.push("escape"), onPaste: text => events.push(`paste:${text}`), onRejected: reason => assert.fail(reason) });
  input.on("data", chunk => events.push(`raw:${chunk.toString()}`));
  input.write("\x1b\x1b[200~draft\n/quit\x1b[201~\x15/effort high\r");
  assert.deepEqual(events, ["escape", "paste:draft\n/quit", "raw:\x15/effort high\r"]);
  input.destroy();
});

test("standalone Escape is responsive without losing a delayed paste marker", async () => {
  let escaped = 0; const pasted: string[] = []; const raw: string[] = [];
  const input = new TerminalInput({ onEscape: () => { escaped++; }, onPaste: value => pasted.push(value), onRejected: reason => assert.fail(reason) });
  input.on("data", chunk => raw.push(chunk.toString()));
  input.write(Buffer.from("\x1b")); await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(escaped, 1);
  input.write(Buffer.from("[200~hello\n/quit\x1b[201~"));
  assert.deepEqual(pasted, ["hello\n/quit"]); assert.equal(raw.join(""), "");
  input.write(Buffer.from("\x1b")); await new Promise(resolve => setTimeout(resolve, 140)); input.write(Buffer.from("a"));
  assert.equal(escaped, 2); assert.equal(raw.join(""), "a");
  input.write(Buffer.from("\x1b")); await new Promise(resolve => setTimeout(resolve, 140));
  input.end(); await new Promise<void>(resolve => input.once("end", resolve));
  assert.equal(escaped, 3); assert.equal(raw.join(""), "a");
});

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
