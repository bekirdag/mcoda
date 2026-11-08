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

/** Bound audit input while retaining source diversity and relevant earlier
 * passages. FIFO eviction made late failed searches erase valid citations. */
export function selectResearchEvidence(packets: ResearchPacket[], request: string, draft: string, maxChars = 24000): ResearchPacket[] {
  const words = new Set((request + " " + draft).toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
  const unique = [...new Map(packets.map(packet => [packet.source + "\n" + packet.passage, packet])).values()];
  const ranked = unique.map((packet, index) => {
    const terms = new Set(packet.passage.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? []);
    const overlap = [...terms].filter(term => words.has(term)).length;
    return { packet, index, score: overlap / Math.sqrt(Math.max(1, terms.size)) + (packet.query ? 1 : 0) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const sources = new Set<string>();
  const leaders = ranked.filter(value => { if (sources.has(value.packet.source)) return false; sources.add(value.packet.source); return true; });
  const selected: ResearchPacket[] = [], included = new Set<number>();
  let chars = 2;
  for (const value of [...leaders, ...ranked]) {
    if (included.has(value.index)) continue;
    const size = JSON.stringify(value.packet).length + 1;
    if (chars + size > maxChars) continue;
    chars += size; included.add(value.index); selected.push(value.packet);
  }
  return selected;
}
