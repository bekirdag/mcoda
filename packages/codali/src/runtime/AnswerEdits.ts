/** Audits that return edits instead of a rewritten answer. A rewrite has to
 * reproduce the whole answer to change one sentence, and in cycle 7 that went
 * wrong both ways: a research rewrite came back at half the length, cut off
 * inside a link, and replaced the complete answer; a design rewrite that fixed
 * a figure was discarded only because it was longer. An edit names the text it
 * replaces, so the rest of the answer cannot be lost, each edit can be judged
 * and refused on its own, and the length of the reply does not matter. */
export interface AnswerEdit { find: string; replace: string; reason?: string; }
export interface AppliedEdits { text: string; applied: AnswerEdit[]; skipped: Array<{ edit: AnswerEdit; reason: string }>; }

export const EDIT_FORMAT_RULE = `Return only JSON: {"edits":[{"find":"...","replace":"...","reason":"..."}]}. Each "find" is a passage copied character for character from the draft, long enough to occur only once (a sentence, a table row or a heading line), and an edit never changes a link address or inline code unless that is the defect, in which case its find includes the whole link; "replace" is the text that goes in its place, in the draft's own format; "reason" names the defect in a few words. Correct every place a changed value or claim is used, each with its own edit. To add text, find the sentence or line it follows and replace it with that line plus the addition. To delete text, replace it with "". Do not edit passages that are correct and do not restate the draft. Return {"edits":[]} when there is no demonstrable defect.`;

/** The edits in an audit reply, or undefined when the reply is not an edit list
 * (then it is read as a full rewritten answer). */
export function parseAnswerEdits(text: string): AnswerEdit[] | undefined {
  const body = text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  if (!/^\{\s*"edits"\s*:/u.test(body)) return undefined;
  let data: unknown;
  try { data = JSON.parse(body); } catch { return undefined; }
  const list = data && typeof data === "object" ? (data as { edits?: unknown }).edits : undefined;
  if (!Array.isArray(list)) return undefined;
  return list.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const { find, replace, reason } = item as Record<string, unknown>;
    if (typeof find !== "string" || !find.trim() || typeof replace !== "string" || find === replace) return [];
    return [{ find, replace, ...(typeof reason === "string" ? { reason: reason.slice(0, 300) } : {}) }];
  }).slice(0, 200);
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** The same passage with any run of whitespace matching any other run: models
 * often copy a passage with a line break turned into a space. */
const loosePattern = (find: string): RegExp => new RegExp(find.trim().split(/\s+/u).map(escape).join("\\s+"), "gu");

/** Spans an edit may not touch: link targets, bare URLs and inline code. A
 * figure edit (v2024 -> v2025) that also rewrote a link's address broke the link. */
