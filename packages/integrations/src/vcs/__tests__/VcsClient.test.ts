import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VcsClient } from "../VcsClient.js";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const setupRepo = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-vcs-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "mcoda@example.test"]);
  git(dir, ["config", "user.name", "mcoda test"]);
  await fs.writeFile(path.join(dir, "sample.txt"), "base\n", "utf8");
  git(dir, ["add", "sample.txt"]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
};

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

describe("VcsClient.applyPatch", () => {
  it("applies a valid patch via stdin", async () => {
    const dir = await setupRepo();
    const client = new VcsClient();
    const filePath = path.join(dir, "sample.txt");
    try {
      await fs.writeFile(filePath, "base\nupdated\n", "utf8");
      const patch = git(dir, ["diff", "--", "sample.txt"]);
      await fs.writeFile(filePath, "base\n", "utf8");

      await client.applyPatch(dir, patch);

      assert.equal(await fs.readFile(filePath, "utf8"), "base\nupdated\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not execute heredoc delimiter payloads", async () => {
    const dir = await setupRepo();
    const client = new VcsClient();
    const markerPath = path.join(dir, "marker.txt");
    const markerCommand = JSON.stringify(markerPath);
    const maliciousPatch = [
      "__PATCH__",
      `node -e \"require('node:fs').writeFileSync(${markerCommand}, 'owned')\"`,
      "cat <<'__PATCH__'",
      "diff --git a/sample.txt b/sample.txt",
      "--- a/sample.txt",
      "+++ b/sample.txt",
      "@@ -1 +1 @@",
      "-base",
      "+patched",
    ].join("\n");

    try {
      await assert.rejects(() => client.applyPatch(dir, maliciousPatch));
      const markerExists = await fs
        .access(markerPath)
        .then(() => true)
        .catch(() => false);
      assert.equal(markerExists, false);
      assert.equal(await fs.readFile(path.join(dir, "sample.txt"), "utf8"), "base\n");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
