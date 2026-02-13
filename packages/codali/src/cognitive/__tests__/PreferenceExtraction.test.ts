import test from "node:test";
import assert from "node:assert/strict";
import { extractPreferences } from "../PreferenceExtraction.js";

test("extractPreferences captures prefer directives", { concurrency: false }, () => {
  const prefs = extractPreferences("Prefer: use async/await");
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0]?.category, "preference");
});

test("extractPreferences captures avoid directives", { concurrency: false }, () => {
  const prefs = extractPreferences("Do not use moment.js");
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0]?.category, "constraint");
});

test("extractPreferences handles inline avoids", { concurrency: false }, () => {
  const prefs = extractPreferences("Please avoid lodash in this change.");
  assert.equal(prefs.length, 1);
  assert.ok(prefs[0]?.content.includes("lodash"));
});
