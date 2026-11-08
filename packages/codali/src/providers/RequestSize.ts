import type { ProviderRequest } from "./ProviderTypes.js";

/** Image bytes are not text tokens. Reserve conservatively for bounded screenshots;
 * actual server tokenization and receipts remain authoritative. */
export function estimateProviderInputTokens(request: Pick<ProviderRequest, "messages" | "tools" | "responseFormat">): number {
  let imageTokens = 0;
  const messages = request.messages.map(({ images, ...message }) => {
    imageTokens += (images?.length ?? 0) * 8192;
    return message;
  });
  return Math.ceil(JSON.stringify({ messages, tools: request.tools, responseFormat: request.responseFormat }).length / 3) + imageTokens;
}
