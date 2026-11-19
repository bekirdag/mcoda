import test from "node:test";
import assert from "node:assert/strict";
import { terminalText, TerminalTextStream } from "../TerminalText.js";

test("untrusted terminal output cannot set clipboard, erase screen or hide paths", () => {
  assert.equal(terminalText("safe\u001b]52;c;YXR0YWNr\u0007\u001b[2J\r\u202efile.txt\n"), "safefile.txt\n");
});

test("streamed terminal controls are stripped even when split across tokens", () => {
  const stream = new TerminalTextStream();
  const output = stream.write("hello\u001b]5") + stream.write("2;c;secret") + stream.write("\u0007world\u001b[") + stream.write("2J!") + stream.finish();
  assert.equal(output, "helloworld!");
});

test("ANSI sequences cannot split a secret into separately printable fragments", () => {
  const stream = new TerminalTextStream();
  assert.equal(stream.write("sk-abcdefgh\u001b[") + stream.write("31mijklmnop12345 ") + stream.finish(), "[redacted] ");
  assert.equal(terminalText("sk-abcdefgh\u001b[31mijklmnop12345"), "[redacted]");
  const token = "sk-abcdefghijklmnopqrstuv123456789";
  for (let i = 0; i <= token.length; i++) {
    const chunks = new TerminalTextStream();
    assert.equal(chunks.write(token.slice(0, i)) + chunks.write(token.slice(i)) + chunks.finish(), "[redacted]");
  }
});
