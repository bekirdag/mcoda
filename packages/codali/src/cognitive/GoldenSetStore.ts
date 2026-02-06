import { promises as fs } from "node:fs";
import path from "node:path";

export interface GoldenSetEntry {
  intent: string;
  plan_summary: string;
  touched_files: string[];
  review_notes?: string;
  qa_notes?: string;
  patch_summary?: string;
  created_at: string;
}

export interface GoldenSetStoreOptions {
  workspaceRoot: string;
  storagePath?: string;
  maxEntries?: number;
}

export interface GoldenExampleSummary {
  intent: string;
  patch: string;
  score?: number;
}

const DEFAULT_STORAGE_PATH = ".mcoda/codali/golden-examples.jsonl";
const DEFAULT_MAX_ENTRIES = 50;

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]"],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED_TOKEN]"],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]"],
  [/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
];

const normalizeText = (value: string): string => {
  let next = value;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    next = next.replace(pattern, replacement);
  }
  return next.trim();
};

const tokenize = (value: string): Set<string> => {
  const matches = value.toLowerCase().match(/[a-z0-9_./-]{3,}/g);
  return new Set(matches ?? []);
};

const scoreEntry = (queryTokens: Set<string>, entryText: string): number => {
  if (queryTokens.size === 0) return 0;
  const entryTokens = tokenize(entryText);
  let overlap = 0;
  for (const token of queryTokens) {
    if (entryTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
};

const safeParseJson = (line: string): GoldenSetEntry | undefined => {
  try {
    const parsed = JSON.parse(line) as GoldenSetEntry;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (typeof parsed.intent !== "string" || typeof parsed.plan_summary !== "string") return undefined;
    return {
      intent: parsed.intent,
      plan_summary: parsed.plan_summary,
      touched_files: Array.isArray(parsed.touched_files)
        ? parsed.touched_files.filter((item): item is string => typeof item === "string")
        : [],
      review_notes: typeof parsed.review_notes === "string" ? parsed.review_notes : undefined,
      qa_notes: typeof parsed.qa_notes === "string" ? parsed.qa_notes : undefined,
      patch_summary: typeof parsed.patch_summary === "string" ? parsed.patch_summary : undefined,
      created_at:
        typeof parsed.created_at === "string" && parsed.created_at.trim().length > 0
          ? parsed.created_at
          : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
};

const toPatchSummary = (entry: GoldenSetEntry): string => {
  const parts: string[] = [];
  parts.push(`plan=${entry.plan_summary}`);
  if (entry.touched_files.length > 0) {
    parts.push(`files=${entry.touched_files.join(", ")}`);
  }
  if (entry.review_notes) {
    parts.push(`review=${entry.review_notes}`);
  }
  if (entry.qa_notes) {
    parts.push(`qa=${entry.qa_notes}`);
  }
  if (entry.patch_summary) {
    parts.push(`patch=${entry.patch_summary}`);
  }
  return parts.join(" | ");
};

export class GoldenSetStore {
  private workspaceRoot: string;
  private storagePath: string;
  private maxEntries: number;

  constructor(options: GoldenSetStoreOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.storagePath = this.resolveStoragePath(options.storagePath ?? DEFAULT_STORAGE_PATH);
    this.maxEntries = options.maxEntries && options.maxEntries > 0 ? Math.floor(options.maxEntries) : DEFAULT_MAX_ENTRIES;
  }

  private resolveStoragePath(storagePath: string): string {
    const absolute = path.resolve(this.workspaceRoot, storagePath);
    const relative = path.relative(this.workspaceRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("GoldenSetStore storage path must be inside workspace root");
    }
    return absolute;
  }

  private sanitizeEntry(entry: GoldenSetEntry): GoldenSetEntry {
    return {
      intent: normalizeText(entry.intent),
      plan_summary: normalizeText(entry.plan_summary),
      touched_files: entry.touched_files.map((item) => item.trim()).filter(Boolean),
      review_notes: entry.review_notes ? normalizeText(entry.review_notes) : undefined,
      qa_notes: entry.qa_notes ? normalizeText(entry.qa_notes) : undefined,
      patch_summary: entry.patch_summary ? normalizeText(entry.patch_summary) : undefined,
      created_at: entry.created_at,
    };
  }

  async load(): Promise<GoldenSetEntry[]> {
    try {
      const raw = await fs.readFile(this.storagePath, "utf8");
      const entries = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => safeParseJson(line))
        .filter((entry): entry is GoldenSetEntry => Boolean(entry));
      return entries.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async append(entry: Omit<GoldenSetEntry, "created_at"> & { created_at?: string }): Promise<GoldenSetEntry[]> {
    const nextEntry = this.sanitizeEntry({
      ...entry,
      created_at: entry.created_at ?? new Date().toISOString(),
    });
    if (!nextEntry.intent || !nextEntry.plan_summary) {
      throw new Error("GoldenSetStore entries require intent and plan_summary");
    }
    const existing = await this.load();
    const all = [...existing, nextEntry];
    const bounded = all.slice(Math.max(0, all.length - this.maxEntries));
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    const payload = bounded.map((item) => JSON.stringify(item)).join("\n");
    await fs.writeFile(this.storagePath, payload.length > 0 ? `${payload}\n` : "", "utf8");
    return bounded;
  }

  async findExamples(intent: string, limit = 3): Promise<GoldenExampleSummary[]> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const entries = await this.load();
    if (entries.length === 0) return [];
    const queryTokens = tokenize(intent);
    return entries
      .map((entry) => {
        const text = `${entry.intent}\n${entry.plan_summary}\n${entry.touched_files.join(" ")}\n${entry.review_notes ?? ""}\n${entry.qa_notes ?? ""}`;
        const score = scoreEntry(queryTokens, text);
        return {
          intent: entry.intent,
          patch: toPatchSummary(entry),
          score,
          createdAt: Date.parse(entry.created_at),
        };
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.createdAt - a.createdAt;
      })
      .slice(0, safeLimit)
      .map((entry) => ({ intent: entry.intent, patch: entry.patch, score: entry.score }));
  }
}
