import type { DocdexClient } from "../docdex/DocdexClient.js";
import { adaptRunSummaryForReport } from "../eval/ReportInputAdapter.js";

export interface RunHistoryHit {
  intent: string;
  plan: string;
  diff: string;
  score: number;
}

type SearchHit = {
  path?: unknown;
  score?: unknown;
  request?: unknown;
  intent?: unknown;
  plan?: unknown;
  diff?: unknown;
  data?: unknown;
  run_summary?: unknown;
  snippet?: unknown;
  summary?: unknown;
  text?: unknown;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const extractTextFromHit = (hit: SearchHit): string => {
  const direct = asString(hit.text) ?? asString(hit.summary);
  if (direct) return direct;
  if (typeof hit.snippet === "string") return hit.snippet;
  if (hit.snippet && typeof hit.snippet === "object") {
    const text = asString((hit.snippet as { text?: unknown }).text);
    if (text) return text;
  }
  return "";
};

const extractIntentFromText = (text: string): string | undefined => {
  const requestMatch = text.match(/"request"\s*:\s*"([^"]+)"/i);
  if (requestMatch?.[1]) return requestMatch[1].trim();
  const userRequestMatch = text.match(/USER REQUEST:\s*([^\n]+)/i);
  if (userRequestMatch?.[1]) return userRequestMatch[1].trim();
  return undefined;
};

const extractPlanFromText = (text: string): string | undefined => {
  const planBlock = text.match(/PLAN:\s*\n([\s\S]{1,1200}?)(?:\n(?:TARGETS|RISK|VERIFY|END OF CONTEXT):|\Z)/i);
  if (planBlock?.[1]) return planBlock[1].trim();
  const stepsBlock = text.match(/"steps"\s*:\s*\[([\s\S]{1,1200}?)\]/i);
  if (stepsBlock?.[1]) return stepsBlock[1].trim();
  return undefined;
};

const extractDiffFromText = (text: string): string | undefined => {
  const diffMatch = text.match(/(?:diff|patch)\s*[:=]\s*([\s\S]{1,1200})/i);
  if (diffMatch?.[1]) return diffMatch[1].trim();
  return undefined;
};

const extractHistoryHit = (entry: SearchHit): RunHistoryHit | undefined => {
  const path = asString(entry.path);
  if (!path || !/(^|\/)logs\//.test(path)) return undefined;

  const score = asNumber(entry.score) ?? 0.5;
  const text = extractTextFromHit(entry);
  const dataRecord = asRecord(entry.data);
  const runSummaryRecord = asRecord(entry.run_summary) ?? asRecord(dataRecord?.run_summary);
  const normalizedRun = runSummaryRecord
    ? adaptRunSummaryForReport({ runSummary: runSummaryRecord })
    : undefined;
  const intent =
    asString(entry.intent) ??
    asString(entry.request) ??
    extractIntentFromText(text) ??
    (normalizedRun?.task_id ? `task ${normalizedRun.task_id}` : undefined) ??
    (normalizedRun?.run_id ? `run ${normalizedRun.run_id}` : undefined);
  const planFromNormalized = normalizedRun
    ? [
      `plan=${normalizedRun.phase_outcomes.find((entry) => entry.phase === "plan")?.status ?? "missing"}`,
      `retrieve=${normalizedRun.phase_outcomes.find((entry) => entry.phase === "retrieve")?.status ?? "missing"}`,
      `act=${normalizedRun.phase_outcomes.find((entry) => entry.phase === "act")?.status ?? "missing"}`,
      `verify=${normalizedRun.phase_outcomes.find((entry) => entry.phase === "verify")?.status ?? "missing"}`,
    ].join(";")
    : undefined;
  const diffFromNormalized = normalizedRun
    ? [
      `status=${normalizedRun.final_status}`,
      `failure_class=${normalizedRun.failure_class ?? "none"}`,
      `verification=${normalizedRun.verification_outcome ?? "none"}`,
      `missing=${normalizedRun.missing_data_markers.join("|") || "none"}`,
    ].join(";")
    : undefined;
  const plan = asString(entry.plan) ?? extractPlanFromText(text) ?? planFromNormalized ?? "";
  const diff = asString(entry.diff) ?? extractDiffFromText(text) ?? diffFromNormalized ?? "";

  if (!intent) return undefined;
  if (!plan && !diff) return undefined;

  return {
    intent,
    plan: plan || "inferred_from_log",
    diff: diff || "inferred_from_log",
    score,
  };
};

export class RunHistoryIndexer {
  constructor(private client: DocdexClient) {}

  async findSimilarRuns(intent: string, limit = 3): Promise<RunHistoryHit[]> {
    try {
      const query = `path:logs/codali ${intent}`;
      const searchResult = await this.client.search(query, { limit: limit * 3 });
      const entries = (searchResult as { hits?: SearchHit[] }).hits ?? [];

      const hits: RunHistoryHit[] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        const parsed = extractHistoryHit(entry);
        if (!parsed) continue;
        const dedupeKey = `${parsed.intent}::${parsed.plan}::${parsed.diff}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        hits.push(parsed);
      }

      return hits
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch {
      return [];
    }
  }
}
