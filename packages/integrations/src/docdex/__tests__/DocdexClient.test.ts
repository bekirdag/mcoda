import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DocdexClient } from "../DocdexClient.js";

test("DocdexClient registers and searches documents locally", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-docdex-"));
  const client = new DocdexClient({ workspaceRoot: dir });
  try {
    const registered = await client.registerDocument({
      docType: "SDS",
      path: path.join(dir, "docs", "sds", "demo.md"),
      title: "Demo",
      content: "# Heading\nContent line",
      metadata: { projectKey: "proj" },
    });

    const found = await client.fetchDocumentById(registered.id);
    assert.equal(found.id, registered.id);
    assert.ok(found.segments && found.segments.length > 0);

    const search = await client.search({ docType: "SDS", projectKey: "proj" });
    assert.ok(search.some((doc) => doc.id === registered.id));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
