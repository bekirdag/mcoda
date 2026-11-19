import test from "node:test";
import assert from "node:assert/strict";
import { isWithinScope, scopesOverlap } from "../WorkspaceScope.js";

test("directory scopes accept equivalent notation and preserve segment boundaries", () => {
  for (const file of ["src/a.ts", "./src/a.ts", "src//a.ts"]) {
    for (const scope of ["src", "src/", "./src/", "src//"]) assert.equal(isWithinScope(file, [scope]), true);
  }
  assert.equal(isWithinScope("src-other/a.ts", ["src/"]), false);
  assert.equal(isWithinScope("other/a.ts", ["src/"]), false);
  assert.equal(isWithinScope("local.ts", ["."]), true);
  assert.equal(isWithinScope("local.ts", ["./"]), true);
  assert.equal(scopesOverlap("src/", "src/a.ts"), true);
  assert.equal(scopesOverlap("src/a.ts", "src/"), true);
  assert.equal(scopesOverlap("src/", "other/"), false);
});
test("normalization never turns traversal, absolute or empty scopes into permission", () => {
  for (const value of ["", "/", "/abs/file", "../outside", "src/../outside", "src\\a.ts", "src/a\0.ts", "C:/outside"]) {
    assert.equal(isWithinScope(value, ["."]), false, value);
    assert.equal(isWithinScope("file.ts", [value]), false, value);
    assert.equal(scopesOverlap(value, "file.ts"), false, value);
  }
  assert.equal(isWithinScope("file.ts", []), false);
});
