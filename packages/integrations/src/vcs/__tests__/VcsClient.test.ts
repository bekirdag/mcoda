import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VcsClient } from "../VcsClient.js";

describe("VcsClient.dirtyPaths", () => {
  it("parses modified paths without stripping filename prefixes", async () => {
    const client = new VcsClient();
    (client as any).runGit = async () => ({
      stdout: ` M README.md\u0000A  src/index.ts\u0000?? docs/new file.md\u0000`,
      stderr: "",
    });
    const paths = await client.dirtyPaths("/repo");
    assert.deepEqual(paths, ["README.md", "src/index.ts", "docs/new file.md"]);
  });

  it("returns the new path for renames/copies", async () => {
    const client = new VcsClient();
    (client as any).runGit = async () => ({
      stdout: `R  old.txt\u0000new.txt\u0000C  a.md\u0000b.md\u0000`,
      stderr: "",
    });
    const paths = await client.dirtyPaths("/repo");
    assert.deepEqual(paths, ["new.txt", "b.md"]);
  });
});

describe("VcsClient.ensureClean", () => {
  it("ignores configured paths and .mcoda entries", async () => {
    const client = new VcsClient();
    (client as any).dirtyPaths = async () => [
      "repo_meta.json",
      "logs/output.log",
      ".docdexignore",
      ".mcoda/jobs/job.json",
    ];

    await client.ensureClean("/repo", true, ["repo_meta.json", "logs/", ".docdexignore"]);
  });

  it("throws when non-ignored paths remain", async () => {
    const client = new VcsClient();
    (client as any).dirtyPaths = async () => ["repo_meta.json", "src/index.ts"];

    await assert.rejects(
      () => client.ensureClean("/repo", true, ["repo_meta.json"]),
      /src\/index\.ts/,
    );
  });
});
