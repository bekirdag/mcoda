/** Which numbers in an answer rest on results that were actually executed.
 *
 * Cycle 7 lost three numeric answers (0, 60 and 80 points) whose values were in
 * no tool result at all, or came from a later, simplified rerun that disagreed
 * with an earlier full one; and an equation review with no tools changed a value
 * that executed code had printed. Both the delivery check and the review guard
 * decide here by evidence: a value is backed when an executed result shows it at
 * the precision the answer states it, allowing the usual derivations (rounding,
 * percent and common unit factors, sign). Matching is deliberately lenient: a
 * missed match costs one reconcile turn, a false match only keeps old behaviour. */

export type EvidenceKind = "code" | "calculation";
/** One successful execution: a program's printed or returned output (code) or a calculator/solver receipt (calculation). */
export interface ExecutedResult { seq: number; tool: string; kind: EvidenceKind; text: string; }
export interface AnswerValue { path: string; key?: string; token: string; value: number; /** A unit stated with the value (%, ms, min, h, s, d), which permits unit factors for whole numbers. */ unit?: string; }
export interface Backing { kind: EvidenceKind | "input"; seq?: number; tool?: string; }
export interface ReceiptConflict { key: string; drafted: string; runs: Array<{ seq: number; tool: string; value: number }>; latestDisagrees: boolean; }

