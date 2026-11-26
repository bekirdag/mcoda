import { isDependencyArtifact } from "./StructuralEvidence.js";
import { isTestSourcePath } from "./RequestedTestEvidence.js";

/** Delivery documents (README, delivery notes, guides) the session wrote. Cycle 7
 * left them to the last task (a crash left neither) and stated a session
 * lifetime the code did not have; cycle 5 claimed a logout that failed. */
export const isDeliveryDocument = (file: string): boolean => /\.(?:md|markdown|mdx|rst)$/i.test(file)
  && !isDependencyArtifact(file) && !/^(?:build|dist|out|coverage)\//.test(file) && !/(?:^|\/)(?:CHANGELOG|LICEN[CS]E)[^/]*$/i.test(file);

// A sentence that asks for a document to be delivered, and a mention that only
// refers to one ("see the upstream CONTRIBUTING.md", "described in BRIEF.md").
// "The repo should contain a README.md", "a README.md must explain …" and a list
// under a "Deliverables:" line ask for one too.
const DELIVER = /\b(?:deliver(?:able)?s?|deliver\w*|write|writes|written|create|creates|provide|provides|include|includes|add|adds|produce|ship|prepare|supply|document|update|maintain|keep|contain|contains|explain|explains|describe|describes|cover|covers|outputs?|artifacts?|should|must|shall|needs?|requires?|required)\b/i;
const REFERENCE = /\b(?:see|read|reads|reading|refer(?:s|ring)? to|per|from|according to|(?:described|specified|defined|listed|given) in|as in|upstream|existing|like)\s+(?:the\s+|an?\s+)?(?:[\w-]+\s+)?[`'"(\[*]?$/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** Markdown files the request asks to be delivered that do not exist yet.
 * Inputs and files the request only refers to are excluded. */
export function missingDeliveryDocuments(requestTexts: readonly string[], existingPaths: readonly string[], inputPaths: readonly string[]): string[] {
  const existing = new Set(existingPaths.map(file => file.toLowerCase()));
  const inputs = new Set(inputPaths.map(file => file.toLowerCase()));
  const named = new Set<string>();
  for (const text of requestTexts) {
    let context = "";
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = LIST_ITEM.test(line);
      if (!item) context = line;
      // A list item reads with the line that introduces it ("Deliverables:").
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        const gate = item ? `${context} ${sentence}` : sentence;
        if (!DELIVER.test(gate)) continue;
        for (const match of sentence.matchAll(/(?:^|[\s`'"(\[*])((?:[\w-]+\/)*[\w.-]*[\w-]\.md)\b/gi)) {
          const file = match[1].replace(/^\.\//, "");
          if (REFERENCE.test(sentence.slice(0, match.index! + match[0].length - match[1].length))) continue;
          if (!existing.has(file.toLowerCase()) && !inputs.has(file.toLowerCase())) named.add(file);
        }
      }
    }
  }
  return [...named];
}

/** Statements in a delivered document worth checking: prose lines and list
 * items, without headings, fences, table rules or very short fragments. */
export function deliveryClaims(text: string): string[] {
  const claims: string[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line || /^#/.test(line) || /^\|?[\s:|-]+\|?$/.test(line)) continue;
    const statement = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^\[[ xX]\]\s+/, "").trim();
    if (statement.split(/\s+/).length < 4 || statement.length > 2000) continue;
    claims.push(statement);
  }
  return [...new Set(claims)];
}

const SECONDS: Record<string, number> = { ms: 0.001, millisecond: 0.001, milliseconds: 0.001, s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86_400, day: 86_400, days: 86_400, week: 604_800, weeks: 604_800 };
// Single-letter s, m and d count only when attached to the number (15m, 30s, 7d).
const DURATION = /(\d+(?:\.\d+)?)(?:\s*(milliseconds?|ms|secs?|seconds?|mins?|minutes?|hrs?|hours?|h|days?|weeks?)|(s|m|d))\b/gi;
// Lines that state a setting, not an incidental time ("tests take 2 minutes").
const SETTING = /(?:^|[^a-z])(ttl|timeouts?|expir\w*|lifetime|sessions?|idle|lock\w*|limits?|max\w*|min(?:imum)?|intervals?|retention|cache\w*|window|throttl\w*|rate|debounce|poll\w*|refresh\w*|cookies?|tokens?|retr(?:y|ies)|backoff|delay|duration|age|valid\w*)(?![a-z])/i;
const UNIT_HINT = /(?:^|[^a-z])(ms|millis\w*|secs?|seconds?|mins?|minutes?|hours?|hrs?|days?|weeks?|ttl|timeout|expir\w*|age|interval|delay|duration|window)(?![a-z])/i;
const words = (line: string) => line.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
// A grounding setting must be about the same thing as the document line: one
// topic in common, or one content word. "MAX_RETRIES = 8; // per hour" does not
// ground "sessions last 8 hours".
const TOPICS = [/ttl|expir|lifetime|session|valid|(?:^|_|\b)age|idle|inactiv|cookie|token|logout|sign.?out/,
  /lock|throttl|rate|attempt|brute|window|limit/, /retr|backoff|delay|attempt/, /timeout|deadline|wait/,
  /interval|poll|refresh|cache|retention|debounce|schedule|cron|every|purge|cleanup/];
