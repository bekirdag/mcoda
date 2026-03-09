import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PDR_CHARACTER_PROMPT,
  DEFAULT_PDR_JOB_PROMPT,
  DEFAULT_PDR_RUNBOOK_PROMPT,
} from "../../../prompts/PdrPrompts.js";

test("DEFAULT_PDR_JOB_PROMPT requires explicit stack decisions without injecting a default stack", () => {
  assert.match(
    DEFAULT_PDR_JOB_PROMPT,
    /Explicitly specify the technology stack when the source docs name it/i,
  );
  assert.match(
    DEFAULT_PDR_JOB_PROMPT,
    /record the missing decision as an explicit assumption or unresolved source gap/i,
  );
  assert.doesNotMatch(
    DEFAULT_PDR_JOB_PROMPT,
    /default to TypeScript, React, MySQL, Redis, and Bash scripting/i,
  );
});

test("DEFAULT_PDR_JOB_PROMPT stays repo-shape agnostic", () => {
  assert.doesNotMatch(DEFAULT_PDR_JOB_PROMPT, /apps\/web/i);
  assert.doesNotMatch(DEFAULT_PDR_JOB_PROMPT, /services\/api/i);
  assert.doesNotMatch(DEFAULT_PDR_JOB_PROMPT, /packages\/shared/i);
  assert.doesNotMatch(DEFAULT_PDR_JOB_PROMPT, /contracts\//i);
});

test("PDR prompt contracts still require a technology stack section and rationale", () => {
  assert.match(DEFAULT_PDR_RUNBOOK_PROMPT, /Technology Stack/i);
  assert.match(DEFAULT_PDR_RUNBOOK_PROMPT, /Chosen stack/i);
  assert.match(DEFAULT_PDR_RUNBOOK_PROMPT, /Rationale and trade-offs/i);
  assert.match(DEFAULT_PDR_CHARACTER_PROMPT, /State chosen stack decisions/i);
});
