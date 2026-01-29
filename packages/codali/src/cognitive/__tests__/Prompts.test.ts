import test from "node:test";
import assert from "node:assert/strict";
import { ARCHITECT_PROMPT, buildBuilderPrompt } from "../Prompts.js";

test("Architect prompt references focus/periphery context", () => {
  assert.match(ARCHITECT_PROMPT, /Focus files contain full content/);
  assert.match(ARCHITECT_PROMPT, /periphery files contain interfaces/);
  assert.match(ARCHITECT_PROMPT, /use \"steps\", not \"plan\"/i);
});

test("Builder prompt switches for patch_json mode", () => {
  const toolPrompt = buildBuilderPrompt("tool_calls");
  assert.match(toolPrompt, /Use tools for file changes/);
  assert.doesNotMatch(toolPrompt, /Do NOT call tools/);

  const patchPrompt = buildBuilderPrompt("patch_json");
  assert.match(patchPrompt, /Do NOT call tools/);
  assert.match(patchPrompt, /"patches":/);
  assert.match(patchPrompt, /"action": "replace"/);

  const fileWritePrompt = buildBuilderPrompt("patch_json", "file_writes");
  assert.match(fileWritePrompt, /"files":/);
  assert.match(fileWritePrompt, /"path":/);
  assert.match(fileWritePrompt, /"content":/);
});
