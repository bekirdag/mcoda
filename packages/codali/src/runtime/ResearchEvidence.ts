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

/** A page's identity across link spellings (scheme, www., trailing slash, fragment). */
const sourceKey = (value: string): string => {
  try { const url = new URL(value); return `${url.host.toLowerCase().replace(/^www\./u, "")}${url.pathname.replace(/\/+$/u, "")}${url.search}`; }
  catch { return value.trim().toLowerCase(); }
};
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
  // The pages the draft cites come first: for each, its passages that share
  // most with the lines citing it. In cycle 7 the audit was not shown the
  // passage behind a cited claim with no figure in it ("a further three
  // months") and rewrote the claim as unsupported.
  const anchored: typeof ranked = [];
  let anchorChars = 0;
  const citing = new Map<string, Set<string>>();
  for (const line of draft.split(/\n+/u)) {
    for (const url of line.match(/https?:\/\/[^\s<>()\[\]"'`\\]+/gu) ?? []) {
      const key = sourceKey(url.replace(/[.,;:!?*]+$/u, ""));
      const words = citing.get(key) ?? new Set<string>();
      for (const word of line.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []) words.add(word);
      citing.set(key, words);
    }
  }
  if (citing.size) {
    const cited = ranked.map(value => {
      const words = citing.get(sourceKey(value.packet.source));
      if (!words) return undefined;
      const terms = new Set(value.packet.passage.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
      return { value, key: sourceKey(value.packet.source), overlap: [...words].filter(word => terms.has(word)).length };
    }).filter(item => item !== undefined).sort((a, b) => b.overlap - a.overlap || a.value.index - b.value.index);
    // Best passage of every cited page first, then further passages of them.
    const firsts = new Set<string>();
    const order = [...cited.filter(item => !firsts.has(item.key) && firsts.add(item.key)), ...cited];
    for (const { value } of order) {
      if (anchored.includes(value)) continue;
      const size = JSON.stringify(value.packet).length + 1;
      if (anchorChars + size > maxChars * 0.35) continue;
      anchorChars += size; anchored.push(value);
    }
  }
  // Greedy cover of the draft's anchors, within part of the budget.
  const anchors = draftAnchors(draft), uncovered = new Set(anchors);
  const passages = new Map(ranked.map(value => [value.index, squash(value.packet.passage)]));
  for (const value of anchored) for (const anchor of [...uncovered]) if (passages.get(value.index)!.includes(anchor)) uncovered.delete(anchor);
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
    if (anchorChars + size > maxChars * 0.7) break;
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
 * written: the model service was down or the final request would have run past
 * the time limit. In cycle 6 a 41-minute investigation delivered nothing
 * because that request hit three gateway timeouts in its last three minutes.
 * Built without a model, so it is ready at once. It says plainly that it is
 * evidence and not an answer, and quotes at most 25 words from any one source:
 * the sentence that shares most with the request, figures and dates first. */
export function evidenceReport(packets: ResearchPacket[], request: string, reason: string, maxSources = 30): string | undefined {
  // A search result packet carries several pages as JSON (possibly cut short); read each as its own source.
  const pages = packets.flatMap(packet => /^https?:/.test(packet.source) ? [{ source: packet.source, passage: packet.passage }]
    : [...packet.passage.matchAll(/"url"\s*:\s*"(https?:[^"\s]{1,1000})"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.){0,3000})/gu)]
      .map(match => ({ source: match[1], passage: match[2].replace(/\\[nrt]/gu, " ").replace(/\\(["\\/])/gu, "$1") })))
    .filter(page => page.passage.trim().length >= 40);
  if (!pages.length) return undefined;
  const terms = new Set(request.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
  const best = new Map<string, { excerpt: string; score: number }>();
  for (const packet of pages) {
    for (const sentence of packet.passage.replace(/\s+/gu, " ").split(/(?<=[.!?])\s+|\s+[-•|]\s+/u)) {
      const words = sentence.trim().split(" ").filter(Boolean);
      if (words.length < 5) continue;
      const overlap = new Set(words.map(word => word.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "")).filter(word => terms.has(word))).size;
      const score = overlap * 2 + Math.min(4, words.filter(word => /\d/.test(word)).length);
      const current = best.get(packet.source);
      if (!current || score > current.score) best.set(packet.source, { score, excerpt: words.slice(0, 25).join(" ") + (words.length > 25 ? " …" : "") });
    }
  }
  const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, maxSources);
  if (!ranked.length) return undefined;
  return [`I could not finish writing the answer: ${reason}. What follows is the evidence gathered, not an answer: the pages that were read, each with the one short excerpt closest to the question. Nothing here has been checked against the question as a whole, and points it does not cover remain unanswered.`,
    "", ...ranked.map(([source, { excerpt }], index) => `${index + 1}. ${source}\n   "${excerpt}"`)].join("\n");
}

const OPEN_POINT = /\b(?:unverified|not (?:been )?(?:independently )?verified|unconfirmed|(?:could not|couldn't|can ?not|cannot|was unable to|were unable to|unable to|failed to|did not manage to) (?:be )?(?:independently )?(?:verif(?:y|ied)|confirm(?:ed)?|find|found|locate[d]?|access(?:ed)?|retrieved?|determined?|establish(?:ed)?|open(?:ed)?)|no (?:primary|official|direct|reliable|authoritative) (?:source|page|document|record|figure|confirmation)s? (?:was|were|has been|have been|could be) (?:found|located|retrieved|identified)|(?:was|were) not found (?:during|in) (?:this|the|my) (?:research|search|investigation|review)|remains? (?:unclear|unconfirmed|to be (?:confirmed|verified|determined))|to be (?:confirmed|determined|verified)|tbd)\b/iu;

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
