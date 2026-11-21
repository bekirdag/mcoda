export interface ResearchPacket { source: string; passage: string; tool: string; query?: string; httpStatus?: number; sectionContext?: string[];
  snapshotId?: string; offset?: number; nextOffset?: number | null; totalChars?: number; }

/** Strip repeated transport metadata, not supporting passages. Missing search
 * matches aren't source evidence and must not evict actual retrieved text. */
export function researchPacket(tool: string, input: unknown, output: string): ResearchPacket | undefined {
  const query = input && typeof input === "object" && "query" in input ? String(input.query).slice(0, 200) : undefined;
  try {
    const data = JSON.parse(output);
    if (data.matchFound === false || data.httpStatus >= 400) return;
    if (typeof data.url === "string" && typeof data.content === "string") {
      if (!data.content.trim()) return;
      const recovery: Pick<ResearchPacket, "snapshotId" | "offset" | "nextOffset" | "totalChars"> = {};
      if (typeof data.snapshotId === "string" && data.snapshotId.length > 0 && data.snapshotId.length <= 128) recovery.snapshotId = data.snapshotId;
      for (const key of ["offset", "nextOffset", "totalChars"] as const) {
        if (Number.isSafeInteger(data[key]) && data[key] >= 0 && data[key] <= 1000000) recovery[key] = data[key];
      }
      if (data.nextOffset === null) recovery.nextOffset = null;
      return { source: data.url.slice(0, 1000), passage: data.content.slice(0, 3000), tool, query, httpStatus: data.httpStatus,
        ...recovery,
        ...(Array.isArray(data.sectionContext) ? { sectionContext: data.sectionContext.filter((item: unknown) => typeof item === "string").slice(-4) } : {}) };
    }
  } catch { /* Docdex may return source-labelled text instead of JSON. */ }
  return output.trim() ? { source: tool, passage: output.slice(0, 4000), tool, query } : undefined;
}

const squash = (text: string): string => text.toLowerCase().replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/[‐-―−]/gu, "-").replace(/\s+/gu, " ");

/** Exact quotes and specific figures/identifiers in a draft: the claims an
 * audit must be able to check against the passage they came from. */
export function draftAnchors(draft: string): string[] {
  const text = squash(draft), anchors = new Set<string>();
  for (const match of text.matchAll(/"([^"]{12,200})"/gu)) anchors.add(match[1].trim());
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])(?:\p{L}*\d[\p{L}\p{N}]*(?:[.,/:-]\p{N}+)*)(?![\p{L}\p{N}])/gu)) {
    const token = match[0];
    // Skip bare small numbers and single years: they match almost any page.
    if (token.length < 4 || /^(?:19|20)\d\d$/u.test(token)) continue;
    anchors.add(token);
  }
  return [...anchors].slice(0, 200);
}

/** Bound audit input while retaining source diversity and relevant earlier
 * passages. FIFO eviction made late failed searches erase valid citations.
 * Passages that carry the draft's own quotes and figures come first: in cycle 5
 * the audit saw 9 of 67 passages, missed the one with "Civil penalty: 30,000
 * penalty units", and relabelled that verbatim quote as unverified. */
