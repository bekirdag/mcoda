import test from "node:test";
import assert from "node:assert/strict";
import { TerminalEditor } from "../TerminalEditor.js";

test("editing and deletion keep combining marks and emoji together", () => {
  const editor = new TerminalEditor();
  editor.insert("a👨‍👩‍👧‍👦e\u0301日"); editor.move(-1); editor.delete(true);
  assert.equal(editor.text, "a👨‍👩‍👧‍👦日");
  editor.move(-1); editor.delete(false);
  assert.equal(editor.text, "a日"); assert.equal(editor.cursor, 1);
});

test("line navigation and multiline draft survive history browsing", () => {
  const editor = new TerminalEditor(["previous", "older"]);
  editor.set("first\nsecond"); editor.home(); assert.equal(editor.cursor, 6);
  editor.end(); assert.equal(editor.cursor, 12);
  editor.previous(-1); assert.equal(editor.text, "previous");
  editor.previous(-1); assert.equal(editor.text, "older");
  editor.previous(1); editor.previous(1); assert.equal(editor.text, "first\nsecond");
  editor.set("\nx"); editor.cursor = 0; editor.home(); assert.equal(editor.cursor, 0);
});

test("oversized input is rejected atomically and history deduplicates on submit", () => {
  const editor = new TerminalEditor(["abc"], 4);
  assert.equal(editor.insert("abc"), true); assert.equal(editor.insert("日"), false);
  assert.equal(editor.text, "abc"); assert.equal(editor.cursor, 3);
  assert.equal(editor.submit(), "abc"); assert.deepEqual(editor.history, ["abc"]);
  assert.equal(editor.text, "");
});

test("vertical navigation follows display columns without splitting wide graphemes", () => {
  const editor = new TerminalEditor(); editor.set("日x\nabcd\ne\u0301z");
  assert.equal(editor.vertical(-1), true); assert.equal(editor.cursor, 5);
  assert.equal(editor.vertical(-1), true); assert.equal(editor.cursor, 1);
  assert.equal(editor.vertical(-1), false);
  assert.equal(editor.vertical(1), true); assert.equal(editor.cursor, 5);
});
