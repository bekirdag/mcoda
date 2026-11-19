import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cells, fitCells, wrapCells, graphemes } from '../TerminalCells.js';

test('cells counts ASCII correctly', () => {
  assert.equal(cells('hello'), 5);
});

test('cells counts Japanese wide glyphs as 2', () => {
  assert.equal(cells('日本語'), 6);
});

test('cells handles combining characters (e\u0301)', () => {
  // e + combining acute accent should count as 1 cell
  const text = 'e\u0301';
  assert.equal(cells(text), 1);
});

test('cells handles emoji family', () => {
  // 👨‍👩‍👧‍👦 is a single grapheme, typically 2 cells wide in terminals
  const family = '👨‍👩‍👧‍👦';
  assert.equal(cells(family), 2);
});

test('fitCells clips at whole graphemes', () => {
  const text = '日本語'; // 6 cells total
  assert.equal(fitCells(text, 4), '日本'); // 4 cells
  assert.equal(fitCells(text, 5), '日本'); // 4 cells (cannot fit half)
});

test('fitCells with width <= 0 returns empty string', () => {
  assert.equal(fitCells('hello', 0), '');
  assert.equal(fitCells('hello', -1), '');
});

test('fitCells with ellipsis fits within budget', () => {
  const text = '日本語'; // 6 cells
  // Width 5, ellipsis is 1 cell. Remaining budget for text: 4 cells -> '日本' (4 cells) + '…' (1 cell) = 5 cells
  assert.equal(fitCells(text, 5, true), '日本…');

  const ascii = 'hello'; // 5 cells
  // Width 4, ellipsis is 1 cell. Remaining budget: 3 cells -> 'hel' + '…'
  assert.equal(fitCells(ascii, 4, true), 'hel…');
});

test('wrapCells hard-wraps whole graphemes', () => {
  const text = '日本語'; // 6 cells
  const lines = wrapCells(text, 4);
  assert.deepEqual(lines, ['日本', '語']);
});

test('wrapCells preserves explicit empty lines', () => {
  const text = 'a\n\nb';
  const lines = wrapCells(text, 10);
  assert.deepEqual(lines, ['a', '', 'b']);
});

test('wrapCells clamps width to 1', () => {
  const text = 'ab';
  const lines = wrapCells(text, 0); // should clamp to 1
  assert.deepEqual(lines, ['a', 'b']);

  const lines2 = wrapCells(text, -5);
  assert.deepEqual(lines2, ['a', 'b']);
});

test('wrapCells replaces glyph wider than width with ?', () => {
  // Japanese char is 2 cells wide. Width clamped to 1.
  const text = '日';
  const lines = wrapCells(text, 0); // width becomes 1
  assert.deepEqual(lines, ['?']);
});

test('graphemes uses Intl.Segmenter', () => {
  const text = 'e\u0301';
  const segs = graphemes(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0], 'e\u0301');

  const family = '👨‍👩‍👧‍👦';
  const segs2 = graphemes(family);
  assert.equal(segs2.length, 1);
});
