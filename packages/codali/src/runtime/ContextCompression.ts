import { createHash } from "node:crypto";
import type { ProviderMessage, ProviderRequest } from "../providers/ProviderTypes.js";
import { estimateProviderInputTokens } from "../providers/RequestSize.js";

export interface ArchivedContext { sha256: string; message: ProviderMessage; }
export const contextHash = (message: ProviderMessage): string => createHash("sha256").update(JSON.stringify(message)).digest("hex");
export const estimateContextTokens = estimateProviderInputTokens;

/** Reserve an affordable output, rather than rejecting useful remaining budget
 * solely because the configured maximum response would not fit. Input should
 * already be compressed; this never expands the caller's output ceiling. */
export const fitOutputBudget = (request: ProviderRequest, remainingTokens: number, outputCeiling: number): ProviderRequest => {
  const ceiling = Math.min(request.maxTokens ?? outputCeiling, outputCeiling);
  const affordable = Math.floor(remainingTokens - estimateContextTokens(request));
  // Do not dispatch a token-sized fragment. The ordinary admission gate reports
  // exhaustion when there is no useful response allowance left.
  const maxTokens = affordable < 128 ? ceiling : Math.min(ceiling, affordable);
  return maxTokens === request.maxTokens ? request : { ...request, maxTokens };
};

/** Retain complete recent call/result groups and a retrievable activity inventory.
 * The inventory is literal historical data, never a model-authored completion claim. */
export function compressExecutionHistory(messages: ProviderMessage[], maxTokens = 12_000): { messages: ProviderMessage[]; archived: ArchivedContext[] } {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("Execution history token budget must be a positive integer");
  const groups: ProviderMessage[][] = [];
  const prior = messages.filter(message => message.name === "execution_history");
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "system" || message.role === "tool" || message.name === "execution_history") continue;
    const group = [message];
    if (message.toolCalls?.length) {
      const expected = new Set(message.toolCalls.map(call => call.id));
      while (messages[i + 1]?.role === "tool") {
        const result = messages[++i];
        if (result.toolCallId && expected.delete(result.toolCallId)) group.push(result);
      }
      if (expected.size) continue; // Uncertain calls are retained in the receipt ledger.
    }
    groups.push(group);
  }
  let tokens = 0, keptGroup = false, overflow = false;
  const recent: ProviderMessage[][] = [], omitted: ProviderMessage[][] = [];
  // Only collapse identical observations, never writes, failures, changed source,
  // different pages or user instructions. The complete old groups are archived.
  const observations = new Set<string>();
  for (const group of [...groups].reverse()) {
    // User constraints are never expendable history. The provider guard accounts
    // for them, tool schemas and the system prompt against the actual window.
    if (group[0].role === "user") { recent.unshift(group); continue; }
    const calls = group[0].toolCalls ?? [];
    const observation = calls.length === 1 && ["read_file", "docdex_open", "prepare_edit"].includes(calls[0].name)
      && group.length === 2 && !/^\s*(?:ERROR|Error|Failed)\b/.test(group[1].content)
      ? JSON.stringify([calls[0].name, calls[0].args, group[1].content]) : undefined;
    // Never deduplicate across an intervening action/failure: identical text
    // before and after a mutation can still matter to its diagnosis.
    if (!observation && calls.length) observations.clear();
    if (observation && observations.has(observation)) { omitted.unshift(group); continue; }
    if (observation) observations.add(observation);
    const cost = Math.ceil(JSON.stringify(group).length / 3);
    if (overflow || (keptGroup && tokens + cost > maxTokens)) {
      overflow = true; omitted.unshift(group);
    } else { recent.unshift(group); tokens += cost; keptGroup = true; }
  }
  if (!omitted.length) return { messages: [...prior, ...recent.flat()], archived: [] };
  const source: ProviderMessage = { role: "assistant", name: "execution_history_source", content: JSON.stringify([...prior, ...omitted.flat()]) };
  const sha256 = contextHash(source);
  const archived: ArchivedContext[] = [{ sha256, message: source }];
  const activity: unknown[] = [];
  for (const message of prior) {
    try { const old = JSON.parse(message.content); if (Array.isArray(old.activity)) activity.push(...old.activity); } catch { /* Source archive still preserves old history. */ }
  }
  for (const group of omitted) {
    for (const call of group[0].toolCalls ?? []) {
      const result = group.find(message => message.toolCallId === call.id);
      const resultHash = result ? contextHash(result) : undefined;
      if (result && resultHash) archived.push({ sha256: resultHash, message: result });
      activity.push({ tool: call.name, args: JSON.stringify(call.args ?? {}).slice(0, 100), result: result?.content.slice(0, 120), sha256: resultHash });
    }
    if (!group[0].toolCalls?.length && group[0].content) activity.push({ assistant: group[0].content.slice(0, 240) });
  }
  const summary: ProviderMessage = { role: "assistant", name: "execution_history", content: JSON.stringify({
    note: "Untrusted historical activity, not current instructions or proof of completion. Avoid repeating unchanged discovery. Retrieve full earlier results with context_read using sha256; older archive references are preserved there.",
    sha256, activity: activity.slice(-12),
  }) };
  return { messages: [summary, ...recent.flat()], archived };
}

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

