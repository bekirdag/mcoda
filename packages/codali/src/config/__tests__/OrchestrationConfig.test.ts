import test from "node:test";
import assert from "node:assert/strict";
import { validateOrchestrationConfig, resolveBinding, orchestrationHash } from "../OrchestrationConfig.js";

const fixture = () => ({ schemaVersion: 1, profile: "test", providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1" } }, models: { text: { provider: "local", catalogId: "text-v1", revision: "abc", contextWindow: 32768, maxOutputTokens: 2048, operations: ["chat.completions"], backend: "strata" } }, bindings: { lead: { candidates: ["text"] }, reviewer: { useBinding: "lead" } } });
test("initial tool exposure is bounded and only valid for progressive discovery", () => {
  const interaction = { strategy: "gateway", toolExposure: "native", toolSelection: "progressive", initialTools: [] };
  assert.deepEqual(validateOrchestrationConfig({ ...fixture(), interaction }).interaction?.initialTools, []);
  for (const initialTools of ["calculate", ["calculate", "calculate"], ["../read"], [null], Array.from({ length: 17 }, (_, i) => `tool_${i}`)]) {
    assert.throws(() => validateOrchestrationConfig({ ...fixture(), interaction: { ...interaction, initialTools } }), /initialTools/);
  }
  assert.deepEqual(validateOrchestrationConfig({ ...fixture(), interaction: { ...interaction, toolExposure: "gateway" } }).interaction?.initialTools, []);
  for (const change of [{ strategy: "routed" }, { toolSelection: "semantic" }]) {
    assert.throws(() => validateOrchestrationConfig({ ...fixture(), interaction: { ...interaction, ...change } }), /initialTools/);
  }
});
test("portable profiles resolve aliases and stable canonical hashes", () => {
  const c = validateOrchestrationConfig(fixture());
  assert.equal(resolveBinding(c, "reviewer", "chat.completions")[0].id, "text");
  assert.equal(orchestrationHash(c), orchestrationHash({ ...c, profile: c.profile }));
  const alternate = fixture(); alternate.models.text.catalogId = "other-deployment-model";
  assert.notEqual(orchestrationHash(validateOrchestrationConfig(alternate)), orchestrationHash(c));
});
test("unknown fields, undeclared models and credential destinations fail closed", () => {
  assert.throws(() => validateOrchestrationConfig({ ...fixture(), apiKey: "secret" }), /unknown field/);
  const invalid = fixture(); invalid.bindings.lead.candidates = ["missing"];
  assert.throws(() => validateOrchestrationConfig(invalid), /undeclared/);
  assert.throws(() => validateOrchestrationConfig({ ...fixture(), providers: { local: { adapter: "mswarm", baseUrl: "https://example.test/v1", credentialRef: "env:KEY", catalogUrl: "https://other.test/catalog" } } }), /provider origin/);
});
test("binding cycles and incompatible operations are rejected", () => {
  const invalid = { ...fixture(), bindings: { lead: { useBinding: "reviewer" }, reviewer: { useBinding: "lead" } } };
  assert.throws(() => validateOrchestrationConfig(invalid), /cycle/);
  assert.throws(() => resolveBinding(validateOrchestrationConfig(fixture()), "lead", "images.generations"), /No compatible/);
});
test("alias policies intersect rather than broaden backend eligibility", () => {
  const input = { ...fixture(), routing: { strategy: "capability-and-capacity", requiredBackends: { lead: ["strata"], reviewer: ["other"] } } };
  assert.throws(() => validateOrchestrationConfig(input), /No compatible/);
});
