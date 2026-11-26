import { isDependencyArtifact } from "./StructuralEvidence.js";
import { isTestSourcePath } from "./RequestedTestEvidence.js";

/** Delivery documents (README, delivery notes, guides) the session wrote. Cycle 7
 * left them to the last task (a crash left neither) and stated a session
 * lifetime the code did not have; cycle 5 claimed a logout that failed. */
export const isDeliveryDocument = (file: string): boolean => /\.(?:md|markdown|mdx|rst)$/i.test(file)
  && !isDependencyArtifact(file) && !/^(?:build|dist|out|coverage)\//.test(file) && !/(?:^|\/)(?:CHANGELOG|LICEN[CS]E)[^/]*$/i.test(file);

/** Markdown file names the request mentions that do not exist yet. Inputs are excluded. */
export function missingDeliveryDocuments(requestTexts: readonly string[], existingPaths: readonly string[], inputPaths: readonly string[]): string[] {
  const existing = new Set(existingPaths.map(file => file.toLowerCase()));
  const inputs = new Set(inputPaths.map(file => file.toLowerCase()));
  const named = new Set<string>();
  for (const text of requestTexts) {
    for (const match of text.matchAll(/(?:^|[\s`'"(\[*])((?:[\w-]+\/)*[\w.-]*[\w-]\.md)\b/gi)) {
      const file = match[1].replace(/^\.\//, "");
      if (!existing.has(file.toLowerCase()) && !inputs.has(file.toLowerCase())) named.add(file);
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
      if (!SETTING.test(words(line))) continue;
      for (const stated of durations(line)) {
        if (observed.some(value => same(value, stated.seconds))) continue;
        if (settings.some(setting => sourceValues(setting.text).some(value => matches(value, stated.seconds)))) continue;
        const keywords = [...words(line).toLowerCase().matchAll(new RegExp(SETTING.source, "gi"))].map(match => match[1]);
        const sharing = settings.filter(setting => keywords.some(keyword => words(setting.text).toLowerCase().includes(keyword)));
        const related = (sharing.length ? sharing : settings).slice(0, 3).map(setting => `${setting.path}:${setting.line} ${setting.text.slice(0, 120)}`);
        findings.push(`${doc.path}:${index + 1} states ${stated.text} ("${line.slice(0, 160)}"), but no source setting has that duration and no receipt shows it.`
          + (related.length ? ` Related settings in the code: ${related.join(" | ")}.` : "")
          + " Make the document state what the code does (or change the code if the requirement says so), then verify again.");
      }
    }
  }
  return findings;
}
