import test from "node:test";
import assert from "node:assert/strict";
import { cells } from "../TerminalCells.js";
import { markdownRows, splitTableRow } from "../TerminalMarkdown.js";

test("table cells preserve escaped pipes, code spans and empty fields", () => {
  assert.deepEqual(splitTableRow("| a | `b|c` |"), ["a", "`b|c`"]);
  assert.deepEqual(splitTableRow("a \\| b | c"), ["a | b", "c"]);
  assert.deepEqual(splitTableRow("name | ends\\|"), ["name", "ends|"]);
  assert.deepEqual(splitTableRow("| | b |"), ["", "b"]);
  assert.deepEqual(splitTableRow("| ``a`|b`` | c |"), ["``a`|b``", "c"]);
});

test("tables wrap Unicode cells, align numbers and retain every column on narrow screens", () => {
  const input = "| Project | Count | Note |\n| :--- | ---: | :---: |\n| 日本語 👨‍👩‍👧‍👦 | **27** | `a|b` |\n| Juniper | 9 | " + "long-word-".repeat(12) + " |";
  for (const width of [100, 60, 40, 30, 16, 8]) {
    const rows = markdownRows(input, width);
    assert.ok(rows.every(line => cells(line) <= width));
    const joined = rows.join("\n");
    assert.match(joined.replace(/\n/g, ""), /27/); assert.match(joined, /9/); assert.match(joined, /日本語/);
    const compact = rows.filter(line => !/^[┌├└]/.test(line)).join("").replace(/[│\s]/g, "");
    assert.equal(compact.match(/long-word-/g)?.length, 12);
    if (width >= 40) { assert.match(joined, /┌/); assert.ok(rows.filter(line => line.startsWith("│")).every(line => cells(line) === cells(rows[0]))); }
    else assert.match(joined, /Project/);
  }
});

test("partial and fenced tables preserve source, malformed extra cells are never hidden", () => {
  const raw = "| A | B |\n| --- | --- |\n| one | two |";
  for (const fence of ["```md", "~~~"]) {
    const input = fence + "\n" + raw + "\n" + (fence.startsWith("`") ? "```" : "~~~");
    assert.equal(markdownRows(input, 80).join("\n"), input);
  }
  assert.equal(markdownRows("A | B\n--", 80).join("\n"), "A | B\n--");
  const output = markdownRows(raw + "\n| three | four | extra |", 80).join("\n");
  assert.match(output, /extra/); assert.match(output, /three/); assert.match(output, /two/);
});

test("table content cannot emit terminal or clipboard control sequences", () => {
  const output = markdownRows("| Name | Value |\n| --- | --- |\n| safe\x1b[2J | \x1b]52;c;YXR0YWNr\x07done |", 80).join("\n");
  assert.doesNotMatch(output, /\x1b|YXR0YWNr/); assert.match(output, /safe/); assert.match(output, /done/);
});
