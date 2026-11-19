import test from "node:test";
import assert from "node:assert/strict";
import { TerminalSelection, clipboardSequence } from "../TerminalSelection.js";

test("selection preserves a frame and handles forward and reverse multiline endpoints", () => {
  const lines = ["\x1b[31mabc\x1b[0m", "def   "];
  const forward = new TerminalSelection(lines, { x: 1, y: 0 });
  forward.end = { x: 1, y: 1 };
  const reverse = new TerminalSelection(lines, { x: 1, y: 1 });
  reverse.end = { x: 1, y: 0 };
  lines[0] = "changed";
  assert.equal(forward.text(), "bc\nde");
  assert.equal(reverse.text(), forward.text());
  assert.equal(forward.frame().length, 2);
  assert.match(forward.frame()[0], /\x1b\[7mb/);
});

test("selection includes entire wide and combining graphemes at cell boundaries", () => {
  const selected = new TerminalSelection(["A你e\u0301😀Z"], { x: 2, y: 0 });
  selected.end = { x: 4, y: 0 };
  assert.equal(selected.text(), "你e\u0301😀");
});

test("clipboard uses UTF8 base64 with no interpolated terminal controls", () => {
  const text = "你e\u0301😀\nline two";
  const sequence = clipboardSequence(text);
  assert.match(sequence, /^\x1b\]52;c;[A-Za-z0-9+/=]+\x07$/);
  assert.equal(Buffer.from(sequence.slice(7, -1), "base64").toString("utf8"), text);
});
