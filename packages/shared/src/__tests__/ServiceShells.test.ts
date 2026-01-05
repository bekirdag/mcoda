import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorFactory } from "../errors/ErrorFactory.js";
import { Logger } from "../logging/Logger.js";
import { UtilityService } from "../utils/UtilityService.js";

describe("shared service shells", () => {
  it("constructs placeholder utilities", () => {
    assert.equal(typeof ErrorFactory, "function");
    assert.equal(typeof Logger, "function");
    assert.equal(typeof UtilityService, "function");
    assert.ok(new ErrorFactory());
    assert.ok(new Logger());
    assert.ok(new UtilityService());
  });
});
