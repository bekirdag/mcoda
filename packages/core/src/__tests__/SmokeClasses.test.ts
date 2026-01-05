import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExecutionService } from "../services/execution/ExecutionService.js";
import { PlanningService } from "../services/planning/PlanningService.js";
import { AgentManagementService } from "../services/agents/AgentManagementService.js";
import { ConfigService } from "../config/ConfigService.js";
import { Task } from "../domain/tasks/Task.js";
import { Epic } from "../domain/epics/Epic.js";
import { Project } from "../domain/projects/Project.js";
import { UserStory } from "../domain/userStories/UserStory.js";
import { Dependency } from "../domain/dependencies/Dependency.js";

describe("core placeholder classes", () => {
  it("constructs service shells", () => {
    assert.equal(typeof ExecutionService, "function");
    assert.equal(typeof PlanningService, "function");
    assert.equal(typeof AgentManagementService, "function");
    assert.equal(typeof ConfigService, "function");
    assert.ok(new ExecutionService());
    assert.ok(new PlanningService());
    assert.ok(new AgentManagementService());
    assert.ok(new ConfigService());
  });

  it("constructs domain shells", () => {
    assert.ok(new Task());
    assert.ok(new Epic());
    assert.ok(new Project());
    assert.ok(new UserStory());
    assert.ok(new Dependency());
  });
});
