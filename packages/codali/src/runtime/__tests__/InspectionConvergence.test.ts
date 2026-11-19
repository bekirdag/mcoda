import test from "node:test";
import assert from "node:assert/strict";
import { InspectionConvergence } from "../InspectionConvergence.js";

test("identical sources are not new evidence, so a re-fetch loop goes stale", () => {
  const convergence = new InspectionConvergence("medium");
  assert.equal(convergence.observe("browser_open", { url: "https://eur-lex.europa.eu/a?x=1#top" }, true, "one"), true);
  convergence.endRound();
  for (let round = 0; round < 8; round++) {
    assert.equal(convergence.reason(), undefined);
    assert.equal(convergence.observe("browser_open", { url: "https://www.eur-lex.europa.eu/a/?x=1", scope: "page" }, true, "changed render"), false);
    convergence.endRound();
  }
  assert.match(convergence.reason() ?? "", /no new evidence/);
});

test("new evidence resets staleness and bookkeeping tools never count", () => {
  const convergence = new InspectionConvergence("high");
  for (let round = 0; round < 7; round++) { convergence.observe("context_read", { sha256: `h${round}` }, true, "x"); convergence.observe("server_time", {}, true, `${round}`); convergence.endRound(); }
  assert.equal(convergence.status().staleRounds, 7);
  convergence.observe("docdex_web_research", { query: "EU AI Act dates" }, true, "result"); convergence.endRound();
  assert.equal(convergence.status().staleRounds, 0);
  assert.equal(convergence.observe("docdex_web_research", { query: "dates eu act AI" }, true, "other"), false, "reworded word order is the same query");
});

test("failed calls are not evidence and the round limit scales with effort", () => {
  const convergence = new InspectionConvergence("low");
  assert.equal(convergence.observe("browser_open", { url: "https://a.example" }, false, ""), false);
  assert.equal(convergence.observe("browser_open", { url: "https://a.example" }, true, "now retrieved"), true);
  for (let round = 0; round < 20; round++) { convergence.observe("verify_tests", { files: [round] }, true, "ok"); convergence.endRound(); }
  assert.match(convergence.reason() ?? "", /20-round/);
});