const NUMBER_SOURCE = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?`;
const NUMBER = new RegExp(NUMBER_SOURCE, "g");
const FRACTION = /(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g;
const MAX_TEXT = 20_000;

export const normalizedKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Decimal places a token states; "2.8910" states four, "2" none. */
const decimals = (token: string): number => {
  const [mantissa, exponent] = token.toLowerCase().replace(/^-/, "").split("e");
  return Math.max(0, (mantissa.split(".")[1] ?? "").length - Number(exponent ?? 0));
};
const tolerance = (token: string, value: number): number => 0.5 * 10 ** -decimals(token) * (1 + 1e-9) + 1e-12 * Math.max(1, Math.abs(value));

/** Factors that turn one correct figure into another correct one: percent, milli/kilo, minutes/hours/days. */
const DERIVATIONS = [1, 100, 0.01, 1000, 0.001, 60, 1 / 60, 3600, 1 / 3600, 24, 1 / 24];
/** A whole-number token, or a strict check, matches only the value itself: with
 * unit factors almost any small integer matches something by chance (25 by 0.25,
 * 6 by 0.1 minutes), and a chance match must never count as support. */
const matches = (token: string, value: number, candidate: number, strict = false, unit?: string): boolean => {
  const allowed = tolerance(token, value);
  // A whole number with its unit stated ("25%", "120 minutes") is a conversion, not a chance match.
  const factors = strict || decimals(token) === 0 && !unit ? [1] : DERIVATIONS;
  return factors.some(factor => Math.abs(Math.abs(candidate * factor) - Math.abs(value)) <= allowed);
};

const numbersCache = new WeakMap<ExecutedResult, number[]>();
/** Receipt envelope fields: timings, hashes, versions and settings, never computed values. */
const ENVELOPE_FIELDS = new Set(["elapsedms", "inputsha256", "workersha256", "sourcesha256", "sha256", "version", "library", "precision", "rounding", "arithmetic",
  "semantics", "scope", "isolation", "warning", "exitcode", "timedout", "index", "passed", "ran", "runonly", "runonlycases", "truncated", "language"]);
const textNumbers = (text: string): number[] => {
  const numbers = (text.match(NUMBER) ?? []).map(Number).filter(Number.isFinite);
  for (const [, a, b] of text.matchAll(FRACTION)) { const value = Number(a) / Number(b); if (Number.isFinite(value)) numbers.push(value); }
  return numbers;
};
/** The numbers a result reports, fractions (65/4) evaluated as well. A JSON
 * receipt contributes its values, not its envelope (elapsed time, hashes,
 * library versions); printed output contributes every number it shows. */
export const resultNumbers = (result: ExecutedResult): number[] => {
  const cached = numbersCache.get(result);
  if (cached) return cached;
  const text = result.text.slice(0, MAX_TEXT);
  let numbers: number[];
  try {
    const parsed: unknown = JSON.parse(text);
    numbers = [];
    const walk = (value: unknown, key: string | undefined, depth: number) => {
      if (depth > 16 || key && ENVELOPE_FIELDS.has(normalizedKey(key))) return;
      if (typeof value === "number") { if (Number.isFinite(value)) numbers.push(value); }
      else if (typeof value === "string") {
        const trimmed = value.trim();
        if (/^[[{]/.test(trimmed)) { try { walk(JSON.parse(trimmed), key, depth + 1); return; } catch { /* Not JSON. */ } }
        if (new RegExp(`^(?:${NUMBER_SOURCE}|${FRACTION.source})$`).test(trimmed)) numbers.push(...textNumbers(trimmed));
      } else if (Array.isArray(value)) value.forEach(item => walk(item, key, depth + 1));
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k, depth + 1);
    };
    walk(parsed, undefined, 0);
  } catch { numbers = textNumbers(text); }
  numbersCache.set(result, numbers);
  return numbers;
};

/** Named values a result reports, last value per name: JSON fields at any depth
 * (JSON inside strings too) and `name: value` / `name = value` lines of printed output. */
export const keyedValues = (text: string): Map<string, number> => {
  const found = new Map<string, number>();
  const walk = (value: unknown, key: string | undefined, depth: number) => {
    if (depth > 12) return;
    if (typeof value === "number" && key) found.set(normalizedKey(key), value);
    else if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^[[{]/.test(trimmed)) { try { walk(JSON.parse(trimmed), key, depth + 1); return; } catch { /* Not JSON: read as printed text. */ } }
      if (key && new RegExp(`^${NUMBER_SOURCE}$`).test(trimmed)) found.set(normalizedKey(key), Number(trimmed));
      else if (depth > 0) for (const [k, v] of printedPairs(value)) found.set(k, v);
    } else if (Array.isArray(value)) value.forEach(item => walk(item, key, depth + 1));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, /^\d+$/.test(k) && key ? `${key}${k}` : k, depth + 1);
  };
  const slice = text.slice(0, MAX_TEXT);
  try { walk(JSON.parse(slice), undefined, 0); } catch { for (const [k, v] of printedPairs(slice)) found.set(k, v); }
  return found;
};
const printedPairs = (text: string): Array<[string, number]> => [...text.matchAll(new RegExp(String.raw`([A-Za-z_][A-Za-z0-9_ ]{0,48}?)\s*[:=]\s*(${NUMBER_SOURCE})(?![\d.])`, "g"))]
  .map(([, key, value]) => [normalizedKey(key), Number(value)] as [string, number]).filter(([key, value]) => key && Number.isFinite(value));

/** The answer's JSON document, if it is one (bare or in a single json fence). */
const jsonDocument = (reply: string): string | undefined => {
  const trimmed = reply.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i)?.[1] ?? trimmed;
  return /^[[{]/.test(fenced.trim()) ? fenced.trim() : undefined;
};
const UNIT_SOURCE = String.raw`%|percent|per cent|ms|milliseconds?|msec|s|secs?|seconds?|min|mins|minutes?|h|hrs?|hours?|d|days?`;
const UNIT_NAMES: Array<[RegExp, string]> = [[/^(?:%|percent|per cent)$/i, "%"], [/^(?:ms|msec|milliseconds?)$/i, "ms"], [/^(?:s|secs?|seconds?)$/i, "s"],
  [/^(?:min|mins|minutes?)$/i, "min"], [/^(?:h|hrs?|hours?)$/i, "h"], [/^(?:d|days?)$/i, "d"]];
const textUnit = (text: string): string | undefined => { const word = text.trim(); return UNIT_NAMES.find(([pattern]) => pattern.test(word))?.[1]; };
/** A unit named by a JSON field ("utilisationPercent", "waitMinutes", "latency_ms"). */
const keyUnit = (key?: string): string | undefined => !key ? undefined
  : /(?:percent|pct)$/i.test(key) ? "%" : /(?:ms|millis|milliseconds)$/i.test(key) ? "ms" : /(?:minutes|mins)$/i.test(key) ? "min"
  : /(?:hours|hrs)$/i.test(key) ? "h" : /(?:seconds|secs)$/i.test(key) ? "s" : /days$/i.test(key) ? "d" : undefined;
const TOKEN_MARK = "\u0000num:";
/** Parse JSON keeping each number's own text, so "2.8910" keeps its four places. */
const parseKeepingTokens = (document: string): unknown => {
  const marked = document.replace(new RegExp(String.raw`([:\[,]\s*)(${NUMBER_SOURCE})(?=\s*[,}\]])`, "g"), (_, lead: string, token: string) => `${lead}"\\u0000num:${token}"`);
  try { return JSON.parse(marked); } catch { return JSON.parse(document); }
};

/** Numeric values in an answer. For JSON answers every numeric leaf with its path;
 * for text answers the numbers that are not restated inputs, with a label when
 * one precedes them ("mean wait: 4.2"). */
export const answerValues = (reply: string, prompt = ""): { json: boolean; values: AnswerValue[] } => {
  const document = jsonDocument(reply);
  if (document) {
    try {
      const values: AnswerValue[] = [];
      const walk = (value: unknown, path: string, key: string | undefined) => {
        const unit = keyUnit(key);
        if (typeof value === "number") values.push({ path, key, token: String(value), value, unit });
        else if (typeof value === "string" && value.startsWith(TOKEN_MARK)) { const token = value.slice(TOKEN_MARK.length); values.push({ path, key, token, value: Number(token), unit }); }
        else if (typeof value === "string" && new RegExp(`^${NUMBER_SOURCE}\\s*(?:${UNIT_SOURCE})?$`, "i").test(value.trim())) { const token = value.trim().match(NUMBER)![0]; values.push({ path, key, token, value: Number(token), unit: unit ?? textUnit(value.trim().slice(token.length)) }); }
        else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`, key));
        else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, k);
      };
      walk(parseKeepingTokens(document), "", undefined);
      return { json: true, values };
    } catch { /* Not valid JSON: read it as text. */ }
  }
  const inputs = new Set((prompt.match(NUMBER) ?? []).map(Number));
  const values: AnswerValue[] = [];
  const text = withoutNonQuantities(reply.replace(/```[\s\S]*?```/g, " "));
  const pattern = new RegExp(String.raw`(?:([A-Za-z][A-Za-z_ ()/-]{0,40}?)\s*(?:[:=]|\bis\b|\bequals\b|≈)\s*\**\s*)?(?<![\w.])(${NUMBER_SOURCE})(?![\w.]*\d)(\s*(?:${UNIT_SOURCE})(?![A-Za-z]))?`, "gi");
  for (const match of text.matchAll(pattern)) {
    const token = match[2], value = Number(token);
    if (!Number.isFinite(value) || inputs.has(value)) continue;
    values.push({ path: `#${values.length}`, key: match[1]?.trim() || undefined, token, value, unit: match[3] ? textUnit(match[3]) : undefined });
  }
  return { json: false, values };
};

