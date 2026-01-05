import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAreaCode, createEpicKeyGenerator } from "../KeyHelpers.js";

describe("KeyHelpers", () => {
  it("normalizes area aliases", () => {
    assert.equal(normalizeAreaCode("frontend", "proj"), "web");
    assert.equal(normalizeAreaCode("infra", "proj"), "ops");
  });

  it("generates epic keys with area codes", () => {
    const gen = createEpicKeyGenerator("proj", ["web-01"]);
    const key = gen("frontend");
    assert.equal(key, "web-02");
  });
});
