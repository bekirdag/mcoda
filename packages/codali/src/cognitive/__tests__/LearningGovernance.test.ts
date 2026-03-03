import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLearningDedupeKey,
  createEmptyLearningRuleLedger,
  governLearningRule,
  mergeLearningRuleIntoLedger,
  promoteLearningRuleCandidate,
  readLearningRuleLedger,
  scoreLearningConfidence,
  writeLearningRuleLedger,
} from "../LearningGovernance.js";

test("scoreLearningConfidence is deterministic for equivalent inputs", { concurrency: false }, () => {
  const one = scoreLearningConfidence({
    source: "request_directive",
    content: "Prefer async/await over callbacks.",
    explicit: true,
    evidence_count: 2,
    has_revert_signal: false,
  });
  const two = scoreLearningConfidence({
    source: "request_directive",
    content: "Prefer async/await over callbacks.",
    explicit: true,
    evidence_count: 2,
    has_revert_signal: false,
  });
  assert.equal(one.score, two.score);
  assert.equal(one.band, two.band);
  assert.deepEqual(one.reasons, two.reasons);
});

test("governLearningRule defers low-confidence ambiguous rules", { concurrency: false }, () => {
  const decision = governLearningRule({
    category: "constraint",
    content: "maybe use this",
    source: "request_directive_inline_constraint",
    evidence: [],
  });
  assert.equal(decision.status, "deferred");
  assert.equal(decision.code, "confidence_below_persistence_threshold");
  assert.equal(decision.rule.lifecycle_state, "candidate");
});

test("governLearningRule accepts explicit confirmation as enforced", { concurrency: false }, () => {
  const decision = governLearningRule({
    category: "constraint",
    content: "Do not use moment.js",
    source: "post_mortem_inferred_rule",
    confidence_score: 0.62,
    explicit_confirmation: true,
    evidence: [{ kind: "run", ref: "run-1" }],
  });
  assert.equal(decision.status, "accepted");
  assert.equal(decision.rule.lifecycle_state, "enforced");
  assert.equal(decision.rule.scope, "profile_memory");
});

test("ledger merge suppresses duplicates and supersedes stronger revisions", { concurrency: false }, () => {
  const ledger = createEmptyLearningRuleLedger();
  const first = governLearningRule({
    category: "constraint",
    content: "Do not use moment.js",
    source: "request_directive_explicit_constraint",
    confidence_score: 0.7,
    evidence: [{ kind: "request", ref: "Prefer date-fns" }],
  }).rule;
  const same = governLearningRule({
    category: "constraint",
    content: "Do not use moment.js",
    source: "request_directive_explicit_constraint",
    confidence_score: 0.71,
    evidence: [{ kind: "request", ref: "Prefer date-fns" }],
  }).rule;
  const stronger = governLearningRule({
    category: "constraint",
    content: "Do not use moment.js",
    source: "post_mortem_inferred_rule",
    confidence_score: 0.95,
    evidence: [{ kind: "run", ref: "run-2" }],
    explicit_confirmation: true,
  }).rule;

  const inserted = mergeLearningRuleIntoLedger(ledger, first);
  assert.equal(inserted.action, "inserted");
  const suppressed = mergeLearningRuleIntoLedger(ledger, same);
  assert.equal(suppressed.action, "suppressed");
  const superseded = mergeLearningRuleIntoLedger(ledger, stronger);
  assert.equal(superseded.action, "superseded");
  assert.equal(ledger.rules.length, 2);
  assert.equal(ledger.rules[0]?.superseded_by, ledger.rules[1]?.id);
  assert.equal(ledger.rules[1]?.lifecycle_state, "enforced");
});

test("promoteLearningRuleCandidate upgrades candidate lifecycle", { concurrency: false }, () => {
  const ledger = createEmptyLearningRuleLedger();
  const decision = governLearningRule({
    category: "constraint",
    content: "Do not use moment.js",
    source: "request_directive_explicit_constraint",
    confidence_score: 0.6,
    evidence: [{ kind: "request", ref: "rule" }],
  });
  mergeLearningRuleIntoLedger(ledger, decision.rule);
  const dedupeKey = buildLearningDedupeKey("profile_memory", "constraint", "Do not use moment.js");
  const promotion = promoteLearningRuleCandidate(ledger, dedupeKey);
  assert.equal(promotion.action, "promoted");
  assert.equal(promotion.promoted?.lifecycle_state, "enforced");
  assert.equal(promotion.previous?.superseded_by, promotion.promoted?.id);
});

test("learning ledger persists and reloads", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-learning-ledger-"));
  const ledgerPath = path.join(tmpDir, "learning-rules.json");
  const ledger = createEmptyLearningRuleLedger();
  const decision = governLearningRule({
    category: "lesson",
    content: "Avoid removing exports in helper modules",
    source: "post_mortem_inferred_rule",
    confidence_score: 0.8,
    evidence: [{ kind: "run", ref: "run-3" }],
  });
  mergeLearningRuleIntoLedger(ledger, decision.rule);
  await writeLearningRuleLedger(ledgerPath, ledger);

  const loaded = await readLearningRuleLedger(ledgerPath);
  assert.equal(loaded.schema_version, 1);
  assert.equal(loaded.rules.length, 1);
  assert.equal(loaded.rules[0]?.dedupe_key, ledger.rules[0]?.dedupe_key);
});