/** The executed result (latest first) or prompt input that shows a value at its stated precision. */
export const backingOf = (item: Pick<AnswerValue, "token" | "value" | "unit">, results: ExecutedResult[], prompt = "", strict = false): Backing | undefined => {
  if (decimals(item.token) === 0 && [0, 1].includes(Math.abs(item.value))) return { kind: "input" };
  for (const result of [...results].sort((a, b) => b.seq - a.seq)) {
    if (resultNumbers(result).some(candidate => matches(item.token, item.value, candidate, strict, item.unit))) return { kind: result.kind, seq: result.seq, tool: result.tool };
  }
  // A restated input backs a value only at the precision the request gave it:
  // "2" in the request does not support a computed "2.000000".
  for (const token of prompt.match(NUMBER) ?? []) {
    if (decimals(item.token) <= decimals(token) && Math.abs(Number(token) - item.value) <= tolerance(item.token, item.value)) return { kind: "input" };
  }
  return undefined;
};

/** Answer fields whose name an executed result also reports, where executed runs
 * disagree with each other or the latest one disagrees with the answer. */
// Envelope fields of tool receipts, not names of computed quantities.
const GENERIC_KEYS = new Set(["result", "results", "value", "values", "answer", "output", "actual", "expected", "index", "elapsedms", "precision", "places", "version", "exitcode", "status"]);
export const receiptConflicts = (values: AnswerValue[], results: ExecutedResult[]): ReceiptConflict[] => {
  const ordered = [...results].sort((a, b) => a.seq - b.seq).map(result => ({ result, keyed: keyedValues(result.text) }));
  const conflicts: ReceiptConflict[] = [];
  for (const item of values) {
    if (!item.key) continue;
    const key = normalizedKey(item.key);
    if (key.length < 3 || GENERIC_KEYS.has(key)) continue;
    const runs = ordered.filter(entry => entry.keyed.has(key)).map(entry => ({ seq: entry.result.seq, tool: entry.result.tool, value: entry.keyed.get(key)! }));
    if (!runs.length) continue;
    const latest = runs.at(-1)!;
    const latestDisagrees = !matches(item.token, item.value, latest.value);
    const runsDisagree = runs.some(run => !matches(item.token, latest.value, run.value));
    if (latestDisagrees && backingOf(item, results.filter(result => result.seq > latest.seq)) === undefined || runsDisagree) {
      conflicts.push({ key: item.key, drafted: item.token, runs: runs.slice(-4), latestDisagrees });
    }
  }
  return conflicts;
};

