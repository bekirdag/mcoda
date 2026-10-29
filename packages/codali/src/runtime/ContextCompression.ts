import { createHash } from "node:crypto";
import type { ProviderMessage, ProviderRequest } from "../providers/ProviderTypes.js";

export interface ArchivedContext { sha256: string; message: ProviderMessage; }
export const contextHash = (message: ProviderMessage): string => createHash("sha256").update(JSON.stringify(message)).digest("hex");
export const estimateContextTokens = (request: Pick<ProviderRequest, "messages" | "tools" | "responseFormat">): number =>
  Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools, responseFormat: request.responseFormat }).length / 3);

const shorten = (message: ProviderMessage, maxChars: number, archive: Map<string, ArchivedContext>): ProviderMessage => {
  if (message.content.length <= maxChars) return message;
  const sha256 = contextHash(message);
  const marker = `[Earlier ${message.role} content abbreviated. Full saved source: ${sha256}; use context_read if details matter. Omitted text is not evidence of absence.]\n`;
  const remaining = Math.max(0, maxChars - marker.length - 12), head = Math.ceil(remaining * 0.65), tail = remaining - head;
  archive.set(sha256, { sha256, message: structuredClone(message) });
  return { ...message, content: marker + message.content.slice(0, head) + "\n[…]\n" + (tail ? message.content.slice(-tail) : "") };
};

/** Keep every user statement verbatim. Older assistant prose is expendable context,
 * not authority; its full source remains retrievable from the private transcript. */
export const compressConversation = (messages: ProviderMessage[], targetChars: number): { messages: ProviderMessage[]; archived: ArchivedContext[] } => {
  const original = messages.filter(message => message.role === "user" || message.role === "assistant");
  const result = original.map(message => ({ ...message }));
  const archived = new Map<string, ArchivedContext>();
  const size = () => result.reduce((sum, message) => sum + message.content.length, 0);
  for (const maximum of [1600, 600, 320]) {
    for (let i = 0; i < result.length && size() > targetChars; i++) {
      if (result[i].role !== "assistant") continue;
      // Always shorten from the original, never summarize a previous summary.
      result[i] = shorten(original[i], maximum, archived);
    }
  }
  return { messages: result, archived: [...archived.values()] };
};

/** All routes share this context guard. User/system messages, native call arguments
 * and call/result identities remain intact; no model-generated summary is trusted. */
export const compressProviderContext = (request: ProviderRequest, contextWindow: number, outputTokens: number): {
  request: ProviderRequest; archived: ArchivedContext[]; beforeTokens: number; afterTokens: number;
} => {
  const available = contextWindow - outputTokens - 512;
  const beforeTokens = estimateContextTokens(request);
  if (beforeTokens <= available * 0.8) return { request, archived: [], beforeTokens, afterTokens: beforeTokens };
  const archived = new Map<string, ArchivedContext>();
  const messages = request.messages.map(message => ({ ...message }));
  const compressed = { ...request, messages };
  const target = Math.max(0, Math.floor(available * 0.7));
  for (const maximum of [3000, 1200, 400]) {
    for (let i = 0; i < messages.length && estimateContextTokens(compressed) > target; i++) {
      const original = request.messages[i];
      if (original.role === "user" || original.role === "system") continue;
      messages[i] = shorten(original, maximum, archived);
    }
  }
  const afterTokens = estimateContextTokens(compressed);
  if (afterTokens > available) throw new Error("User instructions, current request and tool schemas exceed this model's context after compression. The full transcript is saved. Use a larger compatible context window or narrow the request; no model call was sent.");
  return { request: compressed, archived: [...archived.values()], beforeTokens, afterTokens };
};