const maskedSpans = (text: string): Array<[number, number]> => {
  const spans: Array<[number, number]> = [];
  for (const pattern of [/\]\([^)\s]*\)/gu, /https?:\/\/[^\s<>()\[\]"'`\\]+/gu, /`[^`\n]+`/gu]) {
    for (const match of text.matchAll(pattern)) spans.push([match.index!, match.index! + match[0].length]);
  }
  return spans;
};
const occurrences = (text: string, find: string): Array<[number, number]> => {
  const found: Array<[number, number]> = [];
  for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) found.push([at, at + find.length]);
  if (found.length) return found;
  return [...text.matchAll(loosePattern(find))].map(match => [match.index!, match.index! + match[0].length] as [number, number]);
};
const headingLines = (text: string): string[] => text.match(/^ {0,3}(?:#{1,6}[ \t]+\S.*|\*\*[^*\n]{2,120}\*\*:?[ \t]*)$/gmu) ?? [];
/** A heading's kind: its level ("#", "##", ...) or "bold" for a bold-only line. */
const headingKind = (line: string): string => /^\s*(#{1,6})[ \t]/u.exec(line)?.[1] ?? "bold";

/** Why one edit must not apply as a deletion: it removes a section heading, or
 * most of the answer. Other large deletions are judged edit by edit and stand.
 * A heading counts as removed only when the replacement has fewer headings of
 * its kind than the passage it replaces: renaming a heading or correcting a
 * figure in it ("**Total cost: $243**" to "$324") is an ordinary edit. */
const deletionDefect = (edit: AnswerEdit, text: string, allowShrink: boolean): string | undefined => {
  const before = headingLines(edit.find), after = headingLines(edit.replace);
  const lines = (value: string) => value.split("\n").filter(line => line.trim()).length;
  for (const kind of new Set(before.map(headingKind))) {
    const lost = before.filter(line => headingKind(line) === kind).length - after.filter(line => headingKind(line) === kind).length;
    // A bold line is lost only when the line itself goes, not when it is reworded or unbolded.
    if (lost > 0 && (kind !== "bold" || lines(edit.find) - lines(edit.replace) >= lost)) return "removes_section";
  }
  if (!allowShrink && edit.find.length - edit.replace.length > text.length * 0.5) return "removes_most_of_answer";
  return undefined;
};

/** Apply edits in order. An edit is placed only where its passage occurs
 * exactly once outside link targets, URLs and inline code; otherwise it is
 * skipped (not_found, inside_link_or_code, ambiguous). `refuse` may veto an
 * edit with a reason. `allowShrink` admits an edit that removes most of the
 * answer, for a request with an explicit length limit. */
export function applyAnswerEdits(draft: string, edits: AnswerEdit[], refuse?: (edit: AnswerEdit, text: string) => string | undefined, allowShrink = false): AppliedEdits {
  let text = draft;
  const applied: AnswerEdit[] = [], skipped: AppliedEdits["skipped"] = [];
  for (const edit of edits) {
    const vetoed = refuse?.(edit, text) ?? deletionDefect(edit, text, allowShrink);
    if (vetoed) { skipped.push({ edit, reason: vetoed }); continue; }
    const masked = maskedSpans(text);
    const all = occurrences(text, edit.find);
    const free = all.filter(([start, end]) => !masked.some(([from, to]) => start < to && end > from && !(start <= from && end >= to)));
    if (!all.length) { skipped.push({ edit, reason: "not_found" }); continue; }
    if (!free.length) { skipped.push({ edit, reason: "inside_link_or_code" }); continue; }
    // The same passage in several places is not a place: "243" could be any of them.
    if (free.length > 1) { skipped.push({ edit, reason: "ambiguous" }); continue; }
    const [[start, end]] = free;
    text = text.slice(0, start) + edit.replace + text.slice(end);
    applied.push(edit);
  }
  return { text, applied, skipped };
}

const headings = (text: string): number => (text.match(/^ {0,3}(?:#{1,6}[ \t]+\S.*|\*\*[^*\n]{2,120}\*\*:?[ \t]*)$/gmu) ?? []).length;
const distinctLinks = (text: string): Set<string> => new Set((text.match(/https?:\/\/[^\s<>()\[\]"'`\\]+/gu) ?? []).map(url => url.replace(/[.,;:!?*]+$/u, "").replace(/\/+$/u, "")));

/** An answer that stops inside markup: an open link, bracket or code span on
 * its last line. Seen in cycle 7 at 4,044 output tokens, a count no cap check
 * would flag, with the server reporting a normal finish. */
export const endsInsideMarkup = (text: string): boolean => {
  const last = text.trimEnd().split("\n").pop() ?? "";
  if (/\]\([^)\s]*$/u.test(last)) return true;
  const opened = (last.match(/\[/gu) ?? []).length, closed = (last.match(/\]/gu) ?? []).length;
  if (opened > closed) return true;
  return (last.match(/`/gu) ?? []).length % 2 === 1;
};

/** What a revised answer lost of the draft's structure, if it lost much: most
 * of its section headings, or most of its distinct links (only the links
 * `countLink` accepts, so removing links that were never retrieved is not a loss). */
export const structureLoss = (draft: string, revised: string, countLink: (url: string) => boolean = () => true): "lost_sections" | "lost_links" | undefined => {
  const before = headings(draft), after = headings(revised);
  if (before >= 3 && after < Math.ceil(before * 0.75)) return "lost_sections";
  const links = new Set([...distinctLinks(draft)].filter(countLink));
  if (links.size >= 4) {
    const kept = distinctLinks(revised);
    if ([...links].filter(link => kept.has(link)).length * 2 < links.size) return "lost_links";
  }
  return undefined;
};
