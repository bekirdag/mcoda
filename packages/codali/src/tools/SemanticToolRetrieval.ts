import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { atomicWriteJson, withStateLock } from "../session/AtomicState.js";
import type { ConfiguredEmbeddings } from "../providers/ConfiguredEmbeddings.js";
import type { ToolDefinition } from "./ToolTypes.js";
import { retrieveTools } from "./ToolRetrieval.js";

export interface ToolRetrievalEvidence { method: "semantic-metadata-v1"; catalogHash: string; spaceId: string; cacheHit: boolean; documents: number; elapsedMs: number; }
const cosine = (a: number[], b: number[]) => {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
};

/** Cache only public tool metadata vectors, keyed by pinned model and content. */
export async function retrieveSemanticTools(query: string, tools: readonly ToolDefinition[], embeddings: ConfiguredEmbeddings, cacheRoot: string,
  signal?: AbortSignal, limit = 3): Promise<{ ranked: Array<{ tool: ToolDefinition; score: number }>; evidence: ToolRetrievalEvidence }> {
  const started = Date.now();
  const ordered = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const documents = ordered.map(tool => `${tool.name.replace(/_/g, " ")}: ${tool.description.slice(0, 700)}`);
  const catalogHash = createHash("sha256").update(JSON.stringify(documents)).digest("hex");
  const file = path.join(cacheRoot, embeddings.space.id, `${catalogHash}.json`);
  const valid = (value: unknown): value is number[][] => Array.isArray(value) && value.length === tools.length
    && value.every(row => Array.isArray(row) && row.length === embeddings.space.dimensions && row.every(v => typeof v === "number" && Number.isFinite(v)));
  let cacheHit = false;
  const vectors = await withStateLock(file, async () => {
    try {
      const cached = JSON.parse(await fs.readFile(file, "utf8"));
      if (cached.catalogHash === catalogHash && cached.spaceId === embeddings.space.id && valid(cached.vectors)) { cacheHit = true; return cached.vectors as number[][]; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    const result: number[][] = [];
    // Small batches fit the service's bounded input contract; every call is metered.
    for (let start = 0; start < documents.length; start += 64) result.push(...await embeddings.embed(documents.slice(start, start + 64), "document", signal));
    if (!valid(result)) throw Error("Invalid tool metadata embeddings");
    await atomicWriteJson(file, { schemaVersion: 1, catalogHash, spaceId: embeddings.space.id, createdAt: new Date().toISOString(), names: ordered.map(tool => tool.name), vectors: result });
    return result;
  });
  const [wanted] = await embeddings.embed([query.slice(0, 4000)], "query", signal);
  const lexical = new Map(retrieveTools(query, tools, 8).map(item => [item.tool.name, item.score]));
  const maxLexical = Math.max(1, ...lexical.values());
  const ranked = ordered.map((tool, i) => ({ tool, score: cosine(wanted, vectors[i]) + .03 * (lexical.get(tool.name) ?? 0) / maxLexical }))
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0, Math.max(1, Math.min(8, limit)));
  return { ranked, evidence: { method: "semantic-metadata-v1", catalogHash, spaceId: embeddings.space.id, cacheHit, documents: tools.length, elapsedMs: Date.now() - started } };
}
