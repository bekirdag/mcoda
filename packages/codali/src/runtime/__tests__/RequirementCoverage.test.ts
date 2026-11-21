import test from "node:test";
import assert from "node:assert/strict";
import { parseRequirementCheck } from "../RequirementCoverage.js";

test("a requirement check yields only explained gaps and never trusts a malformed reply", () => {
  const reply = (requirements: unknown) => JSON.stringify({ requirements });
  const parsed = parseRequirementCheck("```json\n" + reply([
    { item: "p99 latency under 150 ms", status: "covered", note: "" },
    { item: "RPO of 1 minute", status: "missing", note: "No replication or log shipping mechanism is given." },
    { item: "retain audit trail for 3 years", status: "contradicted", note: "The draft retains it for 1 year." },
    { item: "choose the partition key", status: "deferred", note: "Two options are listed without choosing." },
    { item: "something", status: "missing", note: "too short" },
    { item: "odd status", status: "partially", note: "The draft covers half of this requirement." },
  ]) + "\n```")!;
  assert.equal(parsed.requirements, 6);
  assert.deepEqual(parsed.gaps.map(gap => [gap.item, gap.status]), [["RPO of 1 minute", "missing"], ["retain audit trail for 3 years", "contradicted"], ["choose the partition key", "deferred"]]);
  for (const bad of ["The draft is fine.", "[]", reply([]), reply("none"), reply([{ status: "missing", note: "No item named at all here." }]), reply([{ item: "x", status: 3 }]), reply(["text"])]) {
    assert.equal(parseRequirementCheck(bad), undefined, bad);
  }
  // A check that faults most of a finished draft has misread it and is not acted on.
  const sweeping = Array.from({ length: 20 }, (_, index) => ({ item: `requirement ${index}`, status: index < 15 ? "missing" : "covered", note: "The draft does not address this requirement at all." }));
  assert.deepEqual(parseRequirementCheck(reply(sweeping))!.gaps, []);
  // Many real gaps among many requirements are capped, not dropped.
  const many = Array.from({ length: 40 }, (_, index) => ({ item: `requirement ${index}`, status: index < 14 ? "deferred" : "covered", note: "The draft leaves this value to be determined." }));
  assert.equal(parseRequirementCheck(reply(many))!.gaps.length, 12);
});
