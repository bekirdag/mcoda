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

test("deriveIntentSignals maps endpoint/logging nouns to behavior intent", () => {
  const signals = deriveIntentSignals("Create a healthz endpoint and log uptime");
  assert.ok(signals.intents.includes("behavior"));
  assert.ok(signals.matches.behavior.includes("healthz"));
  assert.ok(signals.matches.behavior.includes("endpoint"));
});

test("deriveIntentSignals keeps computation/stat requests from being UI-only", () => {
  const signals = deriveIntentSignals(
    "Add a basic total estimation for task completions as stats on the homepage",
  );
  assert.ok(signals.intents.includes("ui"));
  assert.ok(signals.intents.includes("behavior"));
  assert.ok(signals.matches.behavior.includes("estimation"));
  assert.ok(signals.matches.behavior.includes("stats"));
});

test("deriveIntentSignals detects data intent", () => {
  const signals = deriveIntentSignals("Add a new column to the user table");
  assert.ok(signals.intents.includes("data"));
});

test("deriveIntentSignals detects testing intent", () => {
  const signals = deriveIntentSignals("Add unit tests for the login flow");
  assert.ok(signals.intents.includes("testing"));
  assert.ok(signals.matches.testing.length > 0);
});

test("deriveIntentSignals detects snapshot/approval testing intent", () => {
  const signals = deriveIntentSignals("Add snapshot approval tests");
  assert.ok(signals.intents.includes("testing"));
  assert.ok(
    signals.matches.testing.some((match) =>
      ["snapshot", "snapshots", "approval"].includes(match),
    ),
  );
});

test("deriveIntentSignals detects infra intent", () => {
  const signals = deriveIntentSignals("Update the CI pipeline and Dockerfile");
  assert.ok(signals.intents.includes("infra"));
  assert.ok(signals.matches.infra.length > 0);
});

test("deriveIntentSignals does not treat generic build requests as infra", () => {
  const signals = deriveIntentSignals("Build a new settings page for the app");
  assert.ok(!signals.intents.includes("infra"));
});

test("deriveIntentSignals detects security intent", () => {
  const signals = deriveIntentSignals("Add RBAC policy to auth");
  assert.ok(signals.intents.includes("security"));
  assert.ok(signals.matches.security.includes("rbac"));
});

test("deriveIntentSignals detects CSP/SameSite security intent", () => {
  const signals = deriveIntentSignals("Add CSP headers and SameSite cookies");
  assert.ok(signals.intents.includes("security"));
  assert.ok(
    signals.matches.security.some((match) =>
      ["csp", "samesite"].includes(match),
    ),
  );
});

test("deriveIntentSignals detects performance intent", () => {
  const signals = deriveIntentSignals("Improve cache performance and reduce latency");
  assert.ok(signals.intents.includes("performance"));
  assert.ok(signals.matches.performance.length > 0);
});

test("deriveIntentSignals detects optimize/slow performance intent", () => {
  const signals = deriveIntentSignals("Optimize slow endpoints to reduce latency");
  assert.ok(signals.intents.includes("performance"));
  assert.ok(
    signals.matches.performance.some((match) =>
      ["optimize", "slow"].includes(match),
    ),
  );
});

test("deriveIntentSignals detects observability intent", () => {
  const signals = deriveIntentSignals("Add metrics logging and tracing");
  assert.ok(signals.intents.includes("observability"));
  assert.ok(signals.matches.observability.length > 0);
});

test("deriveIntentSignals does not treat logging-only requests as observability", () => {
  const signals = deriveIntentSignals("Add structured logging with log level control");
  assert.ok(signals.intents.includes("behavior"));
  assert.ok(!signals.intents.includes("observability"));
});

test("deriveIntentSignals detects telemetry instrumentation intent", () => {
  const signals = deriveIntentSignals("Add telemetry instrumentation and tracing");
  assert.ok(signals.intents.includes("observability"));
  assert.ok(signals.matches.observability.includes("telemetry"));
});

test("deriveIntentSignals supports combined intents", () => {
  const signals = deriveIntentSignals("Secure API logging and metrics in CI pipeline");
  assert.ok(signals.intents.includes("security"));
  assert.ok(signals.intents.includes("observability"));
  assert.ok(signals.intents.includes("infra"));
  assert.ok(signals.intents.includes("behavior"));
});

test("deriveIntentSignals defaults to behavior when no matches", () => {
  const signals = deriveIntentSignals("Do the thing");
  assert.deepEqual(signals.intents, ["behavior"]);
});
