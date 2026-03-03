import test from "node:test";
import assert from "node:assert/strict";
import { extractPreferences } from "../PreferenceExtraction.js";

test("extractPreferences captures prefer directives", { concurrency: false }, () => {
  const prefs = extractPreferences("Prefer: use async/await");
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0]?.category, "preference");
  assert.equal(prefs[0]?.scope, "profile_memory");
  assert.equal(typeof prefs[0]?.confidence_score, "number");
  assert.equal(prefs[0]?.source, "request_directive_explicit_preference");
});

test("extractPreferences captures avoid directives", { concurrency: false }, () => {
  const prefs = extractPreferences("Do not use moment.js");
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0]?.category, "constraint");
  assert.equal(prefs[0]?.source, "request_directive_explicit_constraint");
  assert.ok(["high", "medium"].includes(prefs[0]?.confidence_band ?? ""));
});

test("extractPreferences handles inline avoids", { concurrency: false }, () => {
  const prefs = extractPreferences("Please avoid lodash in this change.");
  assert.equal(prefs.length, 1);
  assert.ok(prefs[0]?.content.includes("lodash"));
  assert.equal(prefs[0]?.source, "request_directive_inline_constraint");
  assert.ok(["low", "medium"].includes(prefs[0]?.confidence_band ?? ""));
});

test("extractPreferences handles must-use directives as constraints", { concurrency: false }, () => {
  const prefs = extractPreferences("Must use zod for validation");
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0]?.category, "constraint");
  assert.equal(prefs[0]?.source, "request_directive_explicit_constraint");
});

test("extractPreferences deduplicates equivalent preferences", { concurrency: false }, () => {
  const prefs = extractPreferences(
    ["Prefer: use async/await", "prefer: use async/await", "Do not use moment.js"].join("\n"),
  );
  assert.equal(prefs.length, 2);
});

test("extractPreferences gives explicit directives >= inline confidence", { concurrency: false }, () => {
  const explicit = extractPreferences("Do not use moment.js")[0];
  const inline = extractPreferences("Please avoid lodash in this change.")[0];
  assert.ok((explicit?.confidence_score ?? 0) >= (inline?.confidence_score ?? 0));
});
