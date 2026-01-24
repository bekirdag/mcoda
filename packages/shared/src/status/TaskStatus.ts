export const READY_TO_CODE_REVIEW = "ready_to_code_review";
export const CHANGES_REQUESTED = "changes_requested";
export const WORK_ALLOWED_STATUSES = ["not_started", "in_progress", CHANGES_REQUESTED];
export const REVIEW_ALLOWED_STATUSES = [READY_TO_CODE_REVIEW];
export const QA_ALLOWED_STATUSES = ["ready_to_qa"];

const normalizeStatus = (status: string | undefined): string | undefined => {
  const normalized = status?.toLowerCase().trim();
  return normalized ? normalized : undefined;
};

export const normalizeReviewStatuses = (statuses: string[]): string[] => {
  return Array.from(
    new Set(
      (statuses ?? [])
        .map((status) => status.toLowerCase().trim())
        .filter((status) => Boolean(status) && status !== "blocked" && status !== "ready_to_review"),
    ),
  );
};

export const filterTaskStatuses = (
  input: string[] | undefined,
  allowed: string[],
  fallback: string[],
): { filtered: string[]; rejected: string[] } => {
  const allowedSet = new Set(allowed.map((status) => normalizeStatus(status)).filter(Boolean) as string[]);
  const normalized = Array.from(
    new Set(
      (input ?? [])
        .map((status) => normalizeStatus(status))
        .filter((status): status is string => Boolean(status) && status !== "blocked" && status !== "ready_to_review"),
    ),
  );
  const cleaned = normalizeReviewStatuses(normalized);
  const filtered = cleaned.filter((status) => allowedSet.has(status));
  const rejected = cleaned.filter((status) => !allowedSet.has(status));
  if (filtered.length === 0) {
    return { filtered: fallback.map((status) => normalizeStatus(status)).filter(Boolean) as string[], rejected };
  }
  return { filtered, rejected };
};

export const isReadyToReviewStatus = (status?: string | null): boolean => {
  if (!status) return false;
  return status.toLowerCase().trim() === READY_TO_CODE_REVIEW;
};
