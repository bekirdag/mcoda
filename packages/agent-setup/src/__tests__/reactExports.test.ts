import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentSearchSelect,
  GpuJobOpsPanel,
  McodaAgentSetupPage,
  createMcodaAgentSetupClient,
  defaultMcodaStageDefinitions,
} from "../react/index.js";

test("react subpath exports planned turnkey imports", () => {
  assert.equal(typeof McodaAgentSetupPage, "function");
  assert.equal(typeof AgentSearchSelect, "function");
  assert.equal(typeof GpuJobOpsPanel, "function");
  assert.equal(typeof createMcodaAgentSetupClient, "function");
  assert.ok(defaultMcodaStageDefinitions.length > 0);
});
