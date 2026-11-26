import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { UI_JOURNEY_RULE } from "../SessionController.js";

// The rules a web-app build runs under. They must ask for what the journey
// driver can now check, and no longer offer the cheaper substitutes that let
// cycle 7 builds pass without exercising a session restore or an explained
// refusal.
const skill = (name: string) => fs.readFile(new URL(`../../../config/skills/${name}/SKILL.md`, import.meta.url), "utf8");

test("the journey rule requires a reload-then-act step per role and no longer accepts an API read instead", () => {
  assert.doesNotMatch(UI_JOURNEY_RULE, /reload or a follow-up API read/);
  assert.match(UI_JOURNEY_RULE, /For every role, at least one step reloads a signed-in page and then performs a further mutation/);
  assert.match(UI_JOURNEY_RULE, /never replaces that reload/);
  assert.match(UI_JOURNEY_RULE, /journey driver, which records every network response and console error/);
});

test("unavailable-and-explained actions must be visible with their reason, and form controls labelled", () => {
  assert.match(UI_JOURNEY_RULE, /unavailable, blocked or disabled and explained, show a visible disabled control or notice that states the reason, and assert that reason text/);
  assert.match(UI_JOURNEY_RULE, /an absent control does not meet that requirement/);
  assert.match(UI_JOURNEY_RULE, /Give every form control a label tied to it/);
});

test("delivery notes take their numbers from the code and are written early", async () => {
  assert.match(UI_JOURNEY_RULE, /take each number, limit and duration from the code/);
  assert.match(await skill("planning"), /delivery documents \(README, delivery notes\) in the first task that produces a runnable path/);
  assert.match(await skill("code-implementation"), /write the requested README or delivery notes with the real start steps/);
});

test("the web testing and UI skills carry the same journey obligations", async () => {
  const testing = await skill("webapp-testing");
  assert.match(testing, /page\.step\(name, run, \{ allow \}\)/);
  assert.match(testing, /reloads a signed-in page and then performs a mutation/);
  assert.match(testing, /a missing control fails that assertion/);
  const design = await skill("ui-ux-design");
  assert.match(design, /keep its control visible but disabled, or show a notice in its place, with the reason/);
  assert.match(design, /Tie a label to every input, select and textarea/);
});
