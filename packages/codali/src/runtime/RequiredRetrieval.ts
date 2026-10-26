import type { Provider } from "../providers/ProviderTypes.js";

export type RequiredRetrievalNeed =
  | { type: "docdex.search"; query: string; limit: number }
  | { type: "docdex.web"; query: string; force_web: true };

/** Deterministic retrieval through the ordinary authorized tool loop; makes no model call. */
export function requiredRetrievalProvider(needs: readonly RequiredRetrievalNeed[], requestId: string): Provider {
  if (!Array.isArray(needs) || !needs.length || needs.length > 32) throw new Error("Required retrieval needs must contain 1–32 entries");
  for (const need of needs) {
    if (!need || typeof need.query !== "string" || !need.query.trim() || need.query.length > 16000
      || (need.type !== "docdex.search" && need.type !== "docdex.web")
      || (need.type === "docdex.search" && (!Number.isSafeInteger(need.limit) || need.limit < 1 || need.limit > 100))
      || (need.type === "docdex.web" && need.force_web !== true)) throw new Error("Invalid required retrieval need");
  }
  const pinned = structuredClone(needs);
  let requested = false;
  return { name: "required-retrieval", async generate(request) {
    request.signal?.throwIfAborted();
    if (!requested) {
      requested = true;
      return { message: { role: "assistant", content: JSON.stringify({ version: "v1", role: "rag_worker", request_id: requestId, needs: pinned }) } };
    }
    const response = [...request.messages].reverse().find(message => message.role === "user" && message.content.startsWith("CODALI_RESPONSE v1"));
    if (!response) throw new Error("Required retrieval response missing");
    return { message: { role: "assistant", content: response.content.replace(/^CODALI_RESPONSE v1\s*/, "") } };
  } };
}
