/**
 * Fitting a tool result into a budget without destroying it.
 *
 * Cutting a serialized payload at a character count leaves the model invalid
 * JSON ending mid-token. Observed with `list_commits`: 12,063 characters cut at
 * 12,000, so the model received a broken document and reported "I can only see
 * one commit" — accurate about what survived, useless as an answer.
 *
 * Most oversized results are a list of similar things. Keeping whole items and
 * saying how many were dropped preserves both validity and the fact that more
 * exists, which is what the model needs to be honest about coverage.
 */

export interface TruncationResult {
  text: string;
  truncated: boolean;
  /** Items kept, when the payload was a list. */
  keptItems?: number;
  /** Items dropped, when the payload was a list. */
  droppedItems?: number;
}

const NOTICE = (detail: string): string =>
  `\n\n[TRUNCATED: ${detail}. This result is INCOMPLETE — say so explicitly and do not present it as the full set.]`;

/**
 * Finds the largest array in a payload — the part worth trimming. A connector
 * usually wraps its list in an envelope (`{ value: [...] }`, `{ issues: [...] }`),
 * so the array is rarely at the root.
 */
const findLargestArray = (
  value: unknown,
  depth = 0,
): { parent: Record<string, unknown> | undefined; key?: string; items: unknown[] } | undefined => {
  if (depth > 4) return undefined;
  if (Array.isArray(value)) return { parent: undefined, items: value };
  if (!value || typeof value !== "object") return undefined;

  let best: { parent: Record<string, unknown>; key: string; items: unknown[] } | undefined;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(entry)) {
      if (!best || entry.length > best.items.length) {
        best = { parent: value as Record<string, unknown>, key, items: entry };
      }
      continue;
    }
    const nested = findLargestArray(entry, depth + 1);
    if (nested?.parent && (!best || nested.items.length > best.items.length)) {
      best = { parent: nested.parent, key: nested.key as string, items: nested.items };
    }
  }
  return best;
};

/**
 * Trims a tool result to `limit` characters.
 *
 * When the payload holds a list, drops whole items from the end until it fits,
 * so the result stays parseable. Otherwise falls back to a character cut, which
 * is still better than silence for prose.
 */
export const truncateToolResult = (
  raw: unknown,
  serialized: string,
  limit: number,
): TruncationResult => {
  if (serialized.length <= limit) {
    return { text: serialized, truncated: false };
  }

  const found = findLargestArray(raw);
  if (found && found.items.length > 1) {
    const total = found.items.length;
    // Binary search the largest prefix that fits, rather than dropping one at a
    // time — a 500-item result would otherwise re-serialize 500 times.
    let low = 1;
    let high = total;
    let bestFit = 1;
    let bestText = "";

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const kept = found.items.slice(0, mid);
      const candidate = found.parent
        ? { ...found.parent, [found.key as string]: kept }
        : kept;
      const text = JSON.stringify(candidate, null, 2);
      if (text.length <= limit) {
        bestFit = mid;
        bestText = text;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (bestText) {
      const dropped = total - bestFit;
      return {
        text: `${bestText}${NOTICE(`showing ${bestFit} of ${total} items; ${dropped} omitted`)}`,
        truncated: true,
        keptItems: bestFit,
        droppedItems: dropped,
      };
    }
  }

  return {
    text: `${serialized.slice(0, limit)}${NOTICE(`${serialized.length - limit} more characters were cut`)}`,
    truncated: true,
  };
};
