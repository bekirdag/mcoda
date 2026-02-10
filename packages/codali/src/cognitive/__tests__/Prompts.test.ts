import test from "node:test";
import assert from "node:assert/strict";
import {
  ARCHITECT_PROMPT,
  ARCHITECT_REVIEW_PROMPT,
  ARCHITECT_VALIDATE_PROMPT,
  buildBuilderPrompt,
  buildInterpreterPrompt,
  buildInterpreterRetryPrompt,
} from "../Prompts.js";

test("Architect prompt references focus/periphery context", () => {
  assert.match(ARCHITECT_PROMPT, /File contents are not included by default/);
  assert.match(ARCHITECT_PROMPT, /docdex\.open/);
  assert.match(ARCHITECT_PROMPT, /Do NOT use generic filler lines/i);
  assert.match(ARCHITECT_PROMPT, /RESEARCH SUMMARY/i);
  assert.match(ARCHITECT_PROMPT, /missing evidence|gaps/i);
  assert.match(ARCHITECT_PROMPT, /Every IMPLEMENTATION PLAN line must include request-specific nouns/i);
  assert.match(ARCHITECT_PROMPT, /Every VERIFY line must include request-specific nouns/i);
  assert.match(ARCHITECT_PROMPT, /FILES TO TOUCH must be concrete repo-relative paths/i);
  assert.match(ARCHITECT_PROMPT, /RISK must reference concrete impacted behavior\/components/i);
  assert.match(ARCHITECT_PROMPT, /VALID OUTPUT EXAMPLE/i);
  assert.match(ARCHITECT_PROMPT, /INVALID OUTPUT EXAMPLE/i);
  assert.match(ARCHITECT_PROMPT, /Output plain text only/i);
  assert.match(ARCHITECT_PROMPT, /PREFERRED OUTPUT SHAPE \(PLAIN TEXT\)/i);
  assert.match(ARCHITECT_PROMPT, /^WHAT IS REQUIRED:/m);
  assert.match(ARCHITECT_PROMPT, /^FILES TO TOUCH:/m);
  assert.match(ARCHITECT_PROMPT, /^IMPLEMENTATION PLAN:/m);
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

test("Architect validate prompt enforces anti-generic plan quality", () => {
  assert.match(ARCHITECT_VALIDATE_PROMPT, /Reject generic\/filler plan lines/i);
  assert.match(ARCHITECT_VALIDATE_PROMPT, /Ensure every IMPLEMENTATION PLAN and VERIFY line includes request-specific nouns/i);
  assert.match(ARCHITECT_VALIDATE_PROMPT, /no placeholders or "unknown"/i);
  assert.match(ARCHITECT_VALIDATE_PROMPT, /^WHAT IS REQUIRED:/m);
  assert.match(ARCHITECT_VALIDATE_PROMPT, /^FILES TO TOUCH:/m);
  assert.match(ARCHITECT_VALIDATE_PROMPT, /^IMPLEMENTATION PLAN:/m);
});

test("Architect review prompt enforces semantic correctness checks", () => {
  assert.match(ARCHITECT_REVIEW_PROMPT, /implements the USER REQUEST intent/i);
  assert.match(ARCHITECT_REVIEW_PROMPT, /missing, only partially implemented, or replaced with unrelated\/static content/i);
  assert.match(ARCHITECT_REVIEW_PROMPT, /REASONS:/);
  assert.match(ARCHITECT_REVIEW_PROMPT, /FEEDBACK:/);
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