export interface ProvenanceReport { json: boolean; values: AnswerValue[]; unbacked: AnswerValue[]; conflicts: ReceiptConflict[]; }
/** Delivery check: answer values with no executed result behind them, and named
 * values on which executed runs disagree. */
export const numericProvenance = (reply: string, prompt: string, results: ExecutedResult[]): ProvenanceReport => {
  const { json, values } = answerValues(reply, prompt);
  const unbacked = values.filter(item => !backingOf(item, results, prompt));
  return { json, values, unbacked, conflicts: receiptConflicts(values, results) };
};

/** Whether every value of an answer was printed or returned by executed code. */
export const backedByExecutedCode = (reply: string, prompt: string, results: ExecutedResult[]): boolean => {
  const code = results.filter(result => result.kind === "code");
  const { values } = answerValues(reply, prompt);
  if (!values.length || !code.length) return false;
  return values.every(item => backingOf(item, code, prompt, true) !== undefined);
};

export interface ReviewDispute { field: string; drafted: string; revised: string | null; backing?: Backing; }
export interface ReviewDecision {
  /** accept: the review's answer stands. keep: the draft stands. merge: the review's answer with drafted values restored. */
  verdict: "accept" | "keep" | "merge";
  answer: string;
  /** Drafted values backed by executed code that the review changed without executed support: never accepted. */
  protectedFields: ReviewDispute[];
  /** Drafted values backed by a calculation receipt (or an input) that the review changed without executed support. */
  disputes: ReviewDispute[];
  acceptedChanges: number;
}
/** Whether a review kept a drafted value: judged at the draft's own precision. A
 * review that states fewer places (2.3480 -> 2) changed the value, not kept it. */
const sameValue = (drafted: AnswerValue, revised: AnswerValue): boolean => drafted.value === revised.value
  || decimals(revised.token) >= decimals(drafted.token) && Math.abs(drafted.value - revised.value) <= tolerance(drafted.token, drafted.value);
/** A review value supports itself only by a direct match at no less precision than the draft. */
const reviewBacking = (drafted: AnswerValue, revised: AnswerValue, results: ExecutedResult[], prompt: string): Backing | undefined =>
  decimals(revised.token) >= decimals(drafted.token) ? backingOf(revised, results, prompt, true) : undefined;

/** Decide a tool-less review's edits field by field, by which side executed
 * results support. A changed value is accepted when the review's value is itself
 * backed, or when neither value has executed support (catching a figure that
 * models the wrong quantity is the review's job). A value printed by executed
 * code is never replaced by an unexecuted one. A value from a calculation receipt
 * that the review contests is a dispute: the expression ran, but the review says
 * it is the wrong expression, and only another executed method can settle that.
 * Until one does, the executed value stays. A number is never replaced by null. */
