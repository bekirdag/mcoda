import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlanningCommands } from "../commands/planning/PlanningCommands.js";

describe("planning commands", () => {
  it("exports a planning commands class", () => {
    assert.equal(typeof PlanningCommands, "function");
  });
});