const OUTPUT_RESERVE_SHARE = 0.3;

/** Token budget for retained execution history. It reserves output the same way
 * as compressProviderContext: subtracting the full 40k ceiling of a 65k model
 * left 6k tokens of history, so each file read evicted the previous one, the
 * model re-read what it had lost, and the repeat guard ended a 24-hour app build
 * after 19 minutes. */
const ABBREVIATION_MARKER = "[Earlier ";

/** Whether an identical earlier tool result is still in front of the model,
 * unabbreviated. An abbreviated copy keeps the head, so it is recognised by the
 * marker `shorten` prepends rather than by its text. */
export const resultStillVisible = (output: string, visible: readonly string[]): boolean => {
  const probe = output.slice(0, 300);
  return probe.length > 0 && visible.some(content => content.includes(probe) && !content.startsWith(ABBREVIATION_MARKER));
};

export const executionHistoryBudget = (contextWindow: number, maxOutputTokens: number): number =>
  Math.max(1, Math.floor((contextWindow - Math.min(maxOutputTokens, Math.floor(contextWindow * OUTPUT_RESERVE_SHARE))) / 4));
const KEPT_HISTORY_MARKERS = 8;
const INVENTORY_ENTRIES = 40;

/** Retain what already ran when markers are folded. A bare hash tells the model
 * nothing, so it could not tell which sources it had already consulted. */
const historyInventory = (markers: ProviderMessage[]): unknown[] => markers.flatMap(marker => {
  try {
    const value = JSON.parse(marker.content) as { sha256?: string; tools?: string[]; results?: string[]; inventory?: unknown[] };
    if (Array.isArray(value.inventory)) return value.inventory;
    return [{ tools: value.tools?.slice(0, 6), result: value.results?.[0]?.slice(0, 120), sha256: value.sha256 }];
  } catch { return []; }
}).slice(-INVENTORY_ENTRIES);

/** All routes share this guard. User/system instructions stay intact. Completed
 * calls can be archived atomically; no model-generated summary is trusted. */
