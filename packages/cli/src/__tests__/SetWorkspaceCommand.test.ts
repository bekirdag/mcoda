import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSetWorkspaceArgs } from "../commands/workspace/SetWorkspaceCommand.js";

describe("set-workspace argument parsing", () => {
  it("defaults to git and docdex enabled", () => {
    const parsed = parseSetWorkspaceArgs([]);
    assert.equal(parsed.git, true);
    assert.equal(parsed.docdex, true);
  });

  it("parses workspace root and disables features", () => {
    const parsed = parseSetWorkspaceArgs(["--workspace-root", "/tmp/ws", "--no-git", "--no-docdex"]);
    assert.equal(parsed.workspaceRoot, "/tmp/ws");
    assert.equal(parsed.git, false);
    assert.equal(parsed.docdex, false);
  });

  it("parses codex sandbox override", () => {
    const parsed = parseSetWorkspaceArgs(["--codex-no-sandbox"]);
    assert.equal(parsed.codexNoSandbox, true);
    const parsedFalse = parseSetWorkspaceArgs(["--codex-no-sandbox=false"]);
    assert.equal(parsedFalse.codexNoSandbox, false);
  });
});
