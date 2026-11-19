import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfigurableRoles } from "../RoleResolution.js";

const agent = (slug: string, tier: string, supportsTools = true) => ({
  id: slug, slug, tier, adapter: "openai-api", model: slug,
  healthStatus: "healthy", contextWindow: 32768, maxOutputTokens: 4096,
  supportsTools, supportsJsonSchema: true, reasoningRating: 8, maxComplexity: 10,
  capabilities: ["reasoning", "structured_output"],
});

test("a healthy dedicated tool worker does not report substitution", () => {
  const result = resolveConfigurableRoles({
    inventory: [agent("planner", "small"), agent("worker", "medium"), agent("writer", "large")],
    bindings: { orchestrator: "planner", worker: "worker", synthesizer: "writer" },
  });
  assert.equal(result.toolCapable?.candidate.slug, "worker");
  assert.equal(result.toolCapable, result.assignments.worker);
  assert.ok(!result.warnings.some(warning => warning.startsWith("tool_worker_substituted:")));
});

test("fallback from an incapable bound worker to the orchestrator reports substitution", () => {
  const result = resolveConfigurableRoles({
    inventory: [agent("planner", "small"), agent("text-only", "medium", false)],
    roles: ["orchestrator", "worker"], bindings: { orchestrator: "planner", worker: "text-only" },
  });
  assert.equal(result.assignments.worker?.candidate.slug, "text-only");
  assert.equal(result.toolCapable?.candidate.slug, "planner");
  assert.ok(result.warnings.includes("tool_worker_substituted:planner"));
});

test("an orchestrator serving tools without a worker binding is the preferred route", () => {
  const result = resolveConfigurableRoles({
    inventory: [agent("planner", "small")], roles: ["orchestrator"], bindings: { orchestrator: "planner" },
  });
  assert.equal(result.toolCapable, result.assignments.orchestrator);
  assert.ok(!result.warnings.some(warning => warning.startsWith("tool_worker_substituted:")));
});
