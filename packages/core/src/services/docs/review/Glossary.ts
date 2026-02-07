import glossaryFallback from "./glossary.json" with { type: "json" };
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface GlossaryEntry {
  key: string;
  term: string;
  description: string;
  aliases?: string[];
}

export interface GlossaryData {
  version: 1;
  entries: GlossaryEntry[];
  canonicalPhrases: Record<string, string>;
}

const DEFAULT_GLOSSARY_PATH = fileURLToPath(new URL("./glossary.json", import.meta.url));

let cachedGlossary: GlossaryData | null = null;
let cachedPath: string | null = null;

const normalizeGlossary = (data: any): GlossaryData => {
  const version = data?.version === 1 ? 1 : 1;
  const entries = Array.isArray(data?.entries)
    ? data.entries.filter((entry: any) => entry && typeof entry.term === "string")
    : [];
  const canonicalPhrases = data?.canonicalPhrases && typeof data.canonicalPhrases === "object"
    ? data.canonicalPhrases
    : {};
  return { version, entries, canonicalPhrases };
};

export const loadGlossary = (overridePath?: string): GlossaryData => {
  const glossaryPath = overridePath || process.env.MCODA_GLOSSARY_PATH || DEFAULT_GLOSSARY_PATH;
  if (cachedGlossary && cachedPath === glossaryPath) return cachedGlossary;
  try {
    const raw = fs.readFileSync(glossaryPath, "utf8");
    cachedGlossary = normalizeGlossary(JSON.parse(raw));
    cachedPath = glossaryPath;
  } catch {
    cachedGlossary = normalizeGlossary(glossaryFallback);
    cachedPath = DEFAULT_GLOSSARY_PATH;
  }
  return cachedGlossary;
};

export const getGlossaryEntry = (key: string, glossary?: GlossaryData): GlossaryEntry | undefined => {
  const resolved = glossary ?? loadGlossary();
  return resolved.entries.find((entry) => entry.key === key);
};

export const formatGlossaryForPrompt = (glossary?: GlossaryData): string => {
  const resolved = glossary ?? loadGlossary();
  if (!resolved.entries.length) return "Glossary: (no entries loaded).";
  const lines = ["Glossary (canonical terminology):"];
  for (const entry of resolved.entries) {
    const alias = entry.aliases && entry.aliases.length > 0 ? ` Aliases: ${entry.aliases.join(", ")}.` : "";
    lines.push(`- ${entry.term}: ${entry.description}.${alias}`.trim());
  }
  return lines.join("\n");
};

export const GLOSSARY_PROMPT_SNIPPET = formatGlossaryForPrompt();
