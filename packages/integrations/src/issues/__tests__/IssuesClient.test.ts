import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IssuesClient } from "../IssuesClient.js";

describe("IssuesClient", () => {
  it("exports a client class", () => {
    assert.equal(typeof IssuesClient, "function");
    assert.ok(new IssuesClient());
  });
});
