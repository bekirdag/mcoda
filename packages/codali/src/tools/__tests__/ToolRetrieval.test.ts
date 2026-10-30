import test from "node:test";
import assert from "node:assert/strict";
import { retrieveTools } from "../ToolRetrieval.js";
import { createDeterministicTools } from "../deterministic/DeterministicTools.js";
import type { ToolDefinition } from "../ToolTypes.js";
test("metadata retrieval ranks distinct deterministic capabilities without a request-type table", () => {
  const tools = createDeterministicTools();
  for (const [query, name] of [["exact decimal arithmetic money", "decimal_calculate"], ["symbolic differentiate algebra", "symbolic_math"], ["satisfiability constraints variables", "solve_constraints"], ["SQL SELECT sum table", "query_data"], ["JSON Schema validate", "validate_json"]]) {
    assert.equal(retrieveTools(query, tools, 1)[0].tool.name, name);
  }
  assert.deepEqual(retrieveTools("hello", tools, 3), []);
  const novel: ToolDefinition = { name: "spectral_analysis", description: "Fourier frequency spectrum", capability: "science", handler: async () => ({ output: "" }) };
  assert.equal(retrieveTools("Fourier spectrum", [...tools, novel], 1)[0].tool.name, novel.name);
});