export const decideReview = (draft: string, revised: string, prompt: string, results: ExecutedResult[]): ReviewDecision => {
  const before = answerValues(draft, prompt), after = answerValues(revised, prompt);
  const protectedFields: ReviewDispute[] = [], disputes: ReviewDispute[] = [];
  let acceptedChanges = 0, refined = 0;
  if (before.json && after.json) {
    const revisedByPath = new Map(after.values.map(item => [item.path, item]));
    const restore = new Map<string, string>();
    const document = jsonDocument(revised)!;
    let parsedRevised: unknown;
    try { parsedRevised = parseKeepingTokens(document); } catch { parsedRevised = undefined; }
    for (const item of before.values) {
      const next = revisedByPath.get(item.path);
      if (next && sameValue(item, next)) { if (next.token !== item.token) refined++; continue; }
      const nextBacking = next ? reviewBacking(item, next, results, prompt) : undefined;
      if (next && nextBacking) { acceptedChanges++; continue; }
      const backing = backingOf(item, results, prompt);
      if (next && !backing) { acceptedChanges++; continue; }
      const dispute = { field: item.path, drafted: item.token, revised: next?.token ?? null, backing };
      if (backing?.kind === "code") protectedFields.push(dispute); else disputes.push(dispute);
      restore.set(item.path, item.token);
    }
    if (!restore.size) return { verdict: "accept", answer: revised, protectedFields, disputes, acceptedChanges };
    if (!acceptedChanges && !refined || parsedRevised === undefined) return { verdict: "keep", answer: draft, protectedFields, disputes, acceptedChanges };
    // Restore drafted tokens in the review's document, path by path.
    const setPath = (root: unknown, path: string, token: string): boolean => {
      const parts = [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map(match => match[1] ?? Number(match[2]));
      let node = root as Record<string | number, unknown>;
      for (const part of parts.slice(0, -1)) { node = node?.[part] as Record<string | number, unknown>; if (!node || typeof node !== "object") return false; }
      const last = parts.at(-1);
      if (last === undefined || !node || typeof node !== "object") return false;
      node[last] = `${TOKEN_MARK}${token}`;
      return true;
    };
    for (const [path, token] of restore) if (!setPath(parsedRevised, path, token)) return { verdict: "keep", answer: draft, protectedFields, disputes, acceptedChanges };
    const pretty = /\n/.test(document) ? 2 : undefined;
    const rendered = JSON.stringify(parsedRevised, (_, value) => value, pretty).replace(new RegExp(`"${TOKEN_MARK.replace("\u0000", "\\\\u0000")}(${NUMBER_SOURCE})"`, "g"), "$1");
    const answer = revised.trim() === document ? rendered : revised.replace(document, rendered);
    return { verdict: "merge", answer, protectedFields, disputes, acceptedChanges };
  }
  // Prose: values cannot be paired by field. A drafted value the review dropped
  // is contested unless one of the review's new values is itself backed.
  const introduced = after.values.filter(next => !before.values.some(item => sameValue(item, next)));
  const introducedBacked = introduced.some(next => backingOf(next, results, prompt, true));
  for (const item of before.values) {
    if (after.values.some(next => sameValue(item, next))) continue;
    const backing = backingOf(item, results, prompt);
    if (!backing || introducedBacked) { acceptedChanges++; continue; }
    const dispute = { field: item.key ?? item.path, drafted: item.token, revised: introduced.map(next => next.token).join(", ") || null, backing };
    if (backing.kind === "code") protectedFields.push(dispute); else disputes.push(dispute);
  }
  const contested = protectedFields.length + disputes.length;
  return { verdict: contested ? "keep" : "accept", answer: contested ? draft : revised, protectedFields, disputes, acceptedChanges };
};

const COMPUTE_WORDS = /\b(?:simulat|enumerat|comput|calculat|estimat|tally|probabilit|throughput|utili[sz]|round(?:ed)? to|decimal places?|significant (?:figures|digits))\w*|\bsolve for\b|\bhow (?:many|much)\b/i;
/** Words that ask for a number only when a numeric object follows: "the expected
 * number of", "count the misses", "mean waiting time", not "what do you mean". */
const OBJECT_WORDS = /\b(?:mean|expect\w*|determin\w*|count\w*|averag\w*|varian\w*|evaluat\w*)\s+(?:(?:the|a|an|of|each|all|total)\s+){0,3}(?:\w+\s+){0,2}?(?:numbers?|values?|totals?|sums?|rates?|times?|costs?|lengths?|sizes?|counts?|probabilit\w*|waits?|waiting|delays?|amounts?|percentages?|fractions?|ratios?|hits?|misses|events?|steps?|orderings?)\b/i;
const NO_TOOLS = /\b(?:without (?:using )?(?:any )?(?:tools?|a calculator|code)|(?:do not|don't|never) (?:use|run|call) (?:any )?(?:tools?|code|a calculator)|no tools|by hand|mentally|in your head|from memory)\b/i;
/** A request whose answer is a computed quantity over several stated inputs (an
 * event trace to simulate, orderings to count, a recurrence): one model call
 * cannot work it out reliably in its head. In cycle 7 a 22-event banker's
 * algorithm trace was answered in 24 seconds with counts that could not add up. */
export const requestNeedsComputation = (prompt: string): boolean =>
  (COMPUTE_WORDS.test(prompt) || OBJECT_WORDS.test(prompt)) && !NO_TOOLS.test(prompt) && (withoutNonQuantities(prompt).match(NUMBER) ?? []).length >= 4;

const VERSIONED = String.raw`(?:TLS|SSL|SSH|HTTP|IPv|TCP|QUIC|OAuth|USB|PCIe|DDR|Wi-?Fi|Bluetooth|Python|Node(?:\.js)?|Java|Go|Rust|Ruby|PHP|Perl|Ubuntu|Debian|RHEL|CentOS|Fedora|Alpine|Windows|macOS|iOS|Android|Postgres(?:QL)?|MySQL|MariaDB|SQLite|Redis|Kafka|Kubernetes|Docker|Chrome|Firefox|Safari|Edge|React|Angular|Vue|Django|Rails|Spring|Spark|Hadoop|Elasticsearch|MongoDB|Cassandra|Nginx|Apache|OpenSSL|Linux|v)`;
const WHOLE_VERSIONED = String.raw`(?:HTTP|IPv|USB|DDR|PCIe|Java|Windows|iOS|Android|Python)`;
const MONTH = String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?`;
const NON_QUANTITIES = [
  /\b\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b/g, /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  new RegExp(String.raw`\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b`, "g"), new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}(?:\s+\d{4})?\b`, "g"),
  /\b(?:in|since|by|until|from|before|after|during)\s+(?:19|20)\d{2}\b/gi, /\b\d+(?:st|nd|rd|th)\b/gi,
  /\bv(?:ersion\s*)?\d+(?:\.\d+)*\b/gi, /\b\d+\.\d+\.\d+(?:\.\d+)*\b/g,
  // Named products with version-shaped numbers: TLS 1.2 or 1.3, Python 3.12, Ubuntu 24.04. Only a
  // name, never any capitalised word: "MTBF 2000", "SLA 99.9" and "CPU 4, 8 and 16" are quantities.
  new RegExp(String.raw`\b${VERSIONED}(?:\/|-|\s)?\d+\.\d+(?:\.\d+)*(?:\s*(?:,|or|and|vs\.?|versus|to|\/)\s*\d+\.\d+(?:\.\d+)*)*`, "g"),
  // Products whose versions are whole numbers: HTTP/2 vs 3, IPv6, Java 21, Windows 11.
  new RegExp(String.raw`\b${WHOLE_VERSIONED}(?:\/|-|\s)?\d+(?:\.\d+)*(?:\s*(?:,|or|and|vs\.?|versus|to|\/)\s*\d+(?:\.\d+)*)*`, "g"),
];
/** Text with dates, times of day, ordinals and version numbers blanked out: they are labels, not quantities. */
export const withoutNonQuantities = (text: string): string => NON_QUANTITIES.reduce((rest, pattern) => rest.replace(pattern, match => " ".repeat(match.length)), text);
