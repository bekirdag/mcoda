import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const usagePath = path.resolve(process.cwd(), "docs", "usage.md");
const sdsPath = path.resolve(process.cwd(), "docs", "sds", "sds.md");

test("gateway-trio docs mention usage and SDS behavior", async () => {
  const usage = await fs.readFile(usagePath, "utf8");
  const sds = await fs.readFile(sdsPath, "utf8");
  assert.ok(usage.includes("mcoda gateway-trio"));
  assert.ok(sds.includes("gateway-trio"));
});

test("agent prompts stop and report on merge conflicts", async () => {
  const promptFiles = ["prompts/code-writer.md", "prompts/code-reviewer.md", "prompts/qa-agent.md"];
  const expected = "stop and report; do not attempt to merge";
  for (const promptPath of promptFiles) {
    const content = await fs.readFile(path.resolve(process.cwd(), promptPath), "utf8");
    assert.ok(content.toLowerCase().includes(expected));
  }
  const workPromptSource = await fs.readFile(
    path.resolve(process.cwd(), "packages", "core", "src", "services", "execution", "WorkOnTasksService.ts"),
    "utf8",
  );
  assert.ok(workPromptSource.toLowerCase().includes(expected));
});

test("agent prompts standardize docdex daemon guidance", async () => {
  const promptFiles = [
    "prompts/gateway-agent.md",
    "prompts/code-writer.md",
    "prompts/code-reviewer.md",
    "prompts/qa-agent.md",
  ];
  const expectedDaemon = "docdexd daemon --repo <repo> --host 127.0.0.1 --port 3210 --log warn --secure-mode=false";
  const expectedBaseUrl = "DOCDEX_HTTP_BASE_URL=http://127.0.0.1:3210";
  for (const promptPath of promptFiles) {
    const content = await fs.readFile(path.resolve(process.cwd(), promptPath), "utf8");
    assert.ok(content.includes(expectedDaemon));
    assert.ok(content.includes(expectedBaseUrl));
    assert.equal(/\bmcp\b/i.test(content), false);
    assert.equal(content.includes(".docdex"), false);
  }
});
