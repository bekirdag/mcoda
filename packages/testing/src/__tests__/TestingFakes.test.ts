import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeAgents } from "../fakes/agents/FakeAgents.js";
import { FakeQaClient } from "../fakes/qa/FakeQaClient.js";
import { FakeDocdexClient } from "../fakes/docdex/FakeDocdexClient.js";
import { FakeVcsClient } from "../fakes/vcs/FakeVcsClient.js";

describe("testing fakes", () => {
  it("exports fake client shells", () => {
    assert.ok(new FakeAgents());
    assert.ok(new FakeQaClient());
    assert.ok(new FakeDocdexClient());
    assert.ok(new FakeVcsClient());
  });
});
