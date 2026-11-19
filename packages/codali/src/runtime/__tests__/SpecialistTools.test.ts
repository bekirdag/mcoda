import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSpecialistTools } from "../SpecialistTools.js";
import { estimateProviderInputTokens } from "../../providers/RequestSize.js";
import type { ProviderRequest } from "../../providers/ProviderTypes.js";

const capsule = { instruction: "Fix the function", context: "def f(): return 1", acceptance: "Preserve API" };
test("specialists use distinct configured bindings, preserve capsule and return unverified drafts", async () => {
  const seen: string[] = [];
  const tools = createSpecialistTools({ coding: {}, frontend: {} }, binding => ({ name: binding, generate: async request => {
    seen.push(binding); assert.match(request.messages[1].content, /Preserve API/);
    return { message: { role: "assistant", content: "proposed patch" } };
  } }));
  for (const tool of tools) {
    const result = await tool.handler(capsule, { workspaceRoot: "/tmp" });
    assert.equal(JSON.parse(result.output).verified, false);
  }
  assert.deepEqual(seen, ["coding", "frontend"]);
  assert.equal(createSpecialistTools({ coding: { enabled: false } }, () => { throw new Error("disabled"); }).length, 0);
});

test("specialists reject invalid capsules and unexecuted model tool calls", async () => {
  let calls = 0;
  const [tool] = createSpecialistTools({ coding: {} }, () => ({ name: "test", generate: async () => {
    calls++; return { message: { role: "assistant", content: "", toolCalls: [{ id: "x", name: "write_file", args: {} }] } };
  } }));
  for (const args of [null, { ...capsule, context: "" }, { ...capsule, sources: [42] }]) await assert.rejects(() => tool.handler(args, { workspaceRoot: "/tmp" }));
  assert.equal(calls, 0);
  await assert.rejects(() => tool.handler(capsule, { workspaceRoot: "/tmp" }), /usable draft/);
});

test("frontend screenshot respects workspace and read policy, strips no image from request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-specialist-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codali-specialist-outside-"));
  let request: ProviderRequest | undefined;
  const [tool] = createSpecialistTools({ frontend: {} }, () => ({ name: "vision", generate: async input => {
    request = input; return { message: { role: "assistant", content: "layout draft" } };
  } }));
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    await fs.writeFile(path.join(root, "shot.png"), png);
    await assert.rejects(() => tool.handler({ ...capsule, screenshot: "shot.png" }, { workspaceRoot: root, checkPath: async () => { throw new Error("denied"); } }), /denied/);
    assert.equal(request, undefined);
    await fs.writeFile(path.join(outside, "hosts"), "outside the workspace");
    await fs.symlink(path.join(outside, "hosts"), path.join(root, "escape.png"));
    await assert.rejects(() => tool.handler({ ...capsule, screenshot: "escape.png" }, { workspaceRoot: root }), /inside workspace/);
    await tool.handler({ ...capsule, screenshot: "shot.png" }, { workspaceRoot: root });
    assert.ok(request!.messages[1].images?.[0].dataUrl.startsWith("data:image/png;base64,"));
    const textOnly = { ...request!, messages: request!.messages.map(({ images, ...m }) => m) };
    assert.equal(estimateProviderInputTokens(request!) - estimateProviderInputTokens(textOnly), 8192);
    png.writeUInt32BE(4000, 16); await fs.writeFile(path.join(root, "shot.png"), png);
    await assert.rejects(() => tool.handler({ ...capsule, screenshot: "shot.png" }, { workspaceRoot: root }), /dimensions/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});