const IGNORED_WORDS = new Set("milli millis second seconds minute minutes hour hours days week weeks after every about with from that this than then into only each once must will const export default value values setting settings config".split(" "));
const topicWords = (text: string) => new Set(words(text).toLowerCase().split(/[^a-z]+/)
  .filter(word => word.length >= 4 && !IGNORED_WORDS.has(word)).map(word => word.replace(/(?:es|s)$/, "").slice(0, 5)));
const sameSubject = (doc: string, source: string) => {
  const a = words(doc).toLowerCase(), b = words(source).toLowerCase();
  if (TOPICS.some(topic => topic.test(a) && topic.test(b))) return true;
  const shared = topicWords(source);
  return [...topicWords(doc)].some(word => shared.has(word));
};
// Lines about how long a run takes, or a named library's own default.
const RUN_TIME = /\b(?:takes?|took|lasts?|runs?|finish(?:es)?|completes?)\b[^.]*\b(?:about|around|roughly|approximately|under|less than|up to)\b|\b(?:tests?|suite|build|install(?:ation)?|ci|npm|pnpm|yarn|journey|script|command)\b[^.]*\b(?:takes?|took|runs? (?:in|for)|finish(?:es)? in|completes? in)\b/i;
const LIBRARY_DEFAULT = /\b(?:library|driver|framework|browser|package|module|upstream|sdk|client|engine|runtime)(?:'s)?\b[^.]*\bdefaults?\b|\bdefaults?\b[^.]*\bof (?:the )?(?:library|driver|framework|browser|package|module)\b/i;

function durations(line: string): { text: string; seconds: number }[] {
  return [...line.matchAll(DURATION)].map(match => ({ text: match[0], seconds: Number(match[1]) * SECONDS[(match[2] ?? match[3]).toLowerCase()] }));
}

/** Values a source line gives: products and unit strings are durations already
 * (in the unit the code uses), plain literals may be in any unit. */
function sourceValues(line: string): number[] {
  const values: number[] = [];
  let rest = line;
  for (const match of line.matchAll(/\d[\d_]*(?:\.\d+)?(?:\s*\*\s*\d[\d_]*(?:\.\d+)?)+/g)) {
    values.push(match[0].split("*").reduce((product, part) => product * Number(part.replace(/[_\s]/g, "")), 1));
    rest = rest.replace(match[0], " ");
  }
  for (const match of rest.matchAll(/(?:hours|minutes|seconds|days|weeks|milliseconds)\s*[=:]\s*(\d+(?:\.\d+)?)/gi)) {
    values.push(Number(match[1]) * SECONDS[match[0].split(/\s*[=:]/)[0].toLowerCase()] / 0.001);
  }
  for (const match of rest.matchAll(/['"`](\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)['"`]/gi)) {
    values.push(Number(match[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 } as Record<string, number>)[match[2].toLowerCase()] / 0.001);
  }
  for (const match of rest.replace(/['"`]\d+(?:\.\d+)?\s*(?:ms|s|m|h|d|w)['"`]/gi, " ").matchAll(/(?<![\w.])\d[\d_]*(?:\.\d+)?(?![\w.])/g)) values.push(Number(match[0].replace(/_/g, "")));
  return values;
}

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
// A source number counts in any unit code commonly uses for durations.
const matches = (value: number, seconds: number) => [0.001, 1, 60, 3600, 86_400, 604_800].some(unit => same(value * unit, seconds));

/** Durations a delivered document states for a setting (a session lifetime, a
 * timeout, a lockout window) that no source setting and no receipt output has.
 * Each finding names the document line and the settings the code does have. */
export function ungroundedDurations(docs: readonly { path: string; text: string }[], sources: readonly { path: string; text: string }[],
  receiptOutputs: readonly string[]): string[] {
  const settings = sources.filter(source => !isDeliveryDocument(source.path) && !isTestSourcePath(source.path))
    .flatMap(source => source.text.split(/\r?\n/).map((text, index) => ({ path: source.path, line: index + 1, text: text.trim() })))
    .filter(line => line.text.length <= 400 && UNIT_HINT.test(words(line.text)) && /\d/.test(line.text));
  const observed = receiptOutputs.flatMap(output => durations(output).map(value => value.seconds));
  const findings: string[] = [];
  for (const doc of docs) {
    for (const [index, raw] of doc.text.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!SETTING.test(words(line)) || RUN_TIME.test(line) || LIBRARY_DEFAULT.test(line)) continue;
      for (const stated of durations(line)) {
        if (observed.some(value => same(value, stated.seconds))) continue;
        if (settings.some(setting => sameSubject(line, setting.text) && sourceValues(setting.text).some(value => matches(value, stated.seconds)))) continue;
        const keywords = [...words(line).toLowerCase().matchAll(new RegExp(SETTING.source, "gi"))].map(match => match[1]);
        const sharing = settings.filter(setting => sameSubject(line, setting.text) || keywords.some(keyword => words(setting.text).toLowerCase().includes(keyword)));
        const related = (sharing.length ? sharing : settings).slice(0, 3).map(setting => `${setting.path}:${setting.line} ${setting.text.slice(0, 120)}`);
        findings.push(`${doc.path}:${index + 1} states ${stated.text} ("${line.slice(0, 160)}"), but no source setting has that duration and no receipt shows it.`
          + (related.length ? ` Related settings in the code: ${related.join(" | ")}.` : "")
          + " Make the document state what the code does (or change the code if the requirement says so), then verify again.");
      }
    }
  }
  return findings;
}
