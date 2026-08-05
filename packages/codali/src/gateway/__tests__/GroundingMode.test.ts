import assert from "node:assert/strict";
import test from "node:test";
import { decideGroundingMode } from "../GroundingMode.js";

const classifier = (overrides: Record<string, boolean> = {}) => ({
  needsPrivateData: false,
  needsFreshData: false,
  needsDocdex: false,
  needsAppTools: false,
  ...overrides,
});

const modeOf = (query: string, overrides: Record<string, boolean> = {}) =>
  decideGroundingMode({ query, classifier: classifier(overrides) }).mode;

test("a generation request answers from the model", () => {
  assert.equal(modeOf("Write a Python function that reverses a string."), "open");
  assert.equal(modeOf("Generate a sample welcome HTML page for a company."), "open");
  assert.equal(modeOf("Draft a short polite email declining a meeting."), "open");
});

test("a small classifier over-flagging retrieval cannot force a search on a poem", () => {
  // The measured failure: a 3B sets every boolean true, so the haiku went
  // through a repository search and came back citing test fixtures.
  assert.equal(modeOf("Write a haiku about autumn rain.", { needsDocdex: true }), "open");
});

test("private data is always grounded, however the request is phrased", () => {
  assert.equal(modeOf("Write a summary of my open Jira issues.", { needsPrivateData: true }), "grounded");
  assert.equal(modeOf("Generate a report of unread email.", { needsAppTools: true }), "grounded");
});

test("naming something in the workspace forces grounding", () => {
  // "Write" plus a repository noun is not free composition.
  assert.equal(modeOf("Write a summary of the README."), "grounded");
  assert.equal(modeOf("Create a diagram of this repository's packages."), "grounded");
  assert.equal(modeOf("Generate release notes from the latest commits."), "grounded");
});

test("current-state questions stay grounded", () => {
  assert.equal(modeOf("Who is the current CEO of Microsoft?"), "grounded");
  assert.equal(modeOf("What is the latest stable version of Node.js?"), "grounded");
  assert.equal(modeOf("What is the weather today?"), "grounded");
  assert.equal(modeOf("What happened in the news?", { needsFreshData: true }), "grounded");
});

test("a question about the codebase is grounded", () => {
  assert.equal(modeOf("Which file defines the planner?", { needsDocdex: true }), "grounded");
});

test("settled knowledge and arithmetic answer directly", () => {
  assert.equal(modeOf("What is 17 multiplied by 24?"), "open");
  assert.equal(modeOf("Explain the difference between a stack and a queue."), "open");
});

test("an unclassifiable request falls back to grounded", () => {
  // The failure modes are not symmetric: a wrong `open` invents facts, a wrong
  // `grounded` only wastes a search.
  assert.equal(modeOf("Bekir's Q3 numbers", { needsDocdex: true }), "grounded");
});

test("the decision carries a reason for the trace", () => {
  const decision = decideGroundingMode({
    query: "Write a haiku about rain.",
    classifier: classifier(),
  });
  assert.equal(decision.mode, "open");
  assert.match(decision.reason, /generation/);
});

test("writing an email is composition; asking about my email is a lookup", () => {
  // The noun alone said nothing: it names the artifact being written in one
  // case and the mailbox to search in the other. The possessive separates them.
  assert.equal(modeOf("Draft a polite email declining a meeting."), "open");
  assert.equal(modeOf("Do I have any unread emails?"), "grounded");
  assert.equal(modeOf("Summarise my inbox."), "grounded");
});

test("a rolling window in a generation request is not a freshness signal", () => {
  // "last" as a bare word sent a SQL exercise to web research.
  assert.equal(
    modeOf("Write a SQL query selecting users created in the last 30 days."),
    "open",
  );
});

test("recency has to be asked about, not merely mentioned", () => {
  assert.equal(modeOf("When did the central bank last change its rate?"), "grounded");
  assert.equal(modeOf("What is the newest release?"), "grounded");
});
