import type { RunFailureClass } from "./RunTelemetryTypes.js";

export const RUN_LOG_QUERY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_RUN_LOG_QUERY_LIMIT = 100;
export const MAX_RUN_LOG_QUERY_LIMIT = 2000;

export type RunLogQuerySort = "asc" | "desc";

export interface RunLogQueryFilters {
  run_id?: string;
  task_id?: string;
  phase?: string;
  event_type?: string;
  failure_class?: RunFailureClass | string;
}

export interface RunLogQueryInput {
  schema_version?: number;
  filters?: RunLogQueryFilters;
  limit?: number;
  offset?: number;
  sort?: RunLogQuerySort;
}

export interface RunLogQueryEvent {
  event_index: number;
  file: string;
  line: number;
  type: string;
  timestamp: string;
  run_id?: string;
  task_id?: string;
  phase?: string;
  failure_class?: string;
  data: Record<string, unknown>;
}

export interface NormalizedRunLogQuery {
  schema_version: typeof RUN_LOG_QUERY_SCHEMA_VERSION;
  filters: RunLogQueryFilters;
  limit: number;
  offset: number;
  sort: RunLogQuerySort;
}

export interface RunLogQueryResult {
  schema_version: typeof RUN_LOG_QUERY_SCHEMA_VERSION;
  query: NormalizedRunLogQuery;
  total: number;
  returned: number;
  next_offset: number | null;
  events: RunLogQueryEvent[];
}

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeNonNegativeInteger = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return fallback;
  return Math.floor(value);
};

export const normalizeRunLogQueryInput = (input: RunLogQueryInput = {}): NormalizedRunLogQuery => {
  const filters = input.filters ?? {};
  const limitRaw = normalizeNonNegativeInteger(input.limit, DEFAULT_RUN_LOG_QUERY_LIMIT);
  const limit = Math.min(Math.max(limitRaw, 1), MAX_RUN_LOG_QUERY_LIMIT);
  const offset = normalizeNonNegativeInteger(input.offset, 0);
  const sort: RunLogQuerySort = input.sort === "desc" ? "desc" : "asc";
  return {
    schema_version: RUN_LOG_QUERY_SCHEMA_VERSION,
    filters: {
      run_id: normalizeString(filters.run_id),
      task_id: normalizeString(filters.task_id),
      phase: normalizeString(filters.phase),
      event_type: normalizeString(filters.event_type),
      failure_class: normalizeString(filters.failure_class),
    },
    limit,
    offset,
    sort,
  };
};
