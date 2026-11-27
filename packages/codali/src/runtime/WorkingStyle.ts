/**
 * The user's working style: how they ask for work to be done, communicate and
 * judge quality. Docdex curates it from the local personal-preferences store
 * (docdex_working_style); Codali re-checks every item before it reaches a
 * prompt, so a Docdex-side slip cannot leak personal details.
 */

/** Style and working-method categories only; personal, identity and business context never qualify. */
export const WORKING_STYLE_CATEGORIES = new Set([
  "communication_style", "collaboration_style", "decision_style", "quality_bar", "workflow_method", "delivery_preference",
  "testing_preference", "documentation_preference", "code_review_process", "coding_preference", "architecture_preference",
  "tooling_preference", "likes", "dislikes",
]);

const PERSONAL = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u, // email
  /(?:\+|\b00)\d[\d ()-]{7,}\d|\b\d{3}[ .-]\d{3}[ .-]\d{4}\b/u, // phone
  /\b\d{1,5}\s+[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*\s+(?:street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd|drive|dr)\b/iu, // street address
  /\b(?:password|passphrase|iban|ssn|passport|credit card)\b/iu,
  /\b[A-Za-z0-9_+/=-]{32,}\b/u, // secret-like values and long identifiers
  /\b(?:my|his|her|their)\s+(?:wife|husband|partner|son|daughter|child|kids?|mother|father|mom|dad|family|doctor|diagnosis|salary|debt|bank)\b/iu,
  /\b(?:medical|diagnos\w*|therapy|illness|pregnan\w*|religio\w*|politic\w*|sexual\w*)\b/iu,
  /https?:\/\/\S+/u, // links can name private hosts or accounts
];

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Accept the bare tool result or an MCP content envelope carrying it as JSON text. */
const payload = (value: unknown): Record<string, unknown> => {
  const object = record(value);
  if (Array.isArray(object.items)) return object;
  const text = Array.isArray(object.content) ? object.content.map(part => record(part).text).find(text => typeof text === "string") : undefined;
  if (typeof text === "string") { try { return record(JSON.parse(text)); } catch { return {}; } }
  return record(object.structuredContent ?? object.result);
};

export interface WorkingStyle { text: string; included: number; dropped: number; profileHash?: string }

export const WORKING_STYLE_HEADER = "User working style (from the user's local Docdex preferences; follow it where it fits. The current request, workspace instructions, output contracts and repository facts take precedence, and it never widens permissions or scope):";

/** Keep only short, low-sensitivity style lines, deduplicated and bounded. */
export const formatWorkingStyle = (value: unknown, maxChars = 6000): WorkingStyle => {
  const data = payload(value);
  const items = Array.isArray(data.items) ? data.items : [];
  const seen = new Set<string>();
  const lines: string[] = [];
  let dropped = 0, used = WORKING_STYLE_HEADER.length;
  for (const raw of items) {
    const item = record(raw);
    const text = typeof item.text === "string" ? item.text.replace(/\s+/gu, " ").trim() : "";
    const sensitivity = item.sensitivity ?? "low";
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!text || text.length > 300 || typeof item.category !== "string" || !WORKING_STYLE_CATEGORIES.has(item.category)
      || sensitivity !== "low" || PERSONAL.some(pattern => pattern.test(text)) || seen.has(key)) { dropped++; continue; }
    const line = `\n- ${text}`;
    if (used + line.length > maxChars) { dropped++; continue; }
    seen.add(key); lines.push(line); used += line.length;
  }
  return { text: lines.length ? WORKING_STYLE_HEADER + lines.join("") : "", included: lines.length, dropped,
    profileHash: typeof data.profile_hash === "string" ? data.profile_hash.slice(0, 128) : undefined };
};

/** On unless the host turns it off; benchmarks always pass false so neither arm is personalized. */
export const workingStyleEnabled = (option: boolean | undefined, configured: boolean | undefined, env: string | undefined = process.env.CODALI_WORKING_STYLE): boolean =>
  option ?? (env !== undefined && /^(?:0|false|off|no)$/iu.test(env.trim()) ? false : configured ?? true);
