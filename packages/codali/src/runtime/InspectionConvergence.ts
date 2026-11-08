import { createHash } from "node:crypto";

export type InspectionEffort = "low" | "medium" | "high" | string;

const ROUND_LIMITS: Record<string, number> = { low: 20, medium: 48, high: 96 };
const STALE_ROUND_LIMIT = 8;
// Bookkeeping and retrieval of already-held context never establish new evidence.
const NON_EVIDENCE_TOOLS = new Set(["tools_describe", "tools_discover", "tools_enable", "skill_list", "skill_load", "skill_read", "context_read", "server_time"]);

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;

const normalizedUrl = (value: string): string => {
  try { const url = new URL(value); url.hash = ""; return `${url.host.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}${url.search}`; }
  catch { return value.trim().toLowerCase(); }
};
const normalizedQuery = (value: string): string => [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].sort().join(" ");

function evidenceKey(tool: string, args: unknown, output: string): string {
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (tool === "browser_open" && typeof input.url === "string") return `open:${normalizedUrl(input.url)}`;
  if (tool === "browser_read") return `read:${String(input.snapshotId)}:${normalizedQuery(String(input.query ?? ""))}:${Number(input.offset ?? 0)}`;
  if (tool === "docdex_web_research" && typeof input.query === "string") return `web:${normalizedQuery(input.query)}`;
  return `${tool}:${createHash("sha256").update(JSON.stringify([canonical(args), output])).digest("hex")}`;
}

/** Decides when an investigation has stopped learning. Token and time budgets
 * cannot do this: they are large by design, and an unbounded loop stays inside
 * them for hours. Only new evidence resets the staleness counter. */
export class InspectionConvergence {
  private readonly seen = new Set<string>();
  private rounds = 0;
  private staleRounds = 0;
  private roundHasEvidence = false;
  private readonly maxRounds: number;

  constructor(effort: InspectionEffort) { this.maxRounds = ROUND_LIMITS[effort] ?? ROUND_LIMITS.medium; }

  /** Returns true when this call produced evidence the session did not have. */
  observe(tool: string, args: unknown, ok: boolean, output: string): boolean {
    if (!ok || NON_EVIDENCE_TOOLS.has(tool)) return false;
    const key = evidenceKey(tool, args, output);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.roundHasEvidence = true;
    return true;
  }

  endRound(): void {
    this.rounds++;
    this.staleRounds = this.roundHasEvidence ? 0 : this.staleRounds + 1;
    this.roundHasEvidence = false;
  }

  /** Why inspection should finish now, if it should. */
  reason(): string | undefined {
    if (this.staleRounds >= STALE_ROUND_LIMIT) return `no new evidence in the last ${this.staleRounds} rounds`;
    if (this.rounds >= this.maxRounds) return `reached the ${this.maxRounds}-round inspection limit`;
    return undefined;
  }

  status(): { rounds: number; maxRounds: number; staleRounds: number; distinctEvidence: number } {
    return { rounds: this.rounds, maxRounds: this.maxRounds, staleRounds: this.staleRounds, distinctEvidence: this.seen.size };
  }
}
