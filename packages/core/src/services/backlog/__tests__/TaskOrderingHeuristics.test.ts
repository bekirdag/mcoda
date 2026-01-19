import assert from "node:assert/strict";
import test from "node:test";
import { classifyTask } from "../TaskOrderingHeuristics.js";

test("classifyTask detects foundation from keywords", () => {
  const result = classifyTask({
    title: "Initialize npm project and setup config",
    description: "Scaffold the repo and add OpenAPI spec",
    type: "feature",
  });
  assert.equal(result.stage, "foundation");
  assert.equal(result.foundation, true);
  assert.ok(result.reasons.some((reason) => reason.startsWith("foundation:")));
});

test("classifyTask prefers backend when backend keywords are present", () => {
  const result = classifyTask({
    title: "Implement Express server and API endpoint",
    description: "Add persistence layer",
    type: "feature",
  });
  assert.equal(result.stage, "backend");
  assert.equal(result.foundation, true);
  assert.ok(result.reasons.some((reason) => reason.startsWith("backend:")));
  assert.ok(result.reasons.some((reason) => reason.startsWith("foundation:")));
});

test("classifyTask prefers frontend when frontend keywords are present", () => {
  const result = classifyTask({
    title: "Render task list UI and style it",
    description: "Update HTML and CSS",
    type: "feature",
  });
  assert.equal(result.stage, "frontend");
  assert.equal(result.foundation, false);
  assert.ok(result.reasons.some((reason) => reason.startsWith("frontend:")));
});

test("classifyTask marks chore as foundation even with backend keywords", () => {
  const result = classifyTask({
    title: "Chore: refactor API endpoint",
    description: "Cleanup server routes",
    type: "chore",
  });
  assert.equal(result.stage, "backend");
  assert.equal(result.foundation, true);
  assert.ok(result.reasons.some((reason) => reason.startsWith("backend:")));
  assert.ok(result.reasons.includes("type:chore"));
});

test("classifyTask uses chore to mark foundation when no backend/frontend keywords", () => {
  const result = classifyTask({
    title: "Chore: tidy configs",
    description: "Cleanup and organize scripts",
    type: "chore",
  });
  assert.equal(result.stage, "foundation");
  assert.equal(result.foundation, true);
  assert.ok(result.reasons.includes("type:chore"));
});

test("classifyTask defaults to other when no keywords match", () => {
  const result = classifyTask({
    title: "Investigate performance",
    description: "Gather metrics",
    type: "feature",
  });
  assert.equal(result.stage, "other");
  assert.equal(result.foundation, false);
});
