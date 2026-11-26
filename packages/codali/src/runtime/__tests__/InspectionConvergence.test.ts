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

test("revised programs that still crash keep inspection open; repeated or endless ones do not", () => {
  // Fresh variant: a closed queueing network solved by a script that crashes six
  // times with different bugs, after two tool lookups, before it runs.
  const convergence = new InspectionConvergence("medium");
  convergence.observe("tools_describe", { query: "python" }, true, "catalogue"); convergence.endRound();
  convergence.observe("tools_describe", { names: ["run_code"] }, true, "schema"); convergence.endRound();
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal(convergence.observe("verify_tests", { runner: "python", files: [{ path: "test_mva.py", content: `bug ${attempt}` }] }, false, ""), false);
    convergence.endRound();
    assert.equal(convergence.reason(), undefined, `attempt ${attempt}`);
  }
  assert.equal(convergence.observe("run_code", { language: "python", source: "print(4.36)" }, true, "4.36"), true); convergence.endRound();
  assert.equal(convergence.status().staleRounds, 0);
  // Resending the same failing program is not progress (only its first run was new).
  const stuck = new InspectionConvergence("high");
  for (let round = 0; round < 9; round++) { stuck.observe("run_code", { language: "python", source: "raise SystemExit(1)" }, false, ""); stuck.endRound(); }
  assert.match(stuck.reason() ?? "", /no new evidence/);
  // A model that never gets any program to run still converges, just later.
  const endless = new InspectionConvergence("high");
  let rounds = 0;
  while (!endless.reason() && rounds < 40) { endless.observe("calculate", { expression: `x${rounds} +` }, false, ""); endless.endRound(); rounds++; }
  assert.equal(rounds, 16);
});
