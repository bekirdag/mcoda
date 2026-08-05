import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadCredentialFile,
  parseCredentialFile,
  resetCredentialCache,
  resolveCredential,
} from "../CredentialFile.js";

test("dotenv-style lines are parsed", () => {
  const values = parseCredentialFile(
    [
      "# a comment",
      "",
      "GITHUB_TOKEN=ghp_example",
      'JIRA_TOKEN="quoted value"',
      "SPACED = padded ",
    ].join("\n"),
  );
  assert.equal(values.GITHUB_TOKEN, "ghp_example");
  assert.equal(values.JIRA_TOKEN, "quoted value");
  assert.equal(values.SPACED, "padded");
});

test("`export FOO=bar` is accepted so the file can also be shell-sourced", () => {
  const values = parseCredentialFile("export GITHUB_TOKEN=ghp_example");
  assert.equal(values.GITHUB_TOKEN, "ghp_example");
});

test("a value containing '=' survives intact", () => {
  const values = parseCredentialFile("B64=aGVsbG89dGhlcmU=");
  assert.equal(values.B64, "aGVsbG89dGhlcmU=");
});

test("malformed lines are skipped rather than failing the file", () => {
  const values = parseCredentialFile("NOEQUALS\n=novalue\nGOOD=yes");
  assert.deepEqual(values, { GOOD: "yes" });
});

test("a missing file resolves to no credentials, not an error", async () => {
  resetCredentialCache();
  const dir = await mkdtemp(path.join(tmpdir(), "codali-creds-"));
  assert.deepEqual(loadCredentialFile(path.join(dir, "absent"), true), {});
});

test("values are read from the file", async () => {
  resetCredentialCache();
  const dir = await mkdtemp(path.join(tmpdir(), "codali-creds-"));
  const file = path.join(dir, ".creds");
  await writeFile(file, "GITHUB_TOKEN=from-file\n", "utf8");
  assert.equal(loadCredentialFile(file, true).GITHUB_TOKEN, "from-file");
});

test("the process environment wins over the file", async () => {
  // So a one-off `GITHUB_TOKEN=… codali ask …` overrides the stored value
  // without editing anything.
  resetCredentialCache();
  const dir = await mkdtemp(path.join(tmpdir(), "codali-creds-"));
  const file = path.join(dir, ".creds");
  await writeFile(file, "CODALI_TEST_CRED=from-file\n", "utf8");
  loadCredentialFile(file, true);

  process.env.CODALI_TEST_CRED = "from-env";
  assert.equal(resolveCredential("CODALI_TEST_CRED"), "from-env");
  delete process.env.CODALI_TEST_CRED;
  resetCredentialCache();
});

test("an unknown name resolves to undefined rather than an empty string", () => {
  resetCredentialCache();
  assert.equal(resolveCredential("CODALI_DEFINITELY_NOT_SET"), undefined);
});
