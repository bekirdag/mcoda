export type TaskStage = "foundation" | "backend" | "frontend" | "other";

export interface TaskClassification {
  stage: TaskStage;
  foundation: boolean;
  reasons: string[];
}

const FOUNDATION_KEYWORDS = new Set([
  "initialize",
  "scaffold",
  "setup",
  "install",
  "configure",
  "express",
  "server",
  "openapi",
  "spec",
  "sds",
]);

const BACKEND_KEYWORDS = new Set(["api", "endpoint", "server", "express", "db", "database", "storage", "persistence"]);

const FRONTEND_KEYWORDS = new Set(["ui", "html", "css", "dom", "render", "style", "frontend"]);

const tokenize = (value?: string): string[] => {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
};

const collectHits = (tokens: string[], keywords: Set<string>): string[] =>
  tokens.filter((token) => keywords.has(token));

export const classifyTask = (input: { title?: string; description?: string; type?: string }): TaskClassification => {
  const titleTokens = tokenize(input.title);
  const descriptionTokens = tokenize(input.description);
  const tokens = [...titleTokens, ...descriptionTokens];
  const backendHits = collectHits(tokens, BACKEND_KEYWORDS);
  const frontendHits = collectHits(tokens, FRONTEND_KEYWORDS);
  const foundationHits = collectHits(titleTokens, FOUNDATION_KEYWORDS);
  const type = (input.type ?? "").toLowerCase();
  const isChore = type === "chore";
  const foundation = isChore || foundationHits.length > 0;

  let stage: TaskStage = "other";
  if (backendHits.length > 0) {
    stage = "backend";
  } else if (frontendHits.length > 0) {
    stage = "frontend";
  } else if (foundation) {
    stage = "foundation";
  }

  const reasons = [
    ...backendHits.map((hit) => `backend:${hit}`),
    ...frontendHits.map((hit) => `frontend:${hit}`),
    ...foundationHits.map((hit) => `foundation:${hit}`),
    isChore ? "type:chore" : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    stage,
    foundation,
    reasons,
  };
};
