import test from "node:test";
import assert from "node:assert/strict";
import { deriveIntentSignals } from "../IntentSignals.js";

test("deriveIntentSignals detects UI intent", () => {
  const signals = deriveIntentSignals("Add a welcome header to the landing page");
  assert.ok(signals.intents.includes("ui"));
  assert.ok(signals.matches.ui.length > 0);
});

test("deriveIntentSignals detects content intent", () => {
  const signals = deriveIntentSignals("Update the button text and label copy");
  assert.ok(signals.intents.includes("content"));
  assert.ok(signals.matches.content.length > 0);
});

test("deriveIntentSignals detects behavior intent", () => {
  const signals = deriveIntentSignals("Fix the login bug in the API");
  assert.ok(signals.intents.includes("behavior"));
});

test("deriveIntentSignals detects data intent", () => {
  const signals = deriveIntentSignals("Add a new column to the user table");
  assert.ok(signals.intents.includes("data"));
});

test("deriveIntentSignals defaults to behavior when no matches", () => {
  const signals = deriveIntentSignals("Do the thing");
  assert.deepEqual(signals.intents, ["behavior"]);
});
