import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { cells } from "../TerminalCells.js";
import { renderTerminalScreen, type TerminalScreenState } from "../TerminalScreen.js";

const state = (): TerminalScreenState => ({ workspace: "/projects/example", version: "preview", profile: "Strata", busy: false, activity: "Ready", route: "", effort: "medium", permissions: "ask", tokens: 0, queued: 0, draft: "", cursor: 0, blocks: [], scroll: 0, expanded: false });
const text = (value: ReturnType<typeof renderTerminalScreen>): string => value.lines.map(stripVTControlCharacters).join("\n");

test("normal, narrow and tiny screens stay within terminal cells and rows", () => {
  for (const [columns, rows] of [[100, 30], [80, 24], [45, 18], [24, 10], [12, 5]]) {
    for (const color of [true, false]) {
      const current = state(); current.draft = "日本語 👨‍👩‍👧‍👦 e\u0301\n".repeat(5); current.cursor = current.draft.length;
      const frame = renderTerminalScreen(current, columns, rows, color);
      assert.ok(frame.lines.length <= rows);
      assert.ok(frame.lines.every(line => cells(line) <= columns));
      assert.ok(frame.lines.every(line => !stripVTControlCharacters(line).includes("\x1b")), "No partial escape sequences");
      if (!color) assert.ok(frame.lines.every(line => !line.includes("\x1b")));
      if (frame.cursor) { assert.ok(frame.cursor.row >= 0 && frame.cursor.row < rows); assert.ok(frame.cursor.column >= 0 && frame.cursor.column < columns); }
    }
  }
});

test("streaming and scrollback keep the editor and status in their own rows", () => {
  const current = state(); current.draft = "keep this draft"; current.cursor = 4;
  const before = renderTerminalScreen(current, 80, 24);
  current.blocks = [{ id: "stream", kind: "assistant", title: "Codali", text: "Streaming output\n".repeat(80) }];
  current.busy = true; current.queued = 2;
  const after = renderTerminalScreen(current, 80, 24);
  assert.deepEqual(after.cursor, before.cursor);
  assert.match(text(after), /keep this draft/); assert.match(text(after), /2 queued/);
  current.scroll = 12;
  const scrolled = renderTerminalScreen(current, 80, 24);
  assert.deepEqual(scrolled.cursor, after.cursor); assert.match(text(scrolled), /scrollback/);
});

test("long approvals keep all choices visible and permit complete action scrolling", () => {
  for (const [columns, rows] of [[80, 24], [45, 18], [30, 12], [24, 10]]) {
    const current = state(); current.overlay = { title: "Permission", lines: Array.from({ length: 100 }, (_, i) => `argument-${i}`), offset: 0, choices: ["Allow once", "Allow session", "Deny"], selected: 2 };
    const first = renderTerminalScreen(current, columns, rows, false);
    assert.match(text(first), /Allow once/); assert.match(text(first), /Allow session/); assert.match(text(first), /Deny/);
    assert.equal(first.cursor, undefined);
    current.overlay.offset = 1000;
    assert.match(text(renderTerminalScreen(current, columns, rows, false)), /argument-99/);
  }
});

test("tool detail expansion retains output and the footer", () => {
  const current = state(); current.blocks = [{ id: "tool", kind: "tool", title: "shell", text: "one\ntwo\nthree\nfour\nfive" }];
  assert.match(text(renderTerminalScreen(current, 90, 24, false)), /2 more lines/);
  current.expanded = true; const expanded = text(renderTerminalScreen(current, 90, 24, false));
  assert.match(expanded, /four\n/); assert.doesNotMatch(expanded, /more lines/); assert.match(expanded, /Enter send/);
});
