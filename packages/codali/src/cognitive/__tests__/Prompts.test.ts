import test from "node:test";
import assert from "node:assert/strict";
import {
  ARCHITECT_PROMPT,
  buildBuilderPrompt,
  buildInterpreterPrompt,
  buildInterpreterRetryPrompt,
} from "../Prompts.js";

test("Architect prompt references focus/periphery context", () => {
  assert.match(ARCHITECT_PROMPT, /Focus files contain full content/);
  assert.match(ARCHITECT_PROMPT, /periphery files contain interfaces/);
  assert.match(ARCHITECT_PROMPT, /WRITE POLICY/);
  assert.match(ARCHITECT_PROMPT, /OUTPUT FORMAT \(DSL\)/i);
  assert.match(ARCHITECT_PROMPT, /^PLAN:/m);
});

test("Builder prompt switches for patch_json mode", () => {
  const toolPrompt = buildBuilderPrompt("tool_calls");
  assert.match(toolPrompt, /Use tools for file changes/);
  assert.match(toolPrompt, /WRITE POLICY/);
  assert.doesNotMatch(toolPrompt, /Do NOT call tools/);

  const freeformPrompt = buildBuilderPrompt("freeform");
  assert.match(freeformPrompt, /freeform output/i);
  assert.match(freeformPrompt, /Do NOT output JSON/i);
  assert.match(freeformPrompt, /Do NOT call tools/i);

  const patchPrompt = buildBuilderPrompt("patch_json");
  assert.match(patchPrompt, /Do NOT call tools/);
  assert.match(patchPrompt, /"patches":/);
  assert.match(patchPrompt, /"action": "replace"/);
  assert.match(patchPrompt, /single JSON object/i);

  const fileWritePrompt = buildBuilderPrompt("patch_json", "file_writes");
  assert.match(fileWritePrompt, /"files":/);
  assert.match(fileWritePrompt, /"path":/);
  assert.match(fileWritePrompt, /"content":/);
  assert.match(fileWritePrompt, /single JSON object/i);
});

test("Interpreter prompt includes strict JSON schema", () => {
  const searchPrompt = buildInterpreterPrompt("search_replace");
  assert.match(searchPrompt, /Output JSON only/i);
  assert.match(searchPrompt, /"patches":/);
  assert.match(searchPrompt, /"search_block"/);

  const filePrompt = buildInterpreterPrompt("file_writes");
  assert.match(filePrompt, /"files":/);
  assert.match(filePrompt, /"content"/);

  const retryPrompt = buildInterpreterRetryPrompt("search_replace");
  assert.match(retryPrompt, /respond only with valid json/i);
  assert.match(retryPrompt, /"patches":/);
});
