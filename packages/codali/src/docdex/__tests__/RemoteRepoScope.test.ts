import assert from "node:assert/strict";
import test from "node:test";
import { docdexRepoRootFor } from "../DocdexClient.js";

test("a remote repository discloses no local path", () => {
  // A tenant's repo is addressed by id and has no checkout on this machine.
  // Defaulting the root to the process working directory sent the host's own
  // filesystem path to docdex on every tenant request.
  assert.equal(docdexRepoRootFor(undefined, "repo-abc", "/srv/logmira"), undefined);
});

test("a host that means a local checkout says so", () => {
  assert.equal(docdexRepoRootFor("/work/tenant-a", "repo-abc", "/srv/logmira"), "/work/tenant-a");
});

test("local CLI use is unchanged", () => {
  // No repo id: this is someone running codali in their own repository.
  assert.equal(docdexRepoRootFor(undefined, undefined, "/home/dev/project"), "/home/dev/project");
});
