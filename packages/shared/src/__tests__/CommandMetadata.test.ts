import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeCommandName, getCommandRequiredCapabilities } from "../metadata/CommandMetadata.js";

describe("CommandMetadata", () => {
  it("canonicalizes common aliases", () => {
    assert.equal(canonicalizeCommandName("work on tasks"), "work-on-tasks");
    assert.equal(canonicalizeCommandName("QA Tasks"), "qa-tasks");
  });

  it("returns fallback required capabilities", () => {
    const caps = getCommandRequiredCapabilities("code-review");
    assert.ok(caps.includes("code_review"));
  });
});