export function selectResearchEvidence(packets: ResearchPacket[], request: string, draft: string, maxChars = 48000): ResearchPacket[] {
  const words = new Set((request + " " + draft).toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
  const unique = [...new Map(packets.map(packet => [packet.source + "\n" + packet.passage, packet])).values()];
  const ranked = unique.map((packet, index) => {
    const terms = new Set(packet.passage.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
    const overlap = [...terms].filter(term => words.has(term)).length;
    return { packet, index, score: overlap / Math.sqrt(Math.max(1, terms.size)) + (packet.query ? 1 : 0) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  // Greedy cover of the draft's anchors, within part of the budget.
  const anchors = draftAnchors(draft), uncovered = new Set(anchors), anchored: typeof ranked = [];
  const passages = new Map(ranked.map(value => [value.index, squash(value.packet.passage)]));
  let anchorChars = 0;
  while (uncovered.size) {
    let best: (typeof ranked)[number] | undefined, bestHits = 0;
    for (const value of ranked) {
      if (anchored.includes(value)) continue;
      const passage = passages.get(value.index)!;
      const hits = [...uncovered].filter(anchor => passage.includes(anchor)).length;
      if (hits > bestHits) { best = value; bestHits = hits; }
    }
    if (!best) break;
    const size = JSON.stringify(best.packet).length + 1;
    if (anchorChars + size > maxChars * 0.6) break;
    anchorChars += size; anchored.push(best);
    for (const anchor of [...uncovered]) if (passages.get(best.index)!.includes(anchor)) uncovered.delete(anchor);
  }
  const sources = new Set<string>();
  const leaders = ranked.filter(value => { if (sources.has(value.packet.source)) return false; sources.add(value.packet.source); return true; });
  const selected: ResearchPacket[] = [], included = new Set<number>();
  let chars = 2;
  for (const value of [...anchored, ...leaders, ...ranked]) {
    if (included.has(value.index)) continue;
    const size = JSON.stringify(value.packet).length + 1;
    if (chars + size > maxChars) continue;
    chars += size; included.add(value.index); selected.push(value.packet);
  }
  return selected;
}

/** What an investigation found, as a report, for when its answer could not be
 * written: the final model request failed or would have run past the time
 * limit. In cycle 6 a 41-minute investigation delivered nothing because that
 * request hit three gateway timeouts in its last three minutes. This is built
 * without a model, so it is ready at once; it says plainly that it is evidence
 * and not a finished answer. */
export function evidenceReport(packets: ResearchPacket[], request: string, reason: string, maxChars = 14000): string | undefined {
  if (!packets.some(packet => packet.passage.trim().length >= 40)) return undefined;
  const pages = packets, label = (source: string) => /^https?:/.test(source) ? source : `search result (${source})`;
  const sources = [...new Set(packets.map(packet => packet.source).filter(source => /^https?:/.test(source)))];
  const lines = [`I could not finish writing the answer: ${reason}. What follows is the evidence gathered, not a finished answer: nothing below has been checked against the question as a whole, and points it does not cover remain unanswered.`,
    ...(sources.length ? ["", `Sources read (${sources.length}):`, ...sources.slice(-30).map((source, index) => `${index + 1}. ${source}`)] : []), "", "Most relevant passages:"];
  let used = lines.join("\n").length;
  const perSource = new Map<string, number>();
  for (const packet of selectResearchEvidence(pages, request, "", maxChars * 2)) {
    // At most three passages per source keep one long page from crowding out the rest.
    const count = perSource.get(packet.source) ?? 0;
    if (count >= 3) continue;
    const passage = packet.passage.replace(/\s+/gu, " ").trim().slice(0, 700);
    if (passage.length < 40) continue;
    const entry = `- ${label(packet.source)}${packet.sectionContext?.length ? ` (${packet.sectionContext.join(" > ").slice(0, 160)})` : ""}\n  "${passage}${packet.passage.trim().length > 700 ? "…" : ""}"`;
    if (used + entry.length + 1 > maxChars) break;
    perSource.set(packet.source, count + 1); lines.push(entry); used += entry.length + 1;
  }
  return lines.join("\n");
}

const OPEN_POINT = /\b(?:unverified|not verified|un(?:confirmed|answered|resolved)|could not (?:be )?(?:verif(?:y|ied)|confirm(?:ed)?|find|found|locate[d]?|access(?:ed)?|retrieved?|determined?|establish(?:ed)?)|(?:unable|failed) to (?:verify|confirm|find|locate|access|retrieve|determine|establish|open)|(?:was|were|is|are) not (?:found|located|available|confirmed|retrieved|accessible)|not (?:found|located|retrieved) (?:in|on|during)|no (?:primary |official |direct )?(?:source|evidence|data|figure|record|page|document)s? (?:was |were |has been |have been )?(?:found|located|available|retrieved|identified)|remains? (?:unclear|unknown|open|to be (?:confirmed|verified))|alleged(?:ly)?|missing evidence|not (?:yet )?(?:established|determined)|to be (?:confirmed|determined|verified)|tbd)\b/iu;

/** The points a research draft itself leaves open: the sentences or list items
 * in which it says something was not found, not verified or only alleged.
 * A draft that says so with time left has not finished its research; in cycle
 * 6 one called a core fact "alleged" and stopped with a quarter of its time
 * unused. Decided from the draft's own words, not from the question. */
export function openResearchPoints(draft: string, limit = 8): string[] {
  const points: string[] = [], seen = new Set<string>();
  for (const block of draft.split(/\n+/u)) {
    const line = block.replace(/^[\s>#*|-]+|[\s*|]+$/gu, "").replace(/\*\*/gu, "");
    if (line.length < 12 || !OPEN_POINT.test(line)) continue;
    // Only the sentences that carry the admission, not the settled ones beside them.
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[\p{Lu}\d"“(])/u).filter(part => OPEN_POINT.test(part))) {
      const point = sentence.replace(/\s+/gu, " ").trim().slice(0, 240), key = point.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key); points.push(point);
      if (points.length >= limit) return points;
    }
  }
  return points;
}
