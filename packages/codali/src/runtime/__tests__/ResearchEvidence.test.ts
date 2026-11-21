import test from "node:test";
import assert from "node:assert/strict";
import { draftAnchors, researchPacket, selectResearchEvidence, type ResearchPacket } from "../ResearchEvidence.js";

test("draft anchors are exact quotes and specific figures, not years or small numbers", () => {
  const anchors = draftAnchors('s 63D: “Civil penalty: 30,000 penalty units” under F2025L00889, made in 2025, section 12, on 10 Dec.');
  assert.ok(anchors.includes("civil penalty: 30,000 penalty units"));
  assert.ok(anchors.includes("30,000")); assert.ok(anchors.includes("f2025l00889"));
  assert.ok(!anchors.includes("2025")); assert.ok(!anchors.includes("12")); assert.ok(!anchors.includes("10"));
});

test("the audit sees the passage behind a quoted draft claim even among many more relevant-looking pages", () => {
  // Cycle 5 research 42: 67 passages, 9 shown, the quoted penalty passage left out.
  const draft = 'The ban applies to age-restricted platforms. s 63D: "Civil penalty: 30,000 penalty units". Platforms must take reasonable steps.';
  const filler = Array.from({ length: 40 }, (_, index) => ({ source: `https://example.org/news-${index}`, query: "age restricted platforms reasonable steps",
    passage: ("Age-restricted social media platforms must take reasonable steps to prevent age-restricted users. ").repeat(25) + index, tool: "browser_read" }));
  const penalty = { source: "https://legislation.example/act", passage: 'Section 63D. Civil penalty: 30,000 penalty units. (2) Before making rules the Minister must consult.', tool: "browser_read" };
  const selected = selectResearchEvidence([...filler, penalty], "Australia social media minimum age ban penalties platforms", draft, 12000);
  assert.ok(selected.some(packet => packet.source === penalty.source));
  assert.ok(JSON.stringify(selected).length <= 12000);
});

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

test("the points a draft leaves open are read from its own words", async () => {
  const { openResearchPoints } = await import("../ResearchEvidence.js");
  const draft = `## Kashiwazaki-Kariwa restart
- Unit 6 restarted on 21 January 2026 (TEPCO release).
- **Commercial operation date:** could not be verified from a primary source.
- The 2 June 2026 amendment is alleged by two news sites; the gazette page was not found during this research.

| Item | Value |
| Final 2026 budget | No official figure was found |

The Bundesrat vote count remains unclear. The court's reasoning is set out in paragraphs 40 to 52 of the judgment, which this answer quotes directly and at length so that the reader can follow each step without opening the source, and nothing in that passage is disputed.`;
  const open = openResearchPoints(draft);
  assert.equal(open.length, 4);
  assert.match(open[0], /^Commercial operation date: could not be verified/);
  assert.match(open[1], /alleged by two news sites/);
  assert.match(open[2], /No official figure was found/);
  assert.equal(open[3], "The Bundesrat vote count remains unclear.");
  // A finished answer has none; ordinary uses of similar words are not admissions.
  assert.deepEqual(openResearchPoints("Unit 6 restarted on 21 January 2026. The regulator found the plan adequate and confirmed the date."), []);
  // Finished sentences an independent review got sent back by the first version of the rule.
  for (const finished of ["The indictment alleged wire fraud; the jury convicted on all counts.", "Dark mode is not available on the free plan.", "The audit reported that no evidence was found of data exfiltration.",
    "The API returns 404 when the record is not found in the index.", "Two of the complaints remain unresolved before the tribunal.", "The cause of the 1908 event remains unknown to science.",
    "The appeal was not found admissible.", "Allegedly, the firm knew; the regulator later established that it did."]) assert.deepEqual(openResearchPoints(finished), [], finished);
  // Admissions about the research itself, in the forms a model actually writes.
  for (const admitted of ["I couldn't verify the exact date.", "The filing number cannot be confirmed from the registry.", "We were unable to locate the gazette notice.", "The page failed to open and its figure is unverified.", "No primary source was found for the 47-per-month figure."]) assert.equal(openResearchPoints(admitted).length, 1, admitted);
  assert.equal(openResearchPoints(Array.from({ length: 20 }, (_, index) => `Item ${index} could not be confirmed.`).join("\n")).length, 8);
});

test("the evidence report names each page read with one short excerpt, never a long quotation", async () => {
  const { evidenceReport } = await import("../ResearchEvidence.js");
  const long = "The Federal Aviation Administration capped production of the aircraft at 38 a month on 4 March 2026 after the audit found repeated lapses in tool control, parts traceability, torque records and supplier oversight across three plants, and said the cap would remain until all 27 corrective actions were verified on site. " + "Background paragraph about the company history. ".repeat(40);
  const packets: ResearchPacket[] = [
    { source: "https://regulator.example/orders/14", passage: long, tool: "browser_open" },
    { source: "https://regulator.example/orders/14", passage: "Contact the press office for more information about this order and its publication.", tool: "browser_read" },
    { source: "docdex_web_research", tool: "docdex_web_research", query: "production cap", passage: JSON.stringify({ query: "production cap", pages: [{ url: "https://news.example/cap", content: "Reuters reported the production cap of 38 aircraft a month on 4 March 2026.\nAnalysts expect \"months\" of delay." }, { url: "https://short.example/x", content: "tiny" }] }).slice(0, 300) },
    { source: "calculate", tool: "calculate", passage: "{\"result\":38}" },
  ];
  const report = evidenceReport(packets, "When did the regulator cap production, and at what level?", "the model service was unavailable (service unavailable 504)")!;
  assert.match(report, /^I could not finish writing the answer: the model service was unavailable \(service unavailable 504\)\. What follows is the evidence gathered, not an answer/);
  // One entry per page read, the most relevant sentence first; a truncated search result still yields its page.
  assert.deepEqual([...report.matchAll(/^\d+\. (\S+)$/gm)].map(match => match[1]).sort(), ["https://news.example/cap", "https://regulator.example/orders/14"]);
  assert.match(report, /capped production of the aircraft at 38 a month on 4 March 2026/);
  for (const excerpt of report.matchAll(/^ {3}"(.*)"$/gm)) assert.ok(excerpt[1].replace(/ …$/, "").split(" ").length <= 25, excerpt[1]);
  assert.doesNotMatch(report, /Background paragraph|press office|tiny/);
  assert.equal(evidenceReport([{ source: "calculate", tool: "calculate", passage: "{\"result\":38}" }], "q", "r"), undefined);
});
