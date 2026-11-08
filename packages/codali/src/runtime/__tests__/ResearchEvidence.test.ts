import test from "node:test";
import assert from "node:assert/strict";
import { researchPacket, selectResearchEvidence, type ResearchPacket } from "../ResearchEvidence.js";

test("failed queries and HTTP errors cannot displace actual source passages", () => {
  assert.equal(researchPacket("browser_read", { query: "missing" }, '{"matchFound":false,"url":"https://example.org"}'), undefined);
  assert.equal(researchPacket("browser_open", {}, '{"httpStatus":404,"url":"https://example.org","content":"Not found"}'), undefined);
  const packet = researchPacket("browser_read", { query: "writers" }, JSON.stringify({ url: "https://example.org/a", content: "One writer at a time.", httpStatus: 200, evidenceNotice: "metadata" }));
  assert.deepEqual(packet, { source: "https://example.org/a", passage: "One writer at a time.", tool: "browser_read", query: "writers", httpStatus: 200 });
});

test("bounded audit preserves relevant early evidence and distinct sources instead of FIFO", () => {
  const packets: ResearchPacket[] = [
    { source: "https://example.org/a", passage: "Writers serialize while readers keep a snapshot.", query: "writer snapshot", tool: "browser_read" },
    { source: "https://example.org/b", passage: "Retry the entire transaction after serialization failure.", query: "retry", tool: "browser_read" },
    ...Array.from({ length: 20 }, (_, index) => ({ source: "https://example.org/a", passage: ("Unrelated navigation and background appendix. ").repeat(30) + index, tool: "browser_read" })),
  ];
  const selected = selectResearchEvidence(packets, "Compare writers, readers and transaction retries", "Writers serialize. Retry the entire transaction.", 2000);
  assert.ok(selected.some(packet => packet.passage === packets[0].passage));
  assert.ok(selected.some(packet => packet.source === "https://example.org/b"));
  assert.ok(JSON.stringify(selected).length <= 2000);
  assert.equal(selectResearchEvidence([packets[0], packets[0]], "writers", "").length, 1);
});

test("audit evidence retains bounded browser handles and pagination for real follow-up reads", () => {
  const packet = researchPacket('browser_read', {}, JSON.stringify({ url: 'https://example.org/reference', content: 'Source passage.',
    snapshotId: 'actual-session-handle', offset: 2400, nextOffset: 4800, totalChars: 12000 }));
  assert.ok(packet);
  const selected = selectResearchEvidence([packet], 'Source', 'passage');
  assert.equal(selected[0].snapshotId, 'actual-session-handle');
  assert.equal(selected[0].nextOffset, 4800); assert.equal(selected[0].offset, 2400); assert.equal(selected[0].totalChars, 12000);
  const invalid = researchPacket('browser_read', {}, JSON.stringify({ url: 'https://example.org', content: 'End.', snapshotId: 'x'.repeat(129), offset: -1, nextOffset: null, totalChars: 1000001 }));
  assert.equal(invalid?.snapshotId, undefined); assert.equal(invalid?.offset, undefined); assert.equal(invalid?.totalChars, undefined);
  assert.equal(invalid?.nextOffset, null);
});
