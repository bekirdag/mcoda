export type IntentBucket = "ui" | "content" | "behavior" | "data";

export interface IntentSignals {
  intents: IntentBucket[];
  matches: Record<IntentBucket, string[]>;
}

const UI_KEYWORDS = [
  "ui",
  "ux",
  "page",
  "screen",
  "layout",
  "header",
  "hero",
  "navbar",
  "footer",
  "landing",
  "welcome",
  "title",
  "button",
  "style",
  "css",
  "html",
  "markup",
  "template",
  "component",
  "view",
];

const CONTENT_KEYWORDS = [
  "copy",
  "text",
  "label",
  "wording",
  "message",
  "string",
  "content",
];

const BEHAVIOR_KEYWORDS = [
  "logic",
  "behavior",
  "bug",
  "fix",
  "error",
  "crash",
  "api",
  "backend",
  "server",
  "endpoint",
  "flow",
  "auth",
];

const DATA_KEYWORDS = [
  "schema",
  "database",
  "db",
  "model",
  "migration",
  "table",
  "field",
  "column",
  "sql",
];

const normalize = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9\\s]/g, " ");

const collectMatches = (text: string, keywords: string[]): string[] => {
  const matches: string[] = [];
  for (const keyword of keywords) {
    if (text.includes(keyword)) matches.push(keyword);
  }
  return matches;
};

export const deriveIntentSignals = (request: string): IntentSignals => {
  const normalized = normalize(request ?? "");
  const uiMatches = collectMatches(normalized, UI_KEYWORDS);
  const contentMatches = collectMatches(normalized, CONTENT_KEYWORDS);
  const behaviorMatches = collectMatches(normalized, BEHAVIOR_KEYWORDS);
  const dataMatches = collectMatches(normalized, DATA_KEYWORDS);

  const intents: IntentBucket[] = [];
  if (uiMatches.length) intents.push("ui");
  if (contentMatches.length) intents.push("content");
  if (behaviorMatches.length) intents.push("behavior");
  if (dataMatches.length) intents.push("data");

  if (intents.length === 0) {
    intents.push("behavior");
  }

  return {
    intents,
    matches: {
      ui: uiMatches,
      content: contentMatches,
      behavior: behaviorMatches,
      data: dataMatches,
    },
  };
};
