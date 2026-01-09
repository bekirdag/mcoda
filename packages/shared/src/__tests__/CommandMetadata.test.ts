import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeCommandName, getCommandRequiredCapabilities } from "../metadata/CommandMetadata.js";

describe("CommandMetadata", () => {
  it("canonicalizes common aliases", () => {
    assert.equal(canonicalizeCommandName("work on tasks"), "work-on-tasks");
    assert.equal(canonicalizeCommandName("QA Tasks"), "qa-tasks");
    assert.equal(canonicalizeCommandName("agent rating"), "agent-rating");
  });

  it("returns fallback required capabilities", () => {
    const caps = getCommandRequiredCapabilities("code-review");
    assert.ok(caps.includes("code_review"));
  });

  it("returns empty capabilities for agent rating", () => {
    const caps = getCommandRequiredCapabilities("agent-rating");
    assert.equal(caps.length, 0);
  });
});