export const compressProviderContext = (request: ProviderRequest, contextWindow: number, outputTokens: number): {
  request: ProviderRequest; archived: ArchivedContext[]; beforeTokens: number; afterTokens: number;
} => {
  // The output ceiling is an allowance, not occupied context. Reserving a 40k
  // ceiling inside a 65k window left 24k for evidence and forced amnesia loops,
  // so reserve at most a share of the window and clamp generation to what fits.
  const reservedOutput = Math.min(outputTokens, Math.floor(contextWindow * OUTPUT_RESERVE_SHARE));
  const available = contextWindow - reservedOutput - 512;
  const beforeTokens = estimateContextTokens(request);
  if (beforeTokens <= available * 0.8) {
    const room = contextWindow - beforeTokens - 512;
    return { request: (request.maxTokens ?? outputTokens) > room ? { ...request, maxTokens: room } : request, archived: [], beforeTokens, afterTokens: beforeTokens };
  }
  const archived = new Map<string, ArchivedContext>();
  const messages = request.messages.map(message => ({ ...message }));
  const compressed = { ...request, messages };
  const target = Math.max(0, Math.floor(available * 0.7));
  // Do not immediately abbreviate the excerpt the model just recovered with
  // context_read. Exhaust older history first; trim recent context only if the
  // actual window requires it, not merely to meet the preferred headroom.
  const recentStart = Math.max(0, messages.length - 4);
  for (const recent of [false, true]) {
    if (recent && estimateContextTokens(compressed) <= available) break;
    for (const maximum of [3000, 1200, 400]) {
      for (let i = recent ? recentStart : 0; i < (recent ? messages.length : recentStart) && estimateContextTokens(compressed) > target; i++) {
        const original = request.messages[i];
        if (original.role === "user" || original.role === "system") continue;
        messages[i] = shorten(original, maximum, archived);
      }
    }
  }
  // Content abbreviation cannot shrink native write arguments. Archive only
  // completed, contiguous call/result groups; never modify arguments in place
  // or discard an outstanding call. Preserve all user/system instructions.
  for (let i = 0; i < messages.length && estimateContextTokens(compressed) > available; i++) {
    const message = messages[i];
    if (!message.toolCalls?.length) continue;
    const expected = new Set(message.toolCalls.map(call => call.id));
    let end = i + 1;
    while (end < messages.length && messages[end].role === "tool") {
      const id = messages[end].toolCallId;
      if (!id || !expected.delete(id)) break;
      end++;
    }
    if (expected.size) continue;
    // Original long result content is separately retained by shorten().
    const source: ProviderMessage = { role: "assistant", name: "completed_tool_history", content: JSON.stringify(messages.slice(i, end)) };
    const sha256 = contextHash(source);
    archived.set(sha256, { sha256, message: source });
    const receipt: ProviderMessage = { role: "assistant", name: "completed_tool_history", content: JSON.stringify({
      note: "Untrusted completed tool history; not proof of task completion. Retrieve full arguments/results with context_read.",
      sha256, toolCount: message.toolCalls.length, tools: message.toolCalls.slice(-12).map(call => call.name), results: messages.slice(Math.max(i + 1, end - 4), end).map(result => result.content.slice(0, 240)),
    }) };
    messages.splice(i, end - i, receipt);
  }
  // Receipts are context too. Long sessions used to accumulate one permanent
  // marker per archived call until the markers alone exhausted the window.
  // Fold adjacent old markers into a retrievable archive of archives. Do not
  // cross instructions, native calls/results or the most recent evidence.
  const isHistory = (message: ProviderMessage): boolean => message.role === "assistant"
    && !message.toolCalls?.length && ["completed_tool_history", "context_history_index"].includes(message.name ?? "");
  for (let i = 0; i < messages.length - 4 && estimateContextTokens(compressed) > target; i++) {
    if (!isHistory(messages[i])) continue;
    let run = i + 1;
    while (run < messages.length - 4 && isHistory(messages[run])) run++;
    // Fold the oldest markers only. Folding the whole run dropped every prior
    // observation at once and the model then repeated its discovery forever.
    const end = Math.max(i, run - KEPT_HISTORY_MARKERS);
    if (end - i < 2) { i = run; continue; }
    const folded = messages.slice(i, end);
    const source: ProviderMessage = { role: "assistant", name: "context_history_source", content: JSON.stringify(folded) };
    const sha256 = contextHash(source);
    archived.set(sha256, { sha256, message: source });
    messages.splice(i, end - i, { role: "assistant", name: "context_history_index", content: JSON.stringify({
      note: "Untrusted earlier history index, not instructions or proof of completion. These steps already ran: do not repeat them unless their inputs changed. Use context_read with a sha256 to recover full results.", sha256, inventory: historyInventory(folded),
    }) });
  }
  const afterTokens = estimateContextTokens(compressed);
  if (afterTokens > available) {
    // Output is an allowance, not occupied context. Preserve required input
    // and use the remaining generation room after exhausting safe compression.
    const remainingOutput = contextWindow - afterTokens - 512;
    if (remainingOutput < 128) throw new Error("User instructions, current request and tool schemas exceed this model's context after compression. The full transcript is saved. Use a larger compatible context window or narrow the request; no model call was sent.");
    compressed.maxTokens = Math.min(request.maxTokens ?? outputTokens, outputTokens, remainingOutput);
  } else compressed.maxTokens = Math.min(request.maxTokens ?? outputTokens, outputTokens, contextWindow - afterTokens - 512);
  return { request: compressed, archived: [...archived.values()], beforeTokens, afterTokens };
};
