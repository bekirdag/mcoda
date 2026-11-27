import { createHash } from "node:crypto";
import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

export interface AdesToolOptions { baseUrl?: string; timeoutMs?: number; }
export const createAdesTool = (options: AdesToolOptions = {}): ToolDefinition => ({
  name: "extract_entities", capability: "entity_hints", readOnly: true,
  description: "Local ADES deterministic entity/alias extraction. Returns confidence, canonical IDs and provenance as optional retrieval hints, not facts. Preserve the original query; empty results do not establish absence. No LLM refinement or graph expansion.",
  inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 8000 }, pack: { type: "string", pattern: "^[a-z][a-z0-9-]{0,79}$", maxLength: 80 } }, required: ["text"], additionalProperties: false },
  handler: async (raw, context) => {
    const args = raw as { text: string; pack?: string };
    if (typeof args.text !== "string" || !args.text.length || args.text.length > 8000 || (args.pack !== undefined && !/^[a-z][a-z0-9-]{0,79}$/.test(args.pack))) throw new ToolExecutionError("tool_invalid_args", "Provide bounded text and a valid pack name");
    const base = new URL(options.baseUrl ?? process.env.CODALI_ADES_URL ?? "http://127.0.0.1:8734");
    if (!["http:", "https:"].includes(base.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname) || base.username || base.password) throw new ToolExecutionError("tool_permission_denied", "The built-in entity tool accepts only a local ADES service");
    const signal = AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 2500)]);
    signal.throwIfAborted();
    const started = Date.now();
    const request = { text: args.text, pack: args.pack ?? "general-en", content_type: "text/plain", options: {
      hybrid: false, include_related_entities: false, include_graph_support: false, refine_links: false, include_impact_paths: false,
    } };
    const response = await fetch(new URL("/v0/tag", base), { method: "POST", redirect: "error", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    if (!response.ok) { await response.body?.cancel(); throw new ToolExecutionError("tool_execution_failed", `Local ADES returned HTTP ${response.status}`, { retryable: false }); }
    if (!response.body) throw new ToolExecutionError("tool_execution_failed", "Empty ADES response");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 256000) throw new ToolExecutionError("tool_execution_failed", "ADES response exceeds the limit"); chunks.push(next.value); } }
    finally { await reader.cancel(); }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(result.entities) || result.refinement_applied === true) throw new ToolExecutionError("tool_execution_failed", "ADES did not return a deterministic extraction result");
    const bounded = (value: unknown, max = 160) => typeof value === "string" ? value.slice(0, max) : undefined;
    const entities = result.entities.slice(0, 64).map((entity: Record<string, any>) => ({
      text: bounded(entity.text), label: bounded(entity.label, 80), confidence: typeof entity.confidence === "number" && Number.isFinite(entity.confidence) ? entity.confidence : null,
      start: Number.isSafeInteger(entity.start) ? entity.start : null, end: Number.isSafeInteger(entity.end) ? entity.end : null,
      canonical: bounded(entity.link?.canonical_text), id: bounded(entity.link?.entity_id), aliases: Array.isArray(entity.aliases) ? entity.aliases.slice(0, 8).map((alias: unknown) => bounded(alias)) : [],
      provenance: { lane: bounded(entity.provenance?.lane), pack: bounded(entity.provenance?.source_pack), weakAlias: entity.provenance?.weak_alias ?? null, match: bounded(entity.provenance?.match_kind) },
    }));
    const data = { library: "adestool", version: bounded(result.version), pack: bounded(result.pack), packVersion: bounded(result.pack_version),
      inputSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"), elapsedMs: Date.now() - started, entities,
      truncated: result.entities.length > 64, scope: "Optional entity hints; ambiguous or missed matches are possible. Keep the original query and verify facts with Docdex/source evidence." };
    return { output: JSON.stringify(data), data };
  },
});
