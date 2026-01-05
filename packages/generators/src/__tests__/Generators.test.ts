import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Index } from "../index.js";
import { DocsScaffolder } from "../scaffolding/docs/DocsScaffolder.js";
import { WorkspaceScaffolder } from "../scaffolding/workspace/WorkspaceScaffolder.js";
import { GlobalScaffolder } from "../scaffolding/global/GlobalScaffolder.js";
import { GenerateTypes } from "../openapi/generateTypes.js";
import { ValidateSchema } from "../openapi/validateSchema.js";

describe("generators shells", () => {
  it("exports scaffolders and generators", () => {
    assert.ok(new Index());
    assert.ok(new DocsScaffolder());
    assert.ok(new WorkspaceScaffolder());
    assert.ok(new GlobalScaffolder());
    assert.ok(new GenerateTypes());
    assert.ok(new ValidateSchema());
  });
});
